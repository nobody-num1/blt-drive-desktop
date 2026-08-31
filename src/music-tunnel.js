const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Client WebSocket pour le tunnel musique BLT Drive → Bot
let WebSocket = null;
let ws = null;
let discordId = null;
let token = null;
let connected = false;
let reconnectTimer = null;
let onStatusChange = null;
let onStreamRequest = null;

const BOT_WS_URL = process.env.BOT_WS_URL || 'wss://bot-discord-blt-bot-discord-blt.up.railway.app/music/tunnel';
const RECONNECT_DELAY = 5000;

// File d'attente séquentielle : une seule opération à la fois
const requestQueue = [];
let processing = false;

function enqueueRequest(fn) {
  requestQueue.push(fn);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (requestQueue.length > 0) {
    const fn = requestQueue.shift();
    try { await fn(); } catch {}
  }
  processing = false;
}

// YouTube Music innertube search (pas de yt-dlp, pas d'anti-bot)
const YTMUSIC_BASE = 'https://music.youtube.com';
const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';

async function innertubeSearch(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(`${YTMUSIC_BASE}/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': YTMUSIC_BASE,
        'Referer': YTMUSIC_BASE + '/',
      },
      body: JSON.stringify({
        query,
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20250801.00.00',
            hl: 'fr',
            gl: 'FR',
          },
        },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) throw new Error(`innertube ${resp.status}`);
    const data = await resp.json();

  const results = [];
  const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      // musicCardShelfRenderer
      const shelf = section?.musicCardShelfRenderer;
      if (shelf) {
        for (const item of shelf?.contents || []) {
          const song = item?.musicResponsiveListItemRenderer;
          if (!song) continue;
          const title = song?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
          const videoId = song?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (title && videoId) results.push({ title, videoId });
        }
      }
      // musicShelfRenderer (fallback)
      const shelf2 = section?.musicShelfRenderer;
      if (shelf2) {
        for (const item of shelf2?.contents || []) {
          const song = item?.musicResponsiveListItemRenderer;
          if (!song) continue;
          const title = song?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
          const videoId = song?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (title && videoId) results.push({ title, videoId });
        }
      }
    }
  }

  return results;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveYtDlp() {
  // Cherche yt-dlp bundled avec l'app (extraResources)
  const bundled = path.join(process.resourcesPath, 'yt-dlp', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(bundled)) return bundled;
  // Cherche dans le PATH
  const possible = ['yt-dlp', 'yt-dlp.exe'];
  for (const name of possible) {
    try {
      const { execSync } = require('child_process');
      const p = execSync(`where ${name}`, { encoding: 'utf8' }).trim().split('\n')[0];
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return 'yt-dlp'; // fallback PATH
}

function start(dId, tk, opts = {}) {
  if (ws && ws.readyState <= 1) return; // déjà connecté
  discordId = dId;
  token = tk;
  onStatusChange = opts.onStatusChange || null;
  onStreamRequest = opts.onStreamRequest || null;

  console.log('[music-tunnel] Demarrage pour discordId=' + (dId || 'null') + ' token=' + (tk ? tk.slice(0, 8) + '...' : 'null'));

  try { WebSocket = require('ws'); } catch {
    console.error('[music-tunnel] Module "ws" manquant. Installe-le : npm install ws');
    return;
  }

  connect();
}

function connect() {
  if (ws) { try { ws.close(); } catch {} }

  console.log('[music-tunnel] Connexion vers ' + BOT_WS_URL);
  ws = new WebSocket(BOT_WS_URL);

  ws.on('open', () => {
    console.log('[music-tunnel] WebSocket ouvert, envoi auth...');
    ws.send(JSON.stringify({ type: 'auth', discordId, token }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth-ok') {
      connected = true;
      console.log('[music-tunnel] Auth OK');
      emitStatus('connected');
      return;
    }

    if (msg.type === 'auth-error') {
      console.error('[music-tunnel] Auth echoue:', msg.error);
      connected = false;
      emitStatus('error', msg.error);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    console.log(`[music-tunnel] Message recu: ${msg.type} (${msg.requestId || ''})`);

    if (msg.type === 'stream-request') {
      enqueueRequest(() => handleStreamRequest(msg.requestId, msg.url));
      return;
    }

    if (msg.type === 'search-request') {
      enqueueRequest(() => handleSearchRequest(msg.requestId, msg.query));
      return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[music-tunnel] Ferme (code=' + code + ' reason=' + (reason || '') + ')');
    connected = false;
    emitStatus('disconnected');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[music-tunnel] Erreur WebSocket:', err.code, err.message?.slice(0, 80));
  });
}

function handleSearchRequest(requestId, query) {
  console.log(`[music-tunnel] Search: ${query.slice(0, 60)}`);

  // 1) Innertube search (pas de yt-dlp, pas d'anti-bot)
  innertubeSearch(query).then(results => {
    if (results.length > 0) {
      const r = results[0];
      const result = { title: r.title, url: `https://music.youtube.com/watch?v=${r.videoId}`, duration: 0 };
      console.log(`[music-tunnel] Search innertube ok: ${result.title}`);
      ws.send(JSON.stringify({ type: 'search-result', requestId, result }));
    } else {
      // 2) Fallback yt-dlp
      searchWithYtdlp(requestId, query);
    }
  }).catch(err => {
    console.error(`[music-tunnel] Search innertube echec: ${err.message}`);
    // 2) Fallback yt-dlp
    searchWithYtdlp(requestId, query);
  });
}

function searchWithYtdlp(requestId, query) {
  console.log(`[music-tunnel] Search yt-dlp fallback: ${query.slice(0, 60)}`);
  const ytdlp = resolveYtDlp();
  const searchUrl = 'https://music.youtube.com/search?q=' + encodeURIComponent(query);
  const args = [
    '--extractor-args', 'youtube:player_client=tv,web_creator,mweb',
    '--no-warnings', '--no-playlist',
    '--playlist-items', '1',
    '--print', '%(title)s',
    '--print', '%(webpage_url)s',
    '--print', '%(duration)s',
    searchUrl
  ];

  const proc = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0 || !stdout.trim()) {
      console.error(`[music-tunnel] Search echec (code ${code}): ${stderr.slice(0, 150)}`);
      ws.send(JSON.stringify({ type: 'search-error', requestId, error: stderr.slice(0, 200) || `yt-dlp exit ${code}` }));
      return;
    }

    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length < 2) {
      ws.send(JSON.stringify({ type: 'search-error', requestId, error: 'Pas de resultats' }));
      return;
    }

    const result = {
      title: lines[0],
      url: lines[1],
      duration: parseInt(lines[2]) || 0
    };
    console.log(`[music-tunnel] Search ok: ${result.title}`);
    ws.send(JSON.stringify({ type: 'search-result', requestId, result }));
  });

  proc.on('error', (err) => {
    console.error('[music-tunnel] Search erreur:', err.message);
    ws.send(JSON.stringify({ type: 'search-error', requestId, error: err.message }));
  });
}

function handleStreamRequest(requestId, url) {
  console.log(`[music-tunnel] Stream demande: ${url.slice(0, 60)}`);
  emitStatus('streaming', url);

  const ytdlp = resolveYtDlp();
  const args = [
    '--extractor-args', 'youtube:player_client=tv,web_creator,mweb',
    '--sleep-requests', '1',
    '--force-ipv4',
    '--geo-bypass',
    '--no-playlist', '--no-video', '--no-warnings',
    '--retries', '3',
    '-o', '-',
    '-f', 'bestaudio/best',
    url
  ];

  // Ajoute les cookies si disponibles
  const cookiesFile = path.join(app.getPath('userData'), 'cookies.txt');
  if (fs.existsSync(cookiesFile)) {
    args.splice(1, 0, '--cookies', cookiesFile);
  }

  const proc = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Envoie les données en temps réel au fur et à mesure que yt-dlp télécharge
  const CHUNK_SIZE = 64 * 1024;
  let totalSent = 0;
  let buffer = Buffer.alloc(0);
  let sentStart = false;

  proc.stdout.on('data', (d) => {
    // Au premier chunk, signale que le stream commence
    if (!sentStart) {
      sentStart = true;
      console.log(`[music-tunnel] Stream en cours...`);
    }
    buffer = Buffer.concat([buffer, d]);
    // Envoie par chunks de 64 KB
    while (buffer.length >= CHUNK_SIZE) {
      const chunk = buffer.slice(0, CHUNK_SIZE);
      buffer = buffer.slice(CHUNK_SIZE);
      ws.send(JSON.stringify({
        type: 'audio-chunk',
        requestId,
        data: chunk.toString('base64')
      }));
      totalSent += chunk.length;
    }
  });

  proc.stderr.on('data', (d) => {
    const text = d.toString();
    if (/\[download\]|ETA| at /i.test(text)) return;
    console.log('[music-tunnel yt-dlp]', text.slice(0, 200));
  });

  proc.on('close', (code) => {
    // Envoie le reste du buffer
    if (buffer.length > 0) {
      ws.send(JSON.stringify({
        type: 'audio-chunk',
        requestId,
        data: buffer.toString('base64')
      }));
      totalSent += buffer.length;
      buffer = Buffer.alloc(0);
    }

    if (code !== 0 && totalSent === 0) {
      console.error(`[music-tunnel] yt-dlp echec (code ${code})`);
      ws.send(JSON.stringify({ type: 'audio-error', requestId, error: `yt-dlp exit ${code}` }));
      emitStatus('connected');
      return;
    }

    console.log(`[music-tunnel] Audio termine: ${(totalSent / 1024).toFixed(1)} KB`);
    ws.send(JSON.stringify({ type: 'audio-end', requestId }));
    emitStatus('connected');
  });

  proc.on('error', (err) => {
    console.error('[music-tunnel] Erreur yt-dlp:', err.message);
    ws.send(JSON.stringify({ type: 'audio-error', requestId, error: err.message }));
    emitStatus('connected');
  });

  if (onStreamRequest) onStreamRequest(url);
}

function stop() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} }
  ws = null;
  connected = false;
  emitStatus('disconnected');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (discordId && token) {
      console.log('[music-tunnel] Reconnexion...');
      connect();
    }
  }, RECONNECT_DELAY);
}

function emitStatus(status, detail) {
  if (onStatusChange) {
    try { onStatusChange(status, detail || null); } catch {}
  }
}

function isConnected() { return connected; }
function getStatus() { return connected ? 'connected' : 'disconnected'; }

module.exports = { start, stop, isConnected, getStatus };
