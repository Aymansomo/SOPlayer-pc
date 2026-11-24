'use strict';

/**
 * Pure helpers behind cloud sync. Nothing here touches the network or disk, so
 * the rules that decide what a playlist looks like after two devices meet can be
 * tested on their own (see test/account-merge.test.js).
 *
 * A track's identity is the same canonical key the phone sync already uses
 * (src/server/mobile/collection.js keyForTrack): `youtube:<id>`,
 * `soundcloud:<id>`, `local:<normalised path>`. Only that key is compared — the
 * metadata around it is a convenience copy for machines that cannot resolve it.
 */

function normalisePath(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function trackKey(track) {
  if (!track || typeof track !== 'object') return '';
  const platform = String(track.platform || '').toLowerCase();
  const id = track.id != null ? String(track.id) : '';
  if (platform === 'local' || track.path) {
    if (track.path) return `local:${normalisePath(track.path)}`;
    if (id) return `local:${id}`;
  }
  if (platform === 'soundcloud' && id) return `soundcloud:${id}`;
  if (['youtube', 'ytmusic', 'yt', ''].includes(platform) && id) return `youtube:${id}`;
  if (id) return `${platform || 'other'}:${id}`;
  if (track.url) return `url:${String(track.url).toLowerCase()}`;
  return '';
}

/** The small, device-independent copy of a track that is allowed into the cloud. */
function slimTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const key = trackKey(track);
  if (!key) return null;
  return {
    key,
    id: track.id != null ? String(track.id) : '',
    title: track.title ? String(track.title) : '',
    artist: track.artist ? String(track.artist) : '',
    album: track.album ? String(track.album) : '',
    duration: Number(track.duration) || 0,
    platform: track.platform ? String(track.platform) : '',
    thumbnail: track.thumbnail ? String(track.thumbnail) : '',
    url: track.url ? String(track.url) : '',
    path: track.path ? String(track.path) : '',
    addedAt: Number(track.addedAt) || 0,
  };
}

/** Rebuild a normal renderer track from a cloud row. */
function trackFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const key = String(row.key || '');
  if (!key) return null;
  const platform = String(row.platform || '');
  const path = String(row.path || '');
  const track = {
    id: row.id != null && String(row.id) ? String(row.id) : '',
    title: String(row.title || ''),
    artist: String(row.artist || ''),
    album: String(row.album || ''),
    duration: Number(row.duration) || 0,
    platform: platform || (key.startsWith('local:') ? 'local' : ''),
    thumbnail: String(row.thumbnail || ''),
    url: String(row.url || ''),
    addedAt: Number(row.addedAt) || 0,
  };
  if (path) track.path = path;
  if (!track.id) {
    const sep = key.indexOf(':');
    if (sep > 0 && !track.path) track.id = key.slice(sep + 1);
  }
  return track;
}

function playlistIdOf(playlist) {
  if (!playlist || typeof playlist !== 'object') return '';
  const id = playlist.id != null ? playlist.id : playlist.clientId;
  return id != null ? String(id) : '';
}

function uniqueTracks(tracks) {
  const out = [];
  const seen = new Set();
  for (const track of tracks) {
    const key = trackKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

/**
 * One playlist that exists on both sides: keep the local object (and therefore
 * its cover, description and the exact track objects the renderer already
 * holds), take local order first, then append anything only the other device had.
 *
 * `knownKeys` is the set of items this machine had in the playlist at the last
 * successful sync. A remote row with one of those keys that is no longer in the
 * local list was deleted here, so it must not be copied back — that is what made
 * "remove from playlist" undo itself on the next sync.
 */
function mergePlaylist(local, remote, knownKeys) {
  const localTracks = Array.isArray(local.tracks) ? local.tracks : [];
  const merged = uniqueTracks(localTracks).slice();
  const seen = new Set(merged.map(trackKey));
  const known = knownKeys instanceof Set ? knownKeys : new Set();
  const remoteItems = Array.isArray(remote && remote.items) ? remote.items : [];
  for (const row of remoteItems) {
    const key = String((row && row.key) || '');
    if (!key || seen.has(key) || known.has(key)) continue;
    const rebuilt = trackFromRow(row);
    if (!rebuilt) continue;
    seen.add(key);
    merged.push(rebuilt);
  }
  return Object.assign({}, local, { tracks: merged });
}

function playlistFromRemote(remote) {
  const items = Array.isArray(remote && remote.items) ? remote.items : [];
  return {
    id: String((remote && (remote.clientId || remote.id)) || ''),
    name: String((remote && remote.name) || 'Playlist'),
    description: String((remote && remote.description) || ''),
    cover: String((remote && remote.cover) || ''),
    tracks: items.map(trackFromRow).filter(Boolean),
  };
}

/**
 * Fold the cloud copy into the local one.
 *
 * Guarantees:
 * - Nothing is ever dropped because a side was empty; an empty local collection
 *   can only *adopt* cloud playlists, never delete them.
 * - A playlist is deleted only when it was synced before (`knownIds`) *and* the
 *   local collection still has other playlists, i.e. the user really removed it.
 *   This is the guard for the old "one empty push wiped everything" bug.
 */
function mergeCollections(local, remote, options) {
  const opts = options || {};
  const localPlaylists = Array.isArray(local && local.playlists) ? local.playlists : [];
  const remotePlaylists = Array.isArray(remote && remote.playlists) ? remote.playlists : [];
  const localFavorites = Array.isArray(local && local.favorites) ? local.favorites : [];
  const remoteFavorites = Array.isArray(remote && remote.favorites) ? remote.favorites : [];
  const knownIds = new Set((opts.knownIds || []).map(String));
  // A purge needs a real local library. An empty one only purges when the caller
  // passes `allowPurge: true`, i.e. the renderer knows the last playlist was just
  // deleted on purpose.
  const allowPurge = localPlaylists.length > 0 ? opts.allowPurge !== false : opts.allowPurge === true;
  const knownItems = opts.knownItems && typeof opts.knownItems === 'object' ? opts.knownItems : {};
  const knownFavorites = new Set((opts.knownFavorites || []).map(String));
  // Liking is an accumulating list, so deleting the last likes needs the same
  // vouch a playlist purge needs: a client that has not loaded its library yet
  // sends no favourites and knows none, and that used to erase the account.
  const allowFavoritePurge = localFavorites.length > 0 || opts.allowPurge === true;

  const favorites = uniqueTracks(localFavorites).slice();
  const favoriteKeys = new Set(favorites.map(trackKey));
  for (const row of remoteFavorites) {
    const key = String((row && row.key) || '');
    if (!key || favoriteKeys.has(key)) continue;
    // Liked here before and gone from the local list now: the user unliked it,
    // so the cloud copy must not bring it back.
    if (knownFavorites.has(key) && allowFavoritePurge) continue;
    const rebuilt = trackFromRow(row);
    if (!rebuilt) continue;
    favoriteKeys.add(key);
    favorites.push(rebuilt);
  }

  const remoteById = new Map();
  for (const pl of remotePlaylists) {
    const id = playlistIdOf(pl);
    if (id) remoteById.set(id, pl);
  }

  const playlists = [];
  const removedIds = [];
  const present = new Set();
  for (const pl of localPlaylists) {
    const id = playlistIdOf(pl);
    if (!id) continue;
    const remotePl = remoteById.get(id);
    if (remotePl && remotePl.deleted) {
      removedIds.push(id);
      continue;
    }
    present.add(id);
    const knownKeys = Array.isArray(knownItems[id]) ? new Set(knownItems[id].map(String)) : new Set();
    playlists.push(remotePl ? mergePlaylist(pl, remotePl, knownKeys) : pl);
  }

  for (const remotePl of remotePlaylists) {
    const id = playlistIdOf(remotePl);
    if (!id || present.has(id)) continue;
    if (remotePl.deleted) {
      removedIds.push(id);
      continue;
    }
    if (knownIds.has(id) && allowPurge) {
      // It was here on this machine before, it is gone now, and the user still
      // has other playlists: this is a real delete, not a fresh install.
      removedIds.push(id);
      continue;
    }
    playlists.push(playlistFromRemote(remotePl));
  }

  const tombstones = [];
  if (allowPurge) {
    for (const id of knownIds) {
      if (present.has(id)) continue;
      // Gone locally but still live in the cloud: this delete has not reached
      // Supabase yet, so tombstone it or the next sync resurrects the playlist.
      const remotePl = remoteById.get(id);
      if (remotePl && remotePl.deleted) continue; // already tombstoned
      tombstones.push(id);
    }
  }

  const nextKnown = new Set(knownIds);
  for (const pl of playlists) {
    const id = playlistIdOf(pl);
    if (id) nextKnown.add(id);
  }
  for (const id of removedIds) nextKnown.add(id);

  // Remember exactly which tracks each playlist holds after this merge, so the
  // next sync can tell "new from another PC" apart from "deleted here".
  const nextItems = {};
  for (const pl of playlists) {
    const id = playlistIdOf(pl);
    if (!id) continue;
    nextItems[id] = uniqueTracks(Array.isArray(pl.tracks) ? pl.tracks : []).map(trackKey).filter(Boolean);
  }

  return {
    favorites,
    playlists,
    removedIds: Array.from(new Set(removedIds)),
    tombstones,
    knownIds: Array.from(nextKnown),
    knownItems: nextItems,
    knownFavorites: favorites.map(trackKey).filter(Boolean),
  };
}

/** The exact JSON body the Supabase function expects. */
function toRemotePayload(merged) {
  const playlists = [];
  const seen = new Set();
  (merged.playlists || []).forEach((pl, index) => {
    const clientId = playlistIdOf(pl);
    if (!clientId || seen.has(clientId)) return;
    seen.add(clientId);
    const items = [];
    const itemKeys = new Set();
    const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
    tracks.forEach((track) => {
      const row = slimTrack(track);
      if (!row || itemKeys.has(row.key)) return;
      itemKeys.add(row.key);
      items.push(Object.assign({}, row, { position: items.length }));
    });
    playlists.push({
      clientId,
      name: String(pl.name || ''),
      description: String(pl.description || ''),
      // A playlist cover is either a remote URL (tiny) or a local data URL /
      // artwork key, which is not worth pushing; the other device rebuilds it.
      cover: /^https?:\/\//i.test(String(pl.cover || '')) ? String(pl.cover) : '',
      position: index,
      deleted: false,
      items,
    });
  });
  for (const id of merged.tombstones || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    playlists.push({ clientId: String(id), name: '', description: '', cover: '', position: 0, deleted: true, items: [] });
  }

  const favorites = [];
  const favoriteKeys = new Set();
  (merged.favorites || []).forEach((track) => {
    const row = slimTrack(track);
    if (!row || favoriteKeys.has(row.key)) return;
    favoriteKeys.add(row.key);
    favorites.push(Object.assign({}, row, { position: favorites.length }));
  });

  return { playlists, favorites };
}

module.exports = {
  normalisePath,
  trackKey,
  slimTrack,
  trackFromRow,
  playlistIdOf,
  mergeCollections,
  toRemotePayload,
};
