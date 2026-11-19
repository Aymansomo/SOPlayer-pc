'use strict';

const test = require('node:test');
const assert = require('node:assert');
const merge = require('../src/main/account/merge');

const yt = (id, extra) => Object.assign({ id, platform: 'youtube', title: `song ${id}` }, extra || {});
const sc = (id) => ({ id, platform: 'soundcloud', title: `sc ${id}` });
const localFile = (path) => ({ id: 'f1', platform: 'local', path, title: 'file' });

test('track keys mirror the phone sync', () => {
  assert.equal(merge.trackKey(yt('abc')), 'youtube:abc');
  assert.equal(merge.trackKey(sc('42')), 'soundcloud:42');
  assert.equal(merge.trackKey(localFile('E:\\Music\\A.mp3')), 'local:e:/music/a.mp3');
  assert.equal(merge.trackKey({ url: 'https://x/y' }), 'url:https://x/y');
  assert.equal(merge.trackKey({}), '');
});

test('an empty local collection adopts the cloud instead of deleting it', () => {
  const remote = {
    playlists: [
      { clientId: 'pl_1', name: 'Mine', deleted: false, items: [{ key: 'youtube:a', position: 0 }] },
      { clientId: 'pl_2', name: 'Two', deleted: false, items: [] },
    ],
    favorites: [{ key: 'youtube:z', title: 'liked' }],
  };
  const merged = merge.mergeCollections({ playlists: [], favorites: [] }, remote, { knownIds: [] });
  assert.deepEqual(merged.playlists.map((p) => p.name), ['Mine', 'Two']);
  assert.equal(merged.playlists[0].tracks.length, 1);
  assert.equal(merged.favorites.length, 1);
  assert.deepEqual(merged.removedIds, []);
  assert.deepEqual(merged.tombstones, []);
});

test('a previously synced playlist missing locally is deleted only while others remain', () => {
  const remote = {
    playlists: [
      { clientId: 'pl_1', name: 'Kept', deleted: false, items: [] },
      { clientId: 'pl_old', name: 'Gone', deleted: false, items: [] },
    ],
    favorites: [],
  };
  const local = { playlists: [{ id: 'pl_1', name: 'Kept', tracks: [] }], favorites: [] };

  const kept = merge.mergeCollections(local, remote, { knownIds: ['pl_1', 'pl_old'] });
  assert.deepEqual(kept.playlists.map((p) => p.id), ['pl_1']);
  assert.deepEqual(kept.removedIds, ['pl_old']);

  // With every local playlist gone this looks like a reset, not a delete run.
  const reset = merge.mergeCollections({ playlists: [], favorites: [] }, remote, { knownIds: ['pl_1', 'pl_old'] });
  assert.deepEqual(reset.playlists.map((p) => p.id), ['pl_1', 'pl_old']);
  assert.deepEqual(reset.removedIds, []);
});

test('tombstones are pushed for local deletions but not for a reset', () => {
  const remote = { playlists: [{ clientId: 'pl_1', name: 'Kept', deleted: false, items: [] }], favorites: [] };
  const local = { playlists: [{ id: 'pl_1', name: 'Kept', tracks: [] }], favorites: [] };

  const normal = merge.mergeCollections(local, remote, { knownIds: ['pl_1', 'pl_gone'] });
  assert.deepEqual(normal.tombstones, ['pl_gone']);
  assert.ok(normal.knownIds.includes('pl_gone'));

  const reset = merge.mergeCollections({ playlists: [], favorites: [] }, remote, { knownIds: ['pl_gone'] });
  assert.deepEqual(reset.tombstones, []);
});

test('two devices with the same playlist keep one copy and both sets of tracks', () => {
  const local = {
    playlists: [{ id: 'pl_1', name: 'Mix', cover: 'data:image/png;base64,x', tracks: [yt('a'), yt('b')] }],
    favorites: [yt('a')],
  };
  const remote = {
    playlists: [
      { clientId: 'pl_1', name: 'Mix (old name)', deleted: false, items: [{ key: 'youtube:b' }, { key: 'youtube:c' }] },
    ],
    favorites: [{ key: 'youtube:c' }],
  };
  const merged = merge.mergeCollections(local, remote, { knownIds: ['pl_1'] });
  assert.equal(merged.playlists.length, 1);
  const pl = merged.playlists[0];
  assert.equal(pl.name, 'Mix', 'the local name wins while merging');
  assert.equal(pl.cover, 'data:image/png;base64,x', 'local-only fields survive');
  assert.deepEqual(pl.tracks.map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(merged.favorites.map((t) => t.id).sort(), ['a', 'c']);
});

test('a tombstoned cloud playlist is removed locally', () => {
  const remote = { playlists: [{ clientId: 'pl_1', deleted: true, items: [] }], favorites: [] };
  const merged = merge.mergeCollections({ playlists: [{ id: 'pl_1', name: 'Old', tracks: [] }], favorites: [] }, remote, {
    knownIds: ['pl_1'],
  });
  assert.deepEqual(merged.playlists, []);
  assert.deepEqual(merged.removedIds, ['pl_1']);
});

test('duplicate tracks collapse and the push payload carries identity fields', () => {
  const merged = {
    playlists: [
      {
        id: 'pl_1',
        name: 'Mix',
        cover: 'blob:local-art',
        tracks: [yt('a'), yt('a'), localFile('E:\\Music\\A.mp3')],
      },
    ],
    favorites: [yt('a'), yt('a')],
    tombstones: ['pl_dead', 'pl_1'],
  };
  const payload = merge.toRemotePayload(merged);
  const items = payload.playlists[0].items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.position), [0, 1]);
  assert.equal(items[1].path, 'E:\\Music\\A.mp3');
  assert.equal(payload.playlists[0].cover, '', 'non-URL covers stay local');
  assert.equal(payload.favorites.length, 1);
  assert.deepEqual(payload.playlists.map((p) => p.clientId), ['pl_1', 'pl_dead']);
  assert.equal(payload.playlists[1].deleted, true);
});

test('rows rebuild into renderer tracks without losing local paths', () => {
  const track = merge.trackFromRow({
    key: 'local:e:/music/a.mp3',
    title: 'A',
    path: 'E:\\Music\\A.mp3',
    addedAt: 1700000000000,
  });
  assert.equal(track.platform, 'local');
  assert.equal(track.path, 'E:\\Music\\A.mp3');
  assert.equal(track.addedAt, 1700000000000);
  assert.equal(merge.trackKey(track), 'local:e:/music/a.mp3');
});
