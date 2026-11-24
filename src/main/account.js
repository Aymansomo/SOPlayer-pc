'use strict';

/**
 * SOPlayer cloud account: Supabase Auth (email + password) plus the
 * `sync_music_collection` function, called straight from this process.
 *
 * Only the collection travels: playlist names, their track identities and the
 * likes. Audio, artwork blobs and local paths-as-identity never leave the PC.
 * Tokens live encrypted in the app's data folder, never in the renderer store.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { DATA_DIR } = require('../shared/platform');
const merge = require('./account/merge');

// A dev run (npm start) keeps its account files in its own Electron profile
// (%APPDATA%\Riff Dev on Windows) instead of the shared data folder. Before
// this, dev read the installed app's session, silently signed in as the same
// user and pushed its test playlists over the real collection, which is how
// music disappeared from the installed app on its next sync. With the split,
// dev starts signed out and a test account can never reach the real one.
const DEV_PROFILE = !app.isPackaged && process.env.RIFF_DEV_PROFILE !== '0';
const ACCOUNT_DIR = DEV_PROFILE ? app.getPath('userData') : DATA_DIR;

const CONFIG_FILE = path.join(ACCOUNT_DIR, 'account.json');
const SESSION_FILE = path.join(ACCOUNT_DIR, 'account-session.bin');
const STATE_FILE = path.join(ACCOUNT_DIR, 'account-state.json');

// Personal project, hard-coded on request so the Settings → Account fields do
// not have to be filled in on every machine/reinstall. The anon key is public
// by design; RLS is what protects the data.
const HARDCODED_URL = 'https://tguvcgqfxlwyqqpiguqr.supabase.co';
const HARDCODED_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRndXZjZ3FmeGx3eXFxcGlndXFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxMDk3OTQsImV4cCI6MjExMDY4NTc5NH0.bSU0bpq1S_7m7AQpLEJzdPGlzPvn37UxcgAvTsltyE8';

const FALLBACK_URL = process.env.SOPlayer_SUPABASE_URL || process.env.RIFF_SUPABASE_URL || HARDCODED_URL;
const FALLBACK_KEY = process.env.SOPlayer_SUPABASE_ANON_KEY || process.env.RIFF_SUPABASE_ANON_KEY || HARDCODED_KEY;

let config = null;
let session = null;
let state = null;
let syncing = false;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || null;
  } catch (_) {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

function normaliseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function loadConfig() {
  if (config) return config;
  const stored = readJson(CONFIG_FILE) || {};
  config = {
    url: normaliseUrl(stored.url || FALLBACK_URL),
    key: String(stored.key || FALLBACK_KEY || '').trim(),
  };
  return config;
}

function loadState() {
  if (state) return state;
  const stored = readJson(STATE_FILE) || {};
  const knownItems = {};
  if (stored.knownItems && typeof stored.knownItems === 'object') {
    for (const [id, keys] of Object.entries(stored.knownItems)) {
      if (Array.isArray(keys)) knownItems[id] = keys.map(String);
    }
  }
  state = {
    knownIds: Array.isArray(stored.knownIds) ? stored.knownIds.map(String) : [],
    // Per-playlist item keys and favourite keys as of the last successful sync.
    // Without them a track removed locally looks like a track the cloud should
    // copy back in, and "remove from playlist" undoes itself.
    knownItems,
    knownFavorites: Array.isArray(stored.knownFavorites) ? stored.knownFavorites.map(String) : [],
    // Kept so Settings can still show the last sync time and error after a restart.
    lastSyncAt: Number(stored.lastSyncAt) || 0,
    lastError: String(stored.lastError || ''),
  };
  return state;
}

function saveState() {
  if (!state) return;
  writeJson(STATE_FILE, state);
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function loadSession() {
  if (session) return session;
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE);
    const json = encryptionAvailable() && raw.subarray(0, 4).toString('latin1') !== 'PLAI'
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const parsed = JSON.parse(json);
    session = parsed && parsed.accessToken ? parsed : null;
  } catch (_) {
    session = null;
  }
  return session;
}

function saveSession(next) {
  session = next || null;
  try {
    if (!session) {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      return;
    }
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const json = JSON.stringify(session);
    if (encryptionAvailable()) {
      fs.writeFileSync(SESSION_FILE, safeStorage.encryptString(json));
    } else {
      // No keychain on this machine (rare, mostly Linux without a secret
      // service): keep the file readable but only by this user account.
      fs.writeFileSync(SESSION_FILE, `PLAI${json}`, { mode: 0o600 });
    }
  } catch (_) {}
}

function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.url && cfg.key);
}

function isSignedIn() {
  const s = loadSession();
  return !!(s && s.accessToken && s.refreshToken);
}

function describeError(status, body, fallback) {
  const text = (body && (body.msg || body.message || body.error_description || body.error)) || '';
  if (text) {
    if (/invalid login credentials/i.test(text)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(text)) return 'Confirm your email first — check your inbox.';
    if (/user already registered/i.test(text)) return 'That email already has an account. Sign in instead.';
    if (/rate limit|too many requests/i.test(text)) return 'Too many attempts. Wait a minute and try again.';
    if (/function .* does not exist/i.test(text)) return 'The sync function is missing — run supabase/schema.sql in the Supabase SQL editor.';
    if (/relation .* does not exist/i.test(text)) return 'The sync tables are missing — run supabase/schema.sql in the Supabase SQL editor.';
    if (/permission denied/i.test(text)) return 'Supabase table permissions are missing — run supabase/schema.sql again in the SQL Editor.';
    return String(text).slice(0, 300);
  }
  return `${fallback} (HTTP ${status})`;
}

async function request(pathname, options) {
  const cfg = loadConfig();
  if (!cfg.url || !cfg.key) {
    return { ok: false, error: 'Add your Supabase project URL and anon key first.', status: 0, data: null };
  }
  const opts = options || {};
  const headers = Object.assign(
    { apikey: cfg.key, 'Content-Type': 'application/json' },
    opts.headers || {}
  );
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  let res;
  try {
    res = await fetch(`${cfg.url}${pathname}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    return { ok: false, error: `Cannot reach Supabase: ${(err && err.message) || 'network error'}`, status: 0, data: null };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text ? { message: text } : null;
  }
  if (!res.ok) {
    return { ok: false, error: describeError(res.status, data, 'Request failed'), status: res.status, data };
  }
  return { ok: true, status: res.status, data };
}

function adoptSession(data) {
  if (!data || !data.access_token) return null;
  const expiresIn = Number(data.expires_in) || 3600;
  const next = {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token || (session && session.refreshToken) || ''),
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    userId: String((data.user && data.user.id) || (session && session.userId) || ''),
    email: String((data.user && data.user.email) || (session && session.email) || ''),
  };
  saveSession(next);
  return next;
}

async function ensureFreshSession() {
  const current = loadSession();
  if (!current) return null;
  if (Date.now() < current.expiresAt) return current;
  if (!current.refreshToken) {
    saveSession(null);
    return null;
  }
  const res = await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: current.refreshToken },
  });
  if (!res.ok) {
    saveSession(null);
    return null;
  }
  return adoptSession(Object.assign({}, res.data, { refresh_token: (res.data && res.data.refresh_token) || current.refreshToken }));
}

function status() {
  const cfg = loadConfig();
  const current = loadSession();
  return {
    configured: !!(cfg.url && cfg.key),
    url: cfg.url || '',
    hasKey: !!cfg.key,
    signedIn: !!(current && current.accessToken),
    email: (current && current.email) || '',
    userId: (current && current.userId) || '',
    syncing,
    lastSyncAt: loadState().lastSyncAt || 0,
    lastError: loadState().lastError || '',
  };
}

function configure(patch) {
  const cfg = loadConfig();
  const next = {
    url: normaliseUrl(patch && patch.url !== undefined ? patch.url : cfg.url),
    key: String(patch && patch.key !== undefined ? patch.key : cfg.key || '').trim(),
  };
  config = next;
  writeJson(CONFIG_FILE, next);
  return status();
}

async function signIn(email, password) {
  if (!isConfigured()) return { ok: false, error: 'Add your Supabase project URL and anon key first.', status: status() };
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !password) return { ok: false, error: 'Enter your email and password.', status: status() };
  const res = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: cleanEmail, password: String(password) },
  });
  if (!res.ok) return { ok: false, error: res.error, status: status() };
  adoptSession(res.data);
  const st = status();
  st.lastError = '';
  return { ok: true, status: st };
}

async function signUp(email, password) {
  if (!isConfigured()) return { ok: false, error: 'Add your Supabase project URL and anon key first.', status: status() };
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !password) return { ok: false, error: 'Enter your email and a password.', status: status() };
  if (String(password).length < 6) return { ok: false, error: 'Use a password with at least 6 characters.', status: status() };
  const res = await request('/auth/v1/signup', { method: 'POST', body: { email: cleanEmail, password: String(password) } });
  if (!res.ok) return { ok: false, error: res.error, status: status() };
  if (res.data && res.data.access_token) {
    adoptSession(res.data);
    return { ok: true, needsConfirmation: false, status: status() };
  }
  return {
    ok: true,
    needsConfirmation: true,
    message: 'Account created. Confirm it from the email Supabase sent you, then sign in.',
    status: status(),
  };
}

async function signOut() {
  const current = loadSession();
  if (current) {
    const fresh = await ensureFreshSession().catch(() => null);
    const token = (fresh && fresh.accessToken) || current.accessToken;
    await request('/auth/v1/logout', { method: 'POST', accessToken: token, body: {} }).catch(() => null);
  }
  saveSession(null);
  return status();
}

async function resetPassword(email) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) return { ok: false, error: 'Enter your email first.' };
  if (!isConfigured()) return { ok: false, error: 'Add your Supabase project URL and anon key first.' };
  const res = await request('/auth/v1/recover', { method: 'POST', body: { email: cleanEmail } });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, message: 'Reset link sent. Check your email.' };
}

async function rpc(name, args) {
  const fresh = await ensureFreshSession();
  if (!fresh) return { ok: false, error: 'Sign in first.', status: 0, data: null };
  return request(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    accessToken: fresh.accessToken,
    body: args || {},
  });
}

/**
 * Pull the cloud copy, fold it into the local one, push the result back, and
 * hand the renderer the collection it should hold.
 */
async function sync(payload) {
  if (!isConfigured()) return { ok: false, error: 'Cloud sync is not set up yet.' };
  if (!isSignedIn()) return { ok: false, error: 'Sign in first.' };
  if (syncing) return { ok: false, error: 'A sync is already running.', busy: true };

  syncing = true;
  const localState = loadState();
  try {
    const pulled = await rpc('read_music_collection');
    if (!pulled.ok) {
      localState.lastError = pulled.error;
      saveState();
      return { ok: false, error: pulled.error };
    }

    const local = {
      playlists: Array.isArray(payload && payload.playlists) ? payload.playlists : [],
      favorites: Array.isArray(payload && payload.favorites) ? payload.favorites : [],
    };
    const merged = merge.mergeCollections(local, pulled.data || {}, {
      knownIds: localState.knownIds,
      knownItems: localState.knownItems,
      knownFavorites: localState.knownFavorites,
      allowPurge: payload && payload.allowPurge !== false,
    });

    const pushed = await rpc('sync_music_collection', { p_payload: merge.toRemotePayload(merged) });
    if (!pushed.ok) {
      localState.lastError = pushed.error;
      saveState();
      return { ok: false, error: pushed.error };
    }

    const server = pushed.data && typeof pushed.data === 'object' ? pushed.data : null;
    const final = server
      ? merge.mergeCollections(
        { playlists: merged.playlists, favorites: merged.favorites },
        server,
        {
          knownIds: merged.knownIds,
          knownItems: merged.knownItems,
          knownFavorites: merged.knownFavorites,
          allowPurge: false,
        }
      )
      : merged;

    localState.knownIds = final.knownIds;
    localState.knownItems = final.knownItems || {};
    localState.knownFavorites = final.knownFavorites || [];
    localState.lastSyncAt = Date.now();
    localState.lastError = '';
    saveState();

    return {
      ok: true,
      playlists: final.playlists,
      favorites: final.favorites,
      removedIds: final.removedIds,
      syncedAt: localState.lastSyncAt,
    };
  } catch (err) {
    localState.lastError = (err && err.message) || String(err);
    saveState();
    return { ok: false, error: localState.lastError };
  } finally {
    syncing = false;
  }
}

function register(ipcMain) {
  const channels = [
    'account-status',
    'account-configure',
    'account-sign-in',
    'account-sign-up',
    'account-sign-out',
    'account-reset-password',
    'account-sync',
  ];
  for (const channel of channels) ipcMain.removeHandler(channel);

  ipcMain.handle('account-status', () => status());
  ipcMain.handle('account-configure', (event, patch) => configure(patch || {}));
  ipcMain.handle('account-sign-in', (event, creds) => signIn(creds && creds.email, creds && creds.password));
  ipcMain.handle('account-sign-up', (event, creds) => signUp(creds && creds.email, creds && creds.password));
  ipcMain.handle('account-sign-out', () => signOut());
  ipcMain.handle('account-reset-password', (event, email) => resetPassword(email));
  ipcMain.handle('account-sync', (event, payload) => sync(payload || {}));
}

module.exports = {
  status,
  configure,
  signIn,
  signUp,
  signOut,
  resetPassword,
  sync,
  register,
};
