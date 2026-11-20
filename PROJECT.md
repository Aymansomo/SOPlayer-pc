# Riff + Navic → SOPlayer — Phone Music Project

> **Naming (Nov 2026):** both apps are branded **SOPlayer**. The desktop
> `productName`, window/tray/page titles and the Android `app_name` now say
> SOPlayer, and the Android APK is built as `SOPlayer.apk`. Internal ids were
> deliberately kept so nothing breaks: Electron keeps the `Riff` data folder
> (`app.setName('Riff')`, so existing settings survive), the desktop package
> name/appId and the Android package (`paige.navic[.debug]`) are unchanged, and
> all references below to Riff/Navic describe those internals.

This file is the single source of truth for the **Riff → Navic** work: what we are
building, why, how it is wired, where every file lives, and what is done so far.
Read this first before continuing any phase.

---

## 1. Goal

Turn the user's fork of the **Riff** desktop music player into a small
**Subsonic / OpenSubsonic server** on the local network, so the Android app
**Navic** can:

- browse the PC music library (artists, albums, songs, genres, search),
- stream and download songs from the PC,
- keep **likes (favourites) and playlists synced two-way**,
- play everything on the phone (local files + online YouTube/SoundCloud),
- **remote-control** playback on the PC (play/pause/next/seek/volume/like).

The PC is not always on. When it is off, the phone must keep working with the
songs it has already downloaded/cached in Navic.

---

## 2. Hard requirements and decisions

| Topic | Decision |
|---|---|
| Phone app | **Navic** (Android, Subsonic/OpenSubsonic client). |
| Navic source | `project\Riff\Navic` is **the app the user actually runs**, so small, justified client fixes are allowed (subtitle order, launcher icon, starred sync, download retry, read-only mixes). The server still does the heavy lifting. |
| Music folder | **Only** `E:\ayman\Development\My_progicte\ME\Music_app\project\music`. The user adds music there manually. Do **not** index `script\audio` root files. |
| Port | The originally requested **67676 is impossible** (TCP max 65535). We use **6767**. |
| Desktop API | The existing desktop server stays on `127.0.0.1:38472` and is **never exposed** to the LAN. |
| Phone listener | A separate HTTP server binds `0.0.0.0:6767`. |
| Offline | Navic downloads songs itself; the server does not need to be online for offline playback. |
| Likes / playlists | Must sync both ways (phone ↔ PC). Planned in Phase 3 using Riff's existing `localStorage` collections. |

---

## 3. Architecture

```
┌──────────────────────────── PC (Riff / Electron) ───────────────────────────┐
│                                                                             │
│  Renderer (src/renderer)                                                    │
│    Settings → Phone & Navic  ──IPC──┐                                       │
│    localStorage favourites/playlists│                                       │
│                                     ▼                                       │
│  Main process (src/main/main.js)                                            │
│    ├── desktop server  src/server/server.js   127.0.0.1:38472  (private)    │
│    └── phone server    src/server/mobile/     0.0.0.0:6767     (LAN)        │
│            ├── config.js     mobile.json                                    │
│            ├── auth.js       Subsonic token auth + remote sessions          │
│            ├── library.js    music scan / index / cover art                 │
│            └── subsonic.js   /rest/* API                                    │
│                                                                             │
│  Music library: E:\...\Music_app\project\music  (only this folder)          │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │ Wi-Fi LAN
                                   ▼
                    ┌──────────────────────────────┐
                    │ Navic (Android)              │
                    │  http://<PC-LAN-IP>:6767     │
                    │  browse / stream / download  │
                    │  likes / playlists (2-way)   │
                    └──────────────────────────────┘
```

Why a separate server: the desktop server trusts localhost and exposes routes
that run `yt-dlp`/`ffmpeg` with user-supplied URLs. It must never be reachable
from another device. The phone server only exposes `/rest/*`, `/remote` and a
tiny status route.

---

## 4. Files added / changed for this project

### Server (new)

| File | Purpose |
|---|---|
| `src/server/mobile/config.js` | Persistent `mobile.json`, defaults, credential generation, LAN URL detection, folder seeding. |
| `src/server/mobile/auth.js` | Subsonic auth (`t`/`s`, `p`, `enc:`, `apiKey`), login throttling, remote-page cookie sessions. |
| `src/server/mobile/library.js` | Recursive scan of the configured music folders, `ffprobe` tags, stable IDs, artist/album/song indexes, cover art, stream file lookup, persistence (`mobile-library.json`). |
| `src/server/mobile/atomic-write.js` | Windows-safe replace for `mobile-*.json`: retries `rename` on EBUSY/EPERM, then writes in place. |
| `src/server/mobile/online.js` | Phase 4: YouTube / SoundCloud search and stream relay via `yt-dlp`, saved online collection (`mobile-online.json`), online cover thumbnails. |
| `src/server/mobile/transcode.js` | Phase 2: on-the-fly MP3 transcoding for `format`, `maxBitRate` and `timeOffset`. |
| `src/server/mobile/collection.js` | Phase 3: two-way favourites, playlists and play counts (`mobile-collection.json`), canonical track keys, tombstones, renderer merge. |
| `src/server/mobile/remote.js` | Phase 5: `/remote` login sessions, state snapshots and command dispatch to the renderer. |
| `src/server/mobile/subsonic.js` | Subsonic/OpenSubsonic envelope (XML + JSON), endpoint router, browse/search/cover/stream handlers. |
| `src/server/mobile/index.js` | LAN HTTP listener (`0.0.0.0:6767`), routing, landing page, `/mobile/api/status`, `/remote`. |
| `src/server/mobile/public/remote.html` | Phone remote-control page: login, now playing, play/pause, next/prev, seek, volume, mute, like. |
| `scripts/riff-mobile-firewall.ps1` | Windows firewall helper (needs admin once). |
| `MOBILE.md` | User-facing setup / firewall / troubleshooting guide (English + Arabic). |
| `PROJECT.md` | This file. |
| `test/mobile.test.js` | Handshake, auth, XML/JSON, browse and cover-art tests. |

### Desktop integration (edited)

| File | Change |
|---|---|
| `src/main/main.js` | Starts/stops the phone listener; IPC handlers for mobile config/status/password/folders/test/library scan. |
| `src/main/preload.js` | Exposes the mobile IPC methods to the renderer (`syncMobileCollection` included). |
| `src/server/mobile/store.js` | `/store` page + `/store/files/<name>` downloads for the user's own installers in `<repo>/apps` (version from the file name, Range support, path-traversal safe). |
| `src/renderer/index.html` | **Settings → Phone & Navic** section and nav entry. |
| `src/renderer/app.js` | Phone settings logic (toggle, URLs, credentials, folders, test, library status/reindex, online switch, favourites/playlists sync loop). |

### MyApps (personal store app)

- `MyApps/` — standalone Android app (`com.ayman.myapps`) that stores the APKs
  the user builds and installs/updates them from a list. Reads name/icon/version
  from each APK with `PackageManager.getPackageArchiveInfo`, imports from file
  picker or a direct URL, installs through `FileProvider` +
  `REQUEST_INSTALL_PACKAGES`.
- Build and install with `npm run android:store` (`--wireless`, `--no-build`,
  `--device`, `--apk` work like the Navic script).

### Playlist detail (sort, filter, auto-download)

- **Custom playlist covers**: the playlist sheet has *Change cover image* and
  *Reset cover image*. Subsonic has no per-playlist cover, so the chosen picture
  is copied into `files/playlist-artwork/<hash>.img` by `PlaylistArtworkManager`
  and drawn through `CoverArt(localArtwork = …)` in the playlist grid, list row,
  detail heading and sheet header; resetting deletes the file and the server
  mosaic comes back.

- **Sort/filter sheet** on the playlist screen (`DomainPlaylistSongSort`,
  `PlaylistSongQueryBuilder`): playlist order, recently added (last song added
  first), title, artist, album, duration, plus ascending/descending and the
  Starred / Downloaded filters. Paging re-runs through a raw query, so sorting
  works on the whole playlist, not just the loaded page.
- **Pressing a row plays that song**: the queue is loaded with the same sort and
  filters the screen shows (`CollectionRepository.getPlaylistSongs`), so a row
  clicked under "newest first" no longer started whatever sat at that index in
  the playlist's original order.
- **Downloaded playlists stay current**: pressing download records the playlist
  in `PreferenceManager.downloadedPlaylists`; `DownloadManager.syncAutoDownload`
  then queues any song that is not downloaded yet — called after a playlist
  refresh, after a full library sync (`SyncCoordinator`), and right after songs
  are added from the app. Deleting a playlist's downloads forgets it again.
- **Icon**: `assets/icon.png|ico|1024` (PC, electron-builder) and Navic's
  `mipmap-*/ic_launcher*.png` + `drawable-*/ic_launcher_foreground.png`
  (adaptive icon, dark background) come from the user's AS logo.
- Navic's three icon variants (`Default`, `Inverted`, `Jam` — chosen in
  Settings → Appearance, implemented as activity aliases) all use the same
  SOPlayer artwork; the old Navic vectors/webps were removed so a non-default
  variant can never bring the old logo back. The Android 12+ launch splash
  (`values-v31/themes.xml`) uses `@mipmap/ic_launcher` on
  `@color/splash_background` (`#141416`), so cold starts show the same mark
  instead of the old Navic animation.

### Navic (Android client)

- `Navic/` — client source, built and installed from here.
- **QR login**: Navic's login screen has a *Scan QR code* button
  (`com.journeyapps:zxing-android-embedded`). It reads a JSON code
  `{"app":"soplayer","url","username","password"}` that Riff renders in
  **Settings → Phone & Navic** (generated with the `qrcode` npm package in the
  main process), fills the three fields and logs in. Nothing is stored beyond
  the normal session. The code is shown even while phone access is off: it then
  encodes this PC's LAN address and the saved port, so pairing works before the
  listener is switched on.
- **Phone library auto-sync**: while phone access is running,
  `src/server/mobile/index.js` rescans the configured music folders 10 seconds
  after start and every 5 minutes after that, so songs added on the PC reach
  Navic without pressing **Rescan library**. Scans are incremental; unchanged
  files reuse their cached metadata.
- **Offline content survives syncs**: `SongDao` and `AlbumDao` never delete a
  row that still has a `DOWNLOADED` copy, and `PlaylistDao` keeps every playlist
  listed in `downloadedPlaylists`, and `DbRepository.syncPlaylistSongs` merges
  those saved songs into the server's list instead of replacing it. Deleting a
  playlist or its songs on the PC therefore leaves the downloaded copy on the
  phone intact (playable offline), and opening it succeeds even when the PC no
  longer has it.
- `npm run android:install` (`scripts/install-navic.js`) builds
  `:app:assembleDefaultDebug` and installs the APK with `adb` over USB or
  wireless debugging, so the APK never has to be copied to the phone by hand.
  `--no-build`, `--connect <ip>`, `--pair <ip:port> --pair-code <code>`,
  `--device <serial>` and `--apk <path>` cover the rest. `--app store` does the
  same for `MyApps/` and publishes `apps/MyApps-<version>.apk` for the LAN
  `/store` page.
- **OTA self-updater**: on startup (when *Check for updates* is on and this is
  not the `fdroid` flavor) `ui/component/sheet/ChangelogSheet.kt` reads
  `https://api.github.com/repos/Aymansomo/SOPlayer/releases/latest`, compares
  `tag_name` numerically with `BuildConfig.VERSION_NAME`, and offers the first
  `.apk` asset in a sheet with the release notes. Confirming downloads it to
  `cacheDir/update.apk`, asks for *install unknown apps* via
  `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` when
  `canRequestPackageInstalls()` is false, then opens the system installer with
  a `FileProvider` URI (`${applicationId}.fileprovider`, `res/xml/file_paths.xml`
  maps the cache dir). Network failures are swallowed, so offline launches are
  unchanged.

---

## 5. Configuration

### `mobile.json`

Location: Riff **data folder** (usually `%LOCALAPPDATA%\Riff\mobile.json`; on this
machine `E:\ayman\Development\My_progicte\ME\Music_app\script\audio\mobile.json`).

```json
{
  "enabled": true,
  "port": 6767,
  "bindHost": "0.0.0.0",
  "username": "riff",
  "password": "<generated>",
  "apiKey": "<generated>",
  "folders": [
    "E:\\ayman\\Development\\My_progicte\\ME\\Music_app\\project\\music"
  ],
  "remoteEnabled": true,
  "foldersSeeded": true,
  "createdAt": 0,
  "updatedAt": 0
}
```

- `folders` is the **only** music source list. The app seeds it once with
  `project\music` when that folder exists; after that the user controls it.
- `password` and `apiKey` are generated on first run and can be regenerated from
  the UI. Changing the password requires updating Navic.

### Generated data files (same data folder)

| File | Purpose |
|---|---|
| `mobile-library.json` | Cached library index (songs/albums/artists + file `mtime`/`size`). |
| `mobile-covers/<albumId>.jpg` | Extracted/cached album covers. |
| `mobile-collection.json` | Two-way favourites, playlists, starred albums/artists and play counts (Phase 3). |
| `mobile-online.json` | Saved online songs (YouTube / SoundCloud) found by search: id, provider, remote id, title, artist, duration, thumbnail. |

---

## 6. Stable IDs

All IDs are derived from content/paths, so they survive rescans and do not
change between app restarts:

| Entity | Key | Example |
|---|---|---|
| Song | SHA-1 of `song\n<absolute file path>` | `9f2c...` |
| Album | SHA-1 of `album\n<album artist>\n<album>\n<folder>` | `4a71...` |
| Artist | SHA-1 of `artist\n<normalized name>` | `c0de...` |

Covers use the album ID. Song and artist objects point their `coverArt` at the
album ID, so Navic asks for one image per album.

---

## 7. Subsonic API status

Base URL: `http://<PC-LAN-IP>:6767/rest/<method>.view`
Credentials: Subsonic token auth (`u`, `t`, `s`) or plain/`enc:` password, or
`apiKey=` (OpenSubsonic). Responses: XML by default, JSON with `f=json`.

### Implemented (Phases 0–4)

| Endpoint | Notes |
|---|---|
| `ping`, `getLicense` | Handshake. |
| `getOpenSubsonicExtensions` | Empty list. |
| `getMusicFolders` | Configured music folders. |
| `getUser` | User roles (admin/download/playlist/cover). |
| `getArtists` | Artists grouped by letter (`index`). |
| `getIndexes` | Same artist index + `lastModified`. |
| `getArtist` | Artist with albums. |
| `getAlbum` | Album with songs. |
| `getAlbumList2` | `alphabeticalByName`, `alphabeticalByArtist`, `newest`, `random`, `recent`; paging with `size`/`offset`. |
| `getAlbumList` | ID3 alias of `getAlbumList2`. |
| `getSong` | One song by ID. |
| `getRandomSongs` | Optional `genre`, year range. |
| `getSongsByGenre` | Paged. |
| `getGenres` | Song/album counts per genre. |
| `search3`, `search2` | Artists, albums, songs. |
| `getCoverArt` | Cached/extracted album art, falls back to `assets/icon.png`. |
| `getScanStatus`, `startScan` | Library scan state / trigger rescan. |
| `getStarred2` | Empty until Phase 3. |
| `getPlaylists`, `getPlaylist` | Empty until Phase 3. |
| `stream` | Local files with HTTP Range support; transcodes to MP3 for `format`, `maxBitRate` and `timeOffset` (Phase 2); relays online songs (Phase 4). |
| `download` | Always the untouched original file, with Range support (Phase 2). |
| `scrobble`, `star`, `unstar` | Accepted no-ops until Phase 3. |

### Collection sync (Phase 3)

- `star` / `unstar` accept song `id`, `albumId` and `artistId`; `getStarred2`
  and `getStarred` return whatever is starred on either side.
- `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`
  (`songIdToAdd` / `songIndexToRemove`) and `deletePlaylist` are live; playlist
  ids created on the phone are Riff-style `pl_…` ids.
- Playlists expose a composed cover (`coverArt: plcover_<id>`): `playlist-cover.js`
  tiles the artwork of the first four *different* covers into one 600×600 JPEG
  with ffmpeg, cached in `mobile-covers/playlist-<id>-<hash>.jpg`; the hash
  includes `changedAt`, so an edit regenerates it and deletes the old file.
  That gives Navic the same 2×2 playlist card as the desktop with no client
  change. Without ffmpeg it falls back to the first song's cover.
- `scrobble` counts plays; the count appears as `playCount` on songs and
  `getAlbumList2?type=frequent` orders albums by plays.
- `getAlbumList2` / `getAlbumList` also support `type=starred`.
- `starred` on songs is an ISO timestamp (`collection.starredAt`), never `true`:
  Subsonic clients parse it as a date, and a boolean made the whole
  `getStarred2` response unreadable (Navic's Starred screen stayed empty).
- Two-way with Riff's own `devsize_favorites` / `devsize_playlists` through the
  `mobile-sync-collection` IPC channel: the renderer pushes its arrays every
  15 s (and on focus), the store merges, and the merged result is written back
  to `localStorage` and re-rendered. The renderer adopts the merged snapshot
  whenever it differs from the last one it received (`pc.rendererHash`), not
  only when the PC's own push changed something — that is what carries a phone
  star or playlist edit back to the desktop.
- Identity is a canonical key: `local:<path>`, `youtube:<id>`,
  `soundcloud:<id>`, `<platform>:<id>`. Playlist entries whose online track the
  server has never seen (everything added on the PC, including Spotify imports
  with `sp_…` ids and no URL) are **adopted** into the online collection first,
  pinned so pruning keeps them, and resolved by a YouTube Music lookup by
  artist + title when they are played. Without that a shared playlist appeared
  on the phone with `0 songs`.
- Deletions are tombstones with timestamps (30-day retention) so an unstar on
  either side does not come back on the next sync. Anything the PC previously
  pushed and no longer includes counts as an unstar; phone-added entries are
  never mistaken for deletions.
- The same push carries the PC's last 100 plays (`history`, with `playedAt`)
  and its generated Daily Mixes (`riff_daily_mixes`). History tracks and
  favourites are adopted like playlist tracks, so a PC star is playable on the
  phone and `Starred` is no longer empty; each new `playedAt` counts one
  `scrobble`, which is how the phone's play counts and taste follow PC
  listening. Navic's `DbRepository.syncStarred()` pulls `getStarred2` into its
  local database (the Starred screen reads local songs as one flat list, so a
  long "liked songs" list is no longer cut to the first three rows), and the Starred screen
  refreshes through it instead of re-downloading the whole library.
- `mixes.js` adopts the PC's mixes as `smart_daily_1..N` (unchanged pushes are a
  no-op) and falls back to generating mixes from taste through the desktop's
  `POST /api/vibe` when the PC never pushed any.

### Streaming robustness (Phase 2)

- `stream` understands `format`, `maxBitRate` and `timeOffset` and transcodes
  with ffmpeg (`libmp3lame`) when they ask for something the file is not.
  `format=raw` and a format equal to the file's suffix never transcode, and
  `maxBitRate` only transcodes when the file's bitrate is above the cap.
- Transcoded responses are chunked MP3 (`audio/mpeg`, `Accept-Ranges: none`);
  HEAD returns the same headers without a body. If ffmpeg is missing the
  original bytes are served instead of failing.
- `download` always returns the original file (`format`/`maxBitRate` ignored).
- Range handling: a malformed or multi-range header is ignored (200 + whole
  file); an unsatisfiable range returns 416 with `Content-Range: bytes */<size>`.
- Online songs can also be transcoded: the resolved remote stream is piped into
  ffmpeg instead of being relayed.
- Cache maintenance: every scan deletes cover files for albums that no longer
  exist and stale `mobile-*.tmp` files; online thumbnails of dropped songs are
  removed when the online collection is pruned.

### Remote control (Phase 5)

- `/remote` (and `/remote/api/*`) implement login, logout, state and command.
  The page polls `/remote/api/state` every 1.5 s.
- Commands: `playpause`, `play`, `pause`, `next`, `prev`, `seek`, `volume`,
  `mute`, `like`, `unlike`, plus `playtracks` (the phone chooses what plays:
  `{tracks:[{id,…}], index}`, id = Subsonic song id). They are validated and
  forwarded over IPC (`mobile-command`) to the renderer, which owns playback; it
  applies the command and reports back through `mobile-report-remote-state`
  every second.
- `playtracks` ids are resolved in the main process (`mobile-resolve-tracks` →
  `collection.resolveQueue`) against `library.getSong` / `online.getSong`, so
  the renderer receives ordinary Riff tracks (local files by path, online songs
  by video id) and simply queues them. Ids it cannot resolve are dropped, so the
  phone's `index` is translated to the resolved queue (and moved forward to the
  next surviving song) instead of being reused unchanged.
- Auth: HTTP-only `riff_remote` cookie session (30 days, `SameSite=Strict`),
  the same username/password as Subsonic, failed-login throttling, commands
  only from the same origin, and everything refused when `remoteEnabled` is
  off. CORS stays limited to `/rest/*`.
- If the renderer has not reported for 15 s the page shows “Waiting for Riff…”
  instead of pretending to control anything.
- Navic has a native **Remote** tab (`Navic/app/src/main/kotlin/paige/navic/ui/screen/remote/`,
  client in `Navic/.../domain/repository/RemoteRepository.kt`). It logs in to
  `/remote/api/login` with the credentials Navic already stores, polls the
  snapshot and sends the same commands, so the phone does not need a browser or
  a second sign-in. The web page stays available for any other browser.
- **Choose what plays on the PC**: the Remote tab's *Play on the PC* button
  lists the phone's playlists and sends one as a `playtracks` queue, and every
  song's long-press sheet has **Play on PC** (sent through
  `rememberPlayOnPc()` in `ui/util/PlayOnPc.kt`). The request runs on
  `RemoteRepository`'s own scope (`playOnPcInBackground`), because the sheet is
  dismissed as soon as the row is tapped and would cancel a
  `rememberCoroutineScope` coroutine before the command left the phone.

### Not implemented yet

- Play queue, lyrics, artist info beyond basics.
- Editing Riff's queue, playlist cover art, or serving the remote from a
  different origin.

### Online songs (Phase 4)

- `search3` / `search2` / `search` return local matches first, then online
  YouTube and SoundCloud matches resolved by `yt-dlp` on the PC.
- YouTube results come from **YouTube Music** (InnerTube `WEB_REMIX` search,
  songs filter), the same source the desktop uses, so a search returns the
  released track rather than a video upload with a long intro; results carry
  the real artist, album and square artwork. If YouTube Music is unreachable
  or rate-limits, the search falls back to a plain `ytsearch` through `yt-dlp`.
- Every online match found by search is saved in `mobile-online.json`, so it
  stays browsable in Navic like normal music (capped at 1000 songs; playlist
  tracks are pinned and never pruned). Albums and artists are derived from the
  songs themselves: a real album name groups its tracks (`Currents` by Tame
  Impala), each artist gets a page with their albums, and artist/album artwork
  comes from the songs. Tracks with no album metadata are grouped per artist
  and month under **Singles** (SoundCloud results under **SoundCloud**)
  instead of a single fake album.
- Online songs are normal Subsonic entries: `getSong`, `getAlbum`, `getArtist`,
  `getAlbumList2`, `getCoverArt` (remote thumbnail cached as
  `mobile-covers/online-<id>.img`), `stream` and `download` all work.
- `stream` / `download` resolve a remote audio URL with `yt-dlp` and relay the
  bytes (HTTP Range included) to the phone: original m4a/webm audio first,
  128 kbps MP3 as fallback, and the other provider as the last fallback.
- The relay fetches those bytes in ranged 1 MiB chunks (3 in flight): googlevideo
  throttles a single long connection to ~30 kB/s, while ranged requests reach
  1-5 MB/s, so streaming and downloading online songs is 15-70x faster. The
  transcoding path feeds ffmpeg from the same ranged body.
- Search results read like the desktop's: "Let It Happen (Official Video)" is
  stored as **Let It Happen** by **Tame Impala** (upload noise like
official video/audio/lyrics/HD is stripped, `Artist - Title` becomes the pair
  when the channel is generic or the title repeats it), and artwork is fetched
  at full size (`maxresdefault`, falling back down the size ladder) instead of
  the 120px preview. Saved songs are upgraded on load, and cached `-hq` art
  replaces the old preview-sized files.
- Navic declares exactly one launcher entry: `.MainActivity` has no
  `LAUNCHER` intent-filter of its own, only the icon aliases do (exactly one
  of them enabled), so one APK no longer shows two icons that uninstall
  together. The enabled alias follows the saved icon variant, which is why
  every variant has to look right, not just `MainActivityDefault`.
- Navic's home screen shows **For you** and **Trending now** rows above the
  existing Recent/Playlists/Artists rows. They are server-generated smart
  playlists (`collection.js`, ids `smart_*`). *For you* and *Daily Mix 1-4* are
  **recommendations, not a reshuffle of the phone's library**: `mixes.js` groups
  the played/starred artists into daily buckets and asks the desktop's own
  engine (`POST /api/vibe`, token-protected, same one behind Riff's Daily Mixes)
  for new online songs, which are adopted into the online collection (pinned for
  three days) so they stream like anything else. The day's plan is kept in
  `mobile-mixes.json`, so the mixes stay put until tomorrow, survive an offline
  desktop, and never touch the user's library. *Trending now* is the desktop's
  live feed (`/api/trending`, real YouTube Music chart data). All of them are
  rebuilt on demand (15 min / daily seed), and never sent back to the desktop
  (`snapshotForRenderer` only includes the user's own playlists).
- Lyrics are served from the files the desktop already downloaded
  (`LYRICS_DIR`/`CUSTOM_LYRICS_DIR`, keyed by `sha1(artist\0title)`). When no
  file exists yet (a song the PC never played), `lyrics.ensureLyrics()` asks the
  desktop's own provider chain (`fetchLyricsDirect`, LRCLIB first) and saves the
  result in the shared lyrics folder, so lyrics come with a phone download
  instead of an empty player. `getLyrics`
  returns plain text, `getLyricsBySongId` returns OpenSubsonic structured lines
  with millisecond timestamps. No second provider call.
- Navic refreshes metadata for rows it already stores: search results used to be
  inserted with IGNORE, so a song kept the title/artist it was first synced with.
  `SearchRepository` now updates title, artist, album, cover and duration from
  the search response without touching play counts, ratings or stars. Song rows
  also show the artist before the album (`buildSongInfoString`), falling back to
  `artistName` because this server does not send the OpenSubsonic `artists` list;
  before, every row read `YouTube •` with no artist at all.
- Resolved URLs are cached in memory for 3 hours; nothing is downloaded to disk.
- Toggle: **Settings → Phone & Navic → Online songs**. Off = local files only.

---

## 8. Library scanning

1. Source folders come only from `mobile.json → folders`.
2. Recursive walk; supported extensions: `mp3 m4a aac flac ogg oga opus wav wma
   aiff aif m4b mp4 webm`.
3. Tags via `ffprobe -show_format -show_streams` (`title`, `artist`,
   `album`, `album_artist`, `track`, `disc`, `date`, `genre`). Missing tags fall
   back to filename / parent folder.
4. Files unchanged by `mtime` + `size` are reused from the cache (incremental).
5. Albums are grouped by album artist + album name + folder; artists by name.
6. Cover art is extracted lazily with `ffmpeg` from the first song of an album,
   or taken from `cover.jpg`/`folder.jpg` in the album folder.
7. `ffprobe`/`ffmpeg` are resolved with `src/shared/platform.js`
   (`resolveBinary`); on this machine they live in
   `E:\ayman\Development\My_progicte\ME\Music_app\script\audio\bin`.
8. Scans run asynchronously; the API keeps answering with the previous index
   until the new one is ready.

---

## 9. Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Persistent config, LAN listener, Subsonic auth, handshake, settings UI, firewall helper | **Done** |
| 1 | Library index (music folder only), artists/albums/songs, search, genres, cover art, scan status UI, local `stream`/`download` with Range | **Done** |
| 2 | Robust streaming (transcoding if needed), download edge cases, cache maintenance | **Done** |
| 3 | Two-way favourites, playlists, scrobbles (`star`/`unstar`/`scrobble`, collection file) | **Done** |
| 4 | Online YouTube/SoundCloud songs resolved server-side and exposed as Subsonic entries | **Done** |
| 5 | `/remote` page: play/pause, next/prev, seek, volume, like, now playing | **Done** |
| 6 | Polish, tests, installer notes, docs | **Done** |

---

## 10. Security model

- Phone listener is **off by default**; enabling it is an explicit user action.
- Only `/rest/*`, `/remote`, `/remote/*`, `/mobile/api/status` and the landing
  page are served on the LAN port.
- Auth: Subsonic token auth (MD5 of password + salt) preferred; legacy plain
  and `enc:` passwords supported; OpenSubsonic `apiKey` supported.
- Failed logins throttled: 12 failures per minute per client IP.
- Credentials are independent from every other Riff credential and can be
  regenerated.
- **Never port-forward 6767 on the router.** For remote access use a private VPN
  such as Tailscale.
- `/remote` uses a separate HTTP-only cookie session (30 days,
  `SameSite=Strict`) with the same username/password, failed-login throttling,
  same-origin-only commands, and is refused when `remoteEnabled` is off.
- CORS headers are only sent for `/rest/*`; the remote page is same-origin.
- The desktop server (`127.0.0.1:38472`) remains localhost-only.

---

## 11. Running and testing

### Start the app

```powershell
cd "E:\ayman\Development\My_progicte\ME\Music_app\project\Riff"
npm start
```

Then **Settings → Phone & Navic → Phone access (Subsonic)** on.

### Manual checks

```powershell
# from the PC
curl "http://127.0.0.1:6767/rest/ping.view?u=riff&p=enc:<hex>&v=1.16.1&c=test&f=json"

# from the phone browser
http://<PC-LAN-IP>:6767/
http://<PC-LAN-IP>:6767/remote   # sign in, then control playback
```

Remote controls only work while Riff is open on the PC: the page relays every
command to the renderer and reports “Waiting for Riff…” when it stops hearing
from it.

### Automated tests

```powershell
node --test test/mobile.test.js test/mobile-stream.test.js test/mobile-online.test.js test/mobile-collection.test.js test/mobile-remote.test.js test/mobile-atomic-write.test.js
```

All mobile tests use a temporary data dir and a random port, so they never
touch the real library. Together they cover auth (token, `enc:`, bad password),
XML/JSON envelopes, browse endpoints, cover art, transcoding and Range edge
cases, online search/collection, two-way favourites/playlists/scrobbles and the
remote login/command API. `test/mobile-stream.test.js` uses the real ffmpeg when
it is available and skips the transcoding checks otherwise.

> Note: the full `node --test` suite still has pre-existing, unrelated failures
> in `server-search-cleanup.test.js`, `lyrics-encoding.test.js` and
> `spotify-auth.test.js`. Those suites only import `src/server/server.js` and the
> Spotify modules, none of which this project changes, so they fail independently
> of the mobile work. All `test/mobile-*.test.js` suites pass.

---

## 12. Navic setup

1. PC and phone on the same Wi-Fi.
2. Riff running, **Phone access** enabled, firewall allows the port.
3. Navic → **Servers → Add server**:
   - **Server URL:** `http://<PC-LAN-IP>:6767` (shown in Riff settings)
   - **Username / password:** shown in Riff settings
   - Defaults for everything else.
4. (Optional) In Navic's login screen tap **Scan QR code** and scan the code in
   Riff → Settings → Phone & Navic; it fills the URL, username and password.
5. Tap **Test server** in Riff if unsure.
6. Navic syncs artists/albums/songs automatically. Downloads made in Navic keep
   working when the PC is off.

Navic is built from `Navic/`; the client carries the QR-pairing and offline-keep
fixes described in §4.

---

## 13. Troubleshooting

| Symptom | Check |
|---|---|
| Phone times out | Same Wi-Fi; Riff running; phone access enabled. |
| Connection refused | Wrong port or listener stopped — use **Test server**. |
| Works on PC, not phone | Windows Firewall / network profile is Public (see `MOBILE.md`). |
| Wrong password | Re-copy credentials after **New password**; update Navic. |
| Library empty | Music folder is empty or not configured; press **Rescan library**. |
| No cover art | Files have no embedded art and no `cover.jpg`; fallback icon is used. |
| Songs missing | Unsupported extension or nested inside a skipped hidden folder. |

---

## 14. ملخص بالعربي

- الهدف: تشغيل Riff كسيرفر **Subsonic** على الشبكة المحلية حتى يتصل تطبيق
  **Navic** على الهاتف ويستعرض ويشغّل ويحمّل الأغاني، ويزامن الإعجابات
  وقوائم التشغيل، ويتحكم بتشغيل الموسيقى على الكمبيوتر.
- مصدر الموسيقى الوحيد هو مجلد
  `E:\ayman\Development\My_progicte\ME\Music_app\project\music`، وتضيف أنت
  الأغاني فيه بنفسك.
- تطبيق Navic **لا يُعدّل إطلاقاً**؛ كل العمل داخل Riff (السيرفر).
- المنفذ المطلوب 67676 غير صالح (أقصى منفذ 65535)، لذلك نستخدم **6767**.
- سيرفر الكمبيوتر الداخلي يبقى على `127.0.0.1:38472` ولا يُفتح للشبكة.
- عند إطفاء الكمبيوتر تعمل الأغاني المحمّلة مسبقاً في Navic بدون سيرفر.
- الإعدادات: **Settings → Phone & Navic**، ثم فعّل **Phone access**.
- صفحة `http://<PC-LAN-IP>:6767/remote` تتحكم بالتشغيل من الهاتف: إيقاف/تشغيل،
  التالي/السابق، التقديم، الصوت، والإعجاب. يجب أن يبقى Riff مفتوحاً على الكمبيوتر.
- لا تفتح المنفذ على الراوتر؛ للوصول من خارج المنزل استخدم VPN مثل Tailscale.

---

## 15. Performance notes

- **Startup**: `createWindow()` builds the window and calls `loadFile` first;
  `startServer`, `mobile.setDesktopPort` and `mobile.startIfEnabled` run beside
  it. `get-server-port` returns the `serverReady` promise, so the renderer asks
  for the port and waits for the listener instead of main blocking on it. The
  forced `global.gc()` trims (180 s interval, on blur/minimize/hide, and the
  server's 5 min cache timer) are gone, and `--expose-gc` is no longer passed.
- **Phone collection sync**: the renderer's 15 s heartbeat now sends only a
  fingerprint (`signature`, a rolling hash of favourites, playlists, history and
  mixes) unless something changed. `collection.syncFromRenderer` answers an
  unchanged fingerprint plus an unchanged `state.rev` with
  `{changed:false, collection:null}` — no merge walk, no snapshot, no disk write.
- **Library queries**: `buildIndexes()` also builds `songIdByPath` (normalised
  path → song id, so `songIdByPath` is O(1) instead of a full scan) and the
  normalised `songSearch` / `albumSearch` / `artistSearch` keys, so search no
  longer re-normalises the whole library per request.
- **Navic rows**: `rememberSongPlaybackState(player, song.id)`
  (`ui/util/SongPlaybackState.kt`) maps the player state to just
  `{isCurrent, isPaused}` with `distinctUntilChanged`, so song rows no longer
  recompose five times a second while the progress loop runs. Queue lookups in
  gesture callbacks read `player.uiState.value` directly.

---

## 16. Cloud account (Supabase) — playlists follow you between PCs

Signing in is optional; without it everything behaves exactly as before.

### One-time setup

1. Create a free project at supabase.com.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, press **Run**.
3. **Authentication → Providers → Email**: "Confirm email" on means one click
   in your inbox after sign-up; off means sign-in works immediately.
4. **Project Settings → API**: copy the **Project URL** and the **anon public**
   key.
5. In SOPlayer: **Settings → Account → Supabase project**, paste both, **Save**,
   then **Create account** or **Sign in**.

### What syncs

| Travels to Supabase | Stays on the PC |
| --- | --- |
| playlist names, order, description | audio files and streams |
| one row per song: its identity (`youtube:<id>`, `soundcloud:<id>`, `local:<path>`) + title/artist/album/duration/thumbnail/path | artwork blobs, downloads, caches |
| likes | Daily Mixes, playback state, file paths as identity |

The row count is tiny: 500 songs ≈ 30 KB, so a whole library is a few MB against
the free plan's 500 MB. A `local:<path>` song only plays on a machine that has
that file; elsewhere the row still shows its title and artist.

### Behaviour

- Sync runs when you sign in, when the window regains focus, every 60 s, and on
  **Sync now**; it is skipped entirely while the collection is unchanged.
- Pull → merge → push happens in one SQL transaction, so a dropped connection
  cannot leave half a library behind.
- An empty local collection only *adopts* cloud playlists — it never deletes
  them. A deletion becomes a tombstone only for a playlist that synced before
  and only while other playlists still exist locally (or right after the user
  pressed Delete on the last one).
- **Deleting really deletes.** `account-state.json` remembers `knownIds`,
  `knownItems` and `knownFavorites` — what this PC had at the last successful
  sync. A track or like that was synced and is now missing locally is treated
  as a delete and is *not* copied back from the cloud, while a track that
  only the other PC has still arrives. (Before this, removing a song from a
  playlist or unliking one was undone by the next sync.)
- Signing out keeps your local library as it is.
- Tokens are encrypted with Electron `safeStorage`
  (`%LOCALAPPDATA%\Riff\account-session.bin`); the project URL and anon key sit
  in `%LOCALAPPDATA%\Riff\account.json`. Nothing account-related goes into
  `storage.json`/`localStorage`.
- The phone is unchanged: Navic still connects to this PC as a Subsonic server
  and streams/downloads from it. The PC pushes the same collection it always
  did, now backed by your account.

### Code

`src/main/account.js` (auth + sync), `src/main/account/merge.js` (pure merge
rules), `src/main/main.js` + `src/main/preload.js` (`account-*` IPC),
`src/renderer/app.js` (`initCloudAccountSync`), `supabase/schema.sql`,
`test/account-merge.test.js`.

## In-app updates (PC)

`src/main/updater.js` asks the public GitHub API for the newest `v*` release of
`Aymansomo/SOPlayer-pc`, falling back to the quota-free `/releases/latest`
redirect if the API is rate-limited. **Check for updates** calls the `update-check`
IPC, which *returns* the decision (`available` / `latest` / `error`) to the
renderer; the renderer no longer depends solely on one-way events, so a click
always produces a card or toast. Background checks still emit events for the
automatic popup. Each check is logged as `[update] ...` in `riff.log`, which is
the first place to look if a click ever looks dead again. The asset installer
(`pickAsset` + `downloadAndInstallAsset`) downloads the matching `.exe` and runs
it silently.
