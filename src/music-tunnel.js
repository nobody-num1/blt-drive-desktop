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

  try { WebSocket = require('ws'); } catch {
    console.error('[music-tunnel] Module "ws" manquant. Installe-le : npm install ws');
    return;
  }

  connect();
}

function connect() {
  if (ws) { try { ws.close(); } catch {} }

  ws = new WebSocket(BOT_WS_URL);

  ws.on('open', () => {
    console.log('[music-tunnel] Connecte au bot, auth...');
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

    if (msg.type === 'stream-request') {
      handleStreamRequest(msg.requestId, msg.url);
      return;
    }
  });

  ws.on('close', () => {
    connected = false;
    emitStatus('disconnected');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[music-tunnel] Erreur WebSocket:', err.message?.slice(0, 80));
  });
}

function handleStreamRequest(requestId, url) {
  console.log(`[music-tunnel] Stream demande: ${url.slice(0, 60)}`);
  emitStatus('streaming', url);

  const ytdlp = resolveYtDlp();
  const args = [
    '--extractor-args', 'youtube:player_client=tv,web_safari',
    '--sleep-requests', '2',
    '--force-ipv4',
    '-o', '-',
    '--no-playlist', '--no-video', '--no-warnings',
    '-f', 'bestaudio/best',
    url
  ];

  // Ajoute les cookies si disponibles
  const cookiesFile = path.join(app.getPath('userData'), 'cookies.txt');
  if (fs.existsSync(cookiesFile)) {
    args.splice(1, 0, '--cookies', cookiesFile);
  }

  const proc = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];

  proc.stdout.on('data', (d) => chunks.push(d));

  proc.stderr.on('data', (d) => {
    const text = d.toString();
    if (/\[download\]|ETA| at /i.test(text)) return;
    console.log('[music-tunnel yt-dlp]', text.slice(0, 200));
  });

  proc.on('close', (code) => {
    if (code !== 0 || chunks.length === 0) {
      console.error(`[music-tunnel] yt-dlp echec (code ${code})`);
      ws.send(JSON.stringify({ type: 'audio-error', requestId, error: `yt-dlp exit ${code}` }));
      emitStatus('connected');
      return;
    }

    const audio = Buffer.concat(chunks);
    console.log(`[music-tunnel] Audio pret: ${(audio.length / 1024).toFixed(1)} KB`);

    // Envoie par chunks de 64 KB
    const CHUNK_SIZE = 64 * 1024;
    for (let i = 0; i < audio.length; i += CHUNK_SIZE) {
      const chunk = audio.slice(i, i + CHUNK_SIZE);
      ws.send(JSON.stringify({
        type: 'audio-chunk',
        requestId,
        data: chunk.toString('base64')
      }));
    }

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
