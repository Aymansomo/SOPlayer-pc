'use strict';

/**
 * LAN listener used by the Android app Navic (Subsonic protocol) and by the
 * small /remote page.
 *
 * This is deliberately a *separate* HTTP server from the desktop one in
 * ../server.js: the desktop server trusts localhost and exposes routes that
 * run yt-dlp/ffmpeg with arbitrary user URLs, so it must never be reachable
 * from the network.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const library = require('./library');
const online = require('./online');
const collection = require('./collection');
const remote = require('./remote');
const trending = require('./trending');
const mixes = require('./mixes');
const store = require('./store');
const { handleSubsonic, SERVER_VERSION } = require('./subsonic');
const { clientIp } = require('./auth');

let server = null;
let running = false;
let startedAt = 0;
let lastError = '';
let currentPort = 0;
let currentHost = '';
let trendingTimer = null;
let libraryTimer = null;
let libraryFirstScanTimer = null;

// Rescan the music folders on a timer so songs added on the PC show up in Navic
// without pressing "Rescan library". Scans reuse cached metadata for files whose
// size and mtime did not change, so an unchanged library costs one folder walk.
const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000;

const STATIC_DIR = path.join(__dirname, 'public');

function readStatic(name, contentType) {
  try {
    const body = fs.readFileSync(path.join(STATIC_DIR, name));
    return { body, contentType };
  } catch (_) {
    return null;
  }
}

function getStatus() {
  const cfg = config.get();
  return {
    enabled: !!cfg.enabled,
    running,
    port: running ? currentPort : cfg.port,
    host: running ? currentHost : cfg.bindHost,
    urls: config.lanUrls(cfg),
    username: cfg.username,
    password: cfg.password,
    apiKey: cfg.apiKey,
    remoteEnabled: !!cfg.remoteEnabled,
    startedAt,
    uptimeMs: running && startedAt ? Date.now() - startedAt : 0,
    version: SERVER_VERSION,
    library: library.getScanStatus(),
    online: online.status(),
    collection: collection.status(),
    remote: remote.statePayload(),
    error: lastError || '',
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function landingPage(status) {
  const urls = status.urls.length
    ? status.urls.map((u) => `<li><code>${u.url}</code> <span>(${u.iface})</span></li>`).join('')
    : '<li>No LAN address detected. Connect this PC to Wi‑Fi or Ethernet.</li>';
  const state = status.running
    ? `<span class="dot ok"></span> Running on port ${status.port}`
    : `<span class="dot"></span> Not running — enable “Phone access” in SOPlayer settings`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOPlayer — phone access</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:32px 20px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#101014;color:#e8e6f0;line-height:1.5}
main{max-width:560px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}
p{color:#b7b3c7}
.card{background:#191922;border:1px solid #2a2a38;border-radius:16px;padding:18px 20px;margin:18px 0}
code{background:#22222e;padding:2px 6px;border-radius:6px;font-size:13px}
ul{padding-left:18px}
li{margin:6px 0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#7a7788;margin-right:8px}
.dot.ok{background:#4ade80}
.muted{font-size:13px;color:#8a8699}
</style></head>
<body><main>
<h1>SOPlayer</h1>
<p>Subsonic / OpenSubsonic server for the Navic app.</p>
<div class="card">${state}</div>
<h2>Server addresses</h2>
<ul>${urls}</ul>
<div class="card">
  <strong>Add this server in Navic</strong>
  <p class="muted">URL, username and password are shown in SOPlayer → Settings → Phone &amp; Navic.</p>
</div>
<div class="card">
  <strong>Apps</strong>
  <p class="muted">Download or update the apps you build: <a href="/store">open the store</a>.</p>
</div>
<p class="muted">SOPlayer ${status.version || ''} · OpenSubsonic API 1.16.1</p>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

function handleRequest(req, res) {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://riff.local');
  } catch (_) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const pathname = parsed.pathname;

  try {
    if (req.method === 'OPTIONS') {
      // CORS belongs to the Subsonic API only; the remote page is same-origin.
      if (pathname === '/rest' || pathname.startsWith('/rest/')) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        });
      } else {
        res.writeHead(405, { 'Allow': 'GET, POST' });
      }
      res.end();
      return;
    }

    // ---- Subsonic API ----
    if (pathname === '/rest' || pathname.startsWith('/rest/')) {
      const method = pathname
        .replace(/^\/rest\/?/, '')
        .replace(/\.view$/i, '')
        .trim();
      if (!method) {
        const status = getStatus();
        return sendHtml(res, 200, landingPage(status));
      }
      return handleSubsonic(req, res, method, parsed.searchParams);
    }

    // ---- Remote control API (Phase 5) ----
    if (pathname.startsWith('/remote/')) {
      Promise.resolve(remote.handle(req, res, pathname))
        .then((handled) => {
          if (handled) return;
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
        })
        .catch((err) => {
          console.error('[mobile] remote request failed:', err && err.stack ? err.stack : err);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal error');
        });
      return;
    }

    if (pathname === '/mobile/api/status') {
      const status = getStatus();
      return sendJson(res, 200, {
        ok: true,
        server: 'SOPlayer',
        version: status.version,
        running: status.running,
        remoteEnabled: status.remoteEnabled,
        uptimeMs: status.uptimeMs,
      });
    }

    if (pathname === '/remote' || pathname === '/remote/') {
      const page = readStatic('remote.html', 'text/html; charset=utf-8');
      if (page) {
        res.writeHead(200, {
          'Content-Type': page.contentType,
          'Content-Length': page.body.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(page.body);
      }
      return sendHtml(res, 503, '<!doctype html><meta charset="utf-8"><p>Remote page is not available in this build.</p>');
    }

    // ---- Apps page (own installers, LAN only) ----
    if (pathname === '/store' || pathname === '/store/') {
      return sendHtml(res, 200, store.page(getStatus()));
    }

    if (pathname === '/store/catalog.json') {
      return sendJson(res, 200, store.catalog());
    }

    if (pathname.startsWith('/store/files/')) {
      let relative = '';
      try {
        relative = decodeURIComponent(pathname.slice('/store/files/'.length));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Bad request');
      }
      return store.sendFile(req, res, relative);
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendHtml(res, 200, landingPage(getStatus()));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    console.error('[mobile] request failed:', err && err.stack ? err.stack : err);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal error');
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function start() {
  if (server && running) return Promise.resolve(getStatus());

  const cfg = config.get();
  if (!cfg.port) return Promise.reject(new Error('invalid port'));

  // Load the cached index and refresh it in the background if needed.
  try { library.init(); } catch (err) {
    console.warn('[mobile] library init failed:', err && err.message);
  }

  return new Promise((resolve, reject) => {
    const instance = http.createServer(handleRequest);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      running = false;
      lastError = err && err.message ? err.message : String(err);
      try { instance.close(); } catch (_) {}
      if (server === instance) server = null;
      console.warn(`[mobile] could not start on ${cfg.bindHost}:${cfg.port} — ${lastError}`);
      reject(err);
    };

    instance.on('error', fail);
    instance.on('clientError', (err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
    });
    instance.on('listening', () => {
      if (settled) return;
      settled = true;
      server = instance;
      running = true;
      startedAt = Date.now();
      lastError = '';
      try {
        const addr = instance.address();
        currentPort = addr && typeof addr === 'object' ? addr.port : cfg.port;
      } catch (_) {
        currentPort = cfg.port;
      }
      currentHost = cfg.bindHost;
      const urls = config.lanUrls(cfg).map((u) => u.url);
      console.log(`[mobile] Subsonic server listening on ${currentHost}:${currentPort}`);
      if (urls.length) console.log(`[mobile] phone URL: ${urls[0]}`);
      startTrendingRefresh();
      startAutoScan();
      // Warm the taste mixes too; this also fills the online collection with
      // the day's recommendations before the phone asks for them.
      try { collection.playlists(); } catch (_) {}
      resolve(getStatus());
    });

    try {
      instance.listen(cfg.port, cfg.bindHost);
    } catch (err) {
      fail(err);
    }
  });
}

/** Keep "Trending now" warm from the desktop's live feed. */
function startTrendingRefresh() {
  if (trendingTimer) return;
  const tick = () => { trending.refresh().catch(() => {}); };
  tick();
  trendingTimer = setInterval(tick, 30 * 60 * 1000);
  if (trendingTimer.unref) trendingTimer.unref();
}

function stopTrendingRefresh() {
  if (!trendingTimer) return;
  clearInterval(trendingTimer);
  trendingTimer = null;
}

/** Keep the phone library index current while the listener is running. */
function startAutoScan() {
  if (libraryTimer) return;
  const tick = () => { library.startScan().catch(() => {}); };
  // Let the initial scan started at boot finish first.
  libraryFirstScanTimer = setTimeout(() => {
    libraryFirstScanTimer = null;
    if (running) tick();
  }, 10 * 1000);
  if (libraryFirstScanTimer.unref) libraryFirstScanTimer.unref();
  libraryTimer = setInterval(tick, AUTO_SCAN_INTERVAL_MS);
  if (libraryTimer.unref) libraryTimer.unref();
}

function stopAutoScan() {
  if (libraryFirstScanTimer) {
    clearTimeout(libraryFirstScanTimer);
    libraryFirstScanTimer = null;
  }
  if (!libraryTimer) return;
  clearInterval(libraryTimer);
  libraryTimer = null;
}

function stop() {
  stopTrendingRefresh();
  stopAutoScan();
  return new Promise((resolve) => {
    if (!server) {
      running = false;
      resolve(getStatus());
      return;
    }
    const instance = server;
    server = null;
    running = false;
    startedAt = 0;
    try {
      instance.close(() => resolve(getStatus()));
      // Force-close keep-alive sockets so a restart can rebind immediately.
      if (typeof instance.closeAllConnections === 'function') {
        setImmediate(() => {
          try { instance.closeAllConnections(); } catch (_) {}
        });
      }
      setTimeout(() => resolve(getStatus()), 1500).unref();
    } catch (_) {
      resolve(getStatus());
    }
  });
}

async function restart() {
  await stop();
  if (!config.get().enabled) return getStatus();
  try {
    return await start();
  } catch (err) {
    return getStatus();
  }
}

async function startIfEnabled() {
  if (!config.get().enabled) return getStatus();
  if (running) return getStatus();
  try {
    return await start();
  } catch (_) {
    return getStatus();
  }
}

/**
 * Apply a config patch and restart the listener when needed.
 */
async function applyConfig(patch) {
  const before = config.get();
  const after = config.update(patch || {});
  const needsRestart =
    before.enabled !== after.enabled ||
    before.port !== after.port ||
    before.bindHost !== after.bindHost;
  const foldersChanged =
    JSON.stringify(before.folders || []) !== JSON.stringify(after.folders || []);

  if (needsRestart) {
    await restart();
  }
  if (foldersChanged) {
    library.startScan().catch(() => {});
  }
  return getStatus();
}

module.exports = {
  start,
  stop,
  restart,
  startIfEnabled,
  applyConfig,
  getStatus,
  getConfig: () => config.publicConfig(),
  regeneratePassword: () => config.regeneratePassword(),
  setFolders: (folders) => {
    const cfg = config.setFolders(folders);
    library.startScan().catch(() => {});
    return cfg;
  },
  scanLibrary: () => library.startScan(),
  getLibraryStatus: () => library.getScanStatus(),
  // Two-way favourites / playlists with the renderer (Phase 3).
  syncCollection: (payload) => collection.syncFromRenderer(payload),
  getCollectionStatus: () => collection.status(),
  // "Trending now" and the daily mixes ask the desktop over loopback for its
  // live feed and its own recommendation engine.
  setDesktopPort: (port, token) => {
    trending.setDesktopPort(port);
    mixes.setDesktopPort(port);
    mixes.setDesktopToken(token);
  },
  // Remote control bridge (Phase 5).
  setRemoteState: (snapshot) => remote.setState(snapshot),
  // "Play this on the PC": the phone sends Subsonic ids, the desktop resolves
  // them to tracks its renderer can play. The start index is translated to the
  // resolved queue so the song the phone picked is the one that plays.
  resolveTracks: (ids, startIndex) => collection.resolveQueue(ids, startIndex),
  onRemoteCommand: (handler) => remote.setCommandHandler(handler),
  getRemoteState: () => remote.statePayload(),
  handleRequest,
  lanUrls: config.lanUrls,
};
