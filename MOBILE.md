# Riff → Phone (Navic / Subsonic)

Both apps are now branded **SOPlayer** (desktop window/tray/welcome pages and the
Android launcher label, `SOPlayer.apk`). Internal ids stay as they were, and the
Electron data folder is still `Riff`, so existing settings, logins and the
library index keep working.

Riff can act as a small **Subsonic / OpenSubsonic server** on your local network so
the Android app [Navic](https://navic.app) can browse and stream your music.

Browsing, streaming, downloads, cover art, online YouTube/SoundCloud songs,
two‑way likes/playlists and remote control all work today. See
[Roadmap](#roadmap) for what each phase added.

The full technical overview lives in [PROJECT.md](PROJECT.md).

---

## Quick start

1. Start Riff on the PC.
2. Open **Settings → Phone & Navic**.
3. Turn **Phone access (Subsonic)** on.
4. If Windows asks to allow Riff through the firewall, click **Allow**
   (or use **Add firewall rule** in the settings, which asks for administrator
   permission once).
5. Copy the **server URL**, **username** and **password** shown in the settings.
6. On the phone open Navic → **Servers → Add server**. Tap **Scan QR code** in
   Navic and scan the code in Riff → Settings → Phone & Navic to fill everything
   automatically, or paste:
   - **Server URL:** `http://192.168.x.x:6767`
   - **Username** and **password** from Riff
   - Leave the rest at default.

Tap **Test server** in Riff settings to verify the listener answers.

---

## Updating Navic without copying the APK

> Two ways to update without a cable: this ADB script, or the **My Apps** store
> app below (build → `npm run android:store`, then install/update Navic from
> inside it).

Once developer mode is on, one command builds Navic and installs it straight to
the phone — no file manager, no transfer:

```bash
npm run android:install                         # build + install over USB
npm run android:install -- --no-build           # reinstall the last build
npm run android:install -- --connect 192.168.1.42   # build + install over Wi-Fi
```

**USB (one-time setup):** on the phone open *Settings → About phone*, tap
*Build number* seven times, then in *Developer options* enable **USB debugging**
and plug the phone in; accept the prompt on the phone once.

**Wi-Fi on Android 9/10 (no pairing dialog):** plug the phone in over USB once
(USB debugging enabled) and run:

```bash
npm run android:install -- --wireless
```

That runs `adb tcpip 5555`, finds the phone's Wi-Fi address and installs over
the network; later updates work the same way until the phone reboots. After a
reboot, plug in once and run `--wireless` again (or use `--connect <ip>` once
the USB connection has re-enabled it).

**Wi-Fi (one-time setup, Android 11+):** in *Developer options* enable
**Wireless debugging**. Tap *Pair device with pairing code* and run:

```bash
npm run android:install -- --pair 192.168.1.42:37123 --pair-code 123456
```

then keep using `--connect 192.168.1.42` for later updates (the pairing code
screen's port changes every time, the debug port usually stays `5555`).

If an emulator and the phone are both attached, pick one with
`--device <serial>` (`adb devices` lists the serials). The script lives at
`scripts/install-navic.js`; `--apk <path>` installs a specific file.

### My Apps — the store app on the phone

`MyApps/` is a small Android app that *is* the store: it keeps your APKs on the
phone and installs or updates them from one list, like a private Play Store.

```bash
npm run android:store          # build MyApps and install it (same ADB options)
npm run android:store -- --wireless
```

In the app:

- **+ / Add APK** picks one or more `.apk` files from the phone (Downloads, a
  USB folder, anywhere). The APK is copied into the app's private storage and
  read with `PackageManager`, so the name, icon, package and version come from
  the file itself.
- **Add from link** downloads a direct `.apk` URL (a GitHub release asset, the
  LAN page's `/store/files/...` link, anything).
- Each card shows `Not installed` / `Update available` / `Installed` by
  comparing version codes with what is on the phone, with **Install**, **Open**
  and **Remove**; older builds of the same package are kept side by side.
- First install asks once for *Install unknown apps → My Apps* permission.

Building it publishes `apps/MyApps-<version>.apk` too, so the LAN page can
hand it to a phone that does not have it yet.

### Your own app store (`/store`)

The phone listener also serves a small store page: `http://<pc-ip>:6767/store`.

- It lists every installer in `<repo>/apps` — `.apk`, `.exe`, `.msi`, `.dmg`,
  `.AppImage`, `.deb`, `.zip` — including one level of sub-folders
  (`apps/android/…`).
- Name files `App-1.2.3.apk`. The version comes from the file name, the newest
  build is the big **Download** button, and older builds sit under
  “earlier versions”.
- `npm run android:install` copies each new build there automatically as
  `apps/Navic-<version>.apk`, so “open the store on the phone” is enough to
  update after a build on the PC.
- Read-only and LAN-only: no login, no uploads, no file outside the folder is
  reachable. Downloads support HTTP Range, so a half-finished APK can resume.
- `GET /store/catalog.json` returns the same list as JSON.
- To point it at another folder, set `storeDir` in `mobile.json` (or
  `Settings → Phone & Navic` once the field is exposed there).

For updates away from home, publish the same APKs as GitHub releases (below)
and use Obtainium, or ask for the in-app updater.

### Publishing to GitHub and updating from there

`.github/workflows/android-apk.yml` builds Navic on GitHub and attaches
`Navic.apk` (+ its sha256) to a release whenever an `android-v…` tag is pushed:

```bash
git tag android-v1.0.0
git push origin android-v1.0.0
```

A `v…` tag keeps publishing the desktop installers (`.github/workflows/release.yml`).
Debug APKs are signed with the normal debug key, which is fine for sideloading;
a release build would need a keystore in repository secrets.

How the phone can pick those releases up, cheapest first:

1. **Obtainium** (no code): install [Obtainium](https://github.com/ImranR98/Obtainium),
   add the repository URL, and it watches GitHub releases and installs new
   APKs. Works on Android 9.
2. **Release link in the app** (small change): a Settings entry that opens the
   latest release page; the browser downloads and installs it.
3. **In-app updater** (already built): on launch Navic asks
   `https://api.github.com/repos/Aymansomo/SOPlayer/releases/latest` for the
   newest release, compares its `tag_name` with the installed version and, if
   it is newer, shows the release notes with an **Update** button. Tapping it
   downloads the first `.apk` asset of that release to the app cache and opens
   Android's own installer. The first time, Android asks you to allow
   *install unknown apps* for SOPlayer (Android 9 and newer); grant it and tap
   **Update** again. Checks that fail (no internet, GitHub down) are ignored,
   so the app opens normally offline. Turn it off in
   **Settings → About → Check for updates**, or use the `fdroid` flavor, which
   leaves the updater out.
4. **PC/LAN install** (already built): `npm run android:install` over USB, or
   `--wireless` on Android 9/10.

---

## Music library

Riff indexes **only the music folders listed in Settings → Phone & Navic**.
Nothing else from Riff's data folder is exposed.

- The default is the project music folder:
  `E:\ayman\Development\My_progicte\ME\Music_app\project\music`
- Add your songs there yourself, then press **Rescan library** in Riff.
- Scanning is incremental: only new or changed files are read with `ffprobe`.
- Tags (title, artist, album, track, year, genre) are used when present;
  filenames are the fallback.
- Cover art comes from the file's embedded image, or `cover.jpg` /
  `folder.jpg` in the album folder, otherwise the neutral
  `assets/cover-placeholder.png` is used.
- The cached index is `mobile-library.json`; extracted covers are in
  `mobile-covers/`.

Supported formats: `mp3`, `m4a`, `m4b`, `aac`, `flac`, `ogg`, `oga`, `opus`,
`wav`, `wma`, `aiff`, `aif`, `mp4`, `webm`.

---

## Remote control from the phone

Open `http://<PC-LAN-IP>:6767/remote` in the phone browser (or tap **Open remote
page** in Riff → Settings → Phone & Navic) and sign in with the same username
and password used for Navic:

- play / pause, previous / next
- seek bar and volume (plus mute)
- like / unlike the current song — this also updates Riff's favourites
- artwork, title, artist and album of what the PC is playing

Riff must be **open on the PC**: the page relays commands to it and shows
“Waiting for Riff…” when the renderer stops reporting. The session lasts 30
days; **Disconnect** ends it immediately. Remote control can be switched off
with `remoteEnabled` in `mobile.json`.

The same controls are also built into Navic as a **Remote** tab
(`ui/screen/remote/`). It signs in to `/remote/api` with the account Navic is
already using, so there is no second login; if the tab is hidden, turn it on in
Settings → Navigation Bar.

Besides play/pause, the tab can decide **what** the PC plays: **Play on the PC**
lists your playlists and sends the chosen one to the desktop player. Every song
also has **Play on PC** in its long-press menu, which sends just that song. The
PC has to be running SOPlayer with the phone server on, and it starts playing
right away.

---

## Favourites and playlists sync

Likes (stars) and playlists are **two-way**: what you star or add in Navic shows
up in Riff on the PC, and what you star or create in Riff shows up in Navic.

- Riff pushes its favourites and playlists to the phone server every 15 seconds
  and whenever the window regains focus; merged changes are written straight
  back into Riff.
- Unstarring on either side removes the star on the other side — deletions are
  remembered so they cannot reappear on the next sync.
- Play counts are recorded from Navic's scrobbles (`getAlbumList2?type=frequent`
  is ordered by plays).
- Playlists show a 2×2 cover made from the artwork of their first four songs,
  like the playlist cards in Riff on the PC. Long-press a playlist (or open its
  menu) on the phone to *Change cover image* from your photos; the picture is
  kept on the phone — the Subsonic API has nowhere to store a playlist cover —
  and *Reset cover image* goes back to the mosaic.
- The home screen starts with **For you** and **Trending now**. *For you* and
  **Daily Mix 1-4** are recommendations, not a re-shuffle of your own music: the
  PC's recommendation engine picks new online songs that fit the artists you
  play and star, so the mixes bring music you may like, not songs you already
  have. The day's mixes are remembered until tomorrow. *Trending now* is the
  desktop's live chart feed. All are normal playlists: tap one to see its songs
  and play them.
- Lyrics appear for any song: if Riff on the PC never fetched them, the server
  downloads them (LRCLIB) once and saves them next to the ones the PC already
  has, so downloading a song on the phone also brings its lyrics for offline.
- Your PC and phone share one library state: songs you like on the PC show up in
  Navic's **Starred**, and what you listen to on the PC counts for play counts
  and the home mixes. **Daily Mixes / For you** use the mixes Riff generated on
  the PC, so the phone shows the same lists.
- The read-only smart mixes appear only in the **For you** row on the home
  screen, not in your Playlists list.
- A download that hits a busy PC retries by itself, so you do not have to tap
  download a second time.
- **Downloaded music is never removed by a sync.** If you delete a playlist or
  its songs on the PC, the phone keeps its downloaded copy (and its album page)
  and plays it offline. Its songs stay in the playlist even when the PC no
  longer returns them, and opening a playlist the PC has deleted shows the
  saved songs instead of an error.
- Playlist songs you added only on the PC are adopted into the phone's online
  collection, so a shared playlist lists them instead of showing `0 songs`.
  Imported Spotify tracks have no video id, so the phone looks the song up on
  YouTube Music by artist and title when you play it.
- A star or playlist edit made in Navic reaches the PC on its next sync, even
  though the PC itself pushed nothing new.
- If you have phone access turned off, nothing is sent to the phone; Riff's own
  likes stay exactly as they are.

---

## Streaming quality and transcoding

Navic normally streams the original file. If your phone cannot play a format
(for example FLAC) or you want to save bandwidth, Riff transcodes to MP3 with
ffmpeg on the fly:

- `maxBitRate` caps the bitrate (32–320 kbps); the file is only transcoded when
  it is above the cap.
- `format=mp3` (or any suffix different from the file's own) transcodes.
- `format=raw` always sends the original file.
- `timeOffset` starts the transcoded stream at that many seconds.
- Downloads are always the original file, never a transcode.

If ffmpeg is not installed, streaming still works — you just get the original
format. Cached covers for deleted albums and leftover temp files are cleaned up
automatically on every library rescan.

---

## Online songs (YouTube & SoundCloud)

When **Online songs** is on (Settings → Phone & Navic), a search in Navic also
searches YouTube Music and SoundCloud on the PC. YouTube Music returns the
released track (correct artist, album and artwork), not a video upload with an
intro; if it is unavailable the PC falls back to a normal YouTube search.

- Results are saved like normal music, with their real artist and album, so
  artist and album pages work and you can play them again without searching a
  second time. Songs of one album are grouped together (`Currents` by Tame
  Impala); tracks with no album are grouped per artist and month under
  **Singles** (SoundCloud under **SoundCloud**) instead of a fake album.
- Playing or downloading an online song uses the PC's internet connection and
  `yt-dlp`; the phone receives normal audio over Wi-Fi (Range requests work).
- The newest 1000 online songs are kept; older ones are dropped automatically
  (songs that belong to a synced playlist are pinned and kept).
- Nothing is written to your music folder — online songs are streamed, not
  saved. Navic's own download button keeps a copy on the phone if you want one.
- Turn the switch off to serve only your local music folders.

---

## About the port

You originally asked for **67676**, but TCP ports only go up to **65535**, so
Windows/Node cannot bind it. Riff uses **6767** instead.

To change it:

1. Close Riff.
2. Edit `mobile.json` in Riff's data folder (shown at the bottom of
   **Settings → Phone & Navic**, usually
   `%LOCALAPPDATA%\Riff\mobile.json`, or the custom data folder if you moved it).
3. Set `"port": 6767` to any free port between 1024 and 65535.
4. Start Riff again and update the URL in Navic.

If you change the port, also add a firewall rule for the new port.

---

## Where the data lives

| File / folder | Purpose |
|---|---|
| `mobile.json` | Phone-access settings, username, password, API key, music folders |
| `mobile-library.json` | Cached song / album / artist index |
| `mobile-covers/` | Extracted album covers (one JPEG per album) |
| `mobile-collection.json` | Two‑way favourites / playlists (added in a later step) |

These live in Riff's **data folder**, the same place as `metadata.json`,
`library.json`, `tracks/` and `thumbnails/`.

---

## Security model

- The phone listener is **off by default** and only starts when you enable it.
- It is a **separate HTTP server** from the desktop API. The desktop server
  (`127.0.0.1:38472`) stays bound to localhost and is never exposed.
- Only the Subsonic endpoints (`/rest/*`), the remote page (`/remote`) and a
  tiny status route are served on the LAN port.
- Credentials are independent from anything else in Riff and can be regenerated
  at any time (**New password**).
- Failed logins are throttled (12 attempts per minute per device).
- **Do not forward this port on your router.** It is intended for your home
  network only.

If you want access while away from home, use a private VPN such as
**Tailscale** instead of opening a router port.

---

## Firewall and administrator rights

Windows blocks inbound connections by default, especially when the Wi‑Fi is
classified as **Public**.

Two options:

1. **Approve the prompt** — the first time the listener starts, Windows may show
   “Allow Riff to communicate on these networks”. Tick **Private networks** and
   allow.
2. **Run the helper script as Administrator**:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\riff-mobile-firewall.ps1
   ```

   To also switch your current Wi‑Fi from Public to Private:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\riff-mobile-firewall.ps1 -SetPrivate
   ```

The **Add firewall rule** button in Settings launches the same script with a UAC
prompt, so it only works if you can approve administrator requests on your
account. The script does not need Riff to be run as administrator.

### How to check whether you are an administrator

Open PowerShell and run:

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

- `True` → your current window is elevated.
- `False` → the window is not elevated, but you may still be able to approve a
  UAC prompt. Try the **Add firewall rule** button; if UAC asks for a password
  you do not have, ask the PC owner or use the “Allow” prompt instead.

### Manual firewall command (elevated PowerShell)

```powershell
New-NetFirewallRule -DisplayName "Riff Mobile (Subsonic)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 6767 -Profile Private,Domain
```

To check the current Wi‑Fi profile:

```powershell
Get-NetConnectionProfile
```

If `NetworkCategory` is `Public`, either set it to `Private`:

```powershell
Set-NetConnectionProfile -InterfaceIndex <index> -NetworkCategory Private
```

or add `Public` to the firewall rule's `-Profile` list (less safe on shared
Wi‑Fi).

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Navic times out | PC and phone on the same Wi‑Fi; Riff running; phone access enabled |
| “Connection refused” | Wrong port or listener not running — use **Test server** in Riff |
| Works on PC but not phone | Windows Firewall rule / network profile Public (see above) |
| “Wrong username or password” | Copy credentials again; if you used **New password**, update Navic |
| Nothing happens after enabling | Look at Riff’s logs; the port may be taken by another app |
| Phone can’t see the PC after sleep | Windows may have disconnected Wi‑Fi; wake the PC and retry |
| Remote page says “Waiting for Riff…” | Riff is closed or the window never loaded; reopen Riff |
| Remote page keeps asking to sign in | The password was regenerated (**New password**); sign in again |
| Remote buttons do nothing | Riff is paused on another screen? Reopen Riff; the page needs the desktop window running |
| Navic's Remote tab says it can't reach Riff | The tab uses the saved Navic server address; check the phone is on the same Wi-Fi and `remoteEnabled` is on |
| Library is empty | Add songs to the music folder and press **Rescan library** |
| Missing songs | Unsupported extension, or the file is inside a hidden folder |
| No cover art | No embedded image and no `cover.jpg`; the neutral placeholder is used |
| Wrong duration / tags | The file has no tags; Riff falls back to the filename |

---

## Roadmap

- [x] Phase 0 — persistent config, LAN listener, Subsonic auth, `ping`,
  `getLicense`, `getMusicFolders`, `getOpenSubsonicExtensions`, settings UI,
  firewall helper
- [x] Phase 1 — music-folder library index, artists / albums / songs, genres,
  search, cover art, scan status, local `stream` + `download` with HTTP Range
- [x] Phase 2 — streaming edge cases (MP3 transcoding for `format` /
  `maxBitRate` / `timeOffset`), download safety, cache maintenance
- [x] Phase 3 — two‑way favourites, playlists, scrobbles (synced with Riff's
  own likes and playlists)
- [x] Phase 4 — online YouTube/SoundCloud songs via server-side resolve
  (search, browsable “Online” collection, relayed `stream` / `download`)
- [x] Phase 5 — `/remote` page: login, now playing, play/pause, next/prev,
  seek bar, volume/mute, like
- [x] Phase 6 — polish, automated tests (`test/mobile-*.test.js`), docs and
  installer notes

---

## باختصار بالعربي

- شغّل Riff ثم اذهب إلى **Settings → Phone & Navic** وفعّل **Phone access**.
- ضع أغانيك في مجلد
  `E:\ayman\Development\My_progicte\ME\Music_app\project\music` فقط، ثم اضغط
  **Rescan library**. لا يقوم Riff بفهرسة أي مجلد آخر.
- افتح تطبيق **Navic** في الهاتف وأضف سيرفراً جديداً بالعنوان والمستخدم وكلمة
  المرور الظاهرين في الإعدادات.
- المنفذ **67676 غير صالح** لأن أقصى رقم منفذ هو 65535، لذلك نستخدم **6767**.
- إذا لم يتصل الهاتف، اسمح لـ Riff في جدار الحماية أو شغّل
  `scripts/riff-mobile-firewall.ps1` كمسؤول.
- لا تفتح المنفذ على الراوتر؛ هذا للشبكة المحلية فقط.
