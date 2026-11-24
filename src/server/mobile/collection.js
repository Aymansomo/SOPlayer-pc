'use strict';

/**
 * Phase 3 — two-way favourites, playlists and play counts.
 *
 * One store, two writers:
 *  - Navic (or any Subsonic client) through the `/rest/*` endpoints,
 *  - Riff's renderer, which pushes its `state.favorites` / `state.playlists`
 *    (localStorage) through the `mobile-sync-collection` IPC channel.
 *
 * Everything is keyed by a canonical track key so the two sides can talk:
 *   `local:<normalised path>`        local file
 *   `youtube:<video id>`             YouTube / YouTube Music
 *   `soundcloud:<track id>`          SoundCloud
 *   `<platform>:<id>`                anything else Riff knows about
 *
 * Deletions are tombstones (with a timestamp) instead of plain removals, so an
 * unstar on one side removes the star on the other side and does not come back
 * on the next sync. Tombstones expire after 30 days.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const { DATA_DIR } = require('../../shared/platform');
const library = require('./library');
const online = require('./online');
const trending = require('./trending');
const mixes = require('./mixes');

/**
 * This file holds the phone's favourites and playlists, i.e. account data. A dev
 * run gets its own copy: `npm start` uses a separate renderer storage, so
 * pointing it at the installed app's store made its (much smaller) collection
 * look like mass deletions and emptied the phone's library.
 */
function resolveStatePath() {
  if (process.env.RIFF_DEV_PROFILE !== '0') {
    try {
      const electron = require('electron');
      const electronApp = electron && electron.app;
      if (electronApp && !electronApp.isPackaged) {
        return path.join(electronApp.getPath('userData'), 'mobile-collection.json');
      }
    } catch (_) {}
  }
  return path.join(DATA_DIR, 'mobile-collection.json');
}

const VERSION = 1;
const STATE_PATH = resolveStatePath();
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SCROBBLE_ENTRIES = 1000;

let state = null;
let loaded = false;

// Kept in memory only: after a restart the first push is always a full one.
// `signature` is the renderer's fingerprint of what it last sent, `rev` the
// collection revision that push was applied to. Together they let an unchanged
// 15 s heartbeat cost one string instead of a full merge, snapshot and write.
const syncMemo = { signature: '', rev: -1 };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizePath(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').toLowerCase();
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex');
}

function isoDate(ms) {
  if (!ms) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return undefined;
  }
}

function emptyState() {
  return {
    version: VERSION,
    updatedAt: 0,
    starred: {},
    starredAlbums: {},
    starredArtists: {},
    playlists: {},
    scrobbles: {},
    pc: {
      favoriteKeys: [],
      playlistIds: [],
      playlistHashes: {},
      rendererHash: '',
      historySeen: {},
    },
  };
}

/** Canonical key for a song object coming from library.js / online.js. */
function keyForSong(song) {
  if (!song) return '';
  if (song.online && song.remoteId) return `${song.provider || 'youtube'}:${song.remoteId}`;
  if (song.path) return `local:${normalizePath(song.path)}`;
  if (song.id) return `song:${song.id}`;
  return '';
}

/** Canonical key for a Riff renderer track. */
function keyForTrack(track) {
  if (!track || typeof track !== 'object') return '';
  const platform = String(track.platform || '').toLowerCase();
  const id = track.id != null ? String(track.id) : '';

  if (platform === 'local' || track.path) {
    if (track.path) return `local:${normalizePath(track.path)}`;
    if (id) return `local:${id}`;
  }
  if (platform === 'soundcloud' && id) return `soundcloud:${id}`;
  if (['youtube', 'ytmusic', 'yt', ''].includes(platform) && id) return `youtube:${id}`;
  if (id) return `${platform || 'other'}:${id}`;
  if (track.url) return `url:${String(track.url).toLowerCase()}`;
  return '';
}

function splitKey(key) {
  const text = String(key || '');
  const index = text.indexOf(':');
  if (index < 0) return { kind: '', rest: text };
  return { kind: text.slice(0, index), rest: text.slice(index + 1) };
}

/** Resolve a canonical key to a song id the Subsonic API can serve. */
function songIdForKey(key) {
  const { kind, rest } = splitKey(key);
  if (!key || !kind) return '';
  if (kind === 'local') return library.songIdByPath(rest) || '';
  if (kind === 'youtube' || kind === 'soundcloud') {
    const id = online.songIdFor(kind, rest);
    return online.getSong(id) ? id : '';
  }
  if (kind === 'song') return library.getSong(rest) ? rest : '';
  return '';
}

/** Riff-shaped track object, so the renderer can adopt it as-is. */
function trackFromSong(song) {
  if (!song) return null;
  const track = {
    id: song.online ? song.remoteId || song.id : song.id,
    title: song.title || 'Unknown Title',
    artist: song.artist || 'Unknown Artist',
    album: song.album || '',
    duration: Math.round(Number(song.duration) || 0),
    platform: song.online
      ? (song.provider === 'soundcloud' ? 'soundcloud' : 'ytmusic')
      : 'local',
  };
  if (song.online && song.path) track.url = song.path;
  if (!song.online && song.path) track.path = song.path;
  return track;
}

function sanitizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const out = {};
  for (const key of ['id', 'title', 'artist', 'album', 'platform', 'url', 'path', 'thumbnail', 'tcover']) {
    if (track[key] !== undefined && track[key] !== null) out[key] = track[key];
  }
  if (Number.isFinite(Number(track.duration))) out.duration = Number(track.duration);
  return trackKeyOf(out) ? out : null;
}

function trackKeyOf(track) {
  return keyForTrack(track);
}

/**
 * Turn a Subsonic song id into the Riff-shaped track the desktop renderer
 * plays. The phone sends ids when it asks the PC to play something, so the
 * desktop resolves them against its own library and online cache.
 */
function resolveTrackById(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const song = library.getSong(key) || online.getSong(key);
  return song ? trackFromSong(song) : null;
}

function resolveTracks(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.slice(0, 500).map(resolveTrackById).filter(Boolean);
}

/**
 * Resolve a queue and keep the requested start position pointing at the same
 * song. Resolving drops ids the desktop does not know, so the phone's index
 * cannot be reused as-is: it is translated to the resolved queue here.
 *
 * @returns {{tracks: object[], index: number}}
 */
function resolveQueue(ids, startIndex) {
  const list = Array.isArray(ids) ? ids.slice(0, 500) : [];
  const wanted = Math.max(0, Math.trunc(Number(startIndex) || 0));
  const tracks = [];
  let index = -1;
  list.forEach((id, position) => {
    const track = resolveTrackById(id);
    if (!track) return;
    // The wanted song itself may be missing; start on the next one instead of
    // silently playing a different part of the queue.
    if (index < 0 && position >= wanted) index = tracks.length;
    tracks.push(track);
  });
  if (index < 0) index = Math.max(0, tracks.length - 1);
  return { tracks, index };
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

function sanitizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const out = base;

  const sanitizeMap = (input, mapper) => {
    const map = {};
    if (!input || typeof input !== 'object') return map;
    for (const [key, value] of Object.entries(input)) {
      if (!key || !value || typeof value !== 'object') continue;
      const entry = mapper(key, value);
      if (entry) map[key] = entry;
    }
    return map;
  };

  out.starred = sanitizeMap(raw.starred, (key, value) => ({
    key,
    songId: typeof value.songId === 'string' ? value.songId : '',
    track: value.track && typeof value.track === 'object' ? value.track : null,
    starredAt: Number(value.starredAt) || 0,
    origin: value.origin === 'phone' ? 'phone' : 'pc',
    deleted: !!value.deleted,
  }));

  out.starredAlbums = sanitizeMap(raw.starredAlbums, (key, value) => ({
    id: key,
    at: Number(value.at) || 0,
    deleted: !!value.deleted,
  }));

  out.starredArtists = sanitizeMap(raw.starredArtists, (key, value) => ({
    id: key,
    at: Number(value.at) || 0,
    deleted: !!value.deleted,
  }));

  out.playlists = sanitizeMap(raw.playlists, (key, value) => ({
    id: key,
    name: String(value.name || 'Playlist').slice(0, 200),
    changedAt: Number(value.changedAt) || 0,
    deleted: !!value.deleted,
    songs: Array.isArray(value.songs)
      ? value.songs
        .filter((song) => song && typeof song === 'object' && song.key)
        .map((song) => ({
          key: String(song.key),
          songId: typeof song.songId === 'string' ? song.songId : '',
          track: song.track && typeof song.track === 'object' ? song.track : null,
          addedAt: Number(song.addedAt) || 0,
        }))
      : [],
  }));

  out.scrobbles = sanitizeMap(raw.scrobbles, (key, value) => ({
    plays: Number(value.plays) || 0,
    lastPlayed: Number(value.lastPlayed) || 0,
  }));

  if (raw.pc && typeof raw.pc === 'object') {
    out.pc = {
      favoriteKeys: Array.isArray(raw.pc.favoriteKeys) ? raw.pc.favoriteKeys.filter((k) => typeof k === 'string') : [],
      playlistIds: Array.isArray(raw.pc.playlistIds) ? raw.pc.playlistIds.filter((k) => typeof k === 'string') : [],
      playlistHashes: raw.pc.playlistHashes && typeof raw.pc.playlistHashes === 'object'
        ? raw.pc.playlistHashes
        : {},
      rendererHash: typeof raw.pc.rendererHash === 'string' ? raw.pc.rendererHash : '',
      historySeen: raw.pc.historySeen && typeof raw.pc.historySeen === 'object'
        ? Object.fromEntries(
          Object.entries(raw.pc.historySeen)
            .filter(([key, at]) => key && Number(at) > 0)
            .map(([key, at]) => [key, Number(at)])
        )
        : {},
    };
  }

  out.updatedAt = Number(raw.updatedAt) || 0;
  return out;
}

function readFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!parsed || Number(parsed.version || 0) !== VERSION) return null;
    return sanitizeState(parsed);
  } catch (_) {
    return null;
  }
}

function ensureLoaded() {
  if (loaded) return state;
  state = readFromDisk() || emptyState();
  loaded = true;
  return state;
}

function writeToDisk() {
  if (!state) return;
  state.updatedAt = Date.now();
  state.rev = (Number(state.rev) || 0) + 1;
  const err = writeFileAtomic(STATE_PATH, JSON.stringify(state), 'utf8');
  if (err) {
    console.warn('[mobile] could not save collection:', err && err.message);
  }
}

/** Drop tombstones and old play counts so the file cannot grow forever. */
function prune() {
  ensureLoaded();
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const [key, entry] of Object.entries(state.starred)) {
    if (entry.deleted && entry.starredAt && entry.starredAt < cutoff) delete state.starred[key];
  }
  for (const [key, entry] of Object.entries(state.starredAlbums)) {
    if (entry.deleted && entry.at && entry.at < cutoff) delete state.starredAlbums[key];
  }
  for (const [key, entry] of Object.entries(state.starredArtists)) {
    if (entry.deleted && entry.at && entry.at < cutoff) delete state.starredArtists[key];
  }
  for (const [id, pl] of Object.entries(state.playlists)) {
    if (pl.deleted && pl.changedAt && pl.changedAt < cutoff) delete state.playlists[id];
  }

  const scrobbles = Object.entries(state.scrobbles);
  if (scrobbles.length > MAX_SCROBBLE_ENTRIES) {
    scrobbles
      .sort((a, b) => (b[1].lastPlayed || 0) - (a[1].lastPlayed || 0))
      .slice(MAX_SCROBBLE_ENTRIES)
      .forEach(([key]) => delete state.scrobbles[key]);
  }
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

function isStarredKey(key) {
  ensureLoaded();
  const entry = state.starred[key];
  return !!entry && !entry.deleted;
}

function isStarredSong(song) {
  return isStarredKey(keyForSong(song));
}

/**
 * When a song was starred, as an ISO timestamp.
 *
 * Subsonic clients (Navic included) parse `starred` as a date, not a boolean:
 * sending `true` made the whole starred response unparseable, which is why the
 * phone's Starred screen stayed empty while the PC showed the same stars.
 */
function starredAt(song) {
  ensureLoaded();
  const entry = state.starred[keyForSong(song)];
  if (!entry || entry.deleted) return null;
  return isoDate(entry.starredAt) || isoDate(Date.now());
}

function playCount(song) {
  ensureLoaded();
  const entry = state.scrobbles[keyForSong(song)];
  return entry ? Number(entry.plays) || 0 : 0;
}

function setStarred(key, options) {
  ensureLoaded();
  const opts = options || {};
  const now = Date.now();
  const existing = state.starred[key];
  const songId = opts.songId || songIdForKey(key);
  const track = opts.track || (existing && existing.track) || null;
  state.starred[key] = {
    key,
    songId,
    track,
    starredAt: now,
    origin: opts.origin === 'pc' ? 'pc' : 'phone',
    deleted: false,
  };
  prune();
  writeToDisk();
  return state.starred[key];
}

function starSong(songOrId) {
  ensureLoaded();
  const song = typeof songOrId === 'string' ? library.getSong(songOrId) : songOrId;
  if (!song) return null;
  const key = keyForSong(song);
  if (!key) return null;
  return setStarred(key, {
    songId: song.id,
    track: trackFromSong(song),
    origin: 'phone',
  });
}

function unstarSong(songOrId) {
  ensureLoaded();
  const song = typeof songOrId === 'string' ? library.getSong(songOrId) : songOrId;
  const key = song ? keyForSong(song) : (typeof songOrId === 'string' ? songOrId : '');
  if (!key) return false;
  const existing = state.starred[key];
  state.starred[key] = {
    key,
    songId: (existing && existing.songId) || '',
    track: (existing && existing.track) || null,
    starredAt: Date.now(),
    origin: 'phone',
    deleted: true,
  };
  prune();
  writeToDisk();
  return true;
}

function setStarredAlbum(albumId, deleted) {
  ensureLoaded();
  if (!albumId) return;
  state.starredAlbums[albumId] = { id: albumId, at: Date.now(), deleted: !!deleted };
  prune();
  writeToDisk();
}

function setStarredArtist(artistId, deleted) {
  ensureLoaded();
  if (!artistId) return;
  state.starredArtists[artistId] = { id: artistId, at: Date.now(), deleted: !!deleted };
  prune();
  writeToDisk();
}

/** Starred songs that the phone can actually play. */
function starredSongs() {
  ensureLoaded();
  const songs = [];
  const entries = Object.values(state.starred)
    .filter((entry) => entry && !entry.deleted)
    .sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0));
  for (const entry of entries) {
    const songId = entry.songId && library.getSong(entry.songId)
      ? entry.songId
      : songIdForKey(entry.key);
    const song = songId ? library.getSong(songId) : null;
    if (song) songs.push(song);
  }
  return songs;
}

function starredAlbumList() {
  ensureLoaded();
  return Object.values(state.starredAlbums)
    .filter((entry) => entry && !entry.deleted)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .map((entry) => library.getAlbum(entry.id))
    .filter(Boolean);
}

function starredArtistList() {
  ensureLoaded();
  return Object.values(state.starredArtists)
    .filter((entry) => entry && !entry.deleted)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .map((entry) => library.getArtist(entry.id))
    .filter(Boolean);
}

/** Albums of the most-played songs (Subsonic `getAlbumList2?type=frequent`). */
function frequentAlbums(limit) {
  ensureLoaded();
  const counts = new Map();
  for (const [key, entry] of Object.entries(state.scrobbles)) {
    const plays = Number(entry && entry.plays) || 0;
    if (!plays) continue;
    const songId = songIdForKey(key);
    const song = songId ? library.getSong(songId) : null;
    if (!song || !song.albumId) continue;
    const current = counts.get(song.albumId) || { albumId: song.albumId, plays: 0, lastPlayed: 0 };
    current.plays += plays;
    current.lastPlayed = Math.max(current.lastPlayed, Number(entry.lastPlayed) || 0);
    counts.set(song.albumId, current);
  }
  const size = Math.max(1, Math.min(Number(limit) || 20, 500));
  return Array.from(counts.values())
    .sort((a, b) => (b.plays - a.plays) || (b.lastPlayed - a.lastPlayed))
    .slice(0, size)
    .map((entry) => library.getAlbum(entry.albumId))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Scrobbles
// ---------------------------------------------------------------------------

/**
 * Record one play. `submission === false` still counts the play locally; the
 * flag is accepted for Subsonic compatibility.
 */
function scrobble(songId, at) {
  ensureLoaded();
  const song = library.getSong(songId);
  if (!song) return false;
  const key = keyForSong(song);
  if (!key) return false;
  const now = Number(at) > 0 ? Number(at) : Date.now();
  const entry = state.scrobbles[key] || { plays: 0, lastPlayed: 0 };
  entry.plays += 1;
  entry.lastPlayed = now;
  state.scrobbles[key] = entry;
  prune();
  writeToDisk();
  return true;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

function newPlaylistId() {
  return `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function playlistEntryFromSong(song) {
  const key = keyForSong(song);
  if (!key) return null;
  return {
    key,
    songId: song.id,
    track: trackFromSong(song),
    addedAt: Date.now(),
  };
}

function playlistSummary(pl) {
  const songs = playlistSongs(pl);
  const duration = songs.reduce((total, song) => total + (Number(song.duration) || 0), 0);
  return {
    id: pl.id,
    name: pl.name,
    songCount: songs.length,
    duration: Math.round(duration * 1000) / 1000,
    created: isoDate(pl.changedAt),
    changed: isoDate(pl.changedAt),
    entry: songs,
  };
}

function playlistSongs(pl) {
  if (!pl || !Array.isArray(pl.songs)) return [];
  const songs = [];
  for (const entry of pl.songs) {
    const songId = entry.songId && library.getSong(entry.songId)
      ? entry.songId
      : songIdForKey(entry.key);
    const song = songId ? library.getSong(songId) : null;
    if (song) songs.push(song);
  }
  return songs;
}

/** Playlists created by the user (on either side), without the smart ones. */
function storedPlaylists() {
  ensureLoaded();
  return Object.values(state.playlists)
    .filter((pl) => pl && !pl.deleted)
    .sort((a, b) => (b.changedAt || 0) - (a.changedAt || 0));
}

// ---------------------------------------------------------------------------
// Smart playlists: For you, Daily Mixes, Trending now
// ---------------------------------------------------------------------------
//
// Built from what the phone actually knows — play counts and stars merged from
// both sides — plus the desktop's live trending feed. They are recomputed from
// the current day, never stored, and never sent back to the desktop.

const SMART_PREFIX = 'smart_';
// PC listening history is temporary taste data, not a permanent collection.
const HISTORY_PIN_MS = 3 * 24 * 60 * 60 * 1000;
const SMART_TTL_MS = 15 * 60 * 1000;
const SMART_FOR_YOU_SIZE = 40;
const SMART_MIX_SIZE = 40;
const SMART_MIX_ARTISTS = 3;

let smartCache = { day: '', at: 0, playlists: [] };

function dayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function artistKey(value) {
  return String(value || '').trim().toLowerCase();
}

/** Deterministic shuffle, so the mixes stay put for the whole day. */
function seededOrder(list, seed) {
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) % 2147483647;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Songs with any signal at all, strongest first: plays and stars. Built from the
 * scrobble/star keys rather than the local library, because most listening
 * happens in the online collection (streamed songs never live in the library).
 */
function tasteRows() {
  ensureLoaded();
  const weights = new Map();
  const bump = (key, weight) => {
    if (!key) return;
    weights.set(key, (weights.get(key) || 0) + weight);
  };

  for (const [key, entry] of Object.entries(state.scrobbles)) {
    if (!entry || !entry.plays) continue;
    bump(key, Number(entry.plays) * 2);
  }
  for (const [key, entry] of Object.entries(state.starred)) {
    if (!entry || entry.deleted) continue;
    bump(key, 5);
  }

  const rows = [];
  for (const [key, weight] of weights) {
    const songId = songIdForKey(key);
    const song = songId ? library.getSong(songId) : null;
    if (song) rows.push({ song, weight });
  }
  return rows.sort((a, b) => b.weight - a.weight);
}

function buildForYou(rows, seed) {
  if (rows.length) {
    const pool = rows.slice(0, 60).map((row) => row.song);
    return seededOrder(pool, seed).slice(0, SMART_FOR_YOU_SIZE);
  }
  // Nothing played or starred yet: borrow the newest additions.
  if (typeof library.randomSongs === 'function') {
    return library.randomSongs({ count: SMART_FOR_YOU_SIZE }) || [];
  }
  return [];
}

/** Group the artists you listen to into up to four Daily Mixes. */
function buildDailyMixes(rows) {
  if (!rows.length) return [];

  const byArtist = new Map();
  for (const row of rows) {
    const name = String(row.song.artist || 'Unknown Artist').trim();
    const key = artistKey(name) || 'unknown';
    const entry = byArtist.get(key) || { name, weight: 0, songs: [] };
    entry.weight += row.weight;
    entry.songs.push(row.song);
    byArtist.set(key, entry);
  }

  const artists = [...byArtist.values()].sort((a, b) => b.weight - a.weight);
  const bucketCount = Math.min(4, artists.length);
  if (!bucketCount) return [];

  const buckets = Array.from({ length: bucketCount }, () => ({ artists: [], songs: [], seen: new Set() }));
  artists.forEach((artist, rank) => {
    const bucket = buckets[rank % bucketCount];
    if (bucket.artists.length >= SMART_MIX_ARTISTS) return;
    bucket.artists.push(artist.name);
    for (const song of artist.songs) {
      if (bucket.seen.has(song.id) || bucket.songs.length >= SMART_MIX_SIZE) continue;
      bucket.seen.add(song.id);
      bucket.songs.push(song);
    }
  });

  return buckets.map((bucket) => bucket.songs);
}

function smartPlaylist(id, name, songs, changedAt) {
  return {
    id,
    name,
    changedAt,
    deleted: false,
    smart: true,
    songs: songs.map(playlistEntryFromSong).filter(Boolean),
  };
}

function buildSmartPlaylists(rows, recommended) {
  const day = dayKey();
  const changedAt = Date.parse(`${day}T00:00:00`) || Date.now();
  const playlists = [];
  const rec = Array.isArray(recommended) ? recommended : [];

  if (rec.length) {
    // Recommendations from the desktop's own engine: new online music that fits
    // what you listen to, instead of another pass over songs you already have.
    for (const entry of rec) {
      playlists.push(smartPlaylist(entry.id, entry.name, entry.songs, changedAt));
    }
  } else {
    const forYou = buildForYou(rows, day);
    if (forYou.length) {
      playlists.push(smartPlaylist(`${SMART_PREFIX}for_you`, 'For you', forYou, changedAt));
    }

    buildDailyMixes(rows).forEach((songs, index) => {
      if (!songs.length) return;
      playlists.push(smartPlaylist(`${SMART_PREFIX}daily_${index + 1}`, `Daily Mix ${index + 1}`, songs, changedAt));
    });
  }

  const trendingSongs = trending.currentIds().map((id) => online.getSong(id)).filter(Boolean);
  if (trendingSongs.length) {
    playlists.push(smartPlaylist(`${SMART_PREFIX}trending`, 'Trending now', trendingSongs, Date.now()));
  }

  return playlists.filter((pl) => pl.songs.length);
}

/** Warm the desktop's trending feed in the background (never blocks a request). */
function kickTrendingRefresh(rows) {
  if (trending.currentIds().length && !trending.isStale()) return;
  const seeds = (rows || []).slice(0, 8)
    .map((row) => String(row.song.artist || '').trim())
    .filter(Boolean);
  trending.refresh([...new Set(seeds)]).catch(() => {});
}

/** No listening history yet: seed from the newest online music it knows. */
function recentOnlineRows() {
  const rows = [];
  for (const album of online.albums().slice(0, 8)) {
    for (const song of online.albumSongs(album.id).slice(0, 2)) {
      rows.push({ song, weight: 1 });
    }
  }
  return rows;
}

function smartPlaylists() {
  ensureLoaded();
  const day = dayKey();
  if (smartCache.day !== day || Date.now() - smartCache.at > SMART_TTL_MS) {
    const rows = tasteRows();
    const seeds = rows.length ? rows : recentOnlineRows();
    const recommended = mixes.currentPlaylists();
    if (mixes.isStale()) {
      // Fetching mixes is a network round trip to the desktop; never block a
      // Subsonic request on it. Drop this cache when the new mixes land.
      mixes.refreshInBackground(seeds, () => { smartCache = { day: '', at: 0, playlists: [] }; });
    }
    smartCache = { day, at: Date.now(), playlists: buildSmartPlaylists(seeds, recommended) };
    kickTrendingRefresh(seeds);
  }
  return smartCache.playlists;
}

function playlists() {
  return [...smartPlaylists(), ...storedPlaylists()];
}

function getPlaylist(id) {
  ensureLoaded();
  const key = String(id || '');
  if (key.startsWith(SMART_PREFIX)) {
    return smartPlaylists().find((pl) => pl.id === key) || null;
  }
  const pl = state.playlists[key];
  if (!pl || pl.deleted) return null;
  return pl;
}

function createPlaylist(options) {
  ensureLoaded();
  const opts = options || {};
  const name = String(opts.name || '').trim().slice(0, 200);
  if (!name) return null;
  const id = String(opts.id || '').trim() || newPlaylistId();
  const songs = [];
  for (const songId of Array.isArray(opts.songIds) ? opts.songIds : []) {
    const song = library.getSong(songId);
    const entry = song ? playlistEntryFromSong(song) : null;
    if (entry) songs.push(entry);
  }
  state.playlists[id] = {
    id,
    name,
    changedAt: Date.now(),
    deleted: false,
    songs,
  };
  prune();
  writeToDisk();
  return state.playlists[id];
}

function updatePlaylist(id, patch) {
  ensureLoaded();
  const key = String(id || '');
  // Generated playlists are rebuilt every day; editing one would be lost.
  if (key.startsWith(SMART_PREFIX)) return null;
  const pl = state.playlists[key];
  if (!pl || pl.deleted) return null;
  const options = patch || {};

  if (typeof options.name === 'string' && options.name.trim()) {
    pl.name = options.name.trim().slice(0, 200);
  }

  const removals = Array.isArray(options.removeIndexes)
    ? options.removeIndexes
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => b - a)
    : [];
  for (const index of removals) {
    if (index < pl.songs.length) pl.songs.splice(index, 1);
  }

  for (const songId of Array.isArray(options.addSongIds) ? options.addSongIds : []) {
    const song = library.getSong(songId);
    const entry = song ? playlistEntryFromSong(song) : null;
    if (entry) pl.songs.push(entry);
  }

  pl.changedAt = Date.now();
  prune();
  writeToDisk();
  return pl;
}

function deletePlaylist(id) {
  ensureLoaded();
  const pl = state.playlists[String(id || '')];
  if (!pl) return false;
  pl.deleted = true;
  pl.changedAt = Date.now();
  pl.songs = [];
  prune();
  writeToDisk();
  return true;
}

// ---------------------------------------------------------------------------
// Renderer sync (two-way merge)
// ---------------------------------------------------------------------------

function starEntryFromRenderer(track, at) {
  const key = keyForTrack(track);
  if (!key) return null;
  return {
    key,
    songId: songIdForKey(key),
    track: sanitizeTrack(track),
    starredAt: Number(at) > 0 ? Number(at) : Date.now(),
    origin: 'pc',
    deleted: false,
  };
}

function playlistEntryFromRenderer(track) {
  const key = keyForTrack(track);
  if (!key) return null;
  return {
    key,
    songId: songIdForKey(key),
    track: sanitizeTrack(track),
    addedAt: Number(track && track.addedAt) || 0,
  };
}

/**
 * A playlist shared from the PC can contain online tracks this server has never
 * seen — everything added on the desktop, including imported Spotify tracks
 * whose ids (`sp_...`) are not video ids. Adopt them into the online collection
 * so the playlist's songs can be listed, streamed and given cover art on the
 * phone instead of silently disappearing from the playlist.
 *
 * @param {object[]} playlistList renderer playlists
 */
function adoptTracks(tracks, options) {
  if (!online.isEnabled() || !Array.isArray(tracks)) return;
  const opts = options || {};
  const byProvider = new Map();
  for (const track of tracks) {
    const key = keyForTrack(track);
    if (!key) continue;
    const { kind, rest } = splitKey(key);
    if (!rest || (kind !== 'youtube' && kind !== 'soundcloud')) continue;
    if (songIdForKey(key)) continue;
    const list = byProvider.get(kind) || [];
    list.push({
      remoteId: rest,
      url: typeof track.url === 'string' ? track.url : '',
      title: String(track.title || '').slice(0, 300),
      artist: String(track.artist || '').slice(0, 200),
      album: typeof track.album === 'string' ? track.album.slice(0, 200) : '',
      duration: Number(track.duration) || 0,
      thumbnail: typeof track.thumbnail === 'string' ? track.thumbnail : '',
    });
    byProvider.set(kind, list);
  }
  for (const [kind, candidates] of byProvider) {
    online.addCandidates(kind, candidates, { pinned: !!opts.pinned, pinUntil: opts.pinUntil });
  }
}

function adoptPlaylistTracks(playlistList) {
  const tracks = [];
  for (const raw of playlistList) {
    if (raw && Array.isArray(raw.tracks)) tracks.push(...raw.tracks);
  }
  adoptTracks(tracks, { pinned: true });
}

/**
 * Merge Riff's renderer state into the store.
 *
 * @param {{favorites?:object[],playlists?:object[],history?:object[],mixes?:object}} payload
 * @returns {{changed:boolean, collection:{favorites:object[],playlists:object[]}}}
 */
function syncFromRenderer(payload) {
  ensureLoaded();
  const input = payload && typeof payload === 'object' ? payload : {};
  const signature = typeof input.signature === 'string' ? input.signature : '';

  // The renderer repeats this heartbeat every 15 s. While its fingerprint and
  // the collection revision are both unchanged there is nothing to merge and
  // nothing new for it to adopt, so skip the walk, the snapshot and the write.
  if (signature && signature === syncMemo.signature && (Number(state.rev) || 0) === syncMemo.rev) {
    return { changed: false, collection: null };
  }
  const favorites = Array.isArray(input.favorites) ? input.favorites : [];
  const incomingPlaylists = Array.isArray(input.playlists) ? input.playlists : [];
  const history = Array.isArray(input.history) ? input.history : [];
  let changed = false;
  const now = Date.now();

  // A client that has not loaded its library yet (a fresh install, a dev run
  // with its own storage) pushes an empty collection. Reading that as "every
  // favourite and playlist was deleted" tombstoned the whole store, and the
  // renderer then adopted the empty snapshot and pushed it to the account.
  // Deleting therefore needs either something in the push or a renderer that
  // says it loaded its collection (`ready`).
  const stored = Object.values(state.starred).some((entry) => entry && !entry.deleted)
    || Object.values(state.playlists).some((pl) => pl && !pl.deleted);
  const authoritative = favorites.length > 0
    || incomingPlaylists.length > 0
    || input.ready === true
    || !stored;

  // Playlist songs added on the PC must exist here before entries are built,
  // otherwise they have no song id and the phone shows an empty playlist.
  adoptPlaylistTracks(incomingPlaylists);
  // Favourites and listening history come from the PC as tracks, not songs:
  // adopt them too, or the phone cannot list them (empty "Starred") and the
  // mixes have no taste to work from.
  adoptTracks(favorites, { pinned: true });
  adoptTracks(history, { pinUntil: now + HISTORY_PIN_MS });

  // ---- favourites ----
  const incoming = new Map();
  for (const track of favorites) {
    const entry = starEntryFromRenderer(track, track && track.addedAt);
    if (entry) incoming.set(entry.key, entry);
  }

  for (const entry of incoming.values()) {
    const existing = state.starred[entry.key];
    if (!existing || existing.deleted || entry.starredAt > (existing.starredAt || 0)) {
      state.starred[entry.key] = entry;
      changed = true;
    } else if (existing.origin === 'phone') {
      // The PC adopted a phone star; keep the phone metadata but remember the
      // key as PC-known so an unstar on the desktop is detected next cycle.
      existing.track = existing.track || entry.track;
    }
  }

  // Keys the PC used to send and no longer does were unstarred on the desktop.
  if (authoritative) {
    const previousFavorites = new Set(state.pc.favoriteKeys || []);
    for (const key of previousFavorites) {
      if (incoming.has(key)) continue;
      const existing = state.starred[key];
      if (!existing || existing.deleted) continue;
      state.starred[key] = Object.assign({}, existing, {
        deleted: true,
        starredAt: now,
      });
      changed = true;
    }
    state.pc.favoriteKeys = Array.from(incoming.keys());
  }

  // ---- playlists ----
  const incomingPls = new Map();
  for (const raw of incomingPlaylists) {
    const id = String((raw && raw.id) || '').trim();
    if (!id) continue;
    const songs = (Array.isArray(raw.tracks) ? raw.tracks : [])
      .map(playlistEntryFromRenderer)
      .filter(Boolean);
    const fingerprint = hash(JSON.stringify({
      name: String((raw && raw.name) || ''),
      keys: songs.map((song) => song.key),
    }));
    incomingPls.set(id, {
      id,
      name: String((raw && raw.name) || 'Playlist').trim().slice(0, 200) || 'Playlist',
      songs,
      fingerprint,
    });
  }

  const previousHashes = state.pc.playlistHashes || {};
  for (const [id, incomingPl] of incomingPls) {
    const existing = state.playlists[id];
    const fingerprintChanged = previousHashes[id] !== incomingPl.fingerprint;
    if (!existing || existing.deleted) {
      state.playlists[id] = {
        id,
        name: incomingPl.name,
        changedAt: now,
        deleted: false,
        songs: incomingPl.songs,
      };
      changed = true;
    } else if (fingerprintChanged) {
      state.playlists[id] = {
        id,
        name: incomingPl.name,
        changedAt: now,
        deleted: false,
        songs: incomingPl.songs,
      };
      changed = true;
    }
  }

  if (authoritative) {
    const previousPlaylistIds = new Set(state.pc.playlistIds || []);
    for (const id of previousPlaylistIds) {
      if (incomingPls.has(id)) continue;
      const existing = state.playlists[id];
      if (!existing || existing.deleted) continue;
      state.playlists[id] = Object.assign({}, existing, {
        deleted: true,
        changedAt: now,
        songs: [],
      });
      changed = true;
    }

    state.pc.playlistIds = Array.from(incomingPls.keys());
    state.pc.playlistHashes = {};
    for (const [id, entry] of incomingPls) state.pc.playlistHashes[id] = entry.fingerprint;
  }

  prune();
  // The renderer only adopts the returned collection when `changed` is set,
  // which used to mean "this push changed the store" — so a star or a playlist
  // edit made on the phone never reached the PC. Compare against the snapshot
  // the renderer last received instead. `updatedAt` is excluded: it moves on
  // every write and would make each sync look like a change.
  const snapshot = snapshotForRenderer();
  const snapshotHash = hash(JSON.stringify({
    favorites: snapshot.favorites,
    playlists: snapshot.playlists,
  }));
  if (snapshotHash !== state.pc.rendererHash) {
    state.pc.rendererHash = snapshotHash;
    changed = true;
  }
  // Tell a client that arrived with nothing loaded what this store really
  // holds, so it adopts the collection instead of staying empty.
  if (!authoritative && stored) changed = true;

  // ---- play history (PC → phone) ----
  // The renderer keeps its last 100 plays with a timestamp. Each new playedAt
  // counts one play here, so `getAlbumList2?type=frequent` and the mixes follow
  // what you actually listen to on the PC, not only on the phone.
  const historySeen = {};
  let playsChanged = false;
  for (const track of history) {
    const key = keyForTrack(track);
    if (!key) continue;
    const at = Number(track.playedAt) || now;
    const seenAt = Number((state.pc.historySeen || {})[key]) || 0;
    historySeen[key] = Math.max(seenAt, at);
    if (at <= seenAt) continue;
    const entry = state.scrobbles[key] || { plays: 0, lastPlayed: 0 };
    entry.plays += 1;
    entry.lastPlayed = Math.max(Number(entry.lastPlayed) || 0, at);
    state.scrobbles[key] = entry;
    playsChanged = true;
  }
  state.pc.historySeen = historySeen;
  if (playsChanged) changed = true;

  // The PC's own Daily Mixes, so the phone shows the same mixes it generates.
  if (input.mixes && mixes.setDesktopMixes(input.mixes)) changed = true;

  if (changed) {
    // Taste, stars and mixes all feed the smart playlists; rebuild them.
    smartCache = { day: '', at: 0, playlists: [] };
    writeToDisk();
  }
  if (signature) syncMemo.signature = signature;
  syncMemo.rev = Number(state.rev) || 0;
  return { changed, collection: snapshot };
}

/** Final state in Riff's own shape, for the renderer to adopt. */
function snapshotForRenderer() {
  ensureLoaded();
  const favorites = Object.values(state.starred)
    .filter((entry) => entry && !entry.deleted)
    .sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0))
    .map((entry) => {
      const track = entry.track && keyForTrack(entry.track)
        ? Object.assign({}, entry.track)
        : trackFromSong(entry.songId ? library.getSong(entry.songId) : null);
      if (!track) return null;
      return Object.assign({ key: entry.key, addedAt: entry.starredAt || 0 }, track);
    })
    .filter(Boolean);

  // Only the user's own playlists go back to the desktop; the smart mixes are
  // generated here and would otherwise be pushed into Riff's library.
  const playlistList = storedPlaylists().map((pl) => ({
    id: pl.id,
    name: pl.name,
    changedAt: pl.changedAt,
    tracks: pl.songs
      .map((entry) => {
        const track = entry.track && keyForTrack(entry.track)
          ? Object.assign({}, entry.track)
          : trackFromSong(entry.songId ? library.getSong(entry.songId) : null);
        if (!track) return null;
        return Object.assign({ key: entry.key, addedAt: entry.addedAt || 0 }, track);
      })
      .filter(Boolean),
  }));

  return { favorites, playlists: playlistList, updatedAt: state.updatedAt };
}

function status() {
  ensureLoaded();
  return {
    favorites: Object.values(state.starred).filter((entry) => entry && !entry.deleted).length,
    playlists: playlists().length,
    scrobbles: Object.keys(state.scrobbles).length,
    updatedAt: state.updatedAt ? isoDate(state.updatedAt) : null,
  };
}

module.exports = {
  STATE_PATH,
  keyForSong,
  keyForTrack,
  isStarredSong,
  playCount,
  starSong,
  unstarSong,
  setStarredAlbum,
  setStarredArtist,
  starredSongs,
  starredAt,
  starredAlbumList,
  starredArtistList,
  frequentAlbums,
  scrobble,
  playlists,
  getPlaylist,
  playlistSummary,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  syncFromRenderer,
  snapshotForRenderer,
  resolveTracks,
  resolveQueue,
  status,
};
