-- SOPlayer cloud sync — metadata only.
--
-- Paste this whole file into the Supabase dashboard: SQL Editor → New query → Run.
-- Safe to run again later; every statement is idempotent.
--
-- What is stored here: playlist names, their track identities (youtube:<id>,
-- soundcloud:<id>, local:<path>) and the likes — a few kilobytes per playlist.
-- Audio files, artwork blobs and downloads never leave the PC.
--
-- Sign-up normally needs a confirmation email. To skip it while testing:
-- Authentication → Providers → Email → turn "Confirm email" off.

create table if not exists public.playlists (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  client_id    text        not null,
  name         text        not null default '',
  description  text        not null default '',
  cover        text        not null default '',
  position     integer     not null default 0,
  deleted      boolean     not null default false,
  updated_at   timestamptz not null default now(),
  primary key (user_id, client_id)
);

create table if not exists public.playlist_items (
  user_id            uuid             not null references auth.users (id) on delete cascade,
  playlist_client_id text             not null,
  track_key          text             not null,
  position           integer          not null default 0,
  title              text             not null default '',
  artist             text             not null default '',
  album              text             not null default '',
  duration           double precision not null default 0,
  platform           text             not null default '',
  thumbnail          text             not null default '',
  url                text             not null default '',
  path               text             not null default '',
  added_at           timestamptz,
  primary key (user_id, playlist_client_id, track_key),
  foreign key (user_id, playlist_client_id)
    references public.playlists (user_id, client_id) on delete cascade
);

create table if not exists public.favorites (
  user_id    uuid             not null references auth.users (id) on delete cascade,
  track_key  text             not null,
  position   integer          not null default 0,
  title      text             not null default '',
  artist     text             not null default '',
  album      text             not null default '',
  duration   double precision not null default 0,
  platform   text             not null default '',
  thumbnail  text             not null default '',
  url        text             not null default '',
  path       text             not null default '',
  added_at   timestamptz,
  primary key (user_id, track_key)
);

create index if not exists playlists_user_idx on public.playlists (user_id, position);
create index if not exists playlist_items_user_idx on public.playlist_items (user_id, playlist_client_id, position);

-- Row level security: a signed-in user only ever sees their own rows.
alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;
alter table public.favorites enable row level security;

-- RLS policies alone are not enough: the authenticated role also needs table
-- privileges. Without these, read_music_collection fails with
-- "permission denied for table playlist_items".
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.playlists to authenticated;
grant select, insert, update, delete on public.playlist_items to authenticated;
grant select, insert, update, delete on public.favorites to authenticated;

drop policy if exists playlists_owner on public.playlists;
create policy playlists_owner on public.playlists
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists playlist_items_owner on public.playlist_items;
create policy playlist_items_owner on public.playlist_items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists favorites_owner on public.favorites;
create policy favorites_owner on public.favorites
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Read: the whole collection for the calling user, shaped like the app's own
-- storage, so the desktop can merge without a second request per playlist.
-- ---------------------------------------------------------------------------
create or replace function public.read_music_collection()
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'playlists', coalesce((
      select jsonb_agg(jsonb_build_object(
        'clientId',    p.client_id,
        'name',        p.name,
        'description', p.description,
        'cover',       p.cover,
        'position',    p.position,
        'deleted',     p.deleted,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'key',       i.track_key,
            'position',  i.position,
            'title',     i.title,
            'artist',    i.artist,
            'album',     i.album,
            'duration',  i.duration,
            'platform',  i.platform,
            'thumbnail', i.thumbnail,
            'url',       i.url,
            'path',      i.path,
            'addedAt',   coalesce((extract(epoch from i.added_at) * 1000)::bigint, 0)
          ) order by i.position)
          from public.playlist_items i
          where i.user_id = p.user_id and i.playlist_client_id = p.client_id
        ), '[]'::jsonb)
      ) order by p.position, p.client_id)
      from public.playlists p
      where p.user_id = auth.uid()
    ), '[]'::jsonb),
    'favorites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',       f.track_key,
        'position',  f.position,
        'title',     f.title,
        'artist',    f.artist,
        'album',     f.album,
        'duration',  f.duration,
        'platform',  f.platform,
        'thumbnail', f.thumbnail,
        'url',       f.url,
        'path',      f.path,
        'addedAt',   coalesce((extract(epoch from f.added_at) * 1000)::bigint, 0)
      ) order by f.position)
      from public.favorites f
      where f.user_id = auth.uid()
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Write: replace the caller's collection with the (already merged) snapshot the
-- desktop sends, then return what is now stored. One transaction, so a dropped
-- connection can never leave half a library behind.
-- ---------------------------------------------------------------------------
create or replace function public.sync_music_collection(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Items are rewritten only for playlists included in this push.
  delete from public.playlist_items pi
   where pi.user_id = v_user
     and pi.playlist_client_id in (
       select x ->> 'clientId'
         from jsonb_array_elements(coalesce(v_payload -> 'playlists', '[]'::jsonb)) x
     );

  insert into public.playlists (user_id, client_id, name, description, cover, position, deleted, updated_at)
  select v_user,
         x ->> 'clientId',
         coalesce(x ->> 'name', ''),
         coalesce(x ->> 'description', ''),
         coalesce(x ->> 'cover', ''),
         coalesce((x ->> 'position')::int, 0),
         coalesce((x ->> 'deleted')::boolean, false),
         now()
    from jsonb_array_elements(coalesce(v_payload -> 'playlists', '[]'::jsonb)) x
   where coalesce(x ->> 'clientId', '') <> ''
  on conflict (user_id, client_id) do update
     set name        = excluded.name,
         description = excluded.description,
         cover       = excluded.cover,
         position    = excluded.position,
         deleted     = excluded.deleted,
         updated_at  = now();

  insert into public.playlist_items (
    user_id, playlist_client_id, track_key, position,
    title, artist, album, duration, platform, thumbnail, url, path, added_at
  )
  select v_user,
         x ->> 'clientId',
         i ->> 'key',
         coalesce((i ->> 'position')::int, 0),
         coalesce(i ->> 'title', ''),
         coalesce(i ->> 'artist', ''),
         coalesce(i ->> 'album', ''),
         coalesce((i ->> 'duration')::double precision, 0),
         coalesce(i ->> 'platform', ''),
         coalesce(i ->> 'thumbnail', ''),
         coalesce(i ->> 'url', ''),
         coalesce(i ->> 'path', ''),
         case when (i ->> 'addedAt') ~ '^[0-9]+(\.[0-9]+)?$'
              then to_timestamp(((i ->> 'addedAt')::double precision) / 1000.0)
              else null end
    from jsonb_array_elements(coalesce(v_payload -> 'playlists', '[]'::jsonb)) x
    cross join lateral jsonb_array_elements(coalesce(x -> 'items', '[]'::jsonb)) i
   where coalesce(x ->> 'clientId', '') <> ''
     and coalesce(i ->> 'key', '') <> ''
     and coalesce((x ->> 'deleted')::boolean, false) = false
  on conflict (user_id, playlist_client_id, track_key) do update
     set position  = excluded.position,
         title     = excluded.title,
         artist    = excluded.artist,
         album     = excluded.album,
         duration  = excluded.duration,
         platform  = excluded.platform,
         thumbnail = excluded.thumbnail,
         url       = excluded.url,
         path      = excluded.path,
         added_at  = excluded.added_at;

  delete from public.favorites where user_id = v_user;

  insert into public.favorites (
    user_id, track_key, position, title, artist, album, duration,
    platform, thumbnail, url, path, added_at
  )
  select v_user,
         i ->> 'key',
         coalesce((i ->> 'position')::int, 0),
         coalesce(i ->> 'title', ''),
         coalesce(i ->> 'artist', ''),
         coalesce(i ->> 'album', ''),
         coalesce((i ->> 'duration')::double precision, 0),
         coalesce(i ->> 'platform', ''),
         coalesce(i ->> 'thumbnail', ''),
         coalesce(i ->> 'url', ''),
         coalesce(i ->> 'path', ''),
         case when (i ->> 'addedAt') ~ '^[0-9]+(\.[0-9]+)?$'
              then to_timestamp(((i ->> 'addedAt')::double precision) / 1000.0)
              else null end
    from jsonb_array_elements(coalesce(v_payload -> 'favorites', '[]'::jsonb)) i
   where coalesce(i ->> 'key', '') <> '';

  return public.read_music_collection();
end;
$$;

grant execute on function public.read_music_collection() to authenticated;
grant execute on function public.sync_music_collection(jsonb) to authenticated;
