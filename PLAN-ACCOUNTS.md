# SOPlayer accounts, login and cross-device sync — findings + plan

Status: the Supabase route (option D-S, §7) is now implemented on the PC:
`src/main/account.js`, `src/main/account/merge.js`, `supabase/schema.sql` and a
cloud card in **Settings → Account**. Phone/Navic is untouched and keeps
streaming and downloading through the PC server. See §8 for what shipped.
Scope: the Electron app in this repo (`src/`) and the bundled Navic Android client (`Navic/`).

---

## 1. Why the PC app looks empty

Evidence gathered from the code and this working copy:

| Fact | Where |
| --- | --- |
| The renderer keeps **all** personal data in `localStorage` (`devsize_playlists`, `devsize_favorites`, `devsize_history`, `riff_daily_mixes`, …) and the main process mirrors it to a JSON file called `storage.json`. | `src/renderer/app.js` (disk-storage daemon, ~line 1500), `src/main/main.js` (~line 180) |
| **Dev and packaged builds read different stores.** Running from source (`npm start`) uses `src/storage.json`; the installed app uses `%APPDATA%\Riff\storage.json`. | `src/main/main.js` – `getActiveStorageFile()` |
| This working copy's `src/storage.json` (last written **17 Nov 23:44**) has 200 keys, **0 playlists**, 9 favourites. | checked directly |
| The phone keeps its own copy in `%LOCALAPPDATA%\Riff\mobile-collection.json` and merges the PC's push every 15 s. | `src/server/mobile/collection.js` |
| That merge treats "an id you pushed before and no longer push" as a **delete** (tombstone). | `collection.js` – `previousPlaylistIds` loop |
| Phone/LAN sharing is **off by default** (`enabled: false`) and is a single shared username + generated password, no accounts. | `src/server/mobile/config.js` – `defaults()` |
| "For you" + Daily Mix cards are fetched/generated (YouTube + `riff_daily_mixes` cache), not part of the personal store — that is why they still look normal while Liked songs reads `0 songs`. | screenshot + `riff_daily_mixes` usage |

So the data is almost certainly **not deleted**, it is behind one of these:

1. **Two stores, one profile** — the playlists were written while running one build (source or installed) and you are now looking at the other. Most likely cause, because both files exist and disagree.
2. **Store reset + tombstone cascade** — a launch with an empty/copied store pushed "no playlists" to the phone, which then tombstoned them there too.
3. **Corrupt/partial `storage.json`** — the reader returns `null` on a JSON error and the app starts with defaults without telling you.

### Recovery steps (do these before building anything)

1. `%APPDATA%\Riff\storage.json` — copy it somewhere safe.
2. `src\storage.json` — already 0 playlists; keep it as the second candidate.
3. `%LOCALAPPDATA%\Riff\mobile-collection.json` — the phone-side copy (has `playlists` + `changedAt` + tombstones).
4. Open whichever file has `"devsize_playlists"` with a non-empty array and copy that value into the store the *installed* app reads (`%APPDATA%\Riff\storage.json`), or just swap the files.
5. Then add the two safety fixes in §2 before turning the phone sync back on.

---

## 2. Fixes that must land with (or before) accounts

- **One store, always.** Use `app.getPath('userData')` for both dev and packaged builds, or point dev at the same file. Right now a dev run is silently a different profile.
- **Never let an empty push delete data.** If `playlists.length === 0` while `state.pc.playlistIds` is non-empty, treat it as a reset and refuse the tombstone pass unless the client sends `allowPurge: true`.
- **Back up before first write.** Keep `storage.json.bak` (last 2 rotations) and expose "Import / restore backup" in Settings.
- **Tell the user when the store fails to parse** instead of falling back to defaults silently.

---

## 3. Target account design (Spotify-like)

### Data model (server)

- `users` — id, email, `password_hash` (argon2id or scrypt), display name, avatar, created_at.
- `devices` — id, user_id, name/OS, last_seen, revoked_at.
- `playlists` — id, user_id, name, description, cover (file key or composed 2×2), `rev`, `updated_at`, `deleted`.
- `playlist_items` — playlist_id, position, `track_key`, added_at.
- `favorites` / `history` / `play_counts` — keyed by `track_key`.
- `settings` — per-user UI prefs (theme, audio, etc.).

`track_key` is the existing canonical identity (`local:<path>`, `youtube:<id>`, `soundcloud:<id>`), reused from `collection.js` so nothing has to be re-keyed.

### Auth

- Email + password sign-up / sign-in, "forgot password" by email.
- Short-lived access token (15 min) + refresh token (30–90 days) stored per device:
  - Electron: `safeStorage` (already used in the repo) or the OS keychain.
  - Android: Keystore-backed `EncryptedSharedPreferences` / DataStore.
- Device list with "sign out that device"; required for a music app used on 2+ devices.

### Sync

- **Local stays authoritative for playback.** Both clients keep working offline; sync is a background loop.
- Push/pull with a server-assigned monotonic `rev` cursor (`GET /sync?since=rev`), not timestamps — no clock skew.
- Last-writer-wins per row (per field for playlist name/cover), tombstones with 30-day retention, revision conflicts surfaced as "keep mine / keep server".
- Cover images: upload to object storage, keep the local cache; never sync local file *paths* between devices (they don't exist on the other machine) — sync the track key and resolve locally.
- Same 15 s heartbeat idea you already have, but against the account API instead of the LAN phone server.
- **Migration:** first login uploads the existing local playlists/favourites/history as the account's initial state; a second device that logs in pulls and merges by `track_key` (duplicates collapse).

### What stays as it is

- The phone Subsonic server (`0.0.0.0:6767`) keeps serving *audio* over LAN — accounts are about the collection, not the streaming transport. Navic keeps talking Subsonic for playback; the account layer only syncs the collection.

---

## 4. Phases and effort

| Phase | Work | Estimate |
| --- | --- | --- |
| 0 | Store unification, backups, purge guard, recovery UI | 0.5–1 day |
| 1 | Account service: users, tokens, email/password, device list | 1–2 days |
| 2 | Electron: sign-in screen, secure token storage, sync loop wired into `state.playlists`/`favorites` | 1–2 days |
| 3 | Navic: sign-in screen (Compose), token storage, sync loop over the same API | 1–2 days |
| 4 | Migration + first-login upload, conflict UI, cover upload | 1–2 days |
| 5 | Password reset email, "sign out all devices", account deletion | 0.5 day |

Phase 0 alone will already stop the "my data disappeared" class of bug and can ship as 0.7.6.

---

## 5. The options

### A. Local profiles only (no cloud) — smallest
- Multiple local profiles on the PC, chosen at launch; password on the profile (PBKDF2/scrypt on `storage.json`).
- No sync beyond what the phone already does over LAN.
- Cost: nothing. Works offline. **Does not** give "same data on PC and phone anywhere".

### B. Promote the phone server to "the account server"
- Extend `mobile/auth.js` from one user to many (`users.json`), add a token endpoint, PC logs into `http://<phone>:6767`.
- Cost: nothing. Keeps all current code.
- Fails the real requirement: phone must stay awake and reachable, needs a tunnel/DDNS + TLS for use outside the house, and it is a single point of failure.

### C. Own sync service on Freebuff Sites (Cloudflare Workers + D1 + R2)
- Email/password with Better Auth (or hand-rolled argon2 + JWT), D1 for rows, R2 for covers, deployable from this repo.
- Cost: free tier is enough for personal use; ~$0 with the 6-site allowance.
- Pros: no vendor lock-in, web player possible later, I can build and deploy it end to end.
- Cons: I have to write and maintain the API + both clients; Workers compatibility means the current Node server cannot be reused as-is.

### D. Firebase Auth + Firestore — **fastest to ship**
- Email/password (and Google sign-in) out of the box, first-class Android SDK, JS SDK in Electron, built-in offline cache, free Spark tier.
- Effort roughly half of option C; no server to write.
- Cons: lock-in, 1 MiB per document (fine for one playlist per doc), egress limits, needs a Firebase project + `google-services.json`.

### E. Managed Postgres (Neon / Turso) + a small Node sync API
- Standard SQL, any client, cheap. Still needs the API + auth, i.e. option C's work with a different database.

### Recommendation
**C** if you want everything owned and deployable from this repo; **D** if you want accounts working in the shortest time with the least new code. Both need §2 and Phase 0 first, because accounts on top of a split/buggy store will just sync the wrong data faithfully.

---

## 6. Decisions needed before coding

1. Cloud account (C/D/E) or local profiles only (A/B)?
2. Email + password only, or also Google sign-in?
3. Should history / play counts / Daily Mixes sync, or only playlists + favourites?
4. Offline edits must survive: yes (assumed) — then conflicts need a rule: last-write-wins (assumed) or prompt.
5. Do you want a web player later? That rules in C.

---

## 7. Variant D-S: Supabase, metadata-only (asked 19 Nov)

Question: can the cloud hold **only playlist names and what is in them**, with each app rebuilding the playlist locally, so we never spend space on audio?

Answer: yes — and that is the correct design regardless of provider. Audio never leaves the machine. Only the *collection* is shared.

### What is stored vs what stays local

| Goes to the cloud (a few KB per playlist) | Never leaves the device |
| --- | --- |
| playlist id, name, description, order, `updated_at` | audio files / streams |
| one row per item: `track_key`, `position`, `added_at` | absolute file paths as the identity (paths are device-specific) |
| `track_key` = `youtube:<id>` / `soundcloud:<id>` / `local:<path>` | downloads, cache, waveforms |
| optional 3 tiny columns: title, artist, duration (so a row still reads correctly on a device that cannot resolve it) | full track objects, artwork blobs |
| the playlist list order + favourites + history flags | Daily Mix caches, playback state |

What the PC app then does: sign in → pull names + item keys → create/update its own playlist objects in the local store → resolve every key against what exists on that machine → play from local files / YouTube / SoundCloud exactly as today. Same code path the phone already uses in `collection.js` (`keyForTrack`, `songIdForKey`), so the identity format does not change.

### Size, against the Supabase free plan (checked 19 Nov 2026)

- Free plan: 500 MB Postgres, 1 GB file storage, 5 GB egress (+5 GB cached), 50k MAU, **2 active projects, paused after 7 days of inactivity**, no backups.
- One item row is ~50–60 B of data plus index overhead. **500 songs ≈ 30 KB. 100 playlists of 500 songs ≈ 3 MB.** Even with title/artist/duration denormalised it is ~10 MB.
- So 500 MB is not the constraint — you are using under 1% of it. The limits that actually matter for a personal music app are: the 7-day inactivity pause (a keep-alive ping or a once-a-week launch fixes it) and no automatic backups (keep the local `storage.json` as the real master copy — which is the plan anyway).
- Optional cover art at 300² webp ≈ 25 KB each → 100 playlists ≈ 3 MB against 1 GB. Safe to include, still small.

### The one real caveat: `local:` keys are not portable

A playlist of local files made on the PC syncs its names and rows fine, but `local:E:\...\song.flac` means nothing on the phone. Three ways to handle it, can be combined:

1. **Mark unavailable (simplest, recommended first).** The phone shows the playlist with N greyed rows using the denormalised title/artist. Costs zero storage, playlist still useful.
2. **Stream from the PC on LAN.** Navic already talks Subsonic to `0.0.0.0:6767`; when the PC is reachable, unresolved `local:` rows play through it. Already built, just needs wiring.
3. **Device-exclusive playlists.** A flag that keeps local-file playlists off other devices entirely.

### Why D-S instead of Firebase

Same client-only shape as D (Supabase Auth gives email+password, and PostgREST + row-level security means the clients talk to the API directly, no server to write), but it is SQL you can query, and it fits option E's data model. Cost: $0 on free tier. So "D with Supabase" is really D's speed with E's schema — a good choice if you want this route.

---

## 8. What actually shipped (Supabase, PC only)

| Piece | File |
| --- | --- |
| Merge rules, canonical keys, push payload | `src/main/account/merge.js` (pure, unit-tested) |
| Supabase Auth calls, encrypted session, pull → merge → push | `src/main/account.js` |
| IPC channels `account-status` / `-configure` / `-sign-in` / `-sign-up` / `-sign-out` / `-reset-password` / `-sync` | `src/main/main.js`, `src/main/preload.js` |
| Tables, RLS and the two SQL functions | `supabase/schema.sql` |
| Sign-in card, sync loop, applying the merged collection | `src/renderer/index.html`, `src/renderer/app.js` (`initCloudAccountSync`) |
| Merge tests | `test/account-merge.test.js` |

Setup once per Supabase project:

1. Create a project at supabase.com (free plan is far more than enough: the
   whole collection is a few MB against 500 MB).
2. SQL Editor → paste `supabase/schema.sql` → Run.
3. Authentication → Providers → Email: leaving "Confirm email" on is fine, you
   just click the link once; turning it off makes sign-up immediate.
4. Project Settings → API: copy **Project URL** and the **anon public** key.
5. SOPlayer → Settings → Account → "Supabase project" → paste both → Save →
   create an account or sign in.

Invariants kept from §2 and §7:

- Only names, ids, track keys and tiny metadata travel; audio, artwork blobs and
  downloads stay on the machine that owns them.
- An empty local collection can only **adopt** cloud playlists, never delete
  them; a delete is pushed as a tombstone only for an id that synced before and
  only while other playlists still exist locally.
- Nothing is pushed while the collection is unchanged (signature check), and the
  whole push happens in one SQL transaction.
- Signing out leaves the local library untouched.
- Tokens are encrypted with `safeStorage` in `%LOCALAPPDATA%\Riff\account-session.bin`;
  the project URL/key live in `%LOCALAPPDATA%\Riff\account.json` — never in the
  renderer store.

Known limits of this step:

- The phone is unchanged: it still gets the collection from the PC server and
  streams/downloads from it. A phone that is away from the PC keeps only what it
  already downloaded, as before.
- A playlist made of local files syncs its name and rows, but rows whose file is
  not on the new PC show without a playable source (they still keep title and
  artist).
- `local:` keys are device-specific by design (§7).
