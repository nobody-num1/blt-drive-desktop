const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const ffmpegPath = resolveFfmpeg();
const { DriveApi } = require('./src/drive');
const { transcode, probeDuration } = require('./src/transcode');
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

function parseDeepLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'bltdrive:') return null;
    return {
      token: u.searchParams.get('token') || '',
      label: u.searchParams.get('label') || '',
      discordId: u.searchParams.get('discord_id') || u.searchParams.get('discordId') || '',
      role: u.searchParams.get('role') || '',
      quotaRole: u.searchParams.get('quota_role') || u.searchParams.get('quotaRole') || ''
    };
  } catch { return null; }
}

function handleDeepLink(url) {
  const d = parseDeepLink(url);
  if (!d || !d.token) return;
  if (!settings.origin) { pendingDeepLink = d; return; }
  const acc = upsertAndActivate(d);
  saveSettings();
  emit({ type: 'account-connected', account: publicAccount(acc) });
}

function upsertAndActivate(d) {
  const acc = upsertAccount(d);
  if (acc) settings.activeAccountId = acc.id;
  return acc;
}

function openExternalLogin() {
  const origin = settings.origin;
  if (!origin) return { ok: false, error: 'Renseigne d\u2019abord l\u2019URL du drive' };
  shell.openExternal(origin + '/login');
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

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function runUpload(api, key, webhook, filePath, name, mime, parentId, onChunk) {
  const res = await uploadFile(api, key, webhook, filePath, name, mime, parentId, onChunk);
  return res;
}

async function importLocal(videos, opts) {
  const cfg = await api.config();
  if (!cfg.key) throw new Error('Clé de chiffrement indisponible sur le serveur');
  if (!cfg.webhook) throw new Error('Webhook Discord non configuré sur le serveur');
  if (!cfg.canImport) throw new Error('L\u2019import (transcodage) est réservé aux membres VIP et admin');
  const qualities = (opts.qualities || [720, 480, 360]).filter(q => !isNaN(q)).sort((a, b) => a - b);
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
      for (const q of qualities) {
        const out = path.join(tmp, qualityName(origName, q));
        emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p', pct: null });
        await transcode(ffmpegPath, v, out, q, opts.crf || 23, ms => {
          if (totalMs && totalMs > 0) {
            const pct = Math.min(99, Math.round((ms / totalMs) * 100));
            emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p', pct });
          } else {
            emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p', pct: null });
          }
        });
        emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload ' + q + 'p', pct: 0 });
        await runUpload(api, cfg.key, cfg.webhook, out, qualityName(origName, q), 'video/mp4', opts.parentId || null,
          (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: q + 'p — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }));
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
  if (!cfg.canImport) throw new Error('L\u2019import (transcodage) est réservé aux membres VIP et admin');
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
    for (const q of qualities) {
      const out = path.join(tmp, qualityName(item.name, q));
      emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p', pct: null });
      await transcode(ffmpegPath, local, out, q, opts.crf || 23, ms => {
        if (totalMs && totalMs > 0) {
          const pct = Math.min(99, Math.round((ms / totalMs) * 100));
          emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p', pct });
        } else {
          emit({ type: 'phase', job: j, phase: 'transcode', detail: 'Transcription ' + q + 'p', pct: null });
        }
      });
      emit({ type: 'phase', job: j, phase: 'upload', detail: 'Upload ' + q + 'p', pct: 0 });
      await runUpload(api, cfg.key, cfg.webhook, out, qualityName(item.name, q), 'video/mp4', item.parentId || null,
        (c, t) => emit({ type: 'phase', job: j, phase: 'upload', detail: q + 'p — blocs ' + c + '/' + t, pct: t ? Math.round(c / t * 100) : 0 }));
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

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#040323',
    title: 'BLT Drive Desktop',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

  app.whenReady().then(() => {
    registerProtocol();
    loadSettings();
    // Deep link reçu au démarrage (avant origin) : on l'applique dès que l'origin est connue
    const startup = process.argv.find(a => a.startsWith('bltdrive://'));
    if (startup) { const d = parseDeepLink(startup); if (d && d.token) pendingDeepLink = d; }
    createWindow();
    setupAutoUpdater();
    // Vérifie une mise à jour au démarrage, sans bloquer
    autoUpdater.checkForUpdates().catch(() => {});
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

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
  if (!a) return { ok: false, error: 'Connecte-toi via le bouton « Se connecter »' };
  try {
    const cfg = await a.config();
    const acc = activeAccount();
    const quotaRole = (acc && (acc.quotaRole || acc.role || '')) || '';
    const canImport = !!acc && ['admin', 'vip'].includes(quotaRole);
    return { ok: true, account: publicAccount(acc), quota: cfg.quota, canImport, role: (acc && acc.role) || '', quotaRole, webhook: !!cfg.webhook, hasKey: !!cfg.key };
  } catch (e) { return { ok: false, error: e.message }; }
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
