const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { log } = require('../shared/logger');

const CHECK_DELAY_MS = 1500;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function readIgnored(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version || ''; } catch (e) { return ''; }
}

function writeIgnored(file, version) {
  try { fs.writeFileSync(file, JSON.stringify({ version })); } catch (e) {}
}

function isNewer(latest, current) {
  const p1 = String(latest || '').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = String(current || '').split('.').map(n => parseInt(n, 10) || 0);
  if (p2[0] >= 40 && p1[0] < 40) return true;
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function initUpdater(getWindow) {
  const ignoreFile = path.join(app.getPath('userData'), 'ignored-update.json');
  const pkg = require('../../package.json');
  if (pkg.version && typeof app.setVersion === 'function') {
    app.setVersion(pkg.version);
  }
  // The version every comparison below is made against, even if the runtime
  // could not be told about it.
  const APP_VERSION = String(pkg.version || app.getVersion() || '0.0.0');
  // Point the updater at this fork's own releases, never at upstream Riff.
  const repoMatch = String(pkg.homepage || (pkg.repository && pkg.repository.url) || '')
    .match(/github\.com[/:]([^/]+)\/([^/.#]+)/i);
  const repo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : 'Aymansomo/SOPlayer-pc';
  const repoUrl = `https://github.com/${repo}`;
  const releasesUrl = `${repoUrl}/releases`;
  let installNow = false;
  let current = null;
  let isDownloaded = false;

  try { ipcMain.removeHandler('get-app-version'); } catch (_) {}
  ipcMain.handle('get-app-version', () => APP_VERSION);

  const isDev = !app.isPackaged;
  const canInstall = !isDev && (process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE));

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  let isDownloadingAsset = false;
  async function downloadAndInstallAsset(assetUrl, assetName, sendProgress) {
    if (isDownloadingAsset) return;
    isDownloadingAsset = true;

    const mirrors = [assetUrl, `https://ghfast.top/${assetUrl}`, `https://ghp.ci/${assetUrl}`];
    const tmpFile = path.join(os.tmpdir(), assetName);
    let downloaded = false;

    for (const url of mirrors) {
      let timer = null;
      let fileStream = null;
      const controller = new AbortController();
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          controller.abort(new Error('Download timeout/stall'));
        }, 10000);
      };

      try {
        resetTimer();
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'SOPlayer' }
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const total = parseInt(res.headers.get('content-length') || '0', 10);
        let done = 0;
        fileStream = fs.createWriteStream(tmpFile);

        for await (const chunk of res.body) {
          resetTimer();
          fileStream.write(chunk);
          done += chunk.length;
          if (total > 0 && typeof sendProgress === 'function') {
            sendProgress('update-progress', { percent: Math.round((done / total) * 100) });
          }
        }

        await new Promise((resolve, reject) => {
          fileStream.on('error', reject);
          fileStream.end(resolve);
        });
        if (timer) clearTimeout(timer);

        if (total > 0 && done < total) {
          throw new Error('Download incomplete');
        }

        downloaded = true;
        if (typeof sendProgress === 'function') {
          sendProgress('update-progress', { percent: 100 });
        }
        break;
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (fileStream) {
          try { fileStream.destroy(); } catch (_) {}
        }
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
      }
    }

    if (!downloaded) {
      isDownloadingAsset = false;
      if (typeof sendProgress === 'function') {
        sendProgress('update-error', { message: 'Download failed from all mirrors' });
      }
      return;
    }

    if (process.platform === 'linux' && process.env.APPIMAGE) {
      try {
        fs.chmodSync(tmpFile, 0o755);
        fs.copyFileSync(tmpFile, process.env.APPIMAGE);
        app.relaunch();
        app.exit(0);
      } catch (e) {
        if (typeof sendProgress === 'function') sendProgress('update-error', { message: e.message });
        isDownloadingAsset = false;
      }
      return;
    }

    if (process.platform === 'win32') {
      try {
        if (process.env.PORTABLE_EXECUTABLE_FILE) {
          const batFile = path.join(os.tmpdir(), `riff-update-${Date.now()}.bat`);
          const targetExe = process.env.PORTABLE_EXECUTABLE_FILE;
          const batContent = `@echo off\r\ntimeout /t 2 /nobreak >nul\r\ncopy /y "${tmpFile}" "${targetExe}"\r\nstart "" "${targetExe}"\r\ndel "%~f0"\r\n`;
          fs.writeFileSync(batFile, batContent);
          const child = spawn('cmd.exe', ['/c', batFile], {
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
          app.exit(0);
        } else {
          const child = spawn(tmpFile, ['/S', '--force-run'], {
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
          app.exit(0);
        }
      } catch (e) {
        if (typeof sendProgress === 'function') sendProgress('update-error', { message: e.message });
        isDownloadingAsset = false;
      }
      return;
    }
  }

  // `releases/latest` redirects straight to the newest tag. Unlike the API it has
  // no hourly quota, so it still answers when the 60-calls/hour limit is hit.
  const versionFromReleasesRedirect = async () => {
    try {
      const res = await fetch(`${repoUrl}/releases/latest`, {
        redirect: 'follow',
        headers: { 'User-Agent': 'SOPlayer' },
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) return '';
      const tag = String(res.url || '').split('/tag/')[1] || '';
      return tag.replace(/^v/i, '').trim();
    } catch (_) {
      return '';
    }
  };

  /** The release asset that matches how this build was installed. */
  function pickAsset(assets) {
    const list = Array.isArray(assets) ? assets : [];
    if (process.platform === 'win32') {
      const exes = list.filter((a) => a.name && /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name));
      const portable = exes.find((a) => /portable/i.test(a.name));
      const installer = exes.find((a) => !/portable/i.test(a.name));
      return (process.env.PORTABLE_EXECUTABLE_FILE ? portable || installer : installer || portable) || null;
    }
    if (process.platform === 'linux' && process.env.APPIMAGE) {
      return list.find((a) => a.name && /\.AppImage$/i.test(a.name)) || null;
    }
    return null;
  }

  /**
   * The one place a version is decided. Always returns a result so a manual
   * click is answered by the IPC call itself — one-way events can be missed by
   * a long-running renderer, which made "Check for updates" look like a dead
   * button. Background checks still emit events for the auto-popup.
   */
  const checkViaGithubApi = async (manual = false) => {
    log('INFO', `[update] check start manual=${manual} installed=${APP_VERSION}`);
    let json = null;
    let latestVer = '';
    let apiError = '';
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { 'User-Agent': 'SOPlayer' },
        signal: AbortSignal.timeout(6000)
      });
      log('INFO', `[update] api status=${res.status}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
      latestVer = String(json.tag_name || '').replace(/^v/i, '');
    } catch (err) {
      apiError = (err && err.message) || 'network error';
      log('ERROR', `[update] api failed: ${apiError}`);
    }

    if (!latestVer) latestVer = await versionFromReleasesRedirect();
    if (!latestVer) {
      const message = apiError === 'HTTP 403'
        ? 'GitHub rate limit reached - try again in a few minutes.'
        : `Could not reach GitHub (${apiError})`;
      log('ERROR', `[update] no version found: ${message}`);
      if (!manual) send('update-error', { message });
      return { status: 'error', message };
    }

    log('INFO', `[update] latest=${latestVer} installed=${APP_VERSION}`);
    if (!isNewer(latestVer, APP_VERSION)) {
      if (!manual) send('update-not-available', { version: APP_VERSION });
      return { status: 'latest', version: APP_VERSION };
    }

    const matchedAsset = pickAsset(json && json.assets);
    current = {
      version: latestVer,
      releaseNotes: (json && json.body) || '',
      publishedAt: (json && json.published_at) || '',
      htmlUrl: (json && json.html_url) || `${releasesUrl}/tag/v${latestVer}`,
      assetUrl: matchedAsset ? matchedAsset.browser_download_url : null,
      assetName: matchedAsset ? matchedAsset.name : null
    };
    log('INFO', `[update] available=${latestVer} asset=${matchedAsset ? matchedAsset.name : 'none'} canInstall=${canInstall && !!matchedAsset}`);
    if (!manual && readIgnored(ignoreFile) === latestVer) return { status: 'skipped' };
    const info = {
      version: current.version,
      releaseNotes: current.releaseNotes,
      publishedAt: current.publishedAt,
      htmlUrl: current.htmlUrl,
      canInstall: canInstall && !!matchedAsset,
      url: current.htmlUrl
    };
    if (!manual) send('update-available', info);
    return { status: 'available', info };
  };

  // Detection is checkViaGithubApi's job now; electron-updater is only the
  // installer for a packaged Windows/Linux build.
  let autoUpdater = null;
  if (canInstall) {
    try {
      const eu = require('electron-updater');
      autoUpdater = eu.autoUpdater;
      autoUpdater.allowDowngrade = true;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;

      autoUpdater.on('download-progress', (p) => send('update-progress', { percent: Math.round(p.percent) }));

      autoUpdater.on('update-downloaded', () => {
        isDownloaded = true;
        if (installNow) {
          autoUpdater.quitAndInstall();
        } else {
          send('update-ready', { version: current && current.version });
          send('update-downloaded', {
            version: current && current.version,
            releaseNotes: (current && current.releaseNotes) || '',
            publishedAt: (current && current.publishedAt) || '',
            htmlUrl: (current && current.htmlUrl) || '',
            canInstall: true
          });
        }
      });

      // These are install/download errors: detection has already answered, but an
      // unhandled 'error' event on the emitter would crash the process.
      autoUpdater.on('error', () => {});
    } catch (_) {
      autoUpdater = null;
    }
  }

  try { ipcMain.removeHandler('update-check'); } catch (_) {}
  ipcMain.handle('update-check', async () => {
    try {
      const result = await checkViaGithubApi(true);
      return { ok: true, result };
    } catch (err) {
      const message = (err && err.message) || 'Update check failed';
      log('ERROR', `[update] handler threw: ${message}`);
      return { ok: false, result: { status: 'error', message } };
    }
  });

  const doInstallNow = () => {
    installNow = true;
    if (isDownloaded && autoUpdater && canInstall) {
      try {
        return autoUpdater.quitAndInstall();
      } catch (_) {}
    }
    if (current && current.assetUrl) {
      downloadAndInstallAsset(current.assetUrl, current.assetName, send);
      return;
    }
    if (autoUpdater && canInstall) {
      try {
        autoUpdater.quitAndInstall();
      } catch (_) {
        autoUpdater.downloadUpdate().then(() => {
          autoUpdater.quitAndInstall();
        }).catch(() => {
          if (current && current.assetUrl) {
            downloadAndInstallAsset(current.assetUrl, current.assetName, send);
          } else {
            shell.openExternal((current && current.htmlUrl) || releasesUrl);
          }
        });
      }
    } else {
      shell.openExternal((current && current.htmlUrl) || releasesUrl);
    }
  };

  try { ipcMain.removeHandler('install-update-now'); } catch (_) {}
  ipcMain.on('install-update-now', doInstallNow);

  try { ipcMain.removeAllListeners('update-action'); } catch (_) {}
  ipcMain.on('update-action', (event, action) => {
    if (action === 'ignore') {
      if (current) writeIgnored(ignoreFile, current.version);
      return;
    }
    if (action === 'now') {
      doInstallNow();
    } else if (action === 'later') {
      installNow = false;
      if (autoUpdater && canInstall) {
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.downloadUpdate().catch(() => {});
      }
    }
  });

  setTimeout(() => checkViaGithubApi(false), CHECK_DELAY_MS);
  setInterval(() => checkViaGithubApi(false), CHECK_EVERY_MS).unref();
}

module.exports = { initUpdater };
