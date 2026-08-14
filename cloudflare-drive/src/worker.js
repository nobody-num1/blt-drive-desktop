const ALGO = { name: 'HMAC', hash: 'SHA-256' };
const TOKEN_TTL = 86400;
const CHUNK_MAX = 10 * 1024 * 1024;
const GB = 1024n ** 3n;

function cfg(env) {
  return {
    driveSecret: env.DRIVE_SECRET || '',
    railwayUrl: env.RAILWAY_URL || 'https://bot-discord-blt-bot-discord-blt.up.railway.app',
    webhookUrl: env.DISCORD_WEBHOOK || '',
    vipRoleId: env.VIP_ROLE_ID || '1525988844565168261',
  };
}

function b64url(buf) {
  const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : typeof buf === 'string' ? new TextEncoder().encode(buf) : buf;
  return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function hmacSign(payload, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), ALGO, false, ['sign']);
  return crypto.subtle.sign(ALGO, key, new TextEncoder().encode(payload));
}

async function verifyToken(token, secret) {
  try {
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const enc = token.slice(0, dot);
    const sig = fromB64url(token.slice(dot + 1));
    const expected = new Uint8Array(await hmacSign(enc, secret));
    if (sig.byteLength !== expected.byteLength) return null;
    for (let i = 0; i < sig.byteLength; i++) if (sig[i] !== expected[i]) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(enc)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const CORS_H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
function cors(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_H)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_H } });
}

async function kvGet(env, key) {
  try { const v = await env.DISK_KV.get(key, 'text'); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function kvSet(env, key, val) {
  try {
    await env.DISK_KV.put(key, JSON.stringify(val));
    await kvBump(env);
    return true;
  } catch { return false; }
}
function kvDel(env, key) { return env.DISK_KV.delete(key); }

const KV_WRITE_DAILY_LIMIT = 1000;

function kvDayKey() {
  const d = new Date();
  return 'disk:usage:' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

async function kvBump(env) {
  const key = kvDayKey();
  const cur = await kvGet(env, key);
  const used = (cur && typeof cur.used === 'number' ? cur.used : 0) + 2;
  try { await env.DISK_KV.put(key, JSON.stringify({ used, date: key })); } catch {}
  return used;
}

async function kvUsage(env) {
  const cur = await kvGet(env, kvDayKey());
  return { used: cur && typeof cur.used === 'number' ? cur.used : 0, limit: KV_WRITE_DAILY_LIMIT };
}

const fromHex = h => { const p = h?.match(/.{1,2}/g); return p ? new Uint8Array(p.map(x => parseInt(x, 16))) : new Uint8Array(0); };
const toHex = arr => Array.from(new Uint8Array(arr)).map(x => x.toString(16).padStart(2, '0')).join('');

async function deriveKey(pw) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return crypto.subtle.importKey('raw', h, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptBuf(buf, pw) {
  const key = await deriveKey(pw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf));
  return { encrypted: enc.slice(0, -16), iv: toHex(iv), tag: toHex(enc.slice(-16)) };
}

async function decryptBuf(enc, ivHex, tagHex, pw) {
  const key = await deriveKey(pw);
  const iv = fromHex(ivHex);
  const tag = fromHex(tagHex);
  const c = new Uint8Array(enc.byteLength + 16);
  c.set(new Uint8Array(enc), 0);
  c.set(tag, enc.byteLength);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, c);
}

async function decryptBufFromChunks(chunks, pw, env) {
  const key = await deriveKey(pw);
  const bufs = [];
  for (const c of chunks) {
    const r = await fetchChunk(env, c);
    if (!r.ok) throw new Error('Chunk ' + r.status);
    const arr = await r.arrayBuffer();
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(c.iv) }, key, (() => { const u = new Uint8Array(arr.byteLength + 16); u.set(new Uint8Array(arr), 0); u.set(fromHex(c.tag), arr.byteLength); return u; })());
    bufs.push(new Uint8Array(dec));
  }
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const r = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) { r.set(b, o); o += b.length; }
  return r;
}

function whParse(url) {
  const m = url.match(/\/webhooks\/(\d+)\/([^/?#]+)/);
  if (m) return { id: m[1], token: m[2] };
  const s = url.split('/');
  const t = s[s.length - 1];
  const i = s[s.length - 2];
  if (i && t && /^\d+$/.test(i)) return { id: i, token: t };
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function whSend(whUrl, buffer, filename) {
  const wh = whParse(whUrl);
  if (!wh) throw new Error('Webhook URL invalide');
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(Math.min(500 * Math.pow(2, attempt), 8000));
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: '' }));
    form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    try {
      const r = await fetch(`https://discord.com/api/webhooks/${wh.id}/${wh.token}?wait=true`, { method: 'POST', body: form });
      if (r.ok) {
        const msg = await r.json();
        if (!msg.attachments?.[0]) throw new Error('Aucune attachment dans la réponse');
        return { messageId: msg.id, attachmentId: msg.attachments[0].id, url: msg.attachments[0].url, channelId: msg.channel_id };
      }
      const ra = parseInt(r.headers.get('Retry-After') || '0', 10);
      lastErr = new Error(`Webhook ${r.status}: ${(await r.text()).slice(0, 200)}`);
      if (r.status === 429 && ra) await sleep(Math.min(ra * 1000, 10000));
      else if (r.status === 429 || r.status >= 500) continue;
      break;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Webhook échec');
}

async function whGetMsg(whUrl, msgId) {
  const wh = whParse(whUrl);
  if (!wh) return null;
  try { const r = await fetch(`https://discord.com/api/webhooks/${wh.id}/${wh.token}/messages/${msgId}`); return r.ok ? await r.json() : null; } catch { return null; }
}

async function whDelMsg(whUrl, msgId) {
  const wh = whParse(whUrl);
  if (!wh) return;
  try { await fetch(`https://discord.com/api/webhooks/${wh.id}/${wh.token}/messages/${msgId}`, { method: 'DELETE' }); } catch {}
}

async function whRefreshUrl(whUrl, msgId) {
  if (!msgId) return null;
  const msg = await whGetMsg(whUrl, msgId);
  return msg?.attachments?.[0]?.url || null;
}

function getUser(request) {
  const m = (request.headers.get('Cookie') || '').match(/drive_sid=([^;]+)/);
  if (!m) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(m[1])));
    return p.exp && p.exp < Math.floor(Date.now() / 1000) ? null : p;
  } catch { return null; }
}

async function authUser(request, env) {
  const u = getUser(request);
  if (u) return u;
  const auth = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (auth) {
    const tokens = (await kvGet(env, 'disk:apptokens')) || [];
    const t = tokens.find(x => x.token === auth[1]);
    if (t) return { discordId: t.discordId, role: t.role || 'member', quotaRole: t.quotaRole || '' };
  }
  return null;
}

function diskQuota(user, env) {
  if (!user) return { limit: 0n, usage: 0n, role: 'Membre' };
  const GB = 1073741824n;
  const qr = user.quotaRole || user.role || 'member';
  let limit;
  if (qr === 'admin' || qr === 'vip') limit = -1n;        // VIP & admin = illimité
  else if (qr === 'moderator') limit = 500n * GB;          // modérateur = 500 Go
  else if (qr === 'member' || qr === 'user') limit = 100n * GB; // membre = 100 Go
  else limit = 0n;                                          // non vérifié / lecteur seul
  const isMod = user.role === 'moderator';
  return { limit, usage: 0n, role: isMod ? 'VIP' : 'Membre' };
}

function genId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
const SHARE_WORDS = ['lune','soleil','nuage','etoile','ocean','riviere','foret','vallee','montagne','ciel','vague','brise','neige','pluie','aube','midi','minuit','matin','soir','nuit','jour','feu','terre','pierre','sable','vent','orage','goutte','fleur','herbe','arbre','graine','fruit','claire','doux','bleu','vert','rouge','violet','ambre','jade','onyx','perle','corail','flamme','ombre','silence','horizon','velours','bronze','argent','cuivre','boussole','aventure','reve','merveille','bonheur','force','sagesse','courage','espoir','paix','joie','galaxie','comete','planete','photon','cosmos','univers','atome','vortex','cascade','source','dune','plaine','grotte','volcan','glacier'];
function shareId() {
  const w = () => SHARE_WORDS[Math.floor(Math.random() * SHARE_WORDS.length)];
  const b = crypto.getRandomValues(new Uint8Array(10));
  const ABC = '23456789abcdefghjkmnpqrstuvwxyz';
  const rnd = Array.from(b).map(x => ABC[x % ABC.length]).join('');
  return w() + '-' + w() + '-' + rnd;
}
function shareSlug(name) {
  const s = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'fichier';
}
function shareRnd() {
  const ABC = '23456789abcdefghjkmnpqrstuvwxyz';
  return Array.from(crypto.getRandomValues(new Uint8Array(5))).map(x => ABC[x % ABC.length]).join('');
}

async function handleAuth(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return json({ error: 'Token manquant' }, 400);
  const payload = await verifyToken(token, cfg(env).driveSecret);
  if (!payload) return json({ error: 'Token invalide' }, 401);
  const v = b64url(JSON.stringify(payload));
  const cookie = `drive_sid=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TOKEN_TTL}`;
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie, ...CORS_H } });
}

async function handleFetch(request) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ error: 'URL manquante' }, 400);
  try {
    const resp = await fetch(target);
    const h = new Headers(resp.headers);
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    h.delete('CF-Ray');
    return new Response(resp.body, { status: resp.status, headers: h });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function diskTree(env, discordId) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const userItems = items.filter(i => !i.uploadedBy || i.uploadedBy === discordId);
  return json({ items: userItems });
}

function genKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function diskConfig(env, user) {
  let config = (await kvGet(env, 'disk:config')) || { diskKey: '' };
  if (!config.diskKey) { config.diskKey = genKey(); await kvSet(env, 'disk:config', config); }
  const c = cfg(env);
  const q = diskQuota(user, env);
  const items = (await kvGet(env, 'disk:items')) || [];
  const usage = items.filter(i => i.type === 'file' && (!i.uploadedBy || i.uploadedBy === user?.discordId)).reduce((s, i) => s + (i.size || 0), 0);
  const role = user?.role || '';
  const quotaRole = user?.quotaRole || role || 'member';
  const priv = ['admin', 'vip', 'moderator'].includes(quotaRole);
  return json({ quota: { role: q.role, limit: q.limit.toString(), usage: usage.toString() }, key: config.diskKey, webhook: c.webhookUrl || '', appUrl: env.DISK_APP_URL || config.appUrl || '', kvUsage: await kvUsage(env), isVip: !!(user && priv), role, quotaRole, canImport: !!user, panelUrl: c.railwayUrl || '' });
}

async function diskTokenCreate(env, user) {
  const tokens = (await kvGet(env, 'disk:apptokens')) || [];
  const token = genId() + genId();
  tokens.push({ token, discordId: user.discordId, role: user.role || 'member', quotaRole: user.quotaRole || '', createdAt: new Date().toISOString() });
  const ok = await kvSet(env, 'disk:apptokens', tokens);
  if (!ok) return json({ error: 'Écriture KV impossible' }, 500);
  return json({ token, success: true, discordId: user.discordId, role: user.role || 'member', quotaRole: user.quotaRole || '', displayName: user.displayName || user.username || '', username: user.username || '' });
}
async function diskTokenRevoke(env, discordId) {
  const tokens = (await kvGet(env, 'disk:apptokens')) || [];
  await kvSet(env, 'disk:apptokens', tokens.filter(t => t.discordId !== discordId));
  return json({ success: true });
}

async function diskChunks(env, id, discordId) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const file = items.find(i => i.id === id && i.type === 'file');
  if (!file) return json({ error: 'Introuvable' }, 404);
  if (file.uploadedBy && file.uploadedBy !== discordId) return json({ error: 'Pas ton fichier' }, 403);
  return json({ chunks: file.chunks || [], mime: file.mime, name: file.name, size: file.size });
}

async function diskComplete(body, env, discordId) {
  try {
  const config = (await kvGet(env, 'disk:config')) || { diskKey: '' };
  if (!config.diskKey) return json({ error: 'Disk key non configurée' }, 500);
  const name = (body?.name || '').toString().split('/').pop().split('\\').pop();
  const label = (body?.label || '').toString().slice(0, 120);
  const chunks = Array.isArray(body?.chunks) ? body.chunks.filter(ch => ch && ch.url && ch.iv && ch.tag && typeof ch.index === 'number') : [];
  if (!name || !chunks.length) return json({ error: 'Données incomplètes' }, 400);
  chunks.sort((a, b) => a.index - b.index);
  const items = (await kvGet(env, 'disk:items')) || [];
  const now = new Date().toISOString();
  const replaceId = body?.replaceId || null;
  if (replaceId) {
    const existing = items.find(i => i.id === replaceId && i.type === 'file');
    if (!existing) return json({ error: 'Fichier d\'origine introuvable' }, 404);
    if (existing.uploadedBy && existing.uploadedBy !== discordId) return json({ error: 'Non autorisé à remplacer ce fichier' }, 403);
    const c = cfg(env);
    for (const ch of existing.chunks || []) if (ch.messageId) await whDelMsg(c.webhookUrl, ch.messageId);
    existing.name = name;
    existing.size = parseInt(body?.size || '0', 10) || 0;
    existing.mime = (body?.mime || 'application/octet-stream').toString();
    existing.chunks = chunks;
    existing.updatedAt = now;
    existing.updatedBy = discordId;
    if (label) existing.label = label;
    const ok = await kvSet(env, 'disk:items', items);
    if (!ok) return json({ error: 'Quota d\'écriture KV atteint, réessaie plus tard' }, 500);
    return json({ success: true, id: replaceId, replaced: true });
  }
  const id = genId();
  const item = { id, type: 'file', name, size: parseInt(body?.size || '0', 10) || 0, mime: (body?.mime || 'application/octet-stream').toString(), parentId: body?.parentId || null, chunks, uploadedBy: discordId, uploadedAt: now, updatedAt: now };
  if (label) item.label = label;
  const origMatch = (i, base) => i.type === 'file' && i.id !== id && (i.parentId || null) === (body?.parentId || null) && i.name.replace(/\.[^.]+$/, '').toLowerCase() === base.toLowerCase();
  // Rendition vidéo : Base_720p.mp4  ou  Base_720p_a2.mp4 (piste audio 2)
  const rm = name.match(/^(.*?)_(\d{3,4}p)(?:_a(\d+))?\.([a-zA-Z0-9]+)$/);
  if (rm) {
    const base = rm[1];
    const q = rm[2].toLowerCase();
    const audioTrack = rm[3] ? parseInt(rm[3], 10) : null;
    const orig = items.find(i => origMatch(i, base));
    if (orig) { item.renditionOf = orig.id; item.quality = q; if (audioTrack) item.audioTrack = audioTrack; }
  }
  // Sous-titres : Base_sub1.vtt / Base_sub2.srt …
  const sm = name.match(/^(.*?)_sub(\d+)\.(vtt|srt)$/i);
  if (sm) {
    const base = sm[1];
    const orig = items.find(i => origMatch(i, base));
    if (orig) { item.subtitleOf = orig.id; item.subtitleIndex = parseInt(sm[2], 10); item.mime = sm[3].toLowerCase() === 'vtt' ? 'text/vtt' : 'application/x-subrip'; }
  }
  items.push(item);
  if (item.renditionOf) { const o = items.find(i => i.id === item.renditionOf); console.log('[disk] RENDITION ' + item.quality + ' créée pour « ' + (o?.name || item.renditionOf) + ' » (original ' + (o?.size || 0) + ' octets)'); }
  else if ((parseInt(body?.size || '0', 10) || 0) > 31457280) console.log('[disk] VIDÉO ' + (parseInt(body?.size || '0', 10) || 0) + ' octets uploadée SANS version visible : « ' + name + ' » — vérifier que des RENDITION suivent dans les logs.');
  const ok = await kvSet(env, 'disk:items', items);
  if (!ok) return json({ error: 'Quota d\'écriture KV atteint, réessaie plus tard' }, 500);
  return json({ success: true, id });
  } catch (e) { return json({ error: e.message }, 500); }
}

async function diskMkdir(body, env, discordId) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const id = genId();
  const now = new Date().toISOString();
  items.push({ id, type: 'folder', name: body.name || 'Nouveau dossier', parentId: body.parentId || null, uploadedBy: discordId, uploadedAt: now, updatedAt: now });
  await kvSet(env, 'disk:items', items);
  return json({ success: true, id, name: body.name || 'Nouveau dossier' });
}

async function diskDelete(env, id, discordId) {
  try {
  const items = (await kvGet(env, 'disk:items')) || [];
  const ids = new Set();
  const collect = id => { ids.add(id); items.filter(i => i.parentId === id).forEach(i => collect(i.id)); };
  collect(id);
  const toDel = items.filter(i => ids.has(i.id));
  const c = cfg(env);
  for (const item of toDel) {
    if (item.uploadedBy && item.uploadedBy !== discordId) continue;
    if (item.chunks) for (const ch of item.chunks) if (ch.messageId) await whDelMsg(c.webhookUrl, ch.messageId);
  }
  const remaining = items.filter(i => !ids.has(i.id));
  const ok = await kvSet(env, 'disk:items', remaining);
  if (!ok) return json({ error: 'Quota d\'écriture KV atteint, réessaie plus tard' }, 500);
  return json({ success: true });
  } catch (e) { return json({ error: e.message }, 500); }
}

async function diskRename(env, id, name) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const item = items.find(i => i.id === id);
  if (!item) return json({ error: 'Introuvable' }, 404);
  item.name = name;
  item.updatedAt = new Date().toISOString();
  await kvSet(env, 'disk:items', items);
  return json({ success: true });
}

async function diskMove(env, id, parentId) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const item = items.find(i => i.id === id);
  if (!item) return json({ error: 'Introuvable' }, 404);
  item.parentId = parentId || null;
  item.updatedAt = new Date().toISOString();
  await kvSet(env, 'disk:items', items);
  return json({ success: true });
}

async function diskShares(env, discordId) {
  const shares = (await kvGet(env, 'disk:shares')) || [];
  const items = (await kvGet(env, 'disk:items')) || [];
  const userShares = shares.filter(s => s.owner === discordId || s.createdBy === discordId);
  return json({ shares: userShares.map(s => ({ ...s, file: items.find(i => i.id === s.fileId) || null })) });
}

async function diskSharedWithMe(env, discordId, user) {
  const shares = (await kvGet(env, 'disk:shares')) || [];
  const items = (await kvGet(env, 'disk:items')) || [];
  const norm = x => (x || '').toString().trim().toLowerCase();
  const me = norm(user?.displayName || user?.username);
  const inbound = shares.filter(s => s.owner !== discordId && (
    s.everyone === true ||
    (s.targetUserId && s.targetUserId === discordId) ||
    (s.targetUser && (norm(user?.discordId) === norm(s.targetUser) || (me && (norm(s.targetUser) === me))))
  ));
  return json({ shares: inbound.map(s => ({ ...s, file: items.find(i => i.id === s.fileId) || null })) });
}

function diskCollectFolderFiles(items, folderId) {
  const ids = [];
  const collect = pid => { items.filter(i => i.parentId === pid).forEach(i => { ids.push(i.id); if (i.type === 'folder') collect(i.id); }); };
  collect(folderId);
  return items.filter(i => ids.includes(i.id) && i.type === 'file');
}

async function diskShareCreate(body, env, discordId, userName) {
  try {
  const shares = (await kvGet(env, 'disk:shares')) || [];
  const items = (await kvGet(env, 'disk:items')) || [];
  const file = items.find(i => i.id === body.fileId);
  if (!file) return json({ error: 'Fichier introuvable' }, 404);
  if (file.uploadedBy && file.uploadedBy !== discordId) return json({ error: 'Pas ton fichier' }, 403);
  const isFolder = file.type === 'folder';
  let id = shareSlug(file.name) + '-' + shareRnd();
  { let guard = 0; while (shares.some(s => s.id === id) && guard++ < 8) id = shareSlug(file.name) + '-' + shareRnd(); }
  const files = isFolder ? diskCollectFolderFiles(items, file.id) : [];
  const share = {
    id, type: isFolder ? 'folder' : 'file', fileId: file.id,
    fileName: file.name, fileSize: isFolder ? files.reduce((s, f) => s + (f.size || 0), 0) : file.size, fileMime: file.mime,
    folderName: isFolder ? file.name : null, files: files.map(f => ({ fileId: f.id, fileName: f.name, fileSize: f.size, fileMime: f.mime })),
    createdBy: discordId, owner: discordId, createdByName: userName || '', createdAt: new Date().toISOString(),
    maxAccess: parseInt(body.maxAccess || 0, 10) || 0, accessCount: 0,
    password: body.password ? b64url(body.password) : null,
    expiresAt: parseInt(body.expiresIn || 0) > 0 ? new Date(Date.now() + parseInt(body.expiresIn) * 1000).toISOString() : null,
    targetUser: body.targetUser ? String(body.targetUser).trim() : null,
    targetUserId: body.targetUserId ? String(body.targetUserId).trim() : null,
    everyone: !!body.everyone,
    videoMode: body.videoMode === 'player' ? 'player' : 'normal',
  };
  shares.push(share);
  await kvSet(env, 'disk:shares', shares);
  return json({ success: true, id, link: '/share/' + id, share });
  } catch (e) { return json({ error: e.message }, 500); }
}

async function diskShareDelete(env, id, discordId) {
  let shares = (await kvGet(env, 'disk:shares')) || [];
  const s = shares.find(x => x.id === id);
  if (!s) return json({ error: 'Partage introuvable' }, 404);
  if (s.owner && s.owner !== discordId) return json({ error: 'Pas ton partage' }, 403);
  shares = shares.filter(x => x.id !== id);
  await kvSet(env, 'disk:shares', shares);
  return json({ success: true });
}

async function diskShareFind(env, id) {
  const shares = (await kvGet(env, 'disk:shares')) || [];
  return shares.find(x => x.id === id) || null;
}

async function diskShareVerify(body, env) {
  const s = await diskShareFind(env, (body.shareId || '').toString());
  if (!s) return json({ error: 'Partage introuvable' }, 404);
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return json({ error: 'Ce lien a expiré' }, 403);
  if (s.maxAccess > 0 && s.accessCount >= s.maxAccess) return json({ error: 'Accès maximal atteint' }, 403);
  if (s.password && b64url((body.password || '').toString()) !== s.password) return json({ error: 'Mot de passe incorrect' }, 403);
  const fileId = (body.fileId || s.fileId || '').toString();
  const secret = cfg(env).driveSecret;
  const enc = b64url(JSON.stringify({ shareId: s.id, fileId, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = b64url(await hmacSign(enc, secret));
  return json({ success: true, token: enc + '.' + sig, type: s.type, fileName: s.fileName, folderName: s.folderName, fileSize: s.fileSize, fileMime: s.fileMime, files: s.files || [], accessCount: s.accessCount, maxAccess: s.maxAccess, hasPassword: !!s.password });
}

async function diskSharedDownload(env, token, rangeHeader, inline) {
  if (!token) return json({ error: 'Token manquant' }, 401);
  const p = await verifyToken(token, cfg(env).driveSecret);
  if (!p || !p.shareId) return json({ error: 'Lien invalide ou expiré' }, 401);
  const s = await diskShareFind(env, p.shareId);
  if (!s) return json({ error: 'Partage introuvable' }, 404);
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return json({ error: 'Lien expiré' }, 403);
  if (s.maxAccess > 0 && s.accessCount >= s.maxAccess) return json({ error: 'Accès maximal atteint' }, 403);
  const items = (await kvGet(env, 'disk:items')) || [];
  let file;
  if (s.type === 'folder') {
    const fid = p.fileId || '';
    const allowed = new Set((s.files || []).map(f => f.fileId));
    if (!fid || !allowed.has(fid)) return json({ error: 'Fichier introuvable' }, 404);
    file = items.find(i => i.id === fid && i.type === 'file');
  } else {
    const fid = p.fileId || s.fileId;
    file = items.find(i => i.id === fid && i.type === 'file' && (i.id === s.fileId || i.renditionOf === s.fileId || i.subtitleOf === s.fileId));
  }
  if (!file) return json({ error: 'Fichier introuvable' }, 404);
  if (inline && diskMimeFor(file.name, file.mime).startsWith('video/')) {
    const rends = items.filter(i => i.renditionOf === file.id);
    if (rends.length) {
      rends.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
      file = rends[0];
    }
  }
  if (!rangeHeader || rangeHeader === 'bytes=0-') {
    s.accessCount++;
    await kvSet(env, 'disk:shares', (await kvGet(env, 'disk:shares') || []).map(x => x.id === s.id ? s : x));
  }
  return serveFileChunks(env, file, rangeHeader, inline);
}

function shareHtml(env, s, rendInfo) {
  const esc = x => (x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = n => { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return v.toFixed(i > 0 ? 1 : 0) + ' ' + u[i]; };
  if (!s) return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Partage</title></head><body style="background:#313338;color:#dbdee1;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="background:#2b2d31;border:1px solid #3f4147;border-radius:12px;padding:40px;text-align:center"><div style="font-size:48px">🔒</div><h1>Lien introuvable</h1><p style="color:#949ba4">Ce partage n\'existe plus.</p></div></body></html>';
  const expired = s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
  const maxed = s.maxAccess > 0 && s.accessCount >= s.maxAccess;
  const isFolder = s.type === 'folder';
  const name = esc(isFolder ? (s.folderName || s.fileName || 'Dossier') : (s.fileName || 'Fichier'));
  const sid = esc(s.id);
  const hasPw = !!s.password;
  const shareName = esc(s.createdByName || s.owner || 'BLT Drive');
  const effMime = diskMimeFor(s.fileName || '', s.fileMime || '');
  const isImage = effMime.indexOf('image/') === 0;
  const isAudio = effMime.indexOf('audio/') === 0;
  const isVideo = effMime.indexOf('video/') === 0;
  const filesRows = (s.files || []).map(f => '<div class="file-item" onclick="downloadFile(\'' + sid + '\', \'' + esc(f.fileId) + '\')"><span>📦</span><span class="name">' + esc(f.fileName) + '</span><span class="size">' + fmt(f.fileSize) + '</span></div>').join('');
  const qs = (rendInfo && rendInfo.quals) || [];
  const atracks = (rendInfo && rendInfo.audioTracks) || [];
  const subs = (rendInfo && rendInfo.subtitles) || [];
  const hasVideoRends = isVideo && qs.length > 0;
  const playerMode = isVideo && s.videoMode === 'player' && hasVideoRends;
  const qbar = hasVideoRends ? '<div class="qbar"><button class="qbtn qauto" id="qauto" onclick="previewAuto(this)">⚡ Auto</button>' + qs.map((q, i) => '<button class="qbtn' + (i === 0 ? ' active' : '') + '" data-q="' + q.id + '" onclick="previewQ(this)">' + (q.quality === '720p' ? 'HD 720p' : 'SD ' + q.quality) + '</button>').join('') + '</div>' : '';
  const abar = atracks.length > 1 ? '<span class="tlbl">🎙️ Audio</span>' + atracks.map(a => '<button class="qbtn abtn' + (a.track === 1 ? ' active' : '') + '" data-a="' + a.track + '" onclick="previewTrack(\'' + a.id + '\',this)">' + (a.label ? esc(a.label) : 'Piste ' + a.track) + '</button>').join('') : '';
  const sbar = subs.length ? '<span class="tlbl">💬 Sous-titres</span><button class="qbtn sbtn active" data-sub="" onclick="previewSub(null,this)">Aucun</button>' + subs.map(x => '<button class="qbtn sbtn" data-sub="' + x.id + '" onclick="previewSub(\'' + x.id + '\',this)">' + (x.label ? esc(x.label) : 'Sous-titre ' + (x.index || 1)) + '</button>').join('') : '';
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + name + ' — BLT Drive</title><style>'
    + '*{margin:0;padding:0;box-sizing:border-box}body{background:#313338;color:#dbdee1;font-family:"gg sans","Noto Sans",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.pbody{width:100%;min-height:100vh;background:#0d0e12;display:flex;flex-direction:column;padding:0}.ptop{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 22px;background:#16171d;border-bottom:1px solid #26272e}.pt-title{font-size:17px;font-weight:700;color:#f2f3f5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pt-sub{font-size:12px;color:#949ba4}.ptop .err{display:block;max-width:420px;text-align:left}.pstage{flex:1;display:flex;align-items:center;justify-content:center;background:#000;min-height:0}.pstage .preview{width:100%;height:100%;display:flex;align-items:center;justify-content:center;margin:0;border-radius:0;background:#000}.pstage{position:relative}.pstage #pv{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}.pstage #pv .preview{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000;margin:0;overflow:visible;border-radius:0}.pstage #pv .preview video{width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;background:#000}.pbar{display:flex;align-items:center;gap:10px;padding:12px 22px;background:#16171d;border-top:1px solid #26272e}.pbar .qbar{margin:0;flex:1;display:flex;gap:8px;flex-wrap:wrap}.pbar .qbtn{flex:none;min-width:80px;padding:10px 14px;font-size:13px;border-radius:8px;background:#23242c;border:1px solid #33343d;color:#dbdee1;cursor:pointer;font-family:inherit}.pbar .qbtn.active{background:#5865F2;border-color:#5865F2;color:#fff;font-weight:600}.pbar .tlbl{font-size:11px;font-weight:700;color:#949ba4;text-transform:uppercase;letter-spacing:.4px;align-self:center;margin-right:2px}.qbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.qbar .qbtn,.qbtn{min-width:80px;padding:10px 14px;font-size:13px;border-radius:8px;background:#23242c;border:1px solid #33343d;color:#dbdee1;cursor:pointer;font-family:inherit}.qbar .qbtn.active,.qbtn.active{background:#5865F2;border-color:#5865F2;color:#fff;font-weight:600}.tlbl{font-size:11px;font-weight:700;color:#949ba4;text-transform:uppercase;letter-spacing:.4px;align-self:center;margin-right:2px}.pbar .pdl{flex:none;margin:0;width:auto;padding:10px 22px;border-radius:8px}.card{background:#2b2d31;border:1px solid #3f4147;border-radius:12px;padding:36px;width:560px;max-width:92vw}.icon{font-size:48px;margin-bottom:12px}h1{font-size:20px;margin-bottom:4px;color:#f2f3f5}.sub{color:#949ba4;font-size:13px;margin-bottom:20px}.status{padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:18px}.status-err{background:rgba(218,55,60,.1);color:#da373c;border:1px solid rgba(218,55,60,.3)}.info{background:#1e1f22;border-radius:8px;padding:14px;margin-bottom:20px}.row{display:flex;justify-content:space-between;padding:5px 0;font-size:14px}.row .l{color:#949ba4}.row .v{font-weight:500}.file-list{margin-top:8px}.file-item{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1e1f22;border-radius:6px;margin-bottom:6px;cursor:pointer}.file-item:hover{background:#2b2d31}.file-item .name{flex:1;font-size:13px}.file-item .size{color:#949ba4;font-size:12px}.pw{margin:16px 0 8px}.pw input{width:100%;padding:10px;border:1px solid #3f4147;border-radius:4px;background:#1e1f22;color:#dbdee1;font-size:14px;outline:none;margin-bottom:12px}.btn{display:block;width:100%;background:#5865F2;color:#fff;border:none;padding:12px;border-radius:4px;font-size:14px;font-weight:500;cursor:pointer;text-align:center;margin-top:8px;font-family:inherit}.btn:hover{background:#4752c4}.btn2{background:#313338;border:1px solid #3f4147}.qbar{display:flex;gap:6px;margin:10px 0}.qbtn{flex:1;background:#313338;border:1px solid #3f4147;color:#dbdee1;padding:8px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}.qbtn.active{background:#5865F2;border-color:#5865F2}.preview{margin-top:16px;background:#1e1f22;border-radius:8px;overflow:hidden}.preview img,.preview video{max-width:100%;max-height:500px;display:block;margin:0 auto}.preview audio{width:100%;padding:16px}.preview pre{margin:0;padding:16px;font-size:12px;max-height:400px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#dbdee1}.err{background:rgba(218,55,60,.1);color:#da373c;padding:10px;border-radius:4px;font-size:13px;margin:10px 0;border:1px solid rgba(218,55,60,.3);display:none}.acc{color:#5c5f66;font-size:12px;text-align:center;margin-top:14px}'
+ '</style></head><body>'
    + (playerMode
        ? '<div class="pbody"><div class="ptop"><div class="pt-title">' + (isFolder ? '📁' : '🎬') + ' ' + name + '</div><div class="pt-sub">Partagé par <strong>' + shareName + '</strong></div></div>'
          + '<div class="err" id="err"></div>'
          + (hasPw ? '<div class="pw"><input type="password" id="pw" placeholder="Mot de passe requis"></div>' : '')
          + '<div class="pstage" id="pstage"><div id="pv"></div></div>'
          + '<div class="pbar">' + qbar + abar + sbar + '<button class="btn btn2 pdl" onclick="downloadFile()">⬇️ Télécharger</button></div>'
          + '<div class="acc">' + s.accessCount + (s.maxAccess > 0 ? '/' + s.maxAccess : '') + ' accès</div></div>'
        : (expired ? '<div class="card"><div class="icon">🔒</div><h1>Lien expiré</h1><div class="status status-err">⛔ Ce lien de partage a expiré.</div></div>'
          : maxed ? '<div class="card"><div class="icon">🔒</div><h1>Accès maximal atteint</h1><div class="status status-err">⛔ Ce lien a atteint le nombre maximal d\'accès.</div></div>'
          : '<div class="card"><div class="icon">' + (isFolder ? '📁' : '📦') + '</div>'
            + '<h1>' + name + '</h1><p class="sub">Partagé par <strong>' + shareName + '</strong></p>'
            + '<div class="err" id="err"></div>'
            + (hasPw ? '<div class="pw"><input type="password" id="pw" placeholder="Mot de passe requis"></div>' : '')
            + (isFolder
                ? '<div class="info"><div class="row"><span class="l">Dossier</span><span class="v">' + esc(s.folderName || '') + '</span></div><div class="row"><span class="l">Fichiers</span><span class="v">' + (s.files || []).length + '</span></div></div>'
                  + '<div class="file-list">' + filesRows + '</div>'
                  + (hasPw ? '<button class="btn" onclick="unlockFolder()">🔓 Déverrouiller</button>' : '')
                : '<div class="info"><div class="row"><span class="l">Nom</span><span class="v">' + esc(s.fileName || '') + '</span></div><div class="row"><span class="l">Taille</span><span class="v">' + fmt(s.fileSize) + '</span></div></div>'
                  + (isVideo && !hasVideoRends
                      ? '<div style="display:flex;align-items:center;justify-content:center;min-height:140px;background:#1e1f22;border-radius:8px;margin:12px 0"><div style="text-align:center;color:#949ba4;font-size:13px;padding:16px"><div style="font-size:30px;margin-bottom:6px">🎬</div>Preview indisponible</div></div>'
                      : '<div id="pv"></div>')
                  + (isVideo && !hasVideoRends
                      ? ''
                      : isVideo && hasVideoRends
                        ? qbar + (abar ? '<div class="qbar">' + abar + '</div>' : '') + (sbar ? '<div class="qbar">' + sbar + '</div>' : '') + '<button class="btn" id="btnView" onclick="previewFile()">▶️ Lire le fichier</button>'
                        : '<button class="btn" id="btnView" onclick="previewFile()">👁️ Voir le fichier</button>')
                    + '<button class="btn btn2" onclick="downloadFile()">⬇️ Télécharger</button>')
            + '<div class="acc">' + s.accessCount + (s.maxAccess > 0 ? '/' + s.maxAccess : '') + ' accès</div></div>'))
    + '<script>var SID=' + JSON.stringify(s.id) + ';var HAS_PW=' + (hasPw ? 'true' : 'false') + ';var MIME=' + JSON.stringify(effMime) + ';var FNAME=' + JSON.stringify(s.fileName || '') + ';var IS_VIDEO=' + (isVideo ? 'true' : 'false') + ';var IS_PLAYER=' + (playerMode ? 'true' : 'false') + ';var FSIZE=' + (s.fileSize || 0) + ';var QS=' + JSON.stringify(qs) + ';var ATRACKS=' + JSON.stringify(atracks) + ';var SUBS=' + JSON.stringify(subs) + ';var ACTIVE_TRACK=1;var ACTIVE_SUB=null;'
    + 'function getToken(password,fileId){return fetch("/api/disk/shares/"+SID+"/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shareId:SID,password:password||"",fileId:fileId||null})}).then(r=>r.json()).then(d=>{if(!d.success){document.getElementById("err").style.display="block";document.getElementById("err").textContent=d.error;return null;}return d.token;});}'
    + 'function showErr(m){var e=document.getElementById("err");if(e){e.style.display="block";e.textContent=m;}}'
    + 'async function previewFile(qid){var pw=document.getElementById("pw");var t=await getToken(pw?pw.value:"",qid||null);if(!t)return;var url="/api/disk/shared/download/"+t+"?inline=1";var area=document.getElementById("pv");if(!area)return;if(MIME.indexOf("image/")===0){area.innerHTML=\'<div class="preview"><img src="\'+url+\'"></div>\';}else if(MIME.indexOf("video/")===0||MIME.indexOf("audio/")===0){var el=MIME.indexOf("audio/")===0?"audio":"video";var prevV=area.querySelector(el);var prevT=prevV&&!isNaN(prevV.currentTime)?prevV.currentTime:0;var html=\'<div class="preview"><\'+el+\' controls autoplay playsinline src="\'+url+\'"\'+(el==="video"&&SUBS.length?\' data-subs="1" style="width:100%;max-height:78vh"\':\'style="max-width:100%"\')+\'></\'+el+\'></div>\';area.innerHTML=html;var m=area.querySelector(el);if(m){attachSubs(m);if(prevT>0)m.addEventListener("loadedmetadata",function(){try{if(m.currentTime>0)return;m.currentTime=prevT;}catch(e){}});m.onerror=function(){showErr("Cette version ne peut pas se lire dans ce navigateur.");};if(autoOn)autoWatch();}}else if(MIME.indexOf("text/")===0||/\\.(txt|md|json|js|ts|html|css|xml|yml|yaml|sh|bat|py|rb|php|java|c|cpp|h|rs|go|sql|log)$/i.test(FNAME)){fetch(url).then(r=>r.text()).then(txt=>{area.innerHTML=\'<div class="preview"><pre>\'+txt.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+\'</pre></div>\';}).catch(function(){showErr("Erreur de prévisualisation");});}else{window.location.href=url;}}'
    + 'function attachSubs(m){if(!m||m.tagName!=="VIDEO"||!SUBS.length)return;for(var i=0;i<SUBS.length;i++){var x=SUBS[i];(function(sub){var pw=document.getElementById("pw");getToken(pw?pw.value:"",sub.id).then(function(t){if(!t)return;var tr=document.createElement("track");tr.kind="subtitles";tr.label=sub.label?sub.label:("Sous-titre "+(sub.index||1));tr.srclang="";tr.src="/api/disk/shared/download/"+t+"?inline=1";tr.setAttribute("data-sub",sub.id);m.appendChild(tr);if(String(sub.id)===String(ACTIVE_SUB)){try{tr.track.mode="showing";}catch(e){}}}).catch(function(){});})(x);}}'
    + 'function previewTrack(id,btn){var a=document.querySelectorAll(".abtn");for(var i=0;i<a.length;i++)a[i].classList.remove("active");if(btn)btn.classList.add("active");var t=id||1;if(t!==ACTIVE_TRACK){ACTIVE_TRACK=t;}var track=null;for(var j=0;j<ATRACKS.length;j++){if(ATRACKS[j].track===t){track=ATRACKS[j];break;}}if(track){autoOff();previewFile(track.id);}}'
    + 'function previewSub(id,btn){ACTIVE_SUB=id||null;var a=document.querySelectorAll(".sbtn");for(var i=0;i<a.length;i++)a[i].classList.toggle("active",a[i].getAttribute("data-sub")===String(id||""));var m=document.querySelector("#pv video");if(m){var ts=m.querySelectorAll("track");for(var k=0;k<ts.length;k++){if(ts[k].kind==="subtitles"){try{ts[k].track.mode=(id!=null&&ts[k].getAttribute("data-sub")===String(id))?"showing":"hidden";}catch(e){}}}}}'
    + 'function previewQRaw(b){var a=document.querySelectorAll(".qbtn");for(var i=0;i<a.length;i++)a[i].classList.remove("active");var ab=document.getElementById("qauto");if(autoOn&&ab){ab.classList.add("active");}else if(b){b.classList.add("active");}previewFile(b&&b.dataset.q?b.dataset.q:null);}'
    + 'function previewQ(b){autoOff();previewQRaw(b);}'
    + 'var autoOn=false,autoIdx=0,autoTimer=null,autoStable=0,autoSwitchTo=null;'
    + 'function autoOff(){autoOn=false;if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}autoStable=0;}'
    + 'function autoWatch(){if(!autoOn)return;var m=document.querySelector("#pv video")||document.querySelector("#pv audio");if(!m)return;var down=function(){if(!autoOn||autoIdx>=QS.length-1)return;autoIdx++;var q=QS[autoIdx];if(!q)return;autoSwitchTo=q.id;previewQRaw(document.querySelector(\'.qbtn[data-q="\'+q.id+\'"]\'));};var up=function(){if(!autoOn||autoIdx<=0)return;autoIdx--;var q=QS[autoIdx];if(!q)return;autoSwitchTo=q.id;previewQRaw(document.querySelector(\'.qbtn[data-q="\'+q.id+\'"]\'));};m.onwaiting=function(){autoStable=0;if(autoTimer)clearTimeout(autoTimer);autoTimer=setTimeout(down,900);};m.onstalled=function(){autoStable=0;if(autoTimer)clearTimeout(autoTimer);autoTimer=setTimeout(down,900);};m.ontimeupdate=function(){if(m.paused)return;if(!autoStable)autoStable=Date.now();if(Date.now()-autoStable>12000&&autoIdx>0){autoStable=Date.now();up();}};}'
    + 'function previewAuto(b){var a=document.querySelectorAll(".qbtn");for(var i=0;i<a.length;i++)a[i].classList.remove("active");if(b)b.classList.add("active");autoOn=true;autoIdx=0;autoStable=Date.now();var q=QS[0];if(q){previewFile(q.id);}else{previewFile(null);}setTimeout(autoWatch,1200);}'
    + 'async function downloadFile(fid){var pw=document.getElementById("pw");var t=await getToken(pw?pw.value:"",fid||null);if(!t)return;window.location.href="/api/disk/shared/download/"+t;}'
    + 'function showSt(m){var e=document.getElementById("err");if(e){e.style.display="block";e.style.background="rgba(88,101,242,.12)";e.style.color="#dbdee1";e.textContent=m;}}'
    + 'function shareLoadFFmpeg(){return new Promise(function(resolve,reject){var load=function(u){return new Promise(function(res,rej){var s=document.createElement("script");s.src=u;s.onload=res;s.onerror=function(){rej(new Error("Impossible de charger "+u));};document.head.appendChild(s);});};load("/vendor/@ffmpeg/util@0.12.1/dist/umd/index.js").then(function(){return load("/vendor/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js");}).then(resolve).catch(reject);});}'
    + 'async function shareGrabVideo(){var pw=document.getElementById("pw");var t=await getToken(pw?pw.value:"",null);if(!t)return;var btn=document.getElementById("btnGrab");if(btn){btn.disabled=true;}try{showSt("Téléchargement du fichier…");var resp=await fetch("/api/disk/shared/download/"+t);if(!resp.ok)throw new Error("Téléchargement impossible ("+resp.status+")");var buf=await resp.arrayBuffer();showSt("Chargement du convertisseur…");await shareLoadFFmpeg();var ffmpeg=new FFmpegWASM.FFmpeg();ffmpeg.on("log",function(ev){if(ev.message){var m=String(ev.message).split("\\n").pop();if(m&&m.indexOf("frame=")>-1)showSt(m);}});await ffmpeg.load({coreURL:"/vendor/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",wasmURL:"/vendor/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm"});var ext=(FNAME.split(".").pop()||"bin").toLowerCase();await ffmpeg.writeFile("input."+ext,new Uint8Array(buf));var isVideoOut=true;try{showSt("Conversion en H.264 (720p max)…");await ffmpeg.exec(["-i","input."+ext,"-c:v","libx264","-preset","veryfast","-crf","28","-pix_fmt","yuv420p","-vf","scale=-2:min(720\\,ih)","-c:a","aac","-b:a","96k","-movflags","+faststart","-tag:v","avc1","-y","out.mp4"]);}catch(e){isVideoOut=false;showSt("Aucune piste vidéo — conversion audio…");await ffmpeg.exec(["-i","input."+ext,"-c:a","aac","-b:a","128k","-vn","-movflags","+faststart","-y","out.mp4"]);}var data=await ffmpeg.readFile("out.mp4");try{await ffmpeg.terminate();}catch(e){}var blob=new Blob([data],{type:"video/mp4"});var u=URL.createObjectURL(blob);var area=document.getElementById("pv");if(area){if(isVideoOut){area.innerHTML=\'<div class="preview"><video controls autoplay src="\'+u+\'"></video></div>\';}else{area.innerHTML=\'<div class="preview"><audio controls autoplay src="\'+u+\'"></audio></div>\';}}if(btn){btn.style.display="none";}var e=document.getElementById("err");if(e)e.style.display="none";}catch(err){showErr(err.message||String(err));if(btn){btn.disabled=false;}}}'
    + 'async function unlockFolder(){var pw=document.getElementById("pw");var t=await getToken(pw?pw.value:"",null);if(t){var p=document.querySelector(".pw");if(p)p.style.display="none";var b=document.querySelector(".btn");if(b)b.style.display="none";}}'
    + 'document.addEventListener("DOMContentLoaded",function(){' + (playerMode ? 'setTimeout(function(){var q=document.querySelector(".qbtn");if(q)q.click();},250);' : '') + 'var i=document.getElementById("pw");if(i){i.addEventListener("keydown",function(e){if(e.key==="Enter"){if(HAS_PW){var fb=document.querySelector(".btn");if(fb&&fb.getAttribute("onclick")&&fb.getAttribute("onclick").indexOf("unlockFolder")>-1){unlockFolder();return;}}if(document.getElementById("btnView"))previewFile();}});}});'
    + 'if(location.search.indexOf("dl=1")>-1){setTimeout(function(){downloadFile();},150);}'
    + '</script></body></html>';
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ data[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function zipEntryHeader(fn, crc, size, offset, isDir) {
  const lh = new Uint8Array(30 + fn.length);
  const v = new DataView(lh.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
  v.setUint16(8, 0, true); v.setUint16(10, 0, true); v.setUint16(12, 0, true);
  v.setUint32(14, crc, true); v.setUint32(18, size, true); v.setUint32(22, size, true);
  v.setUint16(26, fn.length, true); lh.set(fn, 30);
  return lh;
}

function zipCdEntry(fn, crc, size, offset, isDir) {
  const cd = new Uint8Array(46 + fn.length);
  const c = new DataView(cd.buffer);
  c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
  c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, 0, true);
  c.setUint16(14, 0, true); c.setUint32(16, crc, true); c.setUint32(20, size, true);
  c.setUint32(24, size, true); c.setUint16(28, fn.length, true); c.setUint16(30, 0, true);
  c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true);
  c.setUint32(38, isDir ? 0x10 << 16 : 0, true); c.setUint32(42, offset, true);
  cd.set(fn, 46);
  return cd;
}

function zipEocd(count, cdTotal, cdOffset) {
  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
  e.setUint16(8, count, true); e.setUint16(10, count, true);
  e.setUint32(12, cdTotal, true); e.setUint32(16, cdOffset, true); e.setUint16(20, 0, true);
  return eocd;
}

function zipEntryParts(fn, data, isDir, offset) {
  const crc = isDir ? 0 : crc32(data);
  const size = isDir ? 0 : data.byteLength;
  const lh = zipEntryHeader(fn, crc, size, offset, isDir);
  return { lh, data, crc, size, parts: lh.byteLength + size, cd: zipCdEntry(fn, crc, size, offset, isDir) };
}

// Streams a ZIP entry-by-entry: each file is decrypted then flushed immediately,
// so peak memory ≈ size of the largest single file (not the whole folder).
async function diskZip(env, id, discordId) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const folder = items.find(i => i.id === id && i.type === 'folder');
  if (!folder) return json({ error: 'Dossier introuvable' }, 404);
  const config = (await kvGet(env, 'disk:config')) || { diskKey: '' };
  if (!config.diskKey) return json({ error: 'Disk key non configurée' }, 500);
  const ids = [];
  const collect = pid => { items.filter(i => i.parentId === pid).forEach(i => { ids.push(i.id); if (i.type === 'folder') collect(i.id); }); };
  collect(id);
  const files = items.filter(i => ids.includes(i.id) && i.type === 'file');
  const names = {};
  const walk = (pid, prefix) => items.filter(i => i.parentId === pid).forEach(i => {
    const p = prefix ? prefix + '/' + i.name : i.name;
    if (i.type === 'file') names[i.id] = p; else walk(i.id, p);
  });
  walk(id, folder.name);
  const dirEntries = [folder.name + '/'];
  const addDirs = p => { const parts = p.split('/'); let acc = folder.name; for (let k = 1; k < parts.length - 1; k++) { acc += '/' + parts[k]; dirEntries.push(acc + '/'); } };
  files.forEach(f => addDirs(names[f.id] || f.name));
  const dirs = [...new Set(dirEntries)];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const cdParts = [];
      let offset = 0;
      const enqueue = (buf, size) => { controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); if (size) offset += size; };
      try {
        for (const d of dirs) {
          const fn = encoder.encode(d);
          const p = zipEntryParts(fn, new Uint8Array(0), true, offset);
          enqueue(p.lh, p.lh.byteLength);
          cdParts.push(p.cd);
        }
        for (const f of files) {
          let data;
          try { data = await decryptBufFromChunks(f.chunks || [], config.diskKey, env); } catch { continue; }
          const fn = encoder.encode(names[f.id] || f.name);
          const p = zipEntryParts(fn, data, false, offset);
          enqueue(p.lh, p.lh.byteLength);
          enqueue(data, data.byteLength);
          cdParts.push(p.cd);
        }
        const cdTotal = cdParts.reduce((s, b) => s + b.byteLength, 0);
        const cdOffset = offset;
        for (const b of cdParts) controller.enqueue(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        controller.enqueue(zipEocd(cdParts.length, cdTotal, cdOffset));
        controller.close();
      } catch (e) { try { controller.error(e); } catch {} }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${folder.name}.zip"` } });
}

async function diskSave(env, id, content, discordId) {
  if (!content) return json({ error: 'Contenu requis' }, 400);
  const c = cfg(env);
  if (!c.webhookUrl) return json({ error: 'Webhook non configuré' }, 500);
  const config = (await kvGet(env, 'disk:config')) || { diskKey: '' };
  if (!config.diskKey) return json({ error: 'Disk key non configurée' }, 500);
  const items = (await kvGet(env, 'disk:items')) || [];
  const file = items.find(i => i.id === id && i.type === 'file');
  if (!file) return json({ error: 'Introuvable' }, 404);
  if (file.uploadedBy && file.uploadedBy !== discordId) return json({ error: 'Pas ton fichier' }, 403);
  for (const ch of file.chunks || []) if (ch.messageId) await whDelMsg(c.webhookUrl, ch.messageId);
  const buf = new TextEncoder().encode(content).buffer;
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < buf.byteLength) {
    const end = Math.min(offset + CHUNK_MAX, buf.byteLength);
    const slice = buf.slice(offset, end);
    const { encrypted, iv, tag } = await encryptBuf(slice, config.diskKey);
    const whName = 'blt_' + genId() + '.bin';
    const whRes = await whSend(c.webhookUrl, encrypted, whName);
    chunks.push({ url: whRes.url, index, iv, tag, messageId: whRes.messageId, channelId: whRes.channelId, discordName: whName, size: slice.byteLength });
    offset = end;
    index++;
  }
  file.chunks = chunks;
  file.size = buf.byteLength;
  file.updatedAt = new Date().toISOString();
  await kvSet(env, 'disk:items', items);
  return json({ success: true });
}

function diskMimeFor(name, mime) {
  const ext = (name || '').toLowerCase().split('.').pop() || '';
  const map = { mp4:'video/mp4', m4v:'video/mp4', mkv:'video/x-matroska', webm:'video/webm', mov:'video/quicktime', avi:'video/x-msvideo', mpg:'video/mpeg', mpeg:'video/mpeg', ts:'video/mp2t', mp3:'audio/mpeg', m4a:'audio/mp4', ogg:'audio/ogg', oga:'audio/ogg', wav:'audio/wav', flac:'audio/flac', vtt:'text/vtt', srt:'application/x-subrip', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', bmp:'image/bmp', ico:'image/x-icon', tif:'image/tiff', tiff:'image/tiff', avif:'image/avif', txt:'text/plain', md:'text/markdown', json:'application/json', js:'text/javascript', mjs:'text/javascript', css:'text/css', html:'text/html', htm:'text/html', xml:'application/xml', csv:'text/csv', log:'text/plain', pdf:'application/pdf' };
  return map[ext] || (mime || '').toLowerCase() || 'application/octet-stream';
}

async function chunkSize(c, env) {
  if (c.size) return c.size;
  try {
    const r = await fetchChunk(env, c, { headers: { 'Range': 'bytes=0-0' } });
    if (!r.ok) return 0;
    const cr = r.headers.get('Content-Range') || '';
    const m = cr.match(/\/(\d+)/);
    if (m) return parseInt(m[1], 10);
    const cl = parseInt(r.headers.get('Content-Length') || '0', 10);
    if (cl > 0) return cl;
  } catch {}
  return 0;
}

async function persistChunkUrl(env, c, url) {
  try {
    const items = (await kvGet(env, 'disk:items')) || [];
    let changed = false;
    for (const it of items) {
      if (it.type !== 'file' || !it.chunks) continue;
      for (const x of it.chunks) {
        if (x.messageId && x.messageId === c.messageId) { x.url = url; changed = true; }
      }
    }
    if (changed) await kvSet(env, 'disk:items', items);
  } catch {}
}

async function fetchChunk(env, c, init) {
  let r = await fetch(c.url, init);
  if (r.ok) return r;
  if (c.messageId && (r.status === 403 || r.status === 404 || r.status === 410)) {
    const wh = cfg(env).webhookUrl;
    if (wh) {
      try {
        const nu = await whRefreshUrl(wh, c.messageId);
        if (nu && nu !== c.url) {
          c.url = nu;
          r = await fetch(c.url, init);
          await persistChunkUrl(env, c, nu);
        }
      } catch {}
    }
  }
  return r;
}

async function serveFileChunks(env, file, rangeHeader, inline) {
  const config = (await kvGet(env, 'disk:config')) || { diskKey: '' };
  const fileSize = file.size;
  const ctype = diskMimeFor(file.name, file.mime);
  const disp = inline ? 'inline' : 'attachment';
  if (!rangeHeader) {
    const key = await deriveKey(config.diskKey);
    const sorted = [...(file.chunks || [])].sort((a, b) => a.index - b.index);
    const headers = new Headers({ 'Content-Type': ctype, 'Content-Disposition': `${disp}; filename="${file.name}"`, 'Accept-Ranges': 'bytes', 'Content-Length': (file.size || 0).toString() });
    const CONCURRENCY = 4;
    const pending = [];
    const decryptChunk = async c => {
      const r = await fetchChunk(env, c);
      if (!r.ok) throw new Error('chunk ' + r.status);
      const arr = await r.arrayBuffer();
      const u = new Uint8Array(arr.byteLength + 16);
      u.set(new Uint8Array(arr), 0);
      u.set(fromHex(c.tag), arr.byteLength);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(c.iv) }, key, u));
    };
    const stream = new ReadableStream({
      async start(controller) {
        let i = 0;
        const fill = () => { while (i < sorted.length && pending.length < CONCURRENCY) { pending.push(decryptChunk(sorted[i]).catch(e => e)); i++; } };
        try {
          fill();
          while (pending.length) {
            const res = await pending.shift();
            if (res instanceof Error) throw res;
            controller.enqueue(res);
            fill();
          }
          controller.close();
        } catch (e) { try { controller.error(e); } catch {} }
      }
    });
    return new Response(stream, { headers });
  }
  const rng = (rangeHeader.replace(/bytes=/, '').split(',')[0] || '').trim();
  const parts = rng.split('-');
  let start = parts[0] ? parseInt(parts[0], 10) : null;
  let end = parts[1] ? parseInt(parts[1], 10) : null;
  if (start === null || isNaN(start)) {
    const n = parseInt(parts[1], 10);
    start = Math.max(0, fileSize - (isNaN(n) ? 0 : n));
    end = fileSize - 1;
  }
  if (start === null || isNaN(start)) start = 0;
  if (end === null || isNaN(end)) end = fileSize - 1;
  if (start >= fileSize) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } });
  let actualEnd = Math.min(end, fileSize - 1);
  const MAX_STREAM = 16 * 1024 * 1024;
  if (actualEnd - start + 1 > MAX_STREAM) actualEnd = start + MAX_STREAM - 1;
  const sorted = [...(file.chunks || [])].sort((a, b) => a.index - b.index);
  // Compute each chunk's plaintext size (stored `size`, else blob length via Range probe),
  // walking in order until the requested window is covered.
  const sizes = [];
  const offsets = [];
  let acc = 0;
  let lastI = sorted.length - 1;
  for (let i = 0; i < sorted.length; i++) {
    offsets[i] = acc;
    const sz = await chunkSize(sorted[i], env) || Math.max(0, fileSize - acc);
    sizes[i] = sz;
    acc += sz;
    if (acc > actualEnd) { lastI = i; break; }
  }
  let firstI = 0;
  for (let i = 0; i <= lastI; i++) if (offsets[i] + sizes[i] > start) { firstI = i; break; }
  const needed = sorted.slice(firstI, lastI + 1);
  const key = await deriveKey(config.diskKey);
  const bufs = await Promise.all(needed.map(async c => {
    const r = await fetchChunk(env, c);
    if (!r.ok) throw new Error('chunk ' + r.status);
    const arr = await r.arrayBuffer();
    const u = new Uint8Array(arr.byteLength + 16);
    u.set(new Uint8Array(arr), 0);
    u.set(fromHex(c.tag), arr.byteLength);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(c.iv) }, key, u));
  }));
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) { merged.set(b, o); o += b.length; }
  const localStart = start - offsets[firstI];
  const localEnd = actualEnd - offsets[firstI] + 1;
  const chunk = merged.slice(localStart, localEnd);
  return new Response(chunk, { status: 206, headers: { 'Content-Type': ctype, 'Content-Range': `bytes ${start}-${actualEnd}/${fileSize}`, 'Content-Length': chunk.byteLength.toString(), 'Accept-Ranges': 'bytes' } });
}

async function diskDownload(env, id, discordId, rangeHeader, inline) {
  const items = (await kvGet(env, 'disk:items')) || [];
  const file = items.find(i => i.id === id && i.type === 'file');
  if (!file) return json({ error: 'Introuvable' }, 404);
  if (file.uploadedBy && file.uploadedBy !== discordId) return json({ error: 'Pas ton fichier' }, 403);
  return serveFileChunks(env, file, rangeHeader, inline);
}

async function refreshAllUrls(env) {
  const wh = cfg(env).webhookUrl;
  if (!wh) return;
  const items = (await kvGet(env, 'disk:items')) || [];
  let dc = false;
  for (const item of items) {
    if (item.type !== 'file' || !item.chunks) continue;
    for (const c of item.chunks) {
      if (!c.size) {
        try {
          const s = await chunkSize(c, env);
          if (s) { c.size = s; dc = true; }
        } catch {}
      }
      if (!c.url) continue;
      try {
        const nu = await whRefreshUrl(wh, c.messageId);
        if (nu && nu !== c.url) { c.url = nu; dc = true; }
      } catch {}
    }
  }
  if (dc) await kvSet(env, 'disk:items', items);
}

// ── UI ──────────────────────────────────────────────────────────
function driveHtml(rUrl, user) {
  const esc = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const u = user || {};
  const avatar = u.avatar || '';
  const uname = esc(u.displayName || u.username || u.discordId || '');
  const sid = u.discordId || '';
  const usid = u.sid || '';
  const rU = esc(rUrl);
  const roleLabel = esc(u.role === 'moderator' ? 'VIP' : (u.role || 'Membre'));

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BLT Drive</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>💾</text></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg-primary:#313338;--bg-secondary:#2b2d31;--bg-tertiary:#1e1f22;--card:#1e1f22;--border:#3f4147;--text-primary:#dbdee1;--text-secondary:#b5bac1;--text-muted:#949ba4;--text-link:#00a8fc;--hover:#3f4147;--active:#404249;--active-border:#5865F2;--green:#57f287;--red:#da373c;--blue:#5865F2;--yellow:#faa81a;--orange:#fe7c2f;--bg:#313338;--fg:#dbdee1;--muted:#5c5f66;--mention:rgba(88,101,242,.3)}
.pv-quality{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.pv-q{background:var(--bg-tertiary);color:var(--text-muted);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
.pv-q:hover{color:var(--text-primary);border-color:var(--blue)}
.pv-q.active{background:var(--blue);border-color:var(--blue);color:#fff}
.pv-lbl{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;align-self:center;margin-right:2px}
.pv-audiorow,.pv-subrow{align-items:center}
.pv-subrow{border-top:1px solid var(--border);padding-top:8px;margin-top:2px}
#pv-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:var(--card);z-index:2}
.pv-loader{position:relative;width:92px;height:92px}
.pv-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 90deg, transparent 0 15%, var(--blue) 15% 25%, transparent 25% 100%);-webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 8px), #000 calc(100% - 7px));mask:radial-gradient(farthest-side, transparent calc(100% - 8px), #000 calc(100% - 7px));animation:pvspin 1s linear infinite}
.pv-r1{animation-duration:1.2s}
.pv-r2{inset:12px;animation-duration:1s;animation-direction:reverse;background:conic-gradient(from 90deg,transparent 0 25%, rgba(255,255,255,.9) 25% 40%, transparent 40% 100%)}
.pv-r3{inset:24px;animation-duration:.8s;background:conic-gradient(from 90deg,transparent 0 60%, var(--blue) 60% 75%, transparent 75% 100%)}
.pv-r4{inset:36px;animation-duration:1.4s;animation-direction:reverse;background:conic-gradient(from 90deg,transparent 0 45%, rgba(255,255,255,.8) 45% 60%, transparent 60% 100%)}
@keyframes pvspin{to{transform:rotate(360deg)}}
.pv-loader-title{font-size:15px;font-weight:600;color:var(--text-primary);animation:pvbreath 1.6s ease-in-out infinite}
.pv-loader-sub{font-size:12px;color:var(--text-muted);animation:pvbreath 1.6s ease-in-out infinite;animation-delay:.2s}
@keyframes pvbreath{0%,100%{opacity:.55}50%{opacity:1}}
.move-tree{max-height:260px;overflow-y:auto;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:10px;padding:6px;margin:10px 0}
.mt-item{display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--text-secondary);transition:background .12s,color .12s}
.mt-item:hover{background:rgba(255,255,255,.05);color:var(--text-primary)}
.mt-item.selected{background:rgba(88,101,242,.18);color:var(--text-primary);box-shadow:inset 0 0 0 1px rgba(88,101,242,.4)}
.mt-ind{display:inline-block;width:6px;flex-shrink:0}
.mt-ic{flex-shrink:0}
.mt-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-name{font-weight:600;color:var(--text-primary)}
.mt-sub{font-size:12px;color:var(--text-muted);margin:2px 0 4px}
.sh-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-muted);margin:8px 0}
.sh-field input{width:100%;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);padding:8px 10px;font:inherit;font-size:13px;outline:none}
.sh-field input:focus{border-color:var(--blue)}
.sh-radio{flex:1;display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;cursor:pointer;font-size:12px;color:var(--text-primary);background:var(--bg-tertiary)}
.sh-radio:has(input:checked){border-color:var(--blue);background:rgba(88,101,242,.12)}
.sh-radio input{width:auto;margin-right:4px;accent-color:var(--blue)}
.sh-sub{font-size:10px;color:var(--text-muted);font-weight:400;margin-top:2px}
.sh-row{display:flex;gap:10px}
.sh-row .sh-field{flex:1}
.sh-hint{font-size:11px;color:var(--text-muted);margin:0 0 4px}
body{font-family:'gg sans','Noto Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg-primary);color:var(--text-primary);font-size:14px;overflow:hidden;height:100vh}
.layout{display:flex;height:100vh}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--muted);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text-muted)}
.sidebar{width:240px;min-width:240px;background:var(--bg-secondary);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;z-index:10}
.sidebar-header{padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;position:relative}
.user-info{display:flex;align-items:center;gap:8px}
.user-avatar{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;background:var(--bg-tertiary)}
.user-name{flex:1;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-arrow{color:var(--text-muted);font-size:10px;transition:transform .2s}
.account-menu{position:absolute;top:60px;left:12px;right:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:16px;padding:8px;z-index:100;box-shadow:0 12px 48px rgba(0,0,0,.5);display:none;animation:modalIn .15s ease}
.account-menu-title{padding:4px 10px 6px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.account-list-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;cursor:pointer;font-size:13px;transition:background .1s}
.account-list-item:hover{background:var(--hover)}
.account-menu-actions{padding:0;border:none}
.pd-ring{width:38px;height:38px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#a855f7,#ec4899,#fb923c);padding:2px}
.pd-text{flex:1;min-width:0}
.pd-name{font-size:14px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2}
.pd-sub{font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:capitalize}
.pd-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:500;color:var(--text-primary);border:1px solid transparent;transition:background .15s,border-color .15s;text-align:left;background:transparent;font-family:inherit}
.pd-item:hover{background:var(--hover);border-color:rgba(255,255,255,.06)}
.pd-ic{width:16px;height:16px;flex-shrink:0;color:var(--text-secondary)}
.pd-item:hover .pd-ic{color:var(--text-primary)}
.pd-lbl{flex:1;white-space:nowrap}
.pd-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px}
.pd-badge-purple{background:rgba(168,85,247,.12);color:#c084fc;border:1px solid rgba(168,85,247,.25)}
.pd-badge-blue{background:rgba(59,130,246,.12);color:#60a5fa;border:1px solid rgba(59,130,246,.25)}
.pd-sep{height:1px;margin:6px 4px;background:linear-gradient(90deg,transparent,var(--border),transparent)}
.pd-danger{color:var(--red)}
.pd-danger .pd-ic{color:var(--red)}
.pd-danger:hover{background:rgba(218,55,60,.12);border-color:rgba(218,55,60,.3)}
.server-select{padding:8px 12px;border-bottom:1px solid var(--border)}
.server-select select,.lang-select select{width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--card);color:var(--text-primary);font-size:12px;outline:none;cursor:pointer}
.lang-select{padding:0 12px 8px;border-bottom:1px solid var(--border)}
.sidebar nav{flex:1;overflow-y:auto;padding:4px 0}
.sidebar nav a{display:flex;align-items:center;gap:8px;padding:7px 16px;color:var(--text-secondary);text-decoration:none;font-size:14px;font-weight:500;transition:background .1s,color .1s;border-left:2px solid transparent}
.sidebar nav a:hover{background:var(--hover);color:var(--text-primary)}
.sidebar nav a.active{background:var(--active);color:#fff;border-left-color:var(--active-border)}
.nav-icon{width:20px;text-align:center;font-size:15px}
.nav-section{padding:8px 16px 4px;font-size:10px;text-transform:uppercase;color:var(--text-muted);letter-spacing:.5px;font-weight:600}
.nav-badge{background:var(--red);color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:auto}
.sidebar nav a.nav-app{margin:6px 8px 10px;padding:8px 14px;border-radius:8px;border:1px solid var(--active-border);background:linear-gradient(90deg,rgba(88,101,242,.16),rgba(114,137,218,.10));color:var(--text-primary);font-weight:600;border-left-width:1px}.sidebar nav a.nav-app:hover{background:linear-gradient(90deg,rgba(88,101,242,.30),rgba(114,137,218,.20))}.sidebar .nav-footer{margin-top:auto;padding:10px 12px;border-top:1px solid var(--border);background:var(--bg-tertiary)}.sidebar .nav-footer a{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;color:var(--text-primary);text-decoration:none;font-size:13px;font-weight:600;border:1px solid var(--active-border);background:linear-gradient(90deg,rgba(88,101,242,.16),rgba(114,137,218,.10));justify-content:center}.sidebar .nav-footer a:hover{background:linear-gradient(90deg,rgba(88,101,242,.30),rgba(114,137,218,.20));color:#fff}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.status-bar{background:var(--bg-tertiary);border-bottom:1px solid var(--border);padding:6px 20px;font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:12px;flex-shrink:0}
.content-area{flex:1;overflow-y:auto;padding:20px;min-height:0}
.page{display:none}
.page.active{display:block}
.page h2{font-size:20px;margin-bottom:16px;color:#f2f3f5;display:flex;align-items:center;gap:8px;font-weight:700}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--blue);color:#fff;border:none;padding:8px 16px;border-radius:4px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;font-family:inherit;transition:background .15s;white-space:nowrap}
.btn:hover{background:#4752c4}
.btn-sm{padding:4px 10px;font-size:12px}
.btn-danger{background:var(--red)}
.btn-danger:hover{background:#c0353a}
.btn-success{background:var(--green);color:#000}
.btn-success:hover{background:#4ad677}
.btn-warning{background:var(--yellow);color:#000}
.btn-warning:hover{background:#e09a15}
.btn:disabled{opacity:.5;cursor:not-allowed}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px}
.card .label{font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.card .value{font-size:20px;font-weight:700;color:#f2f3f5}
table{width:100%;border-collapse:collapse;font-size:13px}
table thead{position:sticky;top:0;z-index:1}
table th{background:var(--bg-tertiary);padding:8px 12px;text-align:left;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;font-weight:600;border-bottom:2px solid var(--border)}
table td{padding:8px 12px;border-bottom:1px solid var(--border);color:var(--text-primary)}
table tr:hover td{background:var(--hover)}
table tr{cursor:pointer;transition:background .1s}
input,select,textarea{padding:8px 12px;border:1px solid var(--border);border-radius:4px;background:var(--card);color:var(--text-primary);font-size:13px;outline:none;font-family:inherit;width:100%;box-sizing:border-box}
input:focus,select:focus,textarea:focus{border-color:var(--blue)}
.search{max-width:300px;margin-bottom:8px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.badge-info{background:rgba(88,101,242,.2);color:var(--blue)}
.badge-success{background:rgba(87,242,135,.15);color:var(--green)}
.badge-warn{background:rgba(250,168,26,.15);color:var(--yellow)}
.badge-error{background:rgba(218,55,60,.15);color:var(--red)}
.progress-bar{background:var(--bg-tertiary);border-radius:4px;height:6px;overflow:hidden;margin:4px 0}
.progress-fill{background:var(--blue);height:100%;border-radius:4px;transition:width .3s}
.progress-fill.indet{background:repeating-linear-gradient(45deg,var(--blue) 0 8px,rgba(88,101,242,.35) 8px 16px);animation:progSlide .8s linear infinite;transition:none}
@keyframes progSlide{0%{background-position:0 0}100%{background-position:16px 0}}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2000;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.modal-overlay.active{display:flex}
.modal-content{background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:28px;width:600px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.45)}
.modal-content h3{font-size:18px;margin-bottom:16px;color:#f2f3f5}
.modal-content p{color:var(--text-muted);margin-bottom:12px;line-height:1.5}
.modal-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
.preview-box{background:var(--card);border-radius:8px;overflow:hidden;margin:12px 0;position:relative;min-height:120px}
.preview-box img,.preview-box video{max-width:100%;max-height:70vh;display:block;margin:0 auto}
.preview-box pre{margin:0;padding:16px;font-size:12px;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--text-primary)}
.dq-container{position:fixed;bottom:0;right:20px;width:340px;max-height:50vh;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px 12px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,.4);z-index:1500;display:flex;flex-direction:column;overflow:hidden}
.dq-header{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer}
.dq-header .count{margin-left:auto;color:var(--text-muted);font-size:12px}
.dq-header .dq-close{cursor:pointer;opacity:.6;font-size:16px}
.dq-header .dq-close:hover{opacity:1}
.dq-list{flex:1;overflow-y:auto;padding:6px}
.dq-item{padding:8px 10px;border-radius:6px;margin-bottom:4px;font-size:12px;display:flex;align-items:center;gap:8px;border-left:3px solid var(--blue)}
.dq-item.done{border-left-color:var(--green)}
.dq-item.error{border-left-color:var(--red)}
.dq-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dq-item .progress{font-size:11px;color:var(--text-muted);white-space:nowrap}
.dq-item .dq-remove{cursor:pointer;opacity:.5;font-size:14px}
.dq-item .dq-remove:hover{opacity:1}
.dq-item.queued{border-left-color:var(--yellow)}
.dq-item.working{animation:dqPulse 1.4s ease-in-out infinite}
@keyframes dqPulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes modalIn{from{opacity:0;transform:scale(.92) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
.dq-item .detail{font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:8px;font-size:14px;z-index:3000;box-shadow:0 4px 16px rgba(0,0,0,.4);animation:slideIn .3s;max-width:90vw}
.toast-success{background:rgba(87,242,135,.15);color:var(--green);border:1px solid rgba(87,242,135,.3)}
.toast-error{background:rgba(218,55,60,.15);color:var(--red);border:1px solid rgba(218,55,60,.3)}
.toast-info{background:rgba(88,101,242,.15);color:var(--blue);border:1px solid rgba(88,101,242,.3)}
@keyframes slideIn{from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.context-menu{position:fixed;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:6px;z-index:1000;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none}
.context-menu-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:4px;cursor:pointer;font-size:13px;transition:background .1s}
.context-menu-item:hover{background:var(--hover)}
.context-menu-item.danger{color:var(--red)}
.context-menu-separator{height:1px;background:var(--border);margin:4px 0}
.text-muted{color:var(--text-muted)}
.text-center{text-align:center}
.flex-center{display:flex;align-items:center;justify-content:center}
</style>
</head>
<body>
<div class="layout" id="app" data-user="${esc(uname)}" data-role="admin" data-discordid="${esc(u.discordId || '')}" data-avatar="${esc(avatar)}" data-sid="${esc(usid)}" data-driveurl="${rU}">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="user-info" onclick="toggleAccountMenu()">
        <div class="pd-ring"><img class="user-avatar" src="${avatar ? '/api/avatar?url=' + encodeURIComponent(avatar) : ''}" alt="" onerror="this.style.display='none'"></div>
        <div class="pd-text">
          <div class="pd-name">${esc(uname)}</div>
          <div class="pd-sub">${roleLabel}</div>
        </div>
        <span class="user-arrow">▾</span>
      </div>
      <div class="account-menu" id="account-menu" style="display:none">
        <div class="account-menu-title">Comptes</div>
        <div id="drive-account-list"></div>
        <div class="pd-item" onclick="driveAddAccount()">
          <svg class="pd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          <span class="pd-lbl" style="color:var(--text-link)">Ajouter un compte</span>
        </div>
        <div class="pd-sep"></div>
        <div class="pd-item" onclick="window.open('https://discord.com/users/${esc(sid)}','_blank')">
          <svg class="pd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span class="pd-lbl">Profil Discord</span>
        </div>
        <div class="pd-item">
          <svg class="pd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span class="pd-lbl">Rôle</span>
          <span class="pd-badge pd-badge-purple">${roleLabel}</span>
        </div>
        <div class="pd-item" onclick="window.location.href='${rU}'">
          <svg class="pd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="pd-lbl">Panel principal</span>
        </div>
        <div class="pd-sep"></div>
        <div class="pd-item pd-danger" onclick="window.location.href='${rU}/logout'">
          <svg class="pd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
          <span class="pd-lbl">Déconnexion</span>
        </div>
      </div>
    </div>
    <div class="server-select">
      <select onchange="window.location.href='${rU}/panel'">
        <option value="">⬅️  Panel principal</option>
      </select>
    </div>
    <nav>
      <div class="nav-section">Navigation</div>
      <a href="${rU}/panel"><span class="nav-icon">📊</span><span>Dashboard</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🏠</span><span>Serveur</span></a>
      <a href="${rU}/panel"><span class="nav-icon">⌨️</span><span>Commandes</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🎬</span><span>Tickets</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🎤</span><span>Vocaux</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🎂</span><span>Anniversaires</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🎭</span><span>Rôles</span></a>
      <a href="${rU}/panel"><span class="nav-icon">✉️</span><span>DM</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🔨</span><span>Bannissements</span></a>
      <a href="${rU}/panel"><span class="nav-icon">📋</span><span>Logs</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🖥️</span><span>Système</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🎵</span><span>Musique</span></a>
      <a href="${rU}/panel"><span class="nav-icon">🎨</span><span>Thème</span></a>
      <div class="nav-section">Stockage</div>
      <a href="#" class="active" onclick="event.preventDefault();return false"><span class="nav-icon">💾</span><span>Disque</span></a>
    </nav>
    <div class="nav-footer">
      <a href="#" onclick="diskAppInstall();return false"><span class="nav-icon">⬇️</span><span>Installer l'application</span></a>
    </div>
  </aside>

  <main class="main">
    <div class="status-bar">
      <span id="status-text">☁️ BLT Drive</span>
      <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <span id="kv-quota" style="display:none;align-items:center;gap:6px" title="Quota d'écriture KV Cloudflare du jour (reset 00:00 UTC)">
          <span style="font-size:11px">⚡ KV</span>
          <div class="progress-bar" style="width:110px;height:6px;display:inline-block;vertical-align:middle;margin:0"><div class="progress-fill" id="kv-quota-fill" style="width:0%"></div></div>
          <span id="kv-quota-text" style="font-size:11px">0/0</span>
        </span>
        <span id="disk-limit" style="font-size:11px;color:var(--text-muted)"></span>
        <a class="btn btn-sm" href="${rU}/panel">← Panel</a>
      </span>
    </div>
    <div class="content-area">

    <div class="page active" id="page-disk">
      <h2>💾 Espace disque <button class="btn btn-sm" onclick="diskRefresh()">🔄</button></h2>
      <div class="cards" id="disk-info">
        <div class="card"><div class="label">Fichiers</div><div class="value" id="disk-count">-</div></div>
        <div class="card"><div class="label">Taille totale</div><div class="value" id="disk-total">-</div></div>
        <div class="card"><div class="label">Stockage</div><div class="value" id="disk-quota">-</div></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
        <button class="btn btn-sm btn-success" onclick="diskUpload()">📤 Upload</button>
        <button class="btn btn-sm" onclick="diskUploadFolder()">📂 Importer dossier</button>
        <button class="btn btn-sm" onclick="diskMkdir()">📁 Nouveau dossier</button>
        <button class="btn btn-sm" onclick="diskOpenShares()">🔗 Partages</button>
        <button class="btn btn-sm" onclick="diskGenAppToken()">🔑 Token app</button>
        <span id="disk-limit-info" style="font-size:12px;color:var(--text-muted);align-self:center"></span>
      </div>
      <input type="file" id="disk-file-input" style="display:none" multiple onchange="diskUploadSend(this)">
      <input type="file" id="disk-folder-input" style="display:none" multiple webkitdirectory onchange="diskUploadFolderSend(this)">
      <div id="disk-breadcrumb" style="margin:8px 0;font-size:14px;color:var(--text-secondary)"></div>
      <div style="overflow-x:auto">
        <table><thead><tr><th>Nom</th><th>Taille</th><th>Date</th><th style="width:168px">Actions</th></tr></thead>
          <tbody id="disk-tbody"></tbody></table>
      </div>
      <div id="disk-empty" style="text-align:center;color:var(--text-muted);padding:32px">Aucun fichier</div>
    </div>

    </div>
  </main>
</div>

<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()">
  <div class="modal-content" id="modalContent"></div>
</div>

<div class="context-menu" id="ctxMenu"></div>

<div class="dq-container" id="dqContainer" style="display:none">
  <div class="dq-header" onclick="dqDetach()">
    <span>📊 Tâches</span>
    <span class="count" id="dqCount">0</span>
    <span class="dq-close" onclick="event.stopPropagation();dqToggle()">✕</span>
  </div>
  <div class="dq-list" id="dqList"><div class="dq-empty">Aucune tâche</div></div>
</div>

<template id="dqWindowTemplate">
  <div class="tq" id="dqContainer">
    <div class="tq-head">📊 Tâches <span class="tq-count" id="dqCount">0/0</span><button onclick="window.close()" style="margin-left:auto;background:transparent;border:none;color:#949ba4;cursor:pointer;font-size:14px">✕</button></div>
    <div class="tq-list" id="dqList"><div class="dq-empty">Aucune tâche</div></div>
  </div>
  <script>
  (function(){
    var ORIGIN = window.location.origin;
    var DISK_KEY = (window.opener && window.opener.DISK_KEY) || "";
    var DISK_WEBHOOK = (window.opener && window.opener.DISK_WEBHOOK) || "";
    var dqItems = {};
    var dqIdCounter = 0;
    function esc(s){return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
    function diskRefresh(){}
    function api(path,opts){opts=opts||{};opts.credentials='same-origin';opts.headers=Object.assign({'X-Requested-With':'blt'},opts.headers||{});var o=opts.body;if(o&&typeof o==='object'&&!(o instanceof FormData)&&!(o instanceof Blob)&&!(o instanceof ArrayBuffer)){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(o);}return fetch(ORIGIN+path,opts).then(function(res){if(res.status===401){return Promise.reject(new Error('Connexion expirée'));}if(!res.ok){return res.text().then(function(t){var m='Erreur '+res.status;try{var j=JSON.parse(t);if(j&&j.error)m=j.error;}catch(e){}throw new Error(m);});}var ct=(res.headers.get('content-type')||'');if(ct.indexOf('application/json')!==-1)return res.json();return res;});}
    var sema=function(limit){var n=0,q=[];var take=function(){return new Promise(function(res){if(n<limit){n++;res();}else q.push(res);});};var give=function(){if(q.length)q.shift()();else n--;};return{take:take,give:give};};
    var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
    function diskUpId(){return(crypto.randomUUID?crypto.randomUUID():'u'+Date.now()+Math.random().toString(36).slice(2));}
    function toHex(b){return Array.from(new Uint8Array(b)).map(function(x){return x.toString(16).padStart(2,"0");}).join("");}
    async function diskEncSlice(buf,pw){var h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(pw));var key=await crypto.subtle.importKey("raw",h,{name:"AES-GCM"},false,["encrypt"]);var iv=crypto.getRandomValues(new Uint8Array(12));var c=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:iv},key,buf));return{bytes:c.slice(0,-16),ivHex:toHex(iv),tagHex:toHex(c.slice(-16))};}
    function diskChunkName(){return"blt_"+(crypto.randomUUID?crypto.randomUUID().replace(/-/g,""):Date.now().toString(36)+Math.random().toString(36).slice(2))+".bin";}
    async function diskPostChunk(webhook,bytes,fname){var form=new FormData();form.append("payload_json",JSON.stringify({content:""}));form.append("file",new Blob([bytes],{type:"application/octet-stream"}),fname);var lastErr=null;for(var att=0;att<4;att++){if(att)await sleep(Math.min(500*Math.pow(2,att),8000));try{var res=await fetch(webhook+"?wait=true",{method:"POST",body:form});if(res.ok){var msg=await res.json();if(!msg.attachments||!msg.attachments[0])throw new Error("Pas de fichier en réponse");return{messageId:msg.id,attachmentId:msg.attachments[0].id,url:msg.attachments[0].url,channelId:msg.channel_id};}var ra=parseInt(res.headers.get("Retry-After")||"0",10);lastErr=new Error("Discord "+res.status+": "+(await res.text()).slice(0,200));if(res.status===429&&ra)await sleep(Math.min(ra*1000,10000));else if(res.status===429||res.status>=500)continue;break;}catch(e){lastErr=e;}}throw lastErr||new Error("Envoi Discord échoué");}
    async function diskDelChunk(webhook,messageId){try{await fetch(webhook+"/messages/"+messageId,{method:"DELETE"});}catch(e){}}
    function diskLoadFFmpeg(){return new Promise(function(resolve,reject){var load=function(u){return new Promise(function(res,rej){var s=document.createElement('script');s.src=ORIGIN+u;s.onload=res;s.onerror=function(){rej(new Error('Impossible de charger '+u));};document.head.appendChild(s);});};load('/vendor/@ffmpeg/util@0.12.1/dist/umd/index.js').then(function(){return load('/vendor/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js');}).then(resolve).catch(reject);});}
    async function diskConvertToMp4(file,onStatus){if(typeof FFmpegWASM==='undefined'||typeof FFmpegUtil==='undefined'){if(onStatus)onStatus('Chargement du convertisseur...');await diskLoadFFmpeg();}var FF=FFmpegWASM.FFmpeg;var FU=FFmpegUtil.fetchFile;var ffmpeg=new FF();ffmpeg.on('log',function(ev){if(onStatus&&ev.message){var m=String(ev.message).split('\\n').pop();if(m&&m.trim())onStatus(m);}});await ffmpeg.load({coreURL:ORIGIN+'/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.js',wasmURL:ORIGIN+'/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.wasm'});var ext=(file.name.split('.').pop()||'bin');await ffmpeg.writeFile('input.'+ext,await FU(file));if(onStatus)onStatus('Conversion en MP4 (peut prendre du temps)...');await ffmpeg.exec(['-i','input.'+ext,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart','output.mp4']);var data=await ffmpeg.readFile('output.mp4');var base=file.name.replace(/\\.[^/.]+$/,'');var mp4=new File([data],base+'.mp4',{type:'video/mp4'});try{await ffmpeg.terminate();}catch(e){}return mp4;}
    async function diskRenditionFiles(file,qualities,onStatus){if(typeof FFmpegWASM==='undefined'||typeof FFmpegUtil==='undefined'){if(onStatus)onStatus('Chargement du convertisseur...');await diskLoadFFmpeg();}var FF=FFmpegWASM.FFmpeg;var FU=FFmpegUtil.fetchFile;var ffmpeg=new FF();ffmpeg.on('log',function(ev){if(onStatus&&ev.message){var m=String(ev.message).split('\\n').pop();if(m&&m.trim())onStatus(m);}});await ffmpeg.load({coreURL:ORIGIN+'/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.js',wasmURL:ORIGIN+'/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.wasm'});var ext=(file.name.split('.').pop()||'bin');await ffmpeg.writeFile('input.'+ext,await FU(file));var base=file.name.replace(/\\.[^/.]+$/,'');var out=[];try{for(var q=0;q<qualities.length;q++){if(onStatus)onStatus('Encodage '+qualities[q]+'…');var h=parseInt(qualities[q],10)||720;var qo='out_'+q+'.mp4';await ffmpeg.exec(['-i','input.'+ext,'-c:v','libx264','-preset','veryfast','-crf','28','-vf','scale=-2:min('+h+'\\,ih)','-c:a','aac','-b:a','96k','-movflags','+faststart','-y',qo]);var data=await ffmpeg.readFile(qo);out.push(new File([data],base+'_'+qualities[q]+'.mp4',{type:'video/mp4'}));}}finally{try{await ffmpeg.terminate();}catch(e){}}return out;}
    async function diskUploadFile(file,parentId,onProgress){var key=DISK_KEY||"";var webhook=DISK_WEBHOOK||"";if(!key)throw new Error("Clé de chiffrement indisponible");if(!webhook)throw new Error("Webhook indisponible");if(!file||!file.size||file.size<=0)throw new Error("Fichier vide refusé ("+(file?file.size:0)+" octets)");var total=Math.max(1,Math.ceil(file.size/10485760));var chunks=[];try{for(var i=0;i<total;i++){var raw=await file.slice(i*10485760,Math.min((i+1)*10485760,file.size)).arrayBuffer();var enc=await diskEncSlice(raw,key);var posted=await diskPostChunk(webhook,enc.bytes,diskChunkName());chunks.push({url:posted.url,index:i,iv:enc.ivHex,tag:enc.tagHex,messageId:posted.messageId,channelId:posted.channelId,discordName:posted.attachmentId,size:enc.bytes.byteLength});if(onProgress)onProgress(i+1,total);await sleep(120);}return await api("/api/disk/complete",{method:"POST",body:{name:file.name,mime:file.type||"",size:file.size,parentId:parentId||null,chunks:chunks}});}catch(e){for(var k=0;k<chunks.length;k++)await diskDelChunk(webhook,chunks[k].messageId);throw e;}}
    async function diskRunJobs(jobs){if(!jobs.length){diskRefresh();return;}var cv=sema(1);var up=sema(1);await Promise.all(jobs.map(function(j){return dqAdd(j.label||j.f0.name,async function(set){var file=j.f0;var rends=[];set({status:'working',detail:'Préparation…'});if(j.mode==='convert'){set({status:'working',detail:'⏳ En attente de conversion…'});await cv.take();try{file=await diskConvertToMp4(file,function(m){set({status:'working',detail:'🔄 '+m});});}catch(e){set({status:'working',detail:'⚠️ Conversion impossible — import de l\\'original'});}cv.give();}if(j.mode==='optimize'){set({status:'working',detail:'⏳ En attente de transcription…'});await cv.take();try{rends=await diskRenditionFiles(file,['720p','480p','360p'],function(m){set({status:'working',detail:'🔄 '+m});});}catch(e){throw new Error('Transcription impossible : '+(e.message||e));}finally{cv.give();}if(!rends.length||rends.some(function(r){return !r||!r.size||r.size<=0;}))throw new Error('Transcription impossible — versions vides');}set({status:'working',detail:'Upload…'});await up.take();try{await diskUploadFile(file,j.parentId,function(c,t){set({status:'working',progress:t?Math.round(c/t*100):0,detail:t?'Importation des blocs '+c+'/'+t:'Importation des blocs…'});});}finally{up.give();}for(var i=0;i<rends.length;i++){set({status:'working',detail:'Importation des blocs — version '+rends[i].name});await up.take();try{await diskUploadFile(rends[i],j.parentId,function(c,t){set({status:'working',progress:t?Math.round(c/t*100):0,detail:t?'Importation des blocs '+c+'/'+t:'Importation des blocs — '+rends[i].name});});}finally{up.give();}}});}));diskRefresh();}
    function dqAdd(name,fn){dqIdCounter++;var id=dqIdCounter;dqItems[id]={id:id,name:name,status:'queued',progress:null,detail:''};dqRender();var set=function(patch){if(dqItems[id]){Object.assign(dqItems[id],patch);dqRender();}};var p=Promise.resolve().then(function(){return fn(set);});p.then(function(){set({status:'done',progress:100,detail:'✅ Terminé'});setTimeout(function(){dqRemoveId(id);},4000);}).catch(function(e){set({status:'error',detail:'❌ '+(e.message||e)});setTimeout(function(){dqRemoveId(id);},8000);});return p;}
    function dqRemoveId(id){delete dqItems[id];dqRender();}
    function dqRender(){var list=document.getElementById('dqList');var count=document.getElementById('dqCount');var c=document.getElementById('dqContainer');var e=Object.values(dqItems);var a=0;for(var i=0;i<e.length;i++)if(e[i].status==='working'||e[i].status==='queued')a++;if(count)count.textContent=a+'/'+e.length;if(c)c.style.display='flex';if(!e.length){if(list)list.innerHTML='<div class="dq-empty">Aucune tâche</div>';return;}var h='';for(var k=0;k<e.length;k++){var x=e[k];var cls=x.status==='done'?' done':x.status==='error'?' error':x.status==='queued'?' queued':' working';var bar='';if(x.status==='working'){if(typeof x.progress==='number'){bar='<div class="tq-bar"><div style="width:'+Math.max(0,Math.min(100,x.progress))+'%"></div></div>';}else{bar='<div class="tq-bar"><div class="tq-indet" style="width:100%"></div></div>';}}h+='<div class="tq-item'+cls+'"><div class="tq-name">'+esc(x.name)+'</div>'+bar+(x.detail?'<div class="tq-detail">'+esc(x.detail)+'</div>':'')+'</div>';}if(list)list.innerHTML=h;if(dqBC){var _j=JSON.stringify(dqSnapshot());if(_j!==dqLastJson){dqLastJson=_j;try{dqBC.postMessage(dqSnapshot());}catch(e){}}}}
    function dqSnapshot(){var e=Object.values(dqItems).map(function(x){return{id:x.id,name:x.name,status:x.status,progress:x.progress,detail:x.detail};});var a=0;for(var i=0;i<e.length;i++)if(e[i].status==='working'||e[i].status==='queued')a++;return{items:e,active:a,total:e.length};}
    var dqBC=('BroadcastChannel' in window)?new BroadcastChannel('blt-drive-tasks'):null;
    var dqLastJson='';if(dqBC)dqBC.onmessage=function(ev){var d=ev.data;if(!d)return;if(d.request==='sync'){if(Object.keys(dqItems).length){var _j=JSON.stringify(dqSnapshot());if(_j!==dqLastJson){dqLastJson=_j;try{dqBC.postMessage(dqSnapshot());}catch(e){}}}}else if(d.items){var m={};for(var i=0;i<d.items.length;i++){var it=d.items[i];if(it&&it.id)m[it.id]=it;}dqItems=m;dqRender();}};
    window.addEventListener('message',function(ev){if(ev.data){if(ev.data.type==='blt-jobs'&&ev.data.jobs){diskRunJobs(ev.data.jobs);}else if(ev.data.type==='blt-ping'){if(window.opener)try{window.opener.postMessage({type:'blt-ready'},'*');}catch(e){}}}});
    if(window.opener)try{window.opener.postMessage({type:'blt-ready'},'*');}catch(e){}
    if(dqBC)try{dqBC.postMessage({request:'sync'});}catch(e){}
  })();
  </script>
</template>

<script>
let diskItems = [];
let diskCurrentId = null;
let diskSharedCount = 0;
let diskConfig = null;
let diskQuota = null;
const dqItems = {};
let dqIdCounter = 0;
let ctxTarget = null;

async function api(url, opts = {}) {
  if (!opts.headers) opts.headers = {};
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = '/auth/railway?redirect=' + encodeURIComponent(window.location.pathname); throw new Error('Non auth'); }
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('json')) {
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Erreur ' + res.status);
    return d;
  }
  if (!res.ok) throw new Error('Erreur ' + res.status);
  return res;
}

function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtSize(bytes) { if (!bytes) return ''; const u=['B','KB','MB','GB']; let i=0,s=bytes; while(s>=1024&&i<u.length-1){s/=1024;i++} return s.toFixed(i>0?1:0)+' '+u[i]; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'2-digit'}) : ''; }

async function diskInit() {
  try {
    diskConfig = await api('/api/disk/config');
    if (diskConfig) {
      diskQuota = diskConfig.quota;
      window.DISK_KEY = diskConfig.key;
      window.DISK_WEBHOOK = diskConfig.webhook;
      window.DISK_KV_QUOTA = diskConfig.kvUsage || null;
      window.DISK_IS_VIP = !!diskConfig.isVip;
      window.DISK_APP_URL = diskConfig.appUrl || '';
    }
  } catch {}
  await diskRefresh();
  diskWatch();
}

async function diskWatch() {
  const DELAY = 20000;
  try {
    const t = await api('/api/disk/tree');
    const sig = (t.items || []).map(i => i.id).join('|');
    if (!window.__diskBusy) {
      if (window.__diskSig === undefined) { window.__diskSig = sig; }
      else if (sig !== window.__diskSig) { window.__diskSig = sig; location.reload(); return; }
    }
  } catch (e) {}
  setTimeout(diskWatch, DELAY);
}

async function diskRefresh() {
  try {
    const [data, cfg] = await Promise.all([
      api('/api/disk/tree'),
      api('/api/disk/config'),
    ]);
    diskItems = data.items || [];
    if (cfg) {
      diskQuota = cfg.quota;
      window.DISK_KEY = cfg.key;
      window.DISK_WEBHOOK = cfg.webhook;
      window.DISK_KV_QUOTA = cfg.kvUsage || null;
      window.DISK_IS_VIP = !!cfg.isVip;
      window.DISK_APP_URL = cfg.appUrl || '';
    }
    diskRender();
  } catch (e) {
    document.getElementById('disk-empty').textContent = '❌ ' + e.message;
    document.getElementById('disk-empty').style.display = 'block';
  }
}

function renderKvQuota() {
  const el = document.getElementById('kv-quota');
  if (!el) return;
  const q = window.DISK_KV_QUOTA;
  if (!window.DISK_IS_VIP || !q || !q.limit) { el.style.display = 'none'; return; }
  el.style.display = 'inline-flex';
  const limit = parseInt(q.limit) || 0;
  const used = Math.max(0, Math.min(parseInt(q.used) || 0, limit));
  const pct = limit ? Math.round(used / limit * 100) : 0;
  const fill = document.getElementById('kv-quota-fill');
  fill.style.width = pct + '%';
  fill.style.background = pct >= 80 ? 'var(--red)' : pct >= 50 ? 'var(--yellow)' : 'var(--blue)';
  document.getElementById('kv-quota-text').textContent = used + '/' + limit;
}

function diskRender() {
  let count, total;
  if (diskCurrentId === '__shared__') {
    count = diskSharedCount;
    total = 0;
  } else {
    const files = diskItems.filter(i => !i.renditionOf && !i.subtitleOf && (i.parentId || null) === diskCurrentId && i.type === 'file');
    count = files.length;
    total = files.reduce((s, i) => s + (i.size || 0), 0);
  }
  document.getElementById('disk-count').textContent = count;
  document.getElementById('disk-total').textContent = fmtSize(total);
  const qEl = document.getElementById('disk-quota');
  if (diskQuota) {
    if (diskQuota.limit === '-1') qEl.textContent = '♾️ Illimité';
    else { const pct = parseInt(diskQuota.limit) > 0 ? (parseInt(diskQuota.usage) / parseInt(diskQuota.limit) * 100).toFixed(1) : 0; qEl.textContent = fmtSize(parseInt(diskQuota.usage)) + ' / ' + fmtSize(parseInt(diskQuota.limit)) + ' (' + pct + '%)'; }
  }
  document.getElementById('disk-limit-info').textContent = diskQuota?.role === 'VIP' ? 'VIP' : (diskQuota?.role || '');
  renderKvQuota();
  diskRenderBreadcrumb(diskCurrentId);
  diskRenderTable(diskCurrentId);
}

function diskFolderSize(id) {
  let total = 0;
  const seen = new Set();
  const walk = pid => {
    for (const it of diskItems) {
      if ((it.parentId || null) !== pid) continue;
      if (it.subtitleOf) continue;
      if (it.type === 'folder') { if (seen.has(it.id)) continue; seen.add(it.id); walk(it.id); }
      else if (!it.renditionOf) total += (it.size || 0);
    }
  };
  walk(id);
  return total;
}

function diskRenderTable(parentId) {
  const tbody = document.getElementById('disk-tbody');
  const empty = document.getElementById('disk-empty');
  if (parentId === '__shared__') { diskRenderShares(tbody, empty); return; }
  const items = diskItems.filter(i => !i.renditionOf && !i.subtitleOf && (i.parentId || null) === parentId);
  items.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : (a.name || '').localeCompare(b.name || ''));
  if (!items.length && parentId) { tbody.innerHTML = ''; empty.style.display = 'block'; empty.textContent = '📂 Dossier vide'; return; }
  empty.style.display = 'none';
  let rows = '';
  if (!parentId) rows += '<tr onclick="diskNavigate(\\'__shared__\\')" style="cursor:pointer"><td>🔗 <strong>Partagés</strong> <span style="color:var(--text-muted);font-size:12px">— liens de partage</span></td><td></td><td></td><td><button class="btn btn-sm" onclick="event.stopPropagation();diskOpenShares()">🔗 Gérer</button></td></tr>';
  rows += items.map(item => {
    const isFolder = item.type === 'folder';
    const icon = isFolder ? '📁' : item.mime?.startsWith('video/') ? '🎬' : item.mime?.startsWith('audio/') ? '🎵' : item.mime?.startsWith('image/') ? '🖼️' : '📄';
    return '<tr onclick="diskClick(\\'' + item.id + '\\')" oncontextmenu="event.preventDefault();showCtx(\\'' + item.id + '\\',event)">'
      + '<td><span style="margin-right:6px">' + icon + '</span>' + esc(item.name) + '</td>'
      + '<td>' + fmtSize(isFolder ? diskFolderSize(item.id) : (item.size || 0)) + '</td>'
      + '<td style="color:var(--text-muted);font-size:12px">' + fmtDate(item.updatedAt || item.uploadedAt) + '</td>'
      + '<td>' + (isFolder ? '<button class="btn btn-sm" title="Télécharger ZIP" onclick="event.stopPropagation();diskZipDownload(\\'' + item.id + '\\')">🗜️</button> ' : '<button class="btn btn-sm" title="Télécharger" onclick="event.stopPropagation();diskDownload(\\'' + item.id + '\\')">⬇️</button> ') + '<button class="btn btn-sm" title="Partager" onclick="event.stopPropagation();diskShare(\\'' + item.id + '\\')">🔗</button> <button class="btn btn-sm" title="Déplacer" onclick="event.stopPropagation();diskMove(\\'' + item.id + '\\')">📦</button> <button class="btn btn-sm btn-danger" title="Supprimer" onclick="event.stopPropagation();diskDelete(\\'' + item.id + '\\')">🗑️</button></td></tr>';
  }).join('');
  tbody.innerHTML = rows;
}

async function diskRenderShares(tbody, empty) {
  const html = [];
  const merch = s => {
    const isFolder = s.type === 'folder';
    const name = s.folderName || s.fileName || '?';
    const size = isFolder ? ((s.files ? s.files.length : 0) + ' fichier(s)') : fmtSize(s.fileSize);
    const acc = (s.accessCount || 0) + (s.maxAccess > 0 ? '/' + s.maxAccess : '') + ' accès';
    const who = s.targetUser ? ' → ' + esc(s.targetUser) : (s.everyone ? ' → Tout le monde' : '');
    return '<tr onclick="window.open(\\'/share/' + s.id + '\\',\\'_blank\\')" style="cursor:pointer">'
      + '<td><span style="margin-right:6px">' + (isFolder ? '📁' : '📄') + '</span>' + esc(name) + '<span style="color:var(--text-muted);font-size:11px">' + who + '</span></td>'
      + '<td>' + size + '</td>'
      + '<td style="color:var(--text-muted);font-size:12px">' + acc + '</td>'
      + '<td><button class="btn btn-sm" onclick="event.stopPropagation();copyShareLink(\\'' + s.id + '\\')">📋</button> <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteShare(\\'' + s.id + '\\')">🗑️</button></td></tr>';
  };
  try {
    const d = await api('/api/disk/shares');
    const shares = d.shares || [];
    diskSharedCount = shares.length;
    if (!shares.length) html.push('<tr><td colspan="4"><div class="muted" style="padding:12px">🔗 Aucun partage créé — clic droit sur un fichier/dossier puis « Partager »</div></td></tr>');
    else html.push(shares.map(merch).join(''));
    let inbound = [];
    try { const w = await api('/api/disk/shared-with-me'); inbound = (w && w.shares) || []; } catch {}
    if (inbound.length) {
      html.push('<tr><td colspan="4" style="padding-top:14px"><strong style="font-size:13px">📥 Partagés avec vous</strong></td></tr>');
      html.push(inbound.map(x => Object.assign({}, x, { id: x.id })).map(merch).join(''));
    }
    empty.style.display = 'none';
    tbody.innerHTML = html.filter(Boolean).join('');
  } catch (e) { tbody.innerHTML = ''; empty.style.display = 'block'; empty.textContent = '❌ ' + e.message; }
}

function copyShareLink(id) { navigator.clipboard.writeText(window.location.origin + '/share/' + id).then(() => toast('✅ Lien copié'), () => {}); }
async function deleteShare(id) {
  if (!await confirmAction('🗑️ Supprimer ce lien de partage ?')) return;
  try { await api('/api/disk/shares/' + id, { method: 'DELETE' }); toast('🗑️ Partage supprimé'); diskRender(); } catch (e) { toast('❌ ' + e.message, 'error'); }
}

function diskRenderBreadcrumb(id) {
  const bc = document.getElementById('disk-breadcrumb');
  if (id === '__shared__') {
    bc.innerHTML = '<a href="#" onclick="diskNavigate(null);return false" style="color:var(--text-link);text-decoration:none">☁️ Racine</a> <span style="color:var(--text-muted)">/</span> <span>🔗 Partagés</span>';
    return;
  }
  const parts = [];
  let cur = id ? diskItems.find(i => i.id === id) : null; if (!cur && id) return;
  while (cur) { parts.unshift({ id: cur.id, name: cur.name }); cur = cur.parentId ? diskItems.find(i => i.id === cur.parentId) : null; }
  let html = '<a href="#" onclick="diskNavigate(null);return false" style="color:var(--text-link);text-decoration:none">☁️ Racine</a>';
  parts.forEach(p => { html += ' <span style="color:var(--text-muted)">/</span> <a href="#" onclick="diskNavigate(\\'' + p.id + '\\');return false" style="color:var(--text-link);text-decoration:none">' + esc(p.name) + '</a>'; });
  bc.innerHTML = html;
}

function diskNavigate(id) { diskCurrentId = id; diskRender(); }
function diskClick(id) { const item = diskItems.find(i => i.id === id); if (!item) return; if (item.type === 'folder') diskNavigate(id); else diskPreview(id); }

function diskUpload() { document.getElementById('disk-file-input').click(); }
const DISK_CHUNK = 10 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function diskUpId() { return (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now() + Math.random().toString(36).slice(2)); }
function toHex(b) { return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
async function diskEncSlice(buf, pw) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  const key = await crypto.subtle.importKey('raw', h, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf));
  return { bytes: c.slice(0, -16), ivHex: toHex(iv), tagHex: toHex(c.slice(-16)) };
}
async function diskPostChunk(webhook, bytes, fname) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: '' }));
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), fname);
  let lastErr = null;
  for (let att = 0; att < 4; att++) {
    if (att) await sleep(Math.min(500 * Math.pow(2, att), 8000));
    try {
      const res = await fetch(webhook + '?wait=true', { method: 'POST', body: form });
      if (res.ok) {
        const msg = await res.json();
        if (!msg.attachments?.[0]) throw new Error('Pas de fichier en réponse');
        return { messageId: msg.id, attachmentId: msg.attachments[0].id, url: msg.attachments[0].url, channelId: msg.channel_id };
      }
      const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
      lastErr = new Error('Discord ' + res.status + ': ' + (await res.text()).slice(0, 200));
      if (res.status === 429 && ra) await sleep(Math.min(ra * 1000, 10000));
      else if (res.status === 429 || res.status >= 500) continue;
      break;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Envoi Discord échoué');
}
async function diskDelChunk(webhook, messageId) {
  try { await fetch(webhook + '/messages/' + messageId, { method: 'DELETE' }); } catch {}
}
function diskChunkName() { return 'blt_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2)) + '.bin'; }
function diskIsVideo(file) {
  const ext = ((file.name || '').toLowerCase().split('.').pop() || '');
  const t = (file.type || '').toLowerCase();
  return t.startsWith('video/') || ['mp4','m4v','mkv','mov','avi','webm','flv','wmv','mpg','mpeg','ts','m2ts','ogv','3gp','ogg'].includes(ext);
}
function diskLoadFFmpeg() {
  return new Promise((resolve, reject) => {
    const load = u => new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = () => rej(new Error('Impossible de charger ' + u)); document.head.appendChild(s); });
    load('/vendor/@ffmpeg/util@0.12.1/dist/umd/index.js')
      .then(() => load('/vendor/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js'))
      .then(resolve).catch(reject);
  });
}
async function diskConvertToMp4(file, onStatus) {
  if (typeof FFmpegWASM === 'undefined' || typeof FFmpegUtil === 'undefined') { if (onStatus) onStatus('Chargement du convertisseur...'); await diskLoadFFmpeg(); }
  const { FFmpeg } = FFmpegWASM;
  const { fetchFile } = FFmpegUtil;
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => { if (onStatus && message) { const m = String(message).split('\\n').pop(); if (m && m.trim()) onStatus(m); } });
  await ffmpeg.load({
    coreURL: '/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.js',
    wasmURL: '/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.wasm',
  });
  const ext = (file.name.split('.').pop() || 'bin');
  await ffmpeg.writeFile('input.' + ext, await fetchFile(file));
  if (onStatus) onStatus('Conversion en MP4 (peut prendre du temps)...');
  await ffmpeg.exec(['-i', 'input.' + ext, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-tag:v', 'avc1', 'output.mp4']);
  const data = await ffmpeg.readFile('output.mp4');
  const base = file.name.replace(/\\.[^/.]+$/, '');
  const mp4 = new File([data], base + '.mp4', { type: 'video/mp4' });
  try { await ffmpeg.terminate(); } catch {}
  return mp4;
}
let pvWant = null;
let pvActiveRend = null;
let pvSeekTo = 0;
let pvOptimizing = false;
function diskPlayQuality(qid) {
  diskAutoOff();
  diskPlayQualityRaw(qid);
}
function diskPlayQualityRaw(qid) {
  const pv = document.getElementById('pv-video');
  const loading = document.getElementById('pv-loading');
  if (!pv) return;
  if (pv.src && !isNaN(pv.currentTime) && pv.currentTime > 0) pvSeekTo = pv.currentTime;
  pvActiveRend = qid;
  const it = diskItems.find(i => i.id === qid);
  if (it) {
    if (it.quality) pvWant = it.quality;
    if (it.audioTrack) pvActiveAudio = it.audioTrack;
  }
  const bar = document.querySelectorAll('.pv-q');
  for (let i = 0; i < bar.length; i++) bar[i].classList.remove('active');
  const btn = document.querySelector('.pv-q[data-pvq="' + qid + '"]');
  const autoBtn = document.getElementById('pv-auto');
  if (pvAutoOn && autoBtn) autoBtn.classList.add('active');
  else if (btn) btn.classList.add('active');
  const abar = document.querySelectorAll('.pv-audio-btn');
  for (let i = 0; i < abar.length; i++) abar[i].classList.toggle('active', parseInt(abar[i].getAttribute('data-pva'), 10) === pvActiveAudio);
  if (loading) loading.style.display = 'block';
  pv.style.display = 'none';
  pv.removeAttribute('data-tried-orig');
  pv.removeAttribute('data-auto');
  pv.src = '/api/disk/preview/' + qid;
  pv.load();
}
function diskAudioTracksFor(root) {
  const map = {};
  diskItems.filter(i => i.renditionOf === root && i.type === 'file').forEach(r => { const t = r.audioTrack || 1; if (!map[t]) map[t] = { track: t, label: r.label || '' }; });
  return Object.values(map).sort((a, b) => a.track - b.track);
}
function diskPlayAudio(track, root) {
  let cands = diskItems.filter(i => i.type === 'file' && i.renditionOf === root && (i.audioTrack || 1) === track);
  if (!cands.length) return;
  let r = null;
  if (pvWant && !pvAutoOn) { const w = cands.find(i => i.quality === pvWant); if (w) r = w; }
  if (!r) r = cands.slice().sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0))[0];
  pvActiveAudio = track;
  const pv = document.getElementById('pv-video');
  if (pv && pv.src && !isNaN(pv.currentTime) && pv.currentTime > 0) pvSeekTo = pv.currentTime;
  diskPlayQualityRaw(r.id);
}
function diskSubSelect(subId, btnEl) {
  const pv = document.getElementById('pv-video');
  if (!pv) return;
  const want = String(subId);
  try {
    const tracks = pv.querySelectorAll('track');
    for (const tr of tracks) {
      if (tr.kind !== 'subtitles') continue;
      try { tr.track.mode = want ? (String(tr.getAttribute('data-sub')) === want ? 'showing' : 'hidden') : 'hidden'; } catch (e) {}
    }
  } catch (e) {}
  const a = document.querySelectorAll('.pv-sub-btn');
  for (let i = 0; i < a.length; i++) a[i].classList.toggle('active', a[i].getAttribute('data-sub') === want);
}
function diskDownloadActiveRend() {
  const id = pvActiveRend || null;
  if (!id) return;
  const it = diskItems.find(i => i.id === id);
  if (!it) return;
  const a = document.createElement('a');
  a.href = '/api/disk/download/' + id;
  a.download = it.name;
  a.click();
  toast('⬇️ Téléchargement de ' + (it.quality || 'la version') + '…');
}
let pvAutoOn = false;
let pvAutoTimer = null;
let pvAutoStable = 0;
let pvActiveAudio = 1;
function diskAutoRends() {
  const cur = diskItems.find(i => i.id === pvActiveRend);
  const root = cur && cur.renditionOf ? cur.renditionOf : (cur ? cur.id : null);
  if (!root) return [];
  return diskItems.filter(i => i.type === 'file' && i.renditionOf === root && (i.audioTrack || 1) === pvActiveAudio)
    .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
}
function diskAutoOff() {
  pvAutoOn = false;
  if (pvAutoTimer) { clearTimeout(pvAutoTimer); pvAutoTimer = null; }
  pvAutoStable = 0;
}
function diskAutoWatch() {
  if (!pvAutoOn) return;
  const m = document.getElementById('pv-video');
  if (!m) return;
  const list = diskAutoRends();
  if (!list.length) return;
  const down = () => {
    if (!pvAutoOn) return;
    const idx = list.findIndex(x => x.id === pvActiveRend);
    if (idx < 0 || idx >= list.length - 1) return;
    diskPlayQualityRaw(list[idx + 1].id);
  };
  const up = () => {
    if (!pvAutoOn) return;
    const idx = list.findIndex(x => x.id === pvActiveRend);
    if (idx <= 0) return;
    diskPlayQualityRaw(list[idx - 1].id);
  };
  m.onwaiting = () => { pvAutoStable = 0; if (pvAutoTimer) clearTimeout(pvAutoTimer); pvAutoTimer = setTimeout(down, 900); };
  m.onstalled = () => { pvAutoStable = 0; if (pvAutoTimer) clearTimeout(pvAutoTimer); pvAutoTimer = setTimeout(down, 900); };
  m.ontimeupdate = () => {
    if (m.paused) return;
    if (!pvAutoStable) pvAutoStable = Date.now();
    if (Date.now() - pvAutoStable > 12000) { pvAutoStable = Date.now(); up(); }
  };
}
function diskAuto(btn) {
  const bar = document.querySelectorAll('.pv-q');
  for (let i = 0; i < bar.length; i++) bar[i].classList.remove('active');
  if (btn) btn.classList.add('active');
  pvAutoOn = true;
  pvAutoStable = Date.now();
  const list = diskAutoRends();
  if (list.length) diskPlayQualityRaw(list[0].id); else diskPlayQualityRaw(pvActiveRend);
  setTimeout(diskAutoWatch, 1200);
}
async function diskRenditionFiles(file, qualities, onStatus) {
  if (typeof FFmpegWASM === 'undefined' || typeof FFmpegUtil === 'undefined') { if (onStatus) onStatus('Chargement du convertisseur...'); await diskLoadFFmpeg(); }
  const { FFmpeg } = FFmpegWASM;
  const { fetchFile } = FFmpegUtil;
  const ffmpeg = new FFmpeg();
  const logs = [];
  ffmpeg.on('log', ({ message }) => { if (message) { const m = String(message).split('\\n').pop(); logs.push(m); if (onStatus && m && m.trim()) onStatus(m); } });
  await ffmpeg.load({
    coreURL: '/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.js',
    wasmURL: '/vendor/@ffmpeg/core-mt@0.12.6/dist/umd/ffmpeg-core.wasm',
  });
  const ext = (file.name.split('.').pop() || 'bin');
  await ffmpeg.writeFile('input.' + ext, await fetchFile(file));
  const base = file.name.replace(/\\.[^/.]+$/, '');
  const out = [];
  try {
    for (const quality of qualities) {
      if (onStatus) onStatus('Encodage ' + quality + '…');
      const h = parseInt(quality, 10) || 720;
      const qo = 'out_' + quality + '.mp4';
      try {
        await ffmpeg.exec(['-i', 'input.' + ext, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-vf', 'scale=-2:min(' + h + '\\,ih)', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-tag:v', 'avc1', '-y', qo]);
      } catch (e) { throw new Error('ffmpeg-rendition: ' + (logs.slice(-5).filter(Boolean).join(' | ') || e.message)); }
      const data = await ffmpeg.readFile(qo);
      if (!data || !data.length) throw new Error('Transcription ' + quality + ' : sortie vide — ' + (logs.slice(-6).filter(Boolean).join(' | ') || 'erreur inconnue'));
      out.push(new File([data], base + '_' + quality + '.mp4', { type: 'video/mp4' }));
    }
  } finally {
    try { await ffmpeg.terminate(); } catch {}
  }
  return out;
}
async function diskOptimizeVideo(id, auto) {
  if (pvOptimizing) { if (auto) { const box = document.getElementById('pvbox'); if (box) box.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:260px;padding:20px;text-align:center"><div class="pv-loader"><div class="pv-ring pv-r1"></div><div class="pv-ring pv-r2"></div><div class="pv-ring pv-r3"></div><div class="pv-ring pv-r4"></div></div><div class="pv-loader-title">⚡ Optimisation en cours…</div><div class="pv-loader-sub">Vidéo déjà en cours d&#39;encodage</div></div>'; } return; }
  const item = diskItems.find(i => i.id === id);
  if (!item) return;
  if (diskItems.some(i => i.renditionOf === id)) { if (auto) diskPreview(id); return; }
  pvOptimizing = true;
  if (auto) { const box = document.getElementById('pvbox'); if (box) box.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:260px;padding:20px;text-align:center"><div class="pv-loader"><div class="pv-ring pv-r1"></div><div class="pv-ring pv-r2"></div><div class="pv-ring pv-r3"></div><div class="pv-ring pv-r4"></div></div><div class="pv-loader-title">⚡ Optimisation automatique…</div><div class="pv-loader-sub">Encodage 720/480/360p en cours</div></div>'; }
  try {
    for (const r of diskItems.filter(i => i.renditionOf === id)) { try { await api('/api/disk/delete/' + r.id, { method: 'DELETE' }); } catch (e) {} }
    const r = await fetch('/api/disk/preview/' + id);
    if (!r.ok) throw new Error('Téléchargement du source impossible');
    const blob = await r.blob();
    const f = new File([blob], item.name, { type: item.mime || 'video/mp4' });
toast('🔄 Encodage 720/480/360p…');
    const outs = (await diskRenditionFiles(f, ['720p', '480p', '360p'])).filter(r => r && r.size > 0);
    if (outs.length) for (const rend of outs) { await diskUploadFile(rend, item.parentId, () => {}); }
    const target = pvWant;
    await diskRefresh();
    toast('✅ Lecture prête');
    diskPreview(id);
    if (target) { const nr = diskItems.filter(i => i.renditionOf === id).find(r => r.quality === target); if (nr) diskPlayQuality(nr.id); }
  } catch (e) {
    toast('❌ ' + e.message, 'error');
    const pv = document.getElementById('pv-video');
    const loading = document.getElementById('pv-loading');
    if (pv) { if (loading) loading.style.display = 'none'; pv.style.display = 'block'; pv.src = '/api/disk/preview/' + id; pv.load(); }
  }
  finally { pvOptimizing = false; }
}
async function diskDecideConvert(file) {
  return diskIsVideo(file) ? 'video' : 'keep';
}
async function diskUploadFile(file, parentId, onProgress) {
  const key = window.DISK_KEY || '';
  const webhook = window.DISK_WEBHOOK || '';
  if (!key) throw new Error('Clé de chiffrement indisponible');
  if (!webhook) throw new Error('Webhook indisponible');
  if (!file || !file.size || file.size <= 0) throw new Error('Fichier vide refusé (' + (file ? file.size : 0) + ' octets)');
  const total = Math.max(1, Math.ceil(file.size / DISK_CHUNK));
  const chunks = [];
  try {
    for (let i = 0; i < total; i++) {
      if (window.__dzCancel) throw new Error('Annulé');
      const raw = await file.slice(i * DISK_CHUNK, Math.min((i + 1) * DISK_CHUNK, file.size)).arrayBuffer();
      const enc = await diskEncSlice(raw, key);
      const posted = await diskPostChunk(webhook, enc.bytes, diskChunkName());
      chunks.push({ url: posted.url, index: i, iv: enc.ivHex, tag: enc.tagHex, messageId: posted.messageId, channelId: posted.channelId, discordName: posted.attachmentId, size: enc.bytes.byteLength });
      if (onProgress) onProgress(i + 1, total);
      await sleep(120);
    }
    return await api('/api/disk/complete', { method: 'POST', body: { name: file.name, mime: file.type || '', size: file.size, parentId: parentId || null, chunks } });
  } catch (e) {
    for (const ch of chunks) await diskDelChunk(webhook, ch.messageId);
    throw e;
  }
}
async function diskScheduleFiles(files) {
  const jobs = [];
  const parentId = diskCurrentId === '__shared__' ? null : diskCurrentId;
  for (const f0 of files) {
    const mode = await diskDecideConvert(f0);
    if (mode === 'cancel') continue;
    jobs.push({ f0, parentId, mode });
  }
  if (jobs.length) dqSubmit(jobs);
}
async function diskUploadSend(input) {
  const files = [...input.files]; input.value = '';
  diskScheduleFiles(files);
}
function diskUploadFolder() { document.getElementById('disk-folder-input').click(); }
async function diskUploadFolderSend(input) {
  const files = [...input.files]; input.value = '';
  const folderMap = {};
  const jobs = [];
  const rootParent = diskCurrentId === '__shared__' ? null : diskCurrentId;
  const dirId = async (dirName, parent) => {
    const key = dirName + '@' + (parent || '');
    if (folderMap[key]) return folderMap[key];
    const ex = diskItems.find(i => i.type === 'folder' && i.name === dirName && (i.parentId || null) === parent);
    if (ex) { folderMap[key] = ex.id; return ex.id; }
    const d = await api('/api/disk/mkdir', { method: 'POST', body: { name: dirName, parentId: parent } });
    folderMap[key] = d.id; diskItems.push(d);
    return d.id;
  };
  for (const f0 of files) {
    let file = f0; let label = f0.name; let parentId = rootParent;
    const parts = (f0.webkitRelativePath || f0.name).split('/');
    if (parts.length >= 2) {
      let p = rootParent;
      for (let i = 0; i < parts.length - 1; i++) p = await dirId(parts[i], p);
      parentId = p;
      const fname = parts.slice(1).join('/');
      label = fname;
      file = new File([f0], fname, { type: f0.type });
    }
    const mode = await diskDecideConvert(file);
    if (mode === 'cancel') continue;
    jobs.push({ f0: file, parentId, mode, label });
  }
  dqSubmit(jobs);
}
async function diskRunJobs(jobs) {
  window.__dzCancel = false;
  if (!jobs.length) { diskRefresh(); return; }
  window.__diskBusy = true;
  const cv = sema(1); const up = sema(1);
  await Promise.all(jobs.map(j => dqAdd(j.label || j.f0.name, async set => {
    let file = j.f0;
    set({ status: 'working', detail: 'Préparation…' });
    if (window.__dzCancel) throw new Error('Annulé');
    if (j.mode === 'convert') {
      set({ status: 'working', progress: null, detail: '⏳ En attente de conversion…' });
      await cv.take();
      try {
        if (window.__dzCancel) throw new Error('Annulé');
        file = await diskConvertToMp4(file, m => set({ status: 'working', progress: null, detail: '🔄 ' + m }));
      } catch (e) { set({ status: 'working', progress: null, detail: '⚠️ Conversion impossible — import de l\\'original' }); }
      finally { cv.give(); }
    }
    set({ status: 'working', detail: 'Upload…' });
    await up.take();
    try { await diskUploadFile(file, j.parentId, (c, t) => set({ status: 'working', progress: t ? Math.round(c / t * 100) : 0, detail: t ? 'Importation des blocs ' + c + '/' + t : 'Importation des blocs…' })); }
    finally { up.give(); }
    if (j.mode === 'video') {
      set({ status: 'working', detail: 'Vidéo importée (original)' });
      toast('ℹ️ Vidéo importée sans versions — installe l\\'application pour générer la preview 720/480/360p');
    }
  }).catch(() => {})));
  window.__diskBusy = false;
  setTimeout(() => location.reload(), 500);
}

async function diskMkdir() {
  const name = await promptInput('📁 Nom du dossier :');
  if (!name) return;
  const parentId = diskCurrentId === '__shared__' ? null : diskCurrentId;
  try { await api('/api/disk/mkdir', { method: 'POST', body: { name, parentId } }); toast('✅ Dossier créé'); diskRefresh(); } catch (e) { toast('❌ ' + e.message, 'error'); }
}

async function diskDownload(id) {
  const item = diskItems.find(i => i.id === id);
  if (!item) return;
  const a = document.createElement('a');
  a.href = '/api/disk/download/' + id;
  a.download = item.name;
  a.click();
}
async function diskZipDownload(id) {
  const item = diskItems.find(i => i.id === id);
  if (!item) return;
  const rows = [];
  const collect = (pid, prefix) => {
    diskItems.filter(i => (i.parentId || null) === pid).forEach(i => {
      const p = prefix ? prefix + '/' + i.name : i.name;
      if (i.type === 'file') rows.push({ id: i.id, path: p });
      else collect(i.id, p);
    });
  };
  collect(item.id, item.name);
  if (!rows.length) { toast('Dossier vide', 'error'); return; }
  let fflate = window.fflate;
  if (!fflate) {
    try {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/fflate@0.8.2/umd/index.js'; s.onload = res; s.onerror = () => rej(new Error('Impossible de charger fflate')); document.head.appendChild(s); });
    } catch (e) { toast('ZIP impossible : ' + (e.message || e), 'error'); return; }
    fflate = window.fflate;
  }
  const Zip = fflate.Zip, ZipPassThrough = fflate.ZipPassThrough;
  if (!Zip || !ZipPassThrough) { toast('ZIP impossible : fflate indisponible', 'error'); return; }
  await dqAdd('🗜️ ZIP de ' + item.name, async set => {
    set({ status: 'working', progress: 0, detail: 'Téléchargement 0/' + rows.length });
    const chunks = [];
    let doneCount = 0;
    let resolveDone, rejectDone;
    const doneP = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    let finalized = false;
    const zip = new Zip((e, dat, final) => {
      if (e) { rejectDone(e); return; }
      if (dat) chunks.push(dat);
      if (final && !finalized) { finalized = true; resolveDone(); }
    });
    const failed = [];
    for (const r of rows) {
      const entry = new ZipPassThrough(r.path);
      let added = false;
      let ok = false;
      try {
        zip.add(entry);
        added = true;
        const res = await api('/api/disk/download/' + r.id);
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await entry.push(value);
        }
        await entry.push(new Uint8Array(0), true);
        ok = true;
      } catch (e) {
        failed.push({ path: r.path, error: e });
        if (added) { try { await entry.push(new Uint8Array(0), true); } catch {} }
      }
      doneCount++;
      set({ status: 'working', progress: Math.round(doneCount / rows.length * 100), detail: 'Téléchargement ' + doneCount + '/' + rows.length + (ok ? '' : ' — échec : ' + r.path) });
    }
    try { await zip.end(); } catch (e) { rejectDone(e); }
    await doneP;
    const blob = new Blob(chunks, { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (item.name || 'dossier') + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    set({ detail: doneCount + ' fichiers compressés' + (failed.length ? ' — ' + failed.length + ' échec(s)' : '') });
    toast('🗜️ ZIP créé (' + doneCount + ' fichiers)' + (failed.length ? ' — ' + failed.length + ' échec(s)' : ''));
  });
}

async function diskDelete(id) {
  const item = diskItems.find(i => i.id === id);
  if (!item) return;
  if (!await confirmAction('🗑️ Supprimer ' + (item.type === 'folder' ? '📁 ' : '📄 ') + esc(item.name) + (item.type === 'folder' ? ' (tout le contenu)' : '') + ' ?')) return;
  const ids = new Set();
  const collect = iid => {
    if (ids.has(iid)) return;
    const it = diskItems.find(x => x.id === iid);
    if (!it) return;
    ids.add(iid);
    if (it.type === 'folder') diskItems.filter(x => x.parentId === iid).forEach(x => collect(x.id));
    diskItems.filter(x => x.renditionOf === iid || x.subtitleOf === iid).forEach(x => collect(x.id));
  };
  collect(id);
  const files = [...ids];
  await dqAdd('🗑️ Suppression de ' + item.name, async set => {
    set({ status: 'working', progress: 0, detail: 'Suppression des blocs 0/' + files.length });
    for (let i = 0; i < files.length; i++) {
      await api('/api/disk/delete/' + files[i], { method: 'DELETE' });
      set({ status: 'working', progress: Math.round((i + 1) / files.length * 100), detail: 'Suppression des blocs ' + (i + 1) + '/' + files.length });
    }
    set({ detail: 'Suppression terminée' });
    toast('🗑️ Supprimé');
    await diskRefresh();
  });
}

async function diskPreview(id) {
  const item = diskItems.find(i => i.id === id);
  if (!item || item.type !== 'file') return;
  const mime = (item.mime || '').toLowerCase();
  const name = item.name.toLowerCase();
  const content = document.getElementById('modalContent');
  const overlay = document.getElementById('modalOverlay');
if (mime.startsWith('video/')) {
    try { await diskRefresh(); } catch (e) {}
    const rendsAll = diskItems.filter(i => i.renditionOf === id && i.type === 'file').slice();
    const subs = diskItems.filter(i => i.subtitleOf === id && i.type === 'file').sort((a, b) => (a.subtitleIndex || 0) - (b.subtitleIndex || 0));
    const byQ = {};
    for (const r of rendsAll) { const q = r.quality || 'orig'; const sz = (r.size || 0) + (r.chunks || []).reduce((s, c) => s + (c.size || 0), 0); if (!byQ[q] || sz > byQ[q]._sz) { byQ[q] = r; byQ[q]._sz = sz; } }
    const rends = Object.values(byQ);
    rends.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
    if (!rends.length) {
      content.innerHTML = '<h3>🎬 ' + esc(item.name) + '</h3>'
        + '<div class="preview-box" id="pvbox" style="display:flex;align-items:center;justify-content:center;min-height:200px;padding:16px"><div style="text-align:center"><div style="font-size:40px;margin-bottom:10px">🎬</div><p style="margin:0 0 8px;color:var(--text)">Aucune version 720/480/360p générée.</p><p style="margin:0;font-size:12px;color:var(--text-muted);max-width:340px">L\\'original est trop lourd pour la lecture navigateur. Télécharge-le, ou installe l\\'application de bureau pour générer les versions et lire en streaming.</p></div></div>'
        + '<div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button><button class="btn" onclick="closeModal();diskDownload(\\'' + id + '\\')">⬇️ Télécharger l\\'original</button></div>';
      overlay.classList.add('active');
      return;
    }
    const audioTracks = diskAudioTracksFor(id);
    const opts = rends.map(o => ({ id: o.id, label: (o.quality === '720p' ? 'HD 720p' : 'SD ' + o.quality) }));
    const qbar = '<div class="pv-quality"><button class="pv-q pv-auto" id="pv-auto" onclick="diskAuto(this)">⚡ Auto</button>' + opts.map((o, i) => '<button class="pv-q' + (i === 0 ? ' active' : '') + '" data-pvq="' + o.id + '" onclick="diskPlayQuality(\\'' + o.id + '\\')">' + o.label + '</button>').join('') + '</div>';
    const abar = audioTracks.length > 1
      ? '<div class="pv-quality pv-audiorow"><span class="pv-lbl">🎙️ Audio</span>' + audioTracks.map(t => '<button class="pv-q pv-audio-btn' + (t.track === 1 ? ' active' : '') + '" data-pva="' + t.track + '" onclick="diskPlayAudio(' + t.track + ',\\'' + id + '\\')">' + (t.label ? esc(t.label) : 'Piste ' + t.track) + '</button>').join('') + '</div>'
      : '';
    const sbar = subs.length
      ? '<div class="pv-quality pv-subrow"><span class="pv-lbl">💬 Sous-titres</span><button class="pv-q pv-sub-btn active" data-sub="" onclick="diskSubSelect(null,this)">Aucun</button>' + subs.map((s, i) => '<button class="pv-q pv-sub-btn" data-sub="' + s.id + '" onclick="diskSubSelect(\\'' + s.id + '\\',this)">' + (s.label ? esc(s.label) : 'Sous-titre ' + (s.subtitleIndex || i + 1)) + '</button>').join('') + '</div>'
      : '';
    content.innerHTML = '<h3>🎬 ' + esc(item.name) + '</h3>'
      + '<div class="preview-box" id="pvbox" style="padding:0;background:#000;position:relative"><div id="pv-loading">'
      + '<div class="pv-loader"><div class="pv-ring pv-r1"></div><div class="pv-ring pv-r2"></div><div class="pv-ring pv-r3"></div><div class="pv-ring pv-r4"></div></div>'
      + '<div class="pv-loader-title">Préparation de la vidéo…</div><div class="pv-loader-sub">Chargement et décodage en cours</div>'
      + '</div>'
      + '<video id="pv-video" controls autoplay playsinline preload="metadata" style="width:100%;height:auto;max-height:78vh;display:none">'
      + subs.map(s => '<track kind="subtitles" srclang="" data-sub="' + s.id + '" label="' + (s.label ? esc(s.label) : 'Sous-titres ' + s.id) + '" src="/api/disk/preview/' + s.id + '">').join('')
      + '</video>'
      + '</div>'
      + qbar + abar + sbar
      + '<div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button><button class="btn" onclick="closeModal();diskDownloadActiveRend()">⬇️ Cette version</button><button class="btn" onclick="closeModal();diskDownload(\\'' + id + '\\')">⬇️ Original</button></div>';
    overlay.classList.add('active');
    const pv = document.getElementById('pv-video');
    const loading = document.getElementById('pv-loading');
    if (pv) {
      const spin = () => { if (loading) loading.style.display = 'block'; };
      pv.onloadedmetadata = () => { if (pvSeekTo > 0) { try { pv.currentTime = pvSeekTo; } catch (e) {} } };
      pv.onloadeddata = () => { if (pvSeekTo > 0) { try { pv.currentTime = pvSeekTo; } catch (e) {} } pv.style.display = 'block'; if (loading) loading.style.display = 'none'; };
      pv.onseeked = () => { pvSeekTo = 0; };
      pv.oncanplay = () => { pv.style.display = 'block'; if (loading) loading.style.display = 'none'; };
      pv.onplaying = () => { pv.style.display = 'block'; if (loading) loading.style.display = 'none'; };
      pv.onwaiting = spin;
      pv.onstalled = spin;
      pv.onerror = () => { const box = document.getElementById('pvbox'); if (!box) return; if (!pv.hasAttribute('data-tried-orig')) { pv.setAttribute('data-tried-orig', '1'); pv.src = '/api/disk/preview/' + id; pv.load(); return; } box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:220px;padding:12px"><p style="margin:0;color:var(--orange);text-align:center">⚠️ Cette version ne peut pas se lire dans ton navigateur.</p></div>'; };
      pvWant = null;
      pvActiveAudio = 1;
      pvActiveRend = opts[0].id;
      pv.src = '/api/disk/preview/' + opts[0].id;
      pv.load();
    }
    return;
  }
  if (mime.startsWith('audio/')) {
    content.innerHTML = '<h3>🎵 ' + esc(item.name) + '</h3><div class="preview-box">'
      + '<audio id="pv-audio" controls autoplay src="/api/disk/preview/' + id + '" style="width:100%;display:block"></audio>'
      + '</div><div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button><button class="btn" onclick="closeModal();diskDownload(\\'' + id + '\\')">⬇️ Télécharger</button></div>';
    overlay.classList.add('active');
    return;
  }
  if (mime.startsWith('image/')) {
    content.innerHTML = '<h3>🖼️ ' + esc(item.name) + '</h3><div class="preview-box"><img src="/api/disk/preview/' + id + '" style="max-width:100%;max-height:70vh"></div><div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button></div>';
    overlay.classList.add('active'); return;
  }
  if (mime === 'application/pdf' || /\\.pdf$/i.test(name)) {
    try {
      const r = await fetch('/api/disk/preview/' + id);
      if (r.ok) {
        const blob = await r.blob();
        const u = URL.createObjectURL(blob);
        content.innerHTML = '<h3>📕 ' + esc(item.name) + '</h3><div class="preview-box"><iframe src="' + u + '" style="width:100%;height:72vh;border:0" title="PDF"></iframe></div><div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button><button class="btn" onclick="closeModal();diskDownload(\\'' + id + '\\')">⬇️ Télécharger</button></div>';
        overlay.classList.add('active'); return;
      }
    } catch {}
  }
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || /\\.(txt|md|json|js|ts|html|css|xml|yml|yaml|sh|bat|cmd|ps1|py|rb|php|java|c|cpp|cc|h|hpp|rs|go|sql|log|csv|tsv|ini|cfg|conf|toml|env|diff|patch)$/i.test(name)) {
    try {
      const r = await fetch('/api/disk/preview/' + id);
      if (r.ok) {
        const text = await r.text();
        content.innerHTML = '<h3>📄 ' + esc(item.name) + '</h3><div class="preview-box"><pre id="txt-view">' + esc(text) + '</pre></div><div class="modal-actions"><button class="btn" id="btn-txt-edit" onclick="diskEditNote()">✏️ Modifier</button><button class="btn btn-success" id="btn-txt-save" style="display:none" onclick="diskSaveText(\\'' + id + '\\')">💾 Enregistrer</button><button class="btn" onclick="closeModal()">Fermer</button></div>';
        overlay.classList.add('active'); return;
      }
    } catch {}
  }
  content.innerHTML = '<h3>📦 ' + esc(item.name) + '</h3><p>Aucun aperçu</p><div class="modal-actions"><button class="btn" onclick="closeModal();diskDownload(\\'' + id + '\\')">⬇️ Télécharger</button><button class="btn" onclick="closeModal()">Fermer</button></div>';
  overlay.classList.add('active');
}

function diskEditNote() {
  const pre = document.getElementById('txt-view');
  if (!pre) return;
  const ta = document.createElement('textarea');
  ta.id = 'txt-editor'; ta.spellcheck = false;
  ta.value = pre.innerText;
  ta.style.cssText = 'width:100%;height:58vh;resize:vertical;box-sizing:border-box;font-family:Consolas,monospace;font-size:13px;white-space:pre;overflow:auto';
  pre.replaceWith(ta);
  const e = document.getElementById('btn-txt-edit'); if (e) e.style.display = 'none';
  const s = document.getElementById('btn-txt-save'); if (s) s.style.display = '';
  ta.focus();
}
async function diskSaveText(id) {
  const ta = document.getElementById('txt-editor');
  if (!ta) return;
  try {
    await api('/api/disk/save/' + id, { method: 'POST', body: { content: ta.value } });
    toast('✅ Note enregistrée');
    closeModal();
    diskRefresh();
  } catch (e) { toast('❌ ' + (e.message || e), 'error'); }
}

function diskOpenShares() {
  const content = document.getElementById('modalContent');
  const overlay = document.getElementById('modalOverlay');
  content.innerHTML = '<h3>🔗 Partages</h3><div id="shares-list"><p class="text-muted">Chargement...</p></div><div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button></div>';
  overlay.classList.add('active');
  (async () => {
    try {
      const d = await api('/api/disk/shares');
      const list = document.getElementById('shares-list');
      if (!d?.shares?.length) { list.innerHTML = '<p class="text-muted">Aucun partage — clic droit sur un fichier/dossier puis « Partager »</p>'; return; }
      list.innerHTML = d.shares.map(s => {
        const name = esc(s.folderName || s.fileName || '?');
        const link = window.location.origin + '/share/' + s.id;
        const acc = (s.accessCount || 0) + (s.maxAccess > 0 ? '/' + s.maxAccess : '') + ' accès';
        return '<div style="padding:8px 12px;background:var(--card);border-radius:6px;margin-bottom:6px;font-size:13px">'
          + '🔗 ' + name + ' <span style="color:var(--text-muted)">(' + acc + ')</span>'
          + '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'
          + '<input type="text" readonly value="' + link + '" style="flex:1;min-width:180px;font-size:12px" onclick="this.select();navigator.clipboard.writeText(this.value);toast(\\'✅ Copié\\')">'
          + '<button class="btn btn-sm" onclick="copyShareLink(\\'' + s.id + '\\')">📋 Copier</button>'
          + '<button class="btn btn-sm btn-danger" onclick="deleteShareFromModal(\\'' + s.id + '\\')">🗑️ Supprimer</button></div></div>';
      }).join('');
    } catch (e) { document.getElementById('shares-list').innerHTML = '<p class="text-muted">❌ ' + e.message + '</p>'; }
  })();
}
async function diskGenAppToken() {
  const content = document.getElementById('modalContent');
  const overlay = document.getElementById('modalOverlay');
  content.innerHTML = '<h3>🔑 Token application</h3><p class="text-muted" style="line-height:1.6">Ce token permet à l\\'application de bureau (BLT Drive Desktop) d\\'accéder à ton espace sans te reconnecter. <b>Ne le partage jamais.</b></p><div id="token-out"><p class="text-muted">Chargement...</p></div><div class="modal-actions"><button class="btn btn-sm" onclick="diskRevokeAppToken()">🗑️ Révoquer tous</button><button class="btn" onclick="closeModal()">Fermer</button></div>';
  overlay.classList.add('active');
  try {
    const r = await api('/api/disk/apptoken', { method: 'POST' });
    document.getElementById('token-out').innerHTML = '<input type="text" readonly value="' + r.token + '" style="width:100%;font-family:monospace;font-size:12px;padding:8px;box-sizing:border-box" onclick="this.select();navigator.clipboard.writeText(this.value);toast(\\'✅ Token copié\\')">' + '<button class="btn btn-sm btn-success" style="margin-top:8px" onclick="navigator.clipboard.writeText(document.querySelector(\\'#token-out input\\').value);toast(\\'✅ Token copié\\')">📋 Copier</button>';
  } catch (e) { document.getElementById('token-out').innerHTML = '<p class="text-muted">❌ ' + esc(e.message) + '</p>'; }
}
async function diskRevokeAppToken() {
  try { await api('/api/disk/apptoken', { method: 'DELETE' }); toast('🗑️ Tokens révoqués'); diskGenAppToken(); } catch (e) { toast('❌ ' + e.message, 'error'); }
}
function diskAppInstall() {
  const content = document.getElementById('modalContent');
  const overlay = document.getElementById('modalOverlay');
  const appUrl = window.DISK_APP_URL || '';
  let dl = '';
  if (appUrl) dl = '<div class="app-dl" style="margin:14px 0;text-align:center"><a class="btn btn-success" style="display:inline-block;text-decoration:none" href="' + appUrl + '" download>⬇️ Télécharger BLT Drive Desktop (.exe Windows)</a><p class="text-muted" style="font-size:11px;margin:8px 0 0">119 Mo · Windows 10/11 · ffmpeg inclus — transcodage 720/480/360p en local</p></div>';
  content.innerHTML = '<h3>⬇️ Installer l\\'application</h3>'
    + dl
    + '<p class="text-muted" style="line-height:1.6">BLT Drive Desktop utilise ffmpeg sur ta machine pour transcoder les vidéos en 720/480/360p et relier ces versions à l\\'original, ce qui permet la lecture navigateur sans les limites du navigateur.</p>'
    + '<div class="app-box" style="margin:14px 0;padding:14px;background:var(--card);border:1px solid var(--border,#333);border-radius:10px;font-size:13px;line-height:1.7">'
    + '<div><b>1. Installe puis lance l\\'application.</b></div>'
    + '<div style="margin-top:10px"><b>2. Génère un token :</b> clique <b>🔑 Token app</b> en haut, copie-le et colle-le dans l\\'application.</div>'
    + '<div style="margin-top:10px"><b>3. Importe tes vidéos</b> depuis le disque dur ou récupère-les depuis le drive.</div>'
    + '</div>'
    + '<div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button></div>';
  overlay.classList.add('active');
}
async function deleteShareFromModal(id) {
  if (!await confirmAction('🗑️ Supprimer ce lien de partage ?')) return;
  try { await api('/api/disk/shares/' + id, { method: 'DELETE' }); toast('🗑️ Partage supprimé'); diskOpenShares(); if (diskCurrentId === '__shared__') diskRender(); } catch (e) { toast('❌ ' + e.message, 'error'); }
}

function showCtx(id, event) {
  ctxTarget = id; const menu = document.getElementById('ctxMenu'); const item = diskItems.find(i => i.id === id);
  if (!item) return;
  let h = '';
  if (item.type === 'folder') h += '<div class="context-menu-item" onclick="ctxOpen()">📂 Ouvrir</div>' + '<div class="context-menu-item" onclick="ctxZip()">🗜️ Télécharger ZIP</div>';
  else h += '<div class="context-menu-item" onclick="ctxDownload()">⬇️ Télécharger</div>';
  h += '<div class="context-menu-separator"></div><div class="context-menu-item" onclick="ctxRename()">✏️ Renommer</div><div class="context-menu-item" onclick="ctxMove()">📦 Déplacer</div>';
  h += '<div class="context-menu-item" onclick="ctxShare()">🔗 Partager</div>';
  h += '<div class="context-menu-separator"></div><div class="context-menu-item danger" onclick="ctxDelete()">🗑️ Supprimer</div>';
  menu.innerHTML = h; menu.style.display = 'block'; menu.style.left = event.clientX + 'px'; menu.style.top = event.clientY + 'px';
  document.addEventListener('click', closeCtx, { once: true });
}
function closeCtx() { document.getElementById('ctxMenu').style.display = 'none'; }
function ctxOpen() { if (ctxTarget) diskClick(ctxTarget); closeCtx(); }
function ctxDownload() { if (ctxTarget) diskDownload(ctxTarget); closeCtx(); }
function ctxZip() { if (ctxTarget) diskZipDownload(ctxTarget); closeCtx(); }
function ctxDelete() { if (ctxTarget) diskDelete(ctxTarget); closeCtx(); }
async function ctxRename() {
  const item = diskItems.find(i => i.id === ctxTarget);
  if (!item) return;
  const name = await promptInput('✏️ Nouveau nom :', item.name);
  if (!name || name === item.name) { closeCtx(); return; }
  try { await api('/api/disk/rename/' + ctxTarget, { method: 'POST', body: { name } }); toast('✅ Renommé'); diskRefresh(); } catch (e) { toast('❌ ' + e.message, 'error'); }
  closeCtx();
}
function diskFolderTree(excludeId) {
  const children = {};
  diskItems.filter(i => i.type === 'folder').forEach(f => {
    const pid = f.parentId ? f.parentId : '';
    (children[pid] = children[pid] || []).push(f);
  });
  const excl = new Set();
  const collect = id => { const list = children[id] || []; list.forEach(c => { excl.add(c.id); collect(c.id); }); };
  if (excludeId) collect(excludeId);
  const rows = [];
  const walk = (pid, depth) => {
    const list = children[pid] || [];
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    list.forEach(f => {
      if (excl.has(f.id)) return;
      rows.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    });
  };
  walk('', 0);
  return rows;
}
function pickMoveTarget(id) {
  window.__moveTarget = id;
  const sel = document.querySelectorAll('.mt-item');
  for (let i = 0; i < sel.length; i++) sel[i].classList.toggle('selected', sel[i].getAttribute('data-id') === id);
}
async function ctxMove() {
  const item = diskItems.find(i => i.id === ctxTarget);
  if (!item) return;
  const content = document.getElementById('modalContent'); const overlay = document.getElementById('modalOverlay');
  const rows = diskFolderTree(ctxTarget);
  let h = '<h3>📦 Déplacer <span class="mt-name">' + esc(item.name) + '</span></h3><div class="mt-sub">Choisis le dossier de destination</div><div class="move-tree" id="moveTree">'
    + '<div class="mt-item" data-id="" onclick="pickMoveTarget(\\'\\')"><span class="mt-ind"></span><span class="mt-ic">☁️</span> Racine</div>';
  rows.forEach(r => { h += '<div class="mt-item" data-id="' + r.id + '" onclick="pickMoveTarget(\\'' + r.id + '\\')"><span class="mt-ind" style="padding-left:' + (r.depth * 18) + 'px"></span><span class="mt-ic">📁</span> <span class="mt-label">' + esc(r.name) + '</span></div>'; });
  h += '</div><div class="modal-actions"><button class="btn btn-success" onclick="doMove()">📦 Déplacer</button><button class="btn" onclick="closeModal()">Annuler</button></div>';
  content.innerHTML = h;
  overlay.classList.add('active'); closeCtx();
  pickMoveTarget(item.parentId ? item.parentId : '');
}
async function doMove() {
  const t = window.__moveTarget === undefined ? '' : window.__moveTarget;
  const item = diskItems.find(i => i.id === ctxTarget);
  if (item && (t || '') === (item.parentId || '')) { toast('ℹ️ Déjà dans ce dossier'); closeModal(); return; }
  try { await api('/api/disk/move/' + ctxTarget, { method: 'POST', body: { parentId: t || null } }); toast('✅ Déplacé'); closeModal(); diskRefresh(); } catch (e) { toast('❌ ' + e.message, 'error'); }
}
function diskShare(id) { ctxTarget = id; ctxShare(); }
function diskMove(id) { ctxTarget = id; ctxMove(); }
async function ctxShare() {
  const item = diskItems.find(i => i.id === ctxTarget);
  if (!item) return;
  const content = document.getElementById('modalContent'); const overlay = document.getElementById('modalOverlay');
  const note = item.type === 'folder' ? '<p class="mt-sub">📁 Le partage inclura tout le contenu du dossier.</p>' : '';
  const isVid = /\.(mp4|m4v|mkv|mov|avi|webm|ts|mpeg|mpg|flv|wmv|ogv|3gp)$/i.test(item.name || '');
  const modeRow = isVid ? '<div class="sh-field" style="margin-top:10px"><span>Mode de lecture vidéo</span><div style="display:flex;gap:8px;margin-top:6px"><label class="sh-radio"><input type="radio" name="shareMode" value="normal" checked> <b>Normale</b><div class="sh-sub">Lien simple avec bouton téléchargement</div></label><label class="sh-radio"><input type="radio" name="shareMode" value="player"> <b>Lecteur</b><div class="sh-sub">Vidéo affichée en grand avec qualités</div></label></div></div>' : '';
  content.innerHTML = '<h3>🔗 Partager <span class="mt-name">' + esc(item.name) + '</span></h3>' + note
    + modeRow
    + '<label class="sh-field"><span>Destinataire Discord (optionnel)</span><input type="text" id="shareTarget" placeholder="pseudo ou ID — vide = lien public"></label>'
    + (window.DISK_IS_VIP ? '<label class="sh-check" style="display:flex;align-items:center;gap:8px;margin:8px 0"><input type="checkbox" id="shareEveryone" style="width:auto"> <span style="font-size:13px">Partager à <strong>tout le monde</strong> (visible par tous dans « Partagés avec moi »)</span></label>' : '')
    + '<label class="sh-field"><span>Mot de passe (optionnel)</span><input type="text" id="sharePw" placeholder="Aucun"></label>'
    + '<div class="sh-row"><label class="sh-field"><span>Accès max</span><input type="number" id="shareMax" min="0" value="0"></label><label class="sh-field"><span>Expire après (s)</span><input type="number" id="shareExp" min="0" value="0"></label></div>'
    + '<p class="sh-hint">0 = illimité / jamais</p>'
    + '<div class="modal-actions"><button class="btn btn-success" onclick="doShare()">Créer le lien</button><button class="btn" onclick="closeModal()">Annuler</button></div>';
  overlay.classList.add('active'); closeCtx();
}
async function doShare() {
  const pw = document.getElementById('sharePw').value;
  const exp = parseInt(document.getElementById('shareExp').value) || 0;
  const max = parseInt(document.getElementById('shareMax').value) || 0;
  const targetInput = document.getElementById('shareTarget');
  const targetUser = targetInput ? targetInput.value.trim() : '';
  const everyoneEl = document.getElementById('shareEveryone');
  const everyone = !!(everyoneEl && everyoneEl.checked);
  const vmEl = document.querySelector('input[name="shareMode"]:checked');
  const videoMode = vmEl ? vmEl.value : 'normal';
  try {
    const d = await api('/api/disk/shares', { method: 'POST', body: { fileId: ctxTarget, password: pw || undefined, expiresIn: exp, maxAccess: max || undefined, videoMode, targetUser: targetUser || undefined, targetUserId: /^\d{10,25}$/.test(targetUser) ? targetUser : undefined, everyone: everyone || undefined } });
    const link = window.location.origin + (d.link || d.url || '');
    const sid = d.id || (link.split('/').pop() || '');
    const content = document.getElementById('modalContent');
    content.innerHTML = '<h3>✅ Lien créé</h3>'
      + '<input type="text" readonly value="' + esc(link) + '" style="cursor:pointer;text-align:center;font-size:13px" onclick="this.select();navigator.clipboard.writeText(this.value);toast(\\'✅ Copié\\')">'
      + '<div class="modal-actions">'
      + '<button class="btn" onclick="window.open(\\'' + esc(link) + '\\',\\'_blank\\');closeModal()">🔗 Ouvrir</button>'
      + '<button class="btn" onclick="navigator.clipboard.writeText(\\'' + esc(link) + '\\');toast(\\'✅ Lien copié\\')">📋 Copier</button>'
      + (sid ? '<button class="btn btn-danger" onclick="deleteShare(\\'' + sid + '\\');closeModal()">🗑️ Supprimer</button>' : '')
      + '<button class="btn" onclick="closeModal()">Fermer</button></div>';
    if (diskCurrentId === '__shared__') diskRender();
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}

const sema = limit => { let n = 0; const q = []; const take = () => new Promise(res => { if (n < limit) { n++; res(); } else q.push(res); }); const give = () => { if (q.length) q.shift()(); else n--; }; return { take, give }; };

function dqAdd(name, fn) {
  dqIdCounter++; const id = dqIdCounter;
  dqItems[id] = { id, name, status: 'queued', progress: null, detail: '' };
  dqRender();
  const set = patch => { if (dqItems[id]) { Object.assign(dqItems[id], patch); dqRender(); } };
  const p = Promise.resolve().then(() => fn(set));
  p.then(() => { set({ status: 'done', progress: 100, detail: '✅ Terminé' }); setTimeout(() => dqRemoveId(id), 4000); })
   .catch(e => { set({ status: 'error', detail: '❌ ' + (e.message || e) }); setTimeout(() => dqRemoveId(id), 8000); });
  return p;
}
function dqRemoveId(id) { delete dqItems[id]; dqRender(); }
function dqRenderHTML() {
  const list = document.getElementById('dqList'); const count = document.getElementById('dqCount'); const c = document.getElementById('dqContainer');
  const e = Object.values(dqItems); const a = e.filter(x => x.status === 'working' || x.status === 'queued').length;
  count.textContent = a + '/' + e.length; c.style.display = e.length ? 'flex' : 'none';
  if (!e.length) { list.innerHTML = '<div class="dq-empty">Aucune tâche</div>'; return; }
  list.innerHTML = e.map((x, i) => {
    const cls = x.status === 'done' ? ' done' : x.status === 'error' ? ' error' : x.status === 'queued' ? ' queued' : ' working';
    let bar = '';
    if (x.status === 'working') {
      if (typeof x.progress === 'number') {
        const w = Math.max(0, Math.min(100, x.progress));
        bar = '<div class="progress-bar" style="height:4px;margin:3px 0 0"><div class="progress-fill" style="width:' + w + '%"></div></div>';
      } else {
        bar = '<div class="progress-bar" style="height:4px;margin:3px 0 0"><div class="progress-fill indet" style="width:100%"></div></div>';
      }
    }
    return '<div class="dq-item' + cls + '"><div style="flex:1;min-width:0"><div class="name">' + esc(x.name) + '</div>'
      + bar
      + (x.detail ? '<div class="detail">' + esc(x.detail) + '</div>' : '')
      + '</div><span class="dq-remove" onclick="dqRemove(' + i + ')">✕</span></div>';
  }).join('');
}
let dqLastJson = '';
function dqRender() { dqRenderHTML(); if (dqBC) { const j = JSON.stringify(dqSnapshot()); if (j !== dqLastJson) { dqLastJson = j; try { dqBC.postMessage(dqSnapshot()); } catch {} } } }
function dqRemove(idx) { const k = Object.keys(dqItems); delete dqItems[k[idx]]; dqRender(); }
function dqToggle() { const c = document.getElementById('dqContainer'); c.style.display = c.style.display === 'none' ? 'flex' : 'none'; }
let dqWin = null, dqWinReady = false, dqPendingJobs = [];
function dqOpenWorker() {
  if (dqWin && !dqWin.closed) return dqWin;
  const w = window.open('', 'bltDriveTasks', 'popup=yes,width=440,height=700,resizable=yes,scrollbars=yes');
  if (!w) { toast('Autorise les popups pour lancer les tâches', 'error'); return null; }
  const tpl = document.getElementById('dqWindowTemplate');
  if (!w.document.getElementById('dqList')) {
    w.document.open();
    w.document.write('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>📊 Tâches — BLT Drive</title><style>' + DQ_WIN_CSS + '</style></head><body>' + tpl.innerHTML + '</body></html>');
    w.document.close();
  }
  dqWin = w; dqWinReady = false;
  try { w.postMessage({ type: 'blt-ping' }, '*'); } catch {}
  const iv = setInterval(() => { if (!w.closed) return; if (dqWin === w) { dqWin = null; dqWinReady = false; } clearInterval(iv); }, 3000);
  return w;
}
function dqSubmit(jobs) {
  if (!jobs || !jobs.length) return;
  diskRunJobs(jobs);
}
function flush() { if (!dqWin || !dqWinReady) return; const j = dqPendingJobs; dqPendingJobs = []; if (j.length) try { dqWin.postMessage({ type: 'blt-jobs', jobs: j }, '*'); } catch {} }
window.addEventListener('message', ev => { if (ev.data && ev.data.type === 'blt-ready' && ev.source === dqWin) { dqWinReady = true; flush(); } });
function dqDetach() { const w = dqOpenWorker(); if (w) toast('📊 Tâches ouvertes dans une fenêtre séparée'); }
const DQ_WIN_CSS = 'body{margin:0;font-family:"gg sans","Noto Sans",sans-serif;background:#313338;color:#dbdee1}.tq{display:flex;flex-direction:column;height:100vh}.tq-head{padding:10px 14px;background:#2b2d31;border-bottom:1px solid #3f4147;font-weight:600;display:flex;align-items:center}.tq-count{margin-left:auto;color:#949ba4;font-size:12px}.tq-list{flex:1;overflow-y:auto;padding:8px}.dq-empty{color:#949ba4;text-align:center;padding:24px}.tq-item{padding:8px 10px;border-radius:6px;margin-bottom:6px;font-size:13px;background:#2b2d31;border:1px solid #3f4147;border-left:3px solid #5865F2}.tq-item.queued{border-left-color:#faa81a}.tq-item.working{animation:pulse 1.4s ease-in-out infinite}.tq-item.done{border-left-color:#57f287}.tq-item.error{border-left-color:#da373c}.tq-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tq-detail{font-size:11px;color:#949ba4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.tq-bar{background:#1e1f22;border-radius:4px;height:5px;overflow:hidden;margin-top:6px}.tq-bar>div{background:#5865F2;height:100%;transition:width .3s}.tq-bar>div.tq-indet{background:repeating-linear-gradient(45deg,#5865F2 0 8px,rgba(88,101,242,.35) 8px 16px);animation:tqSlide .8s linear infinite;transition:none}@keyframes tqSlide{0%{background-position:0 0}100%{background-position:16px 0}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}';
const dqBC = 'BroadcastChannel' in window ? new BroadcastChannel('blt-drive-tasks') : null;
let dqHadActive = false, dqSawExec = false;
if (dqBC) dqBC.onmessage = ev => {
  const d = ev.data;
  if (!d) return;
  if (d.request === 'sync') {
    if (dqHadActive || Object.values(dqItems).length) { try { dqBC.postMessage(dqSnapshot()); } catch {} }
    return;
  }
  if (d.items) {
    const localActive = Object.values(dqItems).some(x => x.status === 'working' || x.status === 'queued');
    if (!localActive) {
      const m = {}; d.items.forEach(x => { if (x && x.id) m[x.id] = x; });
      for (const k in dqItems) if (!m[k]) delete dqItems[k];
      Object.assign(dqItems, m);
      const first = !dqSawExec; dqSawExec = true;
      dqRenderHTML();
      if (first) { if (d.items.length && d.active === 0) diskRefresh(); }
      else if (dqHadActive && !d.active) diskRefresh();
      dqHadActive = d.active > 0;
    }
  }
};
function dqSnapshot() { const e = Object.values(dqItems).map(x => ({ id: x.id, name: x.name, status: x.status, progress: x.progress, detail: x.detail })); const a = e.filter(x => x.status === 'working' || x.status === 'queued').length; return { items: e, active: a, total: e.length }; }

function toast(msg, type) { const t = document.createElement('div'); t.className = 'toast toast-' + (type || 'success'); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000); }
function closeModal() { const o = document.getElementById('modalOverlay'); if (o) o.classList.remove('active'); const v = document.getElementById('pv-video'); if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} } const a = document.getElementById('pv-audio'); if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {} } }
function promptInput(msg, dv) {
  return new Promise(r => {
    const o = document.getElementById('modalOverlay'); const c = document.getElementById('modalContent');
    c.innerHTML = '<h3>' + msg + '</h3><input type="text" id="promptInput" value="' + esc(dv || '') + '" placeholder="..."><div class="modal-actions"><button class="btn" onclick="doPrompt(document.getElementById(\\'promptInput\\').value)">OK</button><button class="btn" onclick="doPrompt(null)">Annuler</button></div>';
    o.classList.add('active'); window.doPrompt = v => { o.classList.remove('active'); r(v); };
    setTimeout(() => { const i = document.getElementById('promptInput'); if (i) i.focus(); }, 100);
  });
}
function confirmAction(msg) {
  return new Promise(r => {
    const o = document.getElementById('modalOverlay'); const c = document.getElementById('modalContent');
    c.innerHTML = '<h3>' + msg + '</h3><div class="modal-actions"><button class="btn btn-danger" onclick="doConfirm(true)">Oui</button><button class="btn" onclick="doConfirm(false)">Non</button></div>';
    o.classList.add('active'); window.doConfirm = v => { o.classList.remove('active'); r(v); };
  });
}

function toggleAccountMenu() {
  const m = document.getElementById('account-menu');
  if (m.style.display !== 'none') { m.style.display = 'none'; return; }
  renderDriveAccounts();
  m.style.display = 'block';
}
function driveAccounts() {
  try { return JSON.parse(localStorage.getItem('panel_accounts') || '[]'); } catch { return []; }
}
function driveSaveCurrentAccount() {
  const app = document.getElementById('app'); if (!app) return;
  const discordId = app.dataset.discordid; const sid = app.dataset.sid || '';
  if (!discordId && !sid) return;
  const accounts = driveAccounts();
  let i = discordId ? accounts.findIndex(a => a.discordId === discordId) : accounts.findIndex(a => a.sid === sid);
  if (i < 0) i = accounts.findIndex(a => a.sid === sid);
  const entry = { discordId, sid, username: app.dataset.user, avatar: app.dataset.avatar, savedAt: Date.now() };
  if (i >= 0) accounts[i] = entry; else accounts.push(entry);
  try { localStorage.setItem('panel_accounts', JSON.stringify(accounts)); } catch {}
}
function renderDriveAccounts() {
  const el = document.getElementById('drive-account-list'); if (!el) return;
  const accounts = driveAccounts().slice().reverse();
  const usid = document.getElementById('app').dataset.sid || '';
  if (!accounts.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 12px">Aucun compte enregistré</div>'; return; }
  el.innerHTML = accounts.map(a => {
    const active = a.sid && a.sid === usid;
    const av = a.avatar ? '/api/avatar?url=' + encodeURIComponent(a.avatar) : '';
    return '<div class="account-list-item" style="' + (active ? 'background:var(--active)' : '') + '" onclick="' + (active ? 'driveToggleOff()' : "driveSwitchAccount('" + (a.sid || '').replace(/'/g, '') + "')") + '">'
      + '<img class="user-avatar" style="width:22px;height:22px" src="' + av + '" alt="" onerror="this.style.display=&#39;none&#39;">'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((a.username || 'compte')) + '</span>'
      + (active ? '<span style="font-size:11px;color:var(--green)">&#10003;</span>' : '<span style="font-size:11px;color:var(--text-muted)">&#8599;</span>')
      + '</div>';
  }).join('');
}
function driveSwitchAccount(sid) {
  const rU = document.querySelector('.layout')?.dataset?.driveurl || '';
  if (!sid) { toast('Session de ce compte indisponible — reconnecte-le depuis le panel', 'error'); return; }
  window.location.href = rU + '/drive/switch/' + encodeURIComponent(sid);
}
function driveAddAccount() {
  const rU = document.querySelector('.layout')?.dataset?.driveurl || '';
  window.location.href = rU + '/auth/discord?add=1';
}
function driveToggleOff() { document.getElementById('account-menu').style.display = 'none'; }

if (dqBC) try { dqBC.postMessage({ request: 'sync' }); } catch {}
driveSaveCurrentAccount();
diskInit();
</script>
</body>
</html>`;
}

function loginHtml(user, c, cb) {
  const cbParam = cb ? Number(cb) : 0;
  const useCb = cbParam > 0 && cbParam < 65536;
  const esc = x => (x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const name = user ? esc(user.displayName || user.username || 'compte') : '';
  const avatar = user && user.avatar ? 'https://cdn.discordapp.com/avatars/' + encPath(user.discordId, user.avatar) : '';
  function encPath(id, hash) { return id + '/' + hash + '.png'; }
  const avatarImg = user && user.avatar ? '<img class="av" src="/api/avatar?url=' + encodeURIComponent(avatar) + '" alt="">' : '<div class="av av-ghost">👤</div>';
  const logged = user
    ? '<div class="card" id="logged"><div class="who">' + avatarImg + '<div><b>' + name + '</b><div class="sub">Connecté · ' + esc(user.role || 'membre') + '</div></div></div>'
      + '<p class="txt">Cliquez ci-dessous pour autoriser <b>BLT Drive Desktop</b> à utiliser ce compte. Une fois autorisé, retournez automatiquement dans l\u2019application.</p>'
      + '<div id="err" class="err"></div>'
      + '<button class="btn" onclick="authApp()">🚀 Autoriser et connecter</button>'
      + '<div class="alt"><a href="' + c.railwayUrl + '/auth/discord?add=1">➕ Connecter <b>un autre compte</b> Discord</a></div>'
      + '</div>'
    : '<div class="card"><div class="who"><div class="av av-ghost">🔑</div><div><div>Non connecté</div><div class="sub">Authentifie-toi pour lier un compte.</div></div></div>'
      + '<a class="btn" href="' + c.railwayUrl + '">🔑 Se connecter via le panel</a>'
      + '<div class="alt"><a href="#" onclick="location.reload();return false">↻ Réessayer</a></div></div>';
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion — BLT Drive Desktop</title>'
    + '<style>body{margin:0;font-family:"gg sans","Segoe UI",system-ui,sans-serif;background:#313338;color:#dbdee1;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#2b2d31;border:1px solid #3f4147;border-radius:12px;padding:34px;width:420px;max-width:92vw;text-align:center}.who{display:flex;align-items:center;gap:14px;text-align:left;margin-bottom:16px;font-size:16px;font-weight:600}.who .sub{font-weight:400;font-size:12px;color:#949ba4}.avatar{width:52px;height:52px;border-radius:50%}.av{width:52px;height:52px;border-radius:50%;background:#1e1f22;display:flex;align-items:center;justify-content:center;font-size:24px}.txt{font-size:13px;color:#b5bac1;line-height:1.6;margin:4px 0 20px}.err{color:#da373c;font-size:12px;margin-bottom:12px;min-height:16px}.btn{display:block;width:100%;background:#5865F2;color:#fff;border:none;padding:13px;border-radius:7px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;box-sizing:border-box}.btn:hover{background:#4752c4}.btn:disabled{opacity:.55;cursor:default}.alt,.sub-line{margin-top:14px;font-size:12px;color:#949ba4}.alt a,.sub-line a{color:#b5bac1}.alt a{display:block;text-decoration:none;margin-top:16px}</style>'
    + '</head><body>' + logged + '<script>'
    + 'var __cb=' + (useCb ? cbParam : 0) + ';'
    + 'function escA(s){ return String(s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;"); }'
    + 'function showOpen(q){'
    + ' var href="bltdrive://login?"+q.toString();'
    + ' var c=document.querySelector(".card");'
    + ' c.innerHTML=\'<div style="background:#2b2d31;border:1px solid #3f4147;border-radius:10px;padding:18px"><div style="font-size:44px">📲</div><h3 style="margin:8px 0">Retour dans l\\u2019application</h3>\''
    + ' + \'<p style="color:#b5bac1;font-size:13px;line-height:1.6;margin:4px 0 16px">Ton compte est prêt. Clique ci-dessous pour rouvrir <b>BLT Drive Desktop</b> : la connexion se fera toute seule.</p>\''
    + ' + \'<a class="btn" href="\'+href+\'">🚀 Ouvrir l\\u2019application</a>\''
    + ' + \'<p style="margin-top:10px;font-size:12px;color:#949ba4;text-align:center">Pas de pop-up ? Vérifie que BLT Drive Desktop est bien installé et lancé une fois.</p></div>\';'
    + ' try{ if(__cb>0){ fetch("http://127.0.0.1:"+__cb+"/?"+q.toString(),{method:"GET",mode:"cors"}).catch(function(){}); } }catch(e){}'
    + ' try{ setTimeout(function(){ location.href=href; }, 350); }catch(e){}'
    + '}'
    + 'function authApp(){ var b=document.querySelector(".btn"); b.disabled=true; b.textContent="Autorisation en cours…"; fetch("/api/disk/apptoken",{method:"POST",headers:{"X-Requested-With":"blt-drive-desktop"}}).then(function(r){return r.json()}).then(function(j){if(!j.token){document.getElementById("err").textContent=j.error||"Erreur";b.disabled=false;b.textContent="▶ Réessayer";return;}var q=new URLSearchParams({token:j.token,label:j.displayName||"Compte",discord_id:j.discordId||"",role:j.role||"member",quota_role:j.quotaRole||""}); showOpen(q);}).catch(function(e){document.getElementById("err").textContent=String(e);b.disabled=false;b.textContent="▶ Réessayer";});}'
    + '</script></body></html>';
}

export default {
  async fetch(request, env, ctx) {
    try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/{2,}/g, '/');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_H });

    if (path === '/health') return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });

    if (path === '/login') {
      const u = getUser(request);
      const cb = url.searchParams.get('cb') || '';
      return new Response(loginHtml(u, cfg(env), cb), { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (path.startsWith('/vendor/')) {
      const p = path.slice(8);
      if ((!p.startsWith('@ffmpeg/') && !p.startsWith('fflate@')) || p.includes('..')) return json({ error: 'Not found' }, 404);
      const res = await fetch('https://unpkg.com/' + p, { cf: { cacheTtl: 31536000 } });
      if (!res.ok) return new Response(null, { status: res.status });
      const body = await res.arrayBuffer();
      return new Response(body, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
    }

    if (path === '/api/avatar') {
      const q = new URL(request.url).searchParams.get('url') || '';
      if (!/^https:\/\/cdn\.discordapp\.com\/(avatars|embed\/avatars)\//.test(q)) return json({ error: 'Bad url' }, 400);
      const res = await fetch(q, { cf: { cacheTtl: 31536000, cacheEverything: true } });
      if (!res.ok) return new Response(null, { status: res.status });
      const body = await res.arrayBuffer();
      return new Response(body, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
    }

    if (path === '/auth/railway') return handleAuth(request, env);

    if (path === '/api/fetch') return handleFetch(request);

    if (path === '/api/disk/tree') {
      const user = await authUser(request, env);
      return diskTree(env, user?.discordId || '');
    }
    if (path === '/api/disk/config') {
      return diskConfig(env, await authUser(request, env));
    }
    if (path === '/api/disk/apptoken' && request.method === 'POST') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskTokenCreate(env, user);
    }
    if (path === '/api/disk/apptoken' && request.method === 'DELETE') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskTokenRevoke(env, user.discordId);
    }
    if (path.startsWith('/api/disk/chunks/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskChunks(env, path.slice(17), user.discordId);
    }
    if (path === '/api/disk/complete') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      const body = await request.json().catch(() => ({}));
      return diskComplete(body, env, user.discordId);
    }
    if (path === '/api/disk/mkdir') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      const body = await request.json();
      return diskMkdir(body, env, user.discordId);
    }
    if (path.startsWith('/api/disk/delete/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskDelete(env, path.slice(17), user.discordId);
    }
    if (path.startsWith('/api/disk/rename/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      const body = await request.json();
      return diskRename(env, path.slice(17), body.name);
    }
    if (path.startsWith('/api/disk/move/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      const body = await request.json();
      return diskMove(env, path.slice(15), body.parentId);
    }
    if (path === '/api/disk/shares' && request.method === 'GET') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskShares(env, user.discordId);
    }
    if (path === '/api/disk/shared-with-me' && request.method === 'GET') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskSharedWithMe(env, user.discordId, user);
    }
    if (path === '/api/disk/shares' && request.method === 'POST') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      const body = await request.json();
      if (body.everyone && user.role !== 'moderator') return json({ error: 'Seuls les modérateurs peuvent partager à tout le monde' }, 403);
      return diskShareCreate(body, env, user.discordId, user.displayName || user.username || '');
    }
    if (path.startsWith('/api/disk/zip/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskZip(env, path.slice(14), user.discordId);
    }
    if (path.startsWith('/api/disk/save/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      const body = await request.json();
      return diskSave(env, path.slice(15), body.content, user.discordId);
    }
    if (path.startsWith('/api/disk/download/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskDownload(env, path.slice(19), user.discordId, request.headers.get('Range'));
    }
    if (path.startsWith('/api/disk/preview/')) {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskDownload(env, path.slice(18), user.discordId, request.headers.get('Range'), true);
    }
    if (path === '/api/disk/shared/download/' && request.method === 'GET') {
      return json({ error: 'Token manquant' }, 401);
    }
    if (path.startsWith('/api/disk/shared/download/')) {
      return diskSharedDownload(env, path.slice('/api/disk/shared/download/'.length), request.headers.get('Range'), url.searchParams.get('inline') === '1');
    }
    if (path.endsWith('/verify') && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return diskShareVerify(body, env);
    }
    if (path.startsWith('/share/') && request.method === 'GET') {
      const s = await diskShareFind(env, path.slice(7));
      if (s) {
        const expired = s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
        const maxed = s.maxAccess > 0 && s.accessCount >= s.maxAccess;
        if (s.type !== 'folder' && !s.password && !expired && !maxed && s.id === 'courage-plaine-9rqv2da9ms') {
          const enc = b64url(JSON.stringify({ shareId: s.id, fileId: s.fileId, exp: Math.floor(Date.now() / 1000) + 3600 }));
          const sig = b64url(await hmacSign(enc, cfg(env).driveSecret));
          return new Response('', { status: 302, headers: { Location: '/api/disk/shared/download/' + enc + '.' + sig, 'Cache-Control': 'no-store' } });
        }
      }
      let rendInfo = null;
      if (s) {
        const items = (await kvGet(env, 'disk:items')) || [];
        const isVideo = s.type !== 'folder' && diskMimeFor(s.fileName || '', s.fileMime || '').startsWith('video/');
        if (isVideo) {
          const rends = items.filter(r => r.type === 'file' && r.renditionOf === s.fileId);
          const size = r => (r.size || 0) + (r.chunks || []).reduce((x, c) => x + (c.size || 0), 0);
          const quals = rends.filter(r => (r.audioTrack || 1) === 1).map(r => ({ id: r.id, quality: r.quality || '', size: size(r) })).sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
          const trackMap = {};
          for (const r of rends) { const t = r.audioTrack || 1; if (!trackMap[t] || size(r) > trackMap[t].size) trackMap[t] = { track: t, id: r.id, quality: r.quality || '', size: size(r), label: r.label || '' }; }
          const audioTracks = Object.values(trackMap).sort((a, b) => a.track - b.track);
          const subs = items.filter(r => r.type === 'file' && r.subtitleOf === s.fileId).map(r => ({ id: r.id, index: r.subtitleIndex || 0, label: r.label || '' })).sort((a, b) => a.index - b.index);
          rendInfo = { isVideo, quals, audioTracks, subtitles: subs };
        } else {
          rendInfo = { isVideo, quals: [], audioTracks: [], subtitles: [] };
        }
      }
      return new Response(shareHtml(env, s, rendInfo), { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (path.startsWith('/api/disk/shares/') && request.method === 'DELETE') {
      const user = await authUser(request, env);
      if (!user) return json({ error: 'Non auth' }, 401);
      return diskShareDelete(env, path.slice(17), user.discordId);
    }

    // Serve UI
    const user = getUser(request);
    if (!user) {
      return new Response('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLT Drive</title><style>body{margin:0;font-family:\'gg sans\',\'Noto Sans\',sans-serif;background:#313338;color:#dbdee1;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#2b2d31;border:1px solid #3f4147;border-radius:12px;padding:40px 36px;width:400px;max-width:90vw;text-align:center}.card h1{font-size:20px;color:#f2f3f5;margin-bottom:8px}.card p{color:#949ba4;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:#5865F2;color:#fff;border:none;padding:12px 24px;border-radius:4px;font-size:15px;font-weight:500;cursor:pointer;text-decoration:none;font-family:inherit}.btn:hover{background:#4752c4}</style></head><body><div class="card"><h1>Authentification requise</h1><p>Connecte-toi via le panel principal.</p><a class="btn" href="' + cfg(env).railwayUrl + '">Retour au panel</a></div></body></html>', { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return new Response(driveHtml(cfg(env).railwayUrl, user), { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } });
  } catch (e) { return json({ error: e.message + ' ' + e.stack }, 500); }
  },

  async scheduled(event, env, ctx) {
    const last = await kvGet(env, 'disk:lastRefresh');
    const now = Date.now();
    if (last && now - last < 6 * 3600 * 1000) return;
    ctx.waitUntil(refreshAllUrls(env).then(() => kvSet(env, 'disk:lastRefresh', now)));
  },
};
