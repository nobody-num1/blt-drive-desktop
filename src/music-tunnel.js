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

// File d'attente séquentielle : un seul stream à la fois
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

// ── YouTube Music innertube search ──
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

    // Filtre les résultats : préfère les versions studio/original
    const livePatterns = /\b(live|concert|acoustic|unplugged|cover|session|karaoke|instrumental|remix)\b/i;
    const nonLive = results.filter(r => !livePatterns.test(r.title));
    const sorted = nonLive.length > 0 ? nonLive : results;

    return sorted;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Stream audio via BrowserWindow Electron ──
const streamWindows = new Map(); // requestId -> BrowserWindow

function extractVideoId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('v') || '';
  } catch {
    const m = url.match(/[?&]v=([^&]+)/);
    return m ? m[1] : '';
  }
}

function handleStreamRequest(requestId, url) {
  console.log(`[music-tunnel] Stream via browser: ${url.slice(0, 80)}`);
  emitStatus('streaming', url);

  const { BrowserWindow, screen } = require('electron');

  const videoId = extractVideoId(url);
  const watchUrl = videoId ? `https://music.youtube.com/watch?v=${videoId}` : url;

  // Fenêtre visible mais hors écran (YouTube ne charge pas dans une fenêtre cachée)
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW } = primaryDisplay.bounds;

  const playerWindow = new BrowserWindow({
    show: true,
    x: screenW + 100,
    y: 0,
    width: 640,
    height: 480,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-audio.js'),
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  streamWindows.set(requestId, playerWindow);

  playerWindow.webContents.on('did-finish-load', () => {
    console.log(`[music-tunnel] Page chargee, attente video...`);

    // Attend que la vidéo soit prête puis injecte la capture audio
    let attempts = 0;
    const maxAttempts = 20; // 20 x 1s = 20s max

    const tryInject = () => {
      attempts++;
      playerWindow.webContents.executeJavaScript(`
        (function() {
          var v = document.querySelector('video');
          if (!v) return { found: false, readyState: -1, attempt: ${attempts} };
          return { found: true, readyState: v.readyState, paused: v.paused, src: v.src ? v.src.slice(0, 80) : 'none', attempt: ${attempts} };
        })()
      `).then(info => {
        console.log(`[music-tunnel] Video check #${info.attempt}: found=${info.found} readyState=${info.readyState} paused=${info.paused}`);

        if (info.found && info.readyState >= 2) {
          // Vidéo prête, injecte la capture
          injectAudioCapture(playerWindow, requestId);
        } else if (attempts < maxAttempts) {
          setTimeout(tryInject, 1000);
        } else {
          console.error(`[music-tunnel] Timeout: vidéo pas prête après ${maxAttempts}s`);
          ws.send(JSON.stringify({ type: 'audio-error', requestId, error: 'Vidéo pas chargée après 20s' }));
          emitStatus('connected');
          closeStreamWindow(requestId);
        }
      }).catch(err => {
        console.error(`[music-tunnel] Execute JS error:`, err.message);
        if (attempts < maxAttempts) {
          setTimeout(tryInject, 1000);
        } else {
          ws.send(JSON.stringify({ type: 'audio-error', requestId, error: err.message }));
          emitStatus('connected');
          closeStreamWindow(requestId);
        }
      });
    };

    // Premier essai après 2s (laisse le temps au player de se charger)
    setTimeout(tryInject, 2000);
  });

  playerWindow.loadURL(watchUrl).catch(err => {
    console.error('[music-tunnel] Load URL error:', err.message);
    ws.send(JSON.stringify({ type: 'audio-error', requestId, error: err.message }));
    emitStatus('connected');
    closeStreamWindow(requestId);
  });

  if (onStreamRequest) onStreamRequest(url);
}

function injectAudioCapture(playerWindow, requestId) {
  console.log(`[music-tunnel] Injection capture audio...`);

  const jsCode = `
    (function() {
      var _reqId = '${requestId}';

      function log(msg) {
        console.log('[audio-capture] ' + msg);
        if (window.electronAPI) window.electronAPI.sendAudioLog(msg);
      }

      function findVideo() {
        return document.querySelector('video');
      }

      function doCapture(el) {
        try {
          log('Element trouvé: ' + el.tagName + ' readyState=' + el.readyState + ' paused=' + el.paused);

          // Lance la lecture si elle est en pause
          if (el.paused) {
            el.play().then(function() {
              log('Lecture démarrée');
              startCaptureAfterPlay(el);
            }).catch(function(err) {
              log('Autoplay échoué: ' + err.message + ', tentative getDisplayMedia...');
              tryGetDisplayMedia(el);
            });
          } else {
            startCaptureAfterPlay(el);
          }
        } catch (err) {
          log('Erreur doCapture: ' + err.message);
          window.electronAPI.sendAudioError(_reqId, err.message);
        }
      }

      function startCaptureAfterPlay(el) {
        try {
          if (typeof el.captureStream !== 'function') {
            log('captureStream non supporté');
            tryGetDisplayMedia(el);
            return;
          }

          var stream = el.captureStream();
          var audioTracks = stream.getAudioTracks();
          log('Pistes audio: ' + audioTracks.length);

          if (audioTracks.length === 0) {
            log('Pas de piste audio, tentative getDisplayMedia...');
            tryGetDisplayMedia(el);
            return;
          }

          var audioStream = new MediaStream(audioTracks);
          startRecording(audioStream);
        } catch (err) {
          log('Erreur startCaptureAfterPlay: ' + err.message);
          tryGetDisplayMedia(el);
        }
      }

      function tryGetDisplayMedia(el) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          log('getDisplayMedia non supporté');
          window.electronAPI.sendAudioError(_reqId, 'Aucune méthode de capture audio disponible');
          return;
        }

        navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
          .then(function(stream) {
            log('getDisplayMedia audio OK, pistes: ' + stream.getAudioTracks().length);
            startRecording(stream);
          })
          .catch(function(err) {
            log('getDisplayMedia echec: ' + err.message);
            window.electronAPI.sendAudioError(_reqId, 'Capture audio impossible: ' + err.message);
          });
      }

      function startRecording(audioStream) {
        try {
          var mimeType = 'audio/webm;codecs=opus';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/webm';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
              mimeType = 'audio/ogg;codecs=opus';
              if (!MediaRecorder.isTypeSupported(mimeType)) {
                log('Aucun codec supporté');
                window.electronAPI.sendAudioError(_reqId, 'Aucun codec audio supporté');
                return;
              }
            }
          }

          log('Codec: ' + mimeType);
          var mediaRecorder = new MediaRecorder(audioStream, { mimeType: mimeType });

          mediaRecorder.ondataavailable = function(e) {
            if (e.data && e.data.size > 0) {
              e.data.arrayBuffer().then(function(buffer) {
                var bytes = new Uint8Array(buffer);
                var binary = '';
                var chunkSize = 8192;
                for (var i = 0; i < bytes.length; i += chunkSize) {
                  var slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
                  binary += String.fromCharCode.apply(null, slice);
                }
                var base64 = btoa(binary);
                window.electronAPI.sendAudioChunk(_reqId, base64);
              });
            }
          };

          mediaRecorder.onerror = function(e) {
            log('Erreur MediaRecorder: ' + (e.error ? e.error.message : 'unknown'));
            window.electronAPI.sendAudioError(_reqId, 'Erreur enregistrement: ' + (e.error ? e.error.message : 'unknown'));
          };

          mediaRecorder.onstop = function() {
            log('MediaRecorder arrêté');
            window.electronAPI.sendAudioEnd(_reqId);
          };

          mediaRecorder.start(100);
          log('Enregistrement démarré');

          // Détecte la fin de la vidéo
          el.addEventListener('ended', function() {
            log('Vidéo terminée');
            if (mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
            }
          });

        } catch (err) {
          log('Erreur startRecording: ' + err.message);
          window.electronAPI.sendAudioError(_reqId, 'Erreur démarrage: ' + err.message);
        }
      }

      // ── Main ──
      var el = findVideo();
      if (el) {
        doCapture(el);
      } else {
        log('Pas de vidéo trouvée');
        window.electronAPI.sendAudioError(_reqId, 'Aucun élément vidéo trouvé');
      }
    })();
  `;

  playerWindow.webContents.executeJavaScript(jsCode).catch(err => {
    console.error('[music-tunnel] Inject error:', err.message);
    ws.send(JSON.stringify({ type: 'audio-error', requestId, error: err.message }));
    emitStatus('connected');
    closeStreamWindow(requestId);
  });
}

function closeStreamWindow(requestId) {
  const win = streamWindows.get(requestId);
  if (win) {
    try { win.close(); } catch {}
    streamWindows.delete(requestId);
  }
}

// ── API WebSocket → Bot ──

function sendChunk(requestId, data) {
  if (ws && ws.readyState <= 1) {
    ws.send(JSON.stringify({ type: 'audio-chunk', requestId, data }));
  }
}

function sendEnd(requestId) {
  if (ws && ws.readyState <= 1) {
    ws.send(JSON.stringify({ type: 'audio-end', requestId }));
  }
  emitStatus('connected');
  setTimeout(() => closeStreamWindow(requestId), 2000);
}

function sendError(requestId, error) {
  console.error(`[music-tunnel] Audio error: ${error}`);
  if (ws && ws.readyState <= 1) {
    ws.send(JSON.stringify({ type: 'audio-error', requestId, error }));
  }
  emitStatus('connected');
  closeStreamWindow(requestId);
}

// ── WebSocket lifecycle ──

function start(dId, tk, opts = {}) {
  if (ws && ws.readyState <= 1) return;
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
      handleSearchRequest(msg.requestId, msg.query);
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

  innertubeSearch(query).then(results => {
    if (results.length > 0) {
      const r = results[0];
      const result = { title: r.title, url: `https://music.youtube.com/watch?v=${r.videoId}`, duration: 0 };
      console.log(`[music-tunnel] Search innertube ok: ${result.title}`);
      ws.send(JSON.stringify({ type: 'search-result', requestId, result }));
    } else {
      console.log(`[music-tunnel] Search innertube vide, fallback yt-dlp`);
      searchWithYtdlp(requestId, query);
    }
  }).catch(err => {
    console.error(`[music-tunnel] Search innertube echec: ${err.message}`);
    searchWithYtdlp(requestId, query);
  });
}

function searchWithYtdlp(requestId, query) {
  console.log(`[music-tunnel] Search yt-dlp fallback: ${query.slice(0, 60)}`);
  const { spawn } = require('child_process');
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

function resolveYtDlp() {
  const bundled = path.join(process.resourcesPath, 'yt-dlp', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(bundled)) return bundled;
  const possible = ['yt-dlp', 'yt-dlp.exe'];
  for (const name of possible) {
    try {
      const { execSync } = require('child_process');
      const p = execSync(`where ${name}`, { encoding: 'utf8' }).trim().split('\n')[0];
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return 'yt-dlp';
}

function stop() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} }
  ws = null;
  connected = false;
  // Ferme toutes les fenêtres de stream ouvertes
  for (const [id, win] of streamWindows) {
    try { win.close(); } catch {}
  }
  streamWindows.clear();
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

module.exports = { start, stop, isConnected, getStatus, sendChunk, sendEnd, sendError, closeStreamWindow };
