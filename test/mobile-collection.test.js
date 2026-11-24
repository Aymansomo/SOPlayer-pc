'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mobile-collection-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const config = require('../src/server/mobile/config');
const library = require('../src/server/mobile/library');
const collection = require('../src/server/mobile/collection');
const mobile = require('../src/server/mobile/index');

function writeWav(file, seconds = 0.2) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

test('playlists expose one mosaic cover id', async () => {
  const cover = require('../src/server/mobile/playlist-cover');

  assert.strictEqual(cover.coverIdFor('pl_1'), 'plcover_pl_1');
  assert.strictEqual(cover.isPlaylistCoverId('plcover_pl_1'), true);
  assert.strictEqual(cover.isPlaylistCoverId('cover-art-1'), false);
  assert.strictEqual(cover.playlistIdForCover('plcover_pl_1'), 'pl_1');

  // Unknown or foreign ids must not throw; the library cover path takes over.
  assert.strictEqual(await cover.ensureCover('plcover_missing'), null);
  assert.strictEqual(await cover.ensureCover('not-a-playlist-cover'), null);
});

test('PC playlist songs are listed on the phone without a prior search', () => {
  const playlist = {
    id: 'pl_pc_ayman',
    name: 'Ayman',
    tracks: [
      // Imported Spotify track: no video id, no URL, only metadata.
      {
        id: 'sp_hwfprme7',
        title: 'Breathe',
        artist: 'Yeat',
        platform: 'ytmusic',
        url: '',
        thumbnail: 'https://i.scdn.co/image/abc',
        duration: 171,
      },
      {
        id: 'NMRhx71bGo4',
        title: 'Let It Happen',
        artist: 'Tame Impala',
        platform: 'ytmusic',
        url: 'https://www.youtube.com/watch?v=NMRhx71bGo4',
        duration: 468,
      },
    ],
  };

  const first = collection.syncFromRenderer({ favorites: [], playlists: [playlist] });
  assert.strictEqual(first.changed, true);

  const summary = collection.playlistSummary(collection.getPlaylist('pl_pc_ayman'));
  assert.strictEqual(summary.songCount, 2, 'playlist songs must not be dropped');
  assert.deepStrictEqual(summary.entry.map((song) => song.title), ['Breathe', 'Let It Happen']);
  assert.strictEqual(summary.entry[0].artist, 'Yeat');
  assert.strictEqual(summary.entry[0].coverArt, collection.playlistSummary(collection.getPlaylist('pl_pc_ayman')).entry[0].coverArt);

  // Pushing the same PC state again is a no-op.
  assert.strictEqual(
    collection.syncFromRenderer({ favorites: [], playlists: [playlist] }).changed,
    false
  );

  // A star added on the phone must reach the PC even though the PC's own push
  // changed nothing (the renderer adopts the returned collection).
  const song = summary.entry[1];
  collection.starSong(song.id);
  const withPhoneStar = collection.syncFromRenderer({ favorites: [], playlists: [playlist] });
  assert.strictEqual(withPhoneStar.changed, true);
  assert.ok(withPhoneStar.collection.favorites.some((track) => track.title === 'Let It Happen'));

  // Smart mixes: "For you" and the Daily Mixes are built from stars and plays.
  const smart = collection.playlists().filter((pl) => pl.id.startsWith('smart_'));
  const forYou = smart.find((pl) => pl.id === 'smart_for_you');
  assert.ok(forYou, 'For you exists once something is starred');
  assert.ok(collection.playlistSummary(forYou).songCount >= 1);
  assert.ok(smart.every((pl) => pl.name !== 'Trending now'), 'no trending data in tests');

  // Generated mixes must never be pushed into the desktop's own playlists.
  const snapshotIds = collection.snapshotForRenderer().playlists.map((pl) => pl.id);
  assert.ok(!snapshotIds.some((id) => id.startsWith('smart_')));

  // Leave the store as the next test expects to find it.
  collection.unstarSong(song.id);
  collection.syncFromRenderer({ favorites: [], playlists: [] });
});

test('favourites, playlists and scrobbles sync both ways', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const musicDir = path.join(tmpDir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  const filePath = path.join(musicDir, 'Test Artist - Test Song.wav');
  writeWav(filePath);

  const cfg = config.update({
    enabled: true,
    port,
    bindHost: '127.0.0.1',
    folders: [musicDir],
  });

  await mobile.start();
  t.after(async () => {
    await mobile.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  await library.startScan();
  const song = library.allSongs()[0];
  assert.ok(song);

  // "Play on PC" keeps the phone's start position: ids the desktop cannot
  // resolve are dropped from the queue, so the index has to be translated.
  const queue = collection.resolveQueue(['missing-id', song.id, 'also-missing'], 1);
  assert.strictEqual(queue.tracks.length, 1);
  assert.strictEqual(queue.index, 0);
  assert.strictEqual(queue.tracks[0].platform, 'local');
  assert.deepStrictEqual(collection.resolveQueue([], 0), { tracks: [], index: 0 });
  assert.strictEqual(collection.resolveQueue([song.id], 7).index, 0);

  const salt = 'coll';
  const auth = `u=${cfg.username}&t=${md5(cfg.password + salt)}&s=${salt}&v=1.16.1&c=test`;
  const call = async (method, extra) => {
    const res = await get(port, `/rest/${method}.view?${auth}${extra ? `&${extra}` : ''}&f=json`);
    assert.strictEqual(res.status, 200);
    return JSON.parse(res.body)['subsonic-response'];
  };

  const localTrack = {
    id: 'renderer-local-1',
    title: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Song',
    duration: 1,
    platform: 'local',
    path: filePath,
    addedAt: 1000,
  };

  // ---- Renderer -> store ----
  const first = collection.syncFromRenderer({ favorites: [localTrack], playlists: [] });
  assert.strictEqual(first.changed, true);
  assert.strictEqual(first.collection.favorites.length, 1);
  assert.strictEqual(collection.starredSongs().length, 1, 'local path resolves to the indexed song');

  const idempotent = collection.syncFromRenderer({ favorites: [localTrack], playlists: [] });
  assert.strictEqual(idempotent.changed, false, 'unchanged state must not rewrite anything');

  // A client that has not loaded its collection yet pushes nothing. That used
  // to read as "every like was removed" and emptied the store, so it is only
  // a delete when the renderer says it is ready (see the pushes below).
  const notLoaded = collection.syncFromRenderer({ favorites: [], playlists: [] });
  assert.strictEqual(notLoaded.collection.favorites.length, 1, 'an empty push keeps the stored likes');
  assert.strictEqual(collection.starredSongs().length, 1);
  collection.syncFromRenderer({ favorites: [localTrack], playlists: [] });

  // ---- Phone -> store ----
  const starred = await call('star', `id=${song.id}`);
  assert.strictEqual(starred.status, 'ok');
  const starred2 = await call('getStarred2');
  assert.strictEqual(starred2.starred2.song.length, 1);
  assert.strictEqual(starred2.starred2.song[0].id, song.id);
  // Subsonic `starred` is a date; clients parse it, so `true` breaks them.
  assert.strictEqual(typeof starred2.starred2.song[0].starred, 'string');
  assert.ok(!Number.isNaN(Date.parse(starred2.starred2.song[0].starred)));
  const getSong = await call('getSong', `id=${song.id}`);
  assert.strictEqual(typeof getSong.song.starred, 'string');
  assert.ok(!Number.isNaN(Date.parse(getSong.song.starred)));

  // The PC adopts the phone star, so its next push contains it and a later
  // removal on the PC is detected as an unstar.
  collection.syncFromRenderer({ favorites: [localTrack], playlists: [] });
  const afterUnstar = collection.syncFromRenderer({ favorites: [], playlists: [], ready: true });
  assert.strictEqual(afterUnstar.changed, true);
  assert.strictEqual(afterUnstar.collection.favorites.length, 0);
  assert.strictEqual(collection.starredSongs().length, 0);
  const emptyStarred = await call('getStarred2');
  assert.strictEqual(emptyStarred.starred2.song.length, 0);

  // ---- Starred albums ----
  await call('star', `albumId=${song.albumId}`);
  const starredAlbums = await call('getAlbumList2', 'type=starred');
  assert.strictEqual(starredAlbums.albumList2.album.length, 1);
  assert.strictEqual(starredAlbums.albumList2.album[0].id, song.albumId);

  // ---- Renderer playlists ----
  const pushPlaylist = (id, name, tracks) => collection.syncFromRenderer({
    favorites: [],
    playlists: [{ id, name, tracks }],
  });
  const withPlaylist = pushPlaylist('pl_renderer1', 'Road trip', [localTrack]);
  assert.strictEqual(withPlaylist.changed, true);
  assert.strictEqual(withPlaylist.collection.playlists.length, 1);
  assert.strictEqual(withPlaylist.collection.playlists[0].name, 'Road trip');

  // Smart mixes ("smart_*") are generated, not user playlists.
  const userPlaylists = (res) => res.playlists.playlist.filter((pl) => !String(pl.id).startsWith('smart_'));
  const playlists = await call('getPlaylists');
  assert.strictEqual(userPlaylists(playlists).length, 1);
  assert.strictEqual(userPlaylists(playlists)[0].songCount, 1);
  const playlistDetail = await call('getPlaylist', 'id=pl_renderer1');
  assert.strictEqual(playlistDetail.playlist.entry.length, 1);
  assert.strictEqual(playlistDetail.playlist.entry[0].id, song.id);

  // ---- Phone playlist edits ----
  const created = await call('createPlaylist', `name=${encodeURIComponent('Phone list')}&songId=${song.id}`);
  const phonePlaylistId = created.playlist.id;
  assert.strictEqual(created.playlist.songCount, 1);

  await call('updateplaylist', `playlistId=${phonePlaylistId}&songIdToAdd=${song.id}`);
  const grown = await call('getPlaylist', `id=${phonePlaylistId}`);
  assert.strictEqual(grown.playlist.entry.length, 2);

  await call('updateplaylist', `playlistId=${phonePlaylistId}&songIndexToRemove=0`);
  const shrunk = await call('getPlaylist', `id=${phonePlaylistId}`);
  assert.strictEqual(shrunk.playlist.entry.length, 1);

  // The renderer sees the phone-created playlist on its next sync.
  const synced = collection.syncFromRenderer({ favorites: [], playlists: [{ id: 'pl_renderer1', name: 'Road trip', tracks: [localTrack] }] });
  const phonePlaylist = synced.collection.playlists.find((pl) => pl.id === phonePlaylistId);
  assert.ok(phonePlaylist, 'phone playlist must be visible to the renderer');
  assert.strictEqual(phonePlaylist.tracks.length, 1);

  // ---- Deletions propagate both ways ----
  await call('deleteplaylist', `id=${phonePlaylistId}`);
  const remaining = await call('getPlaylists');
  assert.strictEqual(userPlaylists(remaining).length, 1);
  assert.ok(!userPlaylists(remaining).some((pl) => pl.id === phonePlaylistId));

  const cleared = collection.syncFromRenderer({ favorites: [], playlists: [], ready: true });
  assert.strictEqual(cleared.collection.playlists.length, 0);
  await call('deleteplaylist', 'id=pl_renderer1');
  const gone = await call('getPlaylists');
  assert.strictEqual(userPlaylists(gone).length, 0);

  // ---- Scrobbles ----
  await call('scrobble', `id=${song.id}&submission=true`);
  await call('scrobble', `id=${song.id}&submission=true`);
  const played = await call('getSong', `id=${song.id}`);
  assert.strictEqual(played.song.playCount, 2);
  const frequent = await call('getAlbumList2', 'type=frequent');
  assert.strictEqual(frequent.albumList2.album.length, 1);
  assert.strictEqual(frequent.albumList2.album[0].id, song.albumId);
});
