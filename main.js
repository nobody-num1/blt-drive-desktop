const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, ipcMain, dialog, shell, screen, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');

protocol.registerSchemesAsPrivileged([
  { scheme: 'bltdrive', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const ffmpegPath = resolveFfmpeg();
const { DriveApi } = require('./src/drive');
const { transcode, probeDuration, probeStreams, extractSubtitles } = require('./src/transcode');
const { uploadFile, downloadToFile } = require('./src/upload');
const { mimeFor, isVideoPath } = require('./src/mime');

function resolveFfmpeg() {
  const bundled = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(bundled)) return bundled;
  return require('ffmpeg-static');
}

let win = null;
let settings = { origin: '', accounts: [], activeAccountId: '' };
let api = null;
let pendingDeepLink = null;
let loginOnShow = null;
let streamReady = null;

function dlog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch {}
}

function loadSettings() {
  try {
    const data = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
    settings = JSON.parse(data);
  } catch {}
}

function saveSettings() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function buildApi() {
  const acc = activeAccount();
  if (!settings.origin || !acc || !acc.token) return null;
  api = new DriveApi(settings.origin);
  api.setCredential(acc.token);
  return api;
}

function activeAccount() {
  return (settings.accounts || []).find(a => a.id === settings.activeAccountId) || null;
}

function upsertAccount(d) {
  const accounts = settings.accounts || [];
  const token = (d.token || '').trim();
  if (!token) return null;
  const discordId = d.discordId || '';
  let idx = -1;
  if (discordId) idx = accounts.findIndex(a => a.discordId === discordId);
  if (idx < 0) idx = accounts.findIndex(a => a.token === token);
  const id = idx >= 0 ? accounts[idx].id : 'acc_' + token.slice(0, 12) + Math.random().toString(36).slice(2, 7);
  const entry = { id, discordId, label: d.label || 'Compte', role: d.role || '', quotaRole: d.quotaRole || '', token, savedAt: Date.now() };
  if (idx >= 0) accounts[idx] = entry; else accounts.push(entry);
  settings.accounts = accounts.slice(0, 30);
  return entry;
}

function publicAccount(a) {
  return a ? { id: a.id, label: a.label, discordId: a.discordId || '' } : null;
}

function publicAccounts() {
  return (settings.accounts || []).map(publicAccount);
}

function parseParams(url) {
  try {
    const u = new URL(url);
    return {
      token: u.searchParams.get('token') || '',
      label: u.searchParams.get('label') || '',
      discordId: u.searchParams.get('discord_id') || u.searchParams.get('discordId') || '',
      role: u.searchParams.get('role') || '',
      quotaRole: u.searchParams.get('quota_role') || u.searchParams.get('quotaRole') || ''
    };
  } catch { return null; }
}

function parseDeepLink(url) {
  const d = parseParams(url);
  return d && d.token ? d : null;
}

function upsertAndActivate(d) {
  const acc = upsertAccount(d);
  if (acc) settings.activeAccountId = acc.id;
  return acc;
}

function applyLogin(d) {
  if (!d || !d.token) return;
  if (!settings.origin) { pendingDeepLink = d; return; }
  const acc = upsertAndActivate(d);
  dlog('applyLogin: token=' + String(d.token||'').slice(0,8) + '… acc=' + (acc ? acc.id : 'null') + ' role=' + (d.role||'') + ' quotaRole=' + (d.quotaRole||''));
  saveSettings();
  emit({ type: 'account-connected', account: publicAccount(acc) });
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function handleDeepLink(url) {
  applyLogin(parseDeepLink(url));
}

// Mini serveur local (127.0.0.1) : canal de retour fiable pour la connexion
const CB_BASE_PORT = 33445;
let callbackServer = null;
let callbackPort = 0;
let callbackReady = null;

function startCallbackServer() {
  if (callbackReady) return callbackReady;
  callbackReady = new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const send = (status, body, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Private-Network': 'true', ...extra });
        res.end(body);
      };
      if (req.method === 'OPTIONS') return send(204, '');
      let d = null;
      try { d = parseParams('bltdrive://local' + (req.url || '/')); } catch {}
      dlog('callback-server: ' + req.method + ' ' + (req.url||'').slice(0,80) + ' hasToken=' + !!(d && d.token));
      if (d && d.token) applyLogin(d);
      const ok = d && d.token;
      const html = ok
        ? '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>BLT Drive Desktop</title></head>'
          + '<body style="font-family:Segoe UI,system-ui,sans-serif;background:#313338;color:#dbdee1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
          + '<div style="text-align:center"><div style="font-size:44px">✅</div><h2>Connexion réussie</h2>'
          + '<p>Ton compte est connecté sur BLT Drive Desktop. Tu peux fermer cet onglet.</p>'
          + '<a href="#" onclick="window.open(\'\',\'_self\').close();return false" style="color:#5865F2">Fermer</a></div></body></html>'
        : 'missing token';
      send(ok ? 200 : 400, html);
    });
    const bind = port => server.listen(port, '127.0.0.1', () => { callbackServer = server; callbackPort = server.address().port; resolve(callbackPort); });
    server.on('error', () => {
      if (!callbackServer) bind(0); // port fixe pris : on retombe sur un port libre
    });
    bind(CB_BASE_PORT);
  });
  return callbackReady;
}

async function openExternalLogin() {
  const origin = settings.origin;
  if (!origin) return { ok: false, error: 'Renseigne d\u2019abord l\u2019URL du drive' };
  let port = 0;
  try { port = await startCallbackServer(); } catch {}
  const url = origin + '/login' + (port ? '?cb=' + port : '');
  shell.openExternal(url);
  return { ok: true };
}

function registerProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient('bltdrive', process.execPath, [path.resolve(process.argv[1])]);
  } else app.setAsDefaultProtocolClient('bltdrive');
}

function emit(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('evt', evt);
}

function baseName(name) {
  return name.replace(/_\d{3,4}p(?=\.)/, '');
}

function qualityName(originalName, q) {
  const n = baseName(originalName);
  return n.replace(/\.[^.]+$/, '') + '_' + q + 'p.mp4';
}

function trackQualityName(originalName, q, trackNum) {
  const n = baseName(originalName);
  return n.replace(/\.[^.]+$/, '') + '_' + q + 'p_a' + trackNum + '.mp4';
}

function freeBytes(cfg) {
  const q = (cfg && cfg.quota) || {};
  const limit = q.limit;
  if (limit === '-1' || limit === '-1n' || limit === undefined || limit === null) return -1;
  const lim = Number(limit);
  if (!isFinite(lim) || lim <= 0) return -1;
  return Math.max(0, lim - (Number(q.usage) || 0));
}

function fmtBar(n) {
  if (!n || n < 0) return 'illimité';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function assertSpace(cfg, bytes) {
  const free = freeBytes(cfg);
  if (free >= 0 && bytes > free) {
    throw new Error('Espace insuffisant sur le drive : il faut ' + fmtBar(bytes) + ' mais il ne reste que ' + fmtBar(free) + ' (quota ' + fmtBar(cfg.quota.limit) + ').');
  }
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function runUpload(api, key, webhook, filePath, name, mime, parentId, onChunk, label) {
  const res = await uploadFile(api, key, webhook, filePath, name, mime, parentId, onChunk, label);
  return res;
}

async function importLocal(videos, opts) {
  const cfg = await api.config();
  if (!cfg.key) throw new Error('Clé de chiffrement indisponible sur le serveur');
  if (!cfg.webhook) throw new Error('Webhook Discord non configuré sur le serveur');
  if (!cfg.canImport) throw new Error('Connexion requise pour importer');
  const qualities = (opts.qualities || [720, 480, 360]).filter(q => !isNaN(q)).sort((a, b) => a - b);
  const includeTracks = opts.includeTracks !== false;
  for (const v of videos) {
    const j = path.basename(v);
    emit({ type: 'job-start', job: j });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bltdrv-'));
    try {
      const origName = baseName(path.basename(v));
      const mime = mimeFor(origName);
      if (opts.includeOriginal !== false) {
        emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload de l\'original', pct: 0 });
        await runUpload(api, cfg.key, cfg.webhook, v, origName, mime, opts.parentId || null,
          (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: 'Original — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }));
      }
      const totalMs = await probeDuration(ffmpegPath, v);
      const streams = await probeStreams(ffmpegPath, v);
      const baseNameNoExt = origName.replace(/\.[^.]+$/, '');
      const audioCount = includeTracks ? Math.max(1, streams.audio.length) : 1;
      const subtitleTracks = includeTracks ? await extractSubtitles(ffmpegPath, v, tmp, baseNameNoExt) : [];
      // Uploader sous-titres
      for (const st of subtitleTracks) {
        emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload sous-titre ' + (st.label || st.subNum), pct: 0 });
        await runUpload(api, cfg.key, cfg.webhook, st.path, st.name, 'text/vtt', opts.parentId || null,
          (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: 'Sub ' + (st.label || st.subNum) + ' — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }),
          st.label);
      }
      for (const q of qualities) {
        for (let a = 0; a < audioCount; a++) {
          const audioLabel = (streams.audio[a] && (streams.audio[a].title || streams.audio[a].language)) || '';
          const trackName = a === 0 ? qualityName(origName, q) : trackQualityName(origName, q, a + 1);
          const out = path.join(tmp, trackName);
          emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p' + (a > 0 ? ' — piste audio ' + (a + 1) : ''), pct: null });
          await transcode(ffmpegPath, v, out, q, opts.crf || 23, ms => {
            const detail = 'Transcription ' + q + 'p' + (a > 0 ? ' — piste audio ' + (a + 1) : '');
            if (ms === -1) emit({ type: 'phase', job: j, phase: 'transcode', detail, pct: 100 });
            else if (totalMs && totalMs > 0) emit({ type: 'phase', job: j, phase: 'transcode', detail, pct: Math.min(100, Math.round((ms / totalMs) * 100)) });
            else emit({ type: 'phase', job: j, phase: 'transcode', detail, pct: null });
          }, a === 0 && !streams.audio.length ? undefined : a);
          const outBytes = fs.statSync(out).size;
          assertSpace(cfg, outBytes);
          emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload ' + q + 'p' + (a > 0 ? ' — piste audio ' + (a + 1) : ''), pct: 0 });
          await runUpload(api, cfg.key, cfg.webhook, out, trackName, 'video/mp4', opts.parentId || null,
            (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: q + 'p' + (a > 0 ? ' (piste ' + (a + 1) + ')' : '') + ' — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }),
            audioLabel);
        }
      }
      emit({ type: 'job-end', job: j, ok: true });
    } catch (e) {
      emit({ type: 'job-end', job: j, ok: false, error: (e && e.message) || String(e) });
    } finally {
      cleanDir(tmp);
    }
  }
  return { ok: true };
}

async function importDrive(fileId, opts) {
  const cfg = await api.config();
  if (!cfg.key) throw new Error('Clé de chiffrement indisponible');
  if (!cfg.canImport) throw new Error('Connexion requise pour importer');
  const tree = await api.tree();
  const item = (tree.items || []).find(i => i.id === fileId);
  if (!item) throw new Error('Fichier introuvable sur le drive');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dblt-'));
  const j = item.name;
  emit({ type: 'job-start', job: j });
  try {
    const local = path.join(tmp, baseName(item.name));
    emit({ type: 'phase', job: j, phase: 'download', detail: 'Récupération de l\'original', pct: 0 });
    await downloadToFile(api, cfg.key, fileId, local, (c, t) => emit({ type: 'phase', job: j, phase: 'download', detail: 'Récupération ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }));
    const totalMs = await probeDuration(ffmpegPath, local);
    const qualities = (opts.qualities || [720, 480, 360]).sort((a, b) => a - b);
    const includeTracks = opts.includeTracks !== false;
    const streams = await probeStreams(ffmpegPath, local);
    const baseNameNoExt = baseName(item.name).replace(/\.[^.]+$/, '');
    const audioCount = includeTracks ? Math.max(1, streams.audio.length) : 1;
    const subtitleTracks = includeTracks ? await extractSubtitles(ffmpegPath, local, tmp, baseNameNoExt) : [];
    // Uploader sous-titres
    for (const st of subtitleTracks) {
      emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload sous-titre ' + (st.label || st.subNum), pct: 0 });
      await runUpload(api, cfg.key, cfg.webhook, st.path, st.name, 'text/vtt', item.parentId || null,
        (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: 'Sub ' + (st.label || st.subNum) + ' — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }),
        st.label);
    }
    for (const q of qualities) {
      for (let a = 0; a < audioCount; a++) {
        const audioLabel = (streams.audio[a] && (streams.audio[a].title || streams.audio[a].language)) || '';
        const trackName = a === 0 ? qualityName(item.name, q) : trackQualityName(item.name, q, a + 1);
        const out = path.join(tmp, trackName);
        emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p' + (a > 0 ? ' — piste audio ' + (a + 1) : ''), pct: null });
        await transcode(ffmpegPath, local, out, q, opts.crf || 23, ms => {
          const detail = 'Transcription ' + q + 'p' + (a > 0 ? ' — piste audio ' + (a + 1) : '');
          if (ms === -1) emit({ type: 'phase', job: j, phase: 'transcode', detail, pct: 100 });
          else if (totalMs && totalMs > 0) emit({ type: 'phase', job: j, phase: 'transcode', detail, pct: Math.min(100, Math.round((ms / totalMs) * 100)) });
          else emit({ type: 'phase', job: j, phase: 'transcode', detail, pct: null });
        }, a > 0 ? a : undefined);
        const outBytes = fs.statSync(out).size;
        assertSpace(cfg, outBytes);
        emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload ' + q + 'p' + (a > 0 ? ' — piste audio ' + (a + 1) : ''), pct: 0 });
        await runUpload(api, cfg.key, cfg.webhook, out, trackName, 'video/mp4', item.parentId || null,
          (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: q + 'p' + (a > 0 ? ' (piste ' + (a + 1) + ')' : '') + ' — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }),
          audioLabel);
      }
    }
    emit({ type: 'job-end', job: j, ok: true });
    return { ok: true, id: fileId };
  } catch (e) {
    emit({ type: 'job-end', job: j, ok: false, error: (e && e.message) || String(e) });
    throw e;
  } finally {
    cleanDir(tmp);
  }
}

function setupStreamProtocol() {
  if (streamReady) return streamReady;
  streamReady = protocol.handle('bltdrive', async req => {
    try {
      const url = new URL(req.url);
      // bltdrive://preview/<id>  ou  bltdrive://download/<id>
      const seg = url.hostname + url.pathname;
      const m = seg.match(/^(preview|download)\/([^/]+)$/);
      if (!m) return new Response('Bad request', { status: 400 });
      const kind = m[1];
      const id = m[2];
      const a = buildApi();
      if (!a) return new Response('Non connecté', { status: 401 });
      const upstream = kind === 'preview' ? a.preview(id, req.headers.get('range') || '') : a.download(id, req.headers.get('range') || '');
      const res = await upstream;
      if (!res.ok) return new Response(res.statusText || ('Erreur ' + res.status), { status: res.status });
      const hdrs = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        const v = res.headers.get(k);
        if (v) hdrs[k] = v;
      }
      return new Response(res.body, { status: res.status, headers: hdrs });
    } catch (e) {
      return new Response((e && e.message) || 'Erreur streaming', { status: 500 });
    }
  });
  return streamReady;
}

function createWindow() {
  const bounds = savedWindowBounds();
  const defaults = { width: 1080, height: 760 };
  let hasPos = false;
  let posX, posY;
  if (bounds && typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    const disp = screen.getAllDisplays().find(d => {
      const wa = d.workArea;
      return bounds.x >= wa.x - 10 && bounds.x < wa.x + wa.width - 60 && bounds.y >= wa.y - 10 && bounds.y < wa.y + wa.height - 40;
    });
    if (disp) { hasPos = true; posX = bounds.x; posY = bounds.y; }
  }
  const opts = {
    width: bounds ? bounds.width : defaults.width,
    height: bounds ? bounds.height : defaults.height,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#040323',
    title: 'BLT Drive Desktop',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  };
  if (hasPos) { opts.x = posX; opts.y = posY; }
  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  let saveTimer = null;
  const persist = () => {
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        settings.winBounds = win.getBounds();
        saveSettings();
      } catch {}
    }, 300);
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('close', () => {
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    try { settings.winBounds = win.getBounds(); saveSettings(); } catch {}
  });
}

function savedWindowBounds() {
  try {
    const b = settings && settings.winBounds;
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
    const wa = screen.getPrimaryDisplay().workArea;
    const w = Math.max(720, Math.min(b.width, wa.width));
    const h = Math.max(520, Math.min(b.height, wa.height));
    return { width: w, height: h, x: b.x, y: b.y };
  } catch { return null; }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', info => emit({ type: 'update', state: 'available', version: (info && info.version) || '' }));
  autoUpdater.on('update-not-available', () => emit({ type: 'update', state: 'none', version: app.getVersion() }));
  autoUpdater.on('download-progress', p => emit({ type: 'update', state: 'progress', percent: (p && p.percent) || 0, speed: (p && p.bytesPerSecond) || 0, transferred: (p && p.transferred) || 0, total: (p && p.total) || 0 }));
  autoUpdater.on('update-downloaded', info => emit({ type: 'update', state: 'downloaded', version: (info && info.version) || '' }));
  autoUpdater.on('error', err => emit({ type: 'update', state: 'error', detail: (err && err.message) || String(err) }));
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const u = argv.find(a => a.startsWith('bltdrive://'));
    if (u) handleDeepLink(u);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });

  app.whenReady().then(async () => {
    registerProtocol();
    loadSettings();
    cleanOpenDir();
    try { await startCallbackServer(); } catch {}
    // Deep link reçu au démarrage (avant origin) : on l'applique dès que l'origin est connue
    const startup = process.argv.find(a => a.startsWith('bltdrive://'));
    if (startup) {
      const d = parseDeepLink(startup);
      if (d && d.token) {
        if (settings.origin) loginOnShow = d;
        else pendingDeepLink = d;
      }
    }
    createWindow();
    setupStreamProtocol();
    if (loginOnShow) {
      const d = loginOnShow; loginOnShow = null;
      win.webContents.once('did-finish-load', () => applyLogin(d));
    }
    setupAutoUpdater();
    // Vérifie une mise à jour au démarrage, sans bloquer
    autoUpdater.checkForUpdates().catch(() => {});
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('will-quit', () => { cleanOpenDir(); });

ipcMain.on('app-log', (e, m) => dlog('[renderer] ' + String(m || '').slice(0, 200)));

ipcMain.handle('app-get-version', () => ({ version: app.getVersion(), updatable: autoUpdater.isUpdaterActive() }));

ipcMain.handle('app-check-update', async () => {
  if (!autoUpdater.isUpdaterActive()) return { ok: false, error: 'Mise à jour indisponible (mode développement)' };
  try { await autoUpdater.checkForUpdates(); return { ok: true, current: app.getVersion() }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

ipcMain.handle('app-download-update', async () => {
  if (!autoUpdater.isUpdaterActive()) return { ok: false, error: 'Mise à jour indisponible (mode développement)' };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

ipcMain.handle('app-quit-install', () => {
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('get-settings', () => ({ origin: settings.origin, accounts: publicAccounts(), activeAccountId: settings.activeAccountId }));

ipcMain.handle('save-settings', (e, s) => {
  dlog('save-settings: newOrigin="' + ((s && s.origin) || '').trim() + '" pendingDl=' + !!pendingDeepLink + ' accounts_avant=' + (settings.accounts||[]).length);
  settings.origin = ((s && s.origin) || '').trim();
  if (pendingDeepLink) {
    const d = pendingDeepLink; pendingDeepLink = null;
    upsertAndActivate(d);
  }
  saveSettings();
  return { origin: settings.origin, accounts: publicAccounts(), activeAccountId: settings.activeAccountId };
});

ipcMain.handle('connect-account', () => openExternalLogin());

ipcMain.handle('disconnect-account', (e, id) => {
  dlog('disconnect-account: id=' + id + ' accounts_avant=' + (settings.accounts||[]).length);
  const accounts = settings.accounts || [];
  settings.accounts = accounts.filter(a => a.id !== id);
  if (settings.activeAccountId === id) {
    settings.activeAccountId = (settings.accounts[settings.accounts.length - 1] || {}).id || '';
  }
  saveSettings();
  return { origin: settings.origin, accounts: publicAccounts(), activeAccountId: settings.activeAccountId };
});

ipcMain.handle('set-active-account', (e, id) => {
  if ((settings.accounts || []).some(a => a.id === id)) {
    settings.activeAccountId = id;
    saveSettings();
  }
  return { origin: settings.origin, accounts: publicAccounts(), activeAccountId: settings.activeAccountId };
});

ipcMain.handle('test-connection', async () => {
  const a = buildApi();
  if (!a) { dlog('test-connection: buildApi()=null origin="' + settings.origin + '" accounts=' + (settings.accounts||[]).length + ' activeId="' + settings.activeAccountId + '"'); return { ok: false, error: 'Connecte-toi via le bouton « Se connecter »' }; }
  try {
    const cfg = await a.config();
    const acc = activeAccount();
    const quotaRole = (acc && (acc.quotaRole || acc.role || '')) || '';
    const canImport = !!acc && !!cfg.canImport;
    dlog('test-connection: ok=true canImport=' + canImport + ' cfg.canImport=' + cfg.canImport + ' acc=' + (acc ? acc.id : 'null') + ' origin=' + settings.origin);
    return { ok: true, account: publicAccount(acc), quota: cfg.quota, canImport, role: (acc && acc.role) || '', quotaRole, webhook: !!cfg.webhook, hasKey: !!cfg.key };
  } catch (e) { dlog('test-connection: ERROR ' + e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('pick-videos', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Vidéos', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'mpg', 'mpeg', 'ts', 'm4v', '3gp', 'ogv'] }]
  });
  return r.canceled ? [] : r.filePaths.filter(p => isVideoPath(p));
});

ipcMain.handle('list-drive', async () => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try {
    const tree = await a.tree();
    const items = (tree.items || []).filter(i => i.type === 'file' && !i.renditionOf && (mimeFor(i.name).startsWith('video/') || isVideoPath(i.name)));
    return { items };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('explorer-tree', async () => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return { items: (await a.tree()).items || [] }; }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-mkdir', async (e, name, parentId) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.mkdir(name, parentId || null); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-rename', async (e, id, name) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.rename(id, name); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-move', async (e, id, parentId) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.move(id, parentId || null); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-delete', async (e, id) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.del(id); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-shares', async () => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.shares(); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-shared-with-me', async () => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.sharedWithMe(); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-share-create', async (e, body) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.createShare(body || {}); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-share-delete', async (e, id) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try { return await a.deleteShare(id); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-download', async (e, id, defaultName) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName || 'fichier' });
    if (r.canceled || !r.filePath) return { ok: true, canceled: true };
    const res = await a.download(id);
    if (!res.ok) return { error: 'Erreur téléchargement ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(r.filePath, buf);
    return { ok: true, path: r.filePath };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('disk-zip', async (e, id, defaultName) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  try {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName || 'dossier.zip' });
    if (r.canceled || !r.filePath) return { ok: true, canceled: true };
    const res = await a.zip(id);
    if (!res.ok) return { error: 'Erreur ZIP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(r.filePath, buf);
    return { ok: true, path: r.filePath };
  } catch (err) { return { error: err.message }; }
});

const TEMP_OPEN_DIR = path.join(os.tmpdir(), 'blt-drive-open');
let openEditsWatcher = null;
const openEdits = new Map(); // target -> { target, id, name, mime, parentId, mtimeMs, size, lastSeen, busy }
const openingIds = new Set(); // id -> évite les doublons de téléchargement au clic

function cleanOpenDir() {
  try { fs.rmSync(TEMP_OPEN_DIR, { recursive: true, force: true }); } catch {}
}

function startEditWatcher() {
  if (openEditsWatcher) return;
  openEditsWatcher = setInterval(async () => {
    const now = Date.now();
    for (const [target, e] of [...openEdits]) {
      if (e.busy) continue;
      try {
        const st = fs.statSync(target);
        const changed = st.mtimeMs !== e.mtimeMs || st.size !== e.size;
        if (changed) {
          // l'app externe écrit : on note l'état courant et on attend la stabilisation
          e.lastSeen = { mtimeMs: st.mtimeMs, size: st.size };
          e.stableSince = null;
          e.dirty = true;
          e.mtimeMs = st.mtimeMs;
          e.size = st.size;
          continue;
        }
        if (e.lastSeen && e.lastSeen.mtimeMs === st.mtimeMs && e.lastSeen.size === st.size) {
          if (!e.stableSince) e.stableSince = now;
          if (now - e.stableSince < 2500) continue;
          e.lastSeen = null;
          e.stableSince = null;
          e.busy = true;
          try { await reimportEdit(e); }
          catch { }
          finally { e.busy = false; }
          continue;
        }
        // Modifications en attente de réimport (échec précédent) : nouvelle tentative
        if (e.dirty && e.retryAt && now >= e.retryAt) {
          e.retryAt = null;
          e.busy = true;
          try { await reimportEdit(e); }
          catch { }
          finally { e.busy = false; }
          continue;
        }
        // Plus aucune modification : nettoyage après longue inactivité (édition terminée)
        if (!e.dirty && now - e.mtimeMs > 10 * 60 * 1000) {
          openEdits.delete(target);
          try { fs.rmSync(target, { force: true }); dlog('open-external: temp supprimé après inactivité ' + target); } catch {}
        }
      } catch {
        // fichier disparu (ex: app externe l'a déplacé/supprimé) : on abandonne la surveillance
        openEdits.delete(target);
        try { fs.rmSync(target, { force: true }); } catch {}
      }
    }
  }, 1500);
}

async function reimportEdit(e) {
  const a = buildApi();
  if (!a) { e.retryAt = Date.now() + 30000; return; }
  try {
    const cfg = await a.config();
    if (!cfg.key || !cfg.webhook) throw new Error('Clé ou webhook indisponible sur le serveur');
    const size = fs.statSync(e.target).size;
    dlog('open-external: réimport de « ' + e.name + ' » (' + size + ' o)…');
    emit({ type: 'reimport-start', name: e.name });
    await uploadFile(a, cfg.key, cfg.webhook, e.target, e.name, e.mime || 'application/octet-stream', e.parentId || null, null, '', e.id);
    dlog('open-external: réimport OK id=' + e.id);
    const st = fs.statSync(e.target);
    e.mtimeMs = st.mtimeMs;
    e.size = st.size;
    e.dirty = false;
    e.retryAt = null;
    emit({ type: 'reimport-ok', id: e.id, name: e.name });
  } catch (err) {
    dlog('open-external: réimport échec ' + (err && err.message));
    e.retryAt = Date.now() + 30000;
    emit({ type: 'error', detail: 'Réimport de « ' + e.name + ' » échoué (nouvel essai dans 30 s) : ' + ((err && err.message) || String(err)) });
  }
}

ipcMain.handle('disk-open-external', async (e, id, name, extra) => {
  const a = buildApi();
  if (!a) return { error: 'Non connecté' };
  if (openingIds.has(id)) return { busy: true, ok: false };
  openingIds.add(id);
  try {
    emit({ type: 'open-progress', id, name: name || 'fichier', pct: 0 });
    const safe = (name || 'fichier').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    fs.mkdirSync(TEMP_OPEN_DIR, { recursive: true });
    const target = path.join(TEMP_OPEN_DIR, safe);
    const total = (extra && extra.size) || 0;
    const ws = fs.createWriteStream(target);
    let received = 0;
    let lastEmit = 0;
    let lastPct = -2;
    const emitProg = () => {
      const pct = total ? Math.round(received / total * 100) : -1;
      const now = Date.now();
      if (now - lastEmit < 200 && pct !== 100) return;
      lastEmit = now;
      if (pct === lastPct && pct !== 100) return;
      lastPct = pct;
      emit({ type: 'open-progress', id, name: name || 'fichier', pct, received, total });
    };
    const RANGE_STEP = 16 * 1024 * 1024;
    let start = 0;
    let guard = 0;
    while (true) {
      if (total && received >= total) break;
      const end = total ? Math.min(start + RANGE_STEP - 1, total - 1) : start + RANGE_STEP - 1;
      const res = await a.download(id, 'bytes=' + start + '-' + end);
      if (!res.ok) throw new Error('Erreur téléchargement ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) break;
      if (!ws.write(buf)) await new Promise(r => ws.once('drain', r));
      received += buf.length;
      emitProg();
      if (buf.length < RANGE_STEP) break;
      start += RANGE_STEP;
      if (++guard > 10000) throw new Error('Téléchargement interrompu (trop de blocs)');
    }
    await new Promise((ok, ko) => { ws.on('finish', ok); ws.on('error', ko); ws.end(); });
    const st = fs.statSync(target);
    const mime = (extra && extra.mime) || 'application/octet-stream';
    dlog('open-external: écrit ' + target + ' (' + st.size + ' o), ouverture…');
    const err = await shell.openPath(target);
    if (err) { dlog('open-external: shell.openPath error=' + err); return { error: err }; }
    const entry = { target, id, name, mime, parentId: (extra && extra.parentId) || null, mtimeMs: st.mtimeMs, size: st.size, lastSeen: null, stableSince: null, dirty: false, retryAt: null, busy: false };
    openEdits.set(target, entry);
    startEditWatcher();
    return { ok: true, path: target };
  } catch (err) { return { error: err.message }; }
  finally { openingIds.delete(id); }
});

ipcMain.handle('import-local', (e, paths, opts) => {
  const a = buildApi();
  if (!a) return Promise.reject(new Error('Connecte-toi via le bouton « Se connecter »'));
  return importLocal(paths, opts || {});
});
ipcMain.handle('import-drive', (e, fileId, opts) => {
  const a = buildApi();
  if (!a) return Promise.reject(new Error('Connecte-toi via le bouton « Se connecter »'));
  return importDrive(fileId, opts || {});
});

process.on('uncaughtException', err => { try { emit({ type: 'error', detail: (err && err.message) || String(err) }); } catch {} });
