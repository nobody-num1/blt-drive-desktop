const crypto = require('crypto');
const fs = require('fs');

const DISK_CHUNK = 10 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function deriveKey(pw) {
  return crypto.createHash('sha256').update(pw, 'utf8').digest();
}

function encSlice(buf, pw) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pw), iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { bytes: enc, ivHex: iv.toString('hex'), tagHex: cipher.getAuthTag().toString('hex') };
}

function decryptBuf(enc, ivHex, tagHex, pw) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pw), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function chunkName() {
  return 'blt_' + crypto.randomBytes(16).toString('hex') + '.bin';
}

async function postChunk(webhook, bytes, fname) {
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
        if (!msg.attachments || !msg.attachments[0]) throw new Error('Pas de fichier en réponse');
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

async function delChunk(webhook, messageId) {
  try { await fetch(webhook + '/messages/' + messageId, { method: 'DELETE' }); } catch {}
}

async function uploadFile(api, key, webhook, filePath, name, mime, parentId, onProgress, label, replaceId) {
  const size = fs.statSync(filePath).size;
  const total = Math.max(1, Math.ceil(size / DISK_CHUNK));
  const chunks = [];
  const fd = fs.openSync(filePath, 'r');
  let sent = 0;
  try {
    for (let i = 0; i < total; i++) {
      const length = Math.min(DISK_CHUNK, size - i * DISK_CHUNK);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, i * DISK_CHUNK);
      const enc = encSlice(buf, key);
      const posted = await postChunk(webhook, enc.bytes, chunkName());
      chunks.push({ url: posted.url, index: i, iv: enc.ivHex, tag: enc.tagHex, messageId: posted.messageId, channelId: posted.channelId, discordName: posted.attachmentId, size: enc.bytes.length });
      sent += buf.length;
      if (onProgress) onProgress(sent, size);
      await sleep(120);
    }
    const res = await api.complete({ name, mime: mime || 'application/octet-stream', size, parentId: parentId || null, chunks, label: label || '', replaceId: replaceId || null });
    return res;
  } catch (e) {
    for (const ch of chunks) await delChunk(webhook, ch.messageId);
    throw e;
  } finally {
    fs.closeSync(fd);
  }
}

async function refreshChunkUrl(webhook, messageId) {
  if (!webhook || !messageId) return null;
  try {
    const r = await fetch(webhook + '/messages/' + messageId);
    if (!r.ok) return null;
    const m = await r.json();
    return (m && m.attachments && m.attachments[0] && m.attachments[0].url) || null;
  } catch { return null; }
}

async function fetchChunkDirect(c, webhook) {
  let url = c.url;
  let refreshed = false;
  let lastErr = null;
  for (let att = 0; att < 5; att++) {
    if (att) await sleep(Math.min(400 * Math.pow(2, att), 6000));
    try {
      const r = await fetch(url);
      if (r.ok) return await r.arrayBuffer();
      const ra = parseInt(r.headers.get('Retry-After') || '0', 10);
      if ((r.status === 403 || r.status === 404 || r.status === 410) && !refreshed) {
        refreshed = true;
        const nu = await refreshChunkUrl(webhook, c.messageId);
        if (nu) { url = nu; c.url = nu; continue; }
      }
      lastErr = new Error('Téléchargement du bloc ' + r.status);
      if (r.status === 429 && ra) await sleep(Math.min(ra * 1000, 10000));
      else if (r.status === 429 || r.status >= 500) continue;
      throw lastErr;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Téléchargement du bloc échoué');
}

async function downloadToFile(api, key, fileId, destPath, onProgress, webhook) {
  const d = await api.chunks(fileId);
  const chunks = [...(d.chunks || [])].sort((a, b) => a.index - b.index);
  if (!chunks.length) throw new Error('Aucun bloc à télécharger');
  const totalBytes = chunks.reduce((s, c) => s + (c.size || 0), 0);
  const fd = fs.openSync(destPath, 'w');
  const CONC = 4;
  let received = 0;
  let next = 0;
  let cursor = 0;
  const bufs = new Map();
  const pump = () => {
    while (bufs.has(next)) {
      fs.writeSync(fd, bufs.get(next));
      const len = bufs.get(next).length;
      received += len;
      bufs.delete(next);
      next++;
      if (onProgress) onProgress(received, totalBytes, next, chunks.length);
    }
  };
  try {
    const spawn = async () => {
      while (cursor < chunks.length) {
        const i = cursor++;
        const arr = await fetchChunkDirect(chunks[i], webhook);
        bufs.set(i, decryptBuf(Buffer.from(arr), chunks[i].iv, chunks[i].tag, key));
        await pump();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, chunks.length) }, spawn));
    await pump();
  } finally {
    fs.closeSync(fd);
  }
  return { chunks: chunks.length, size: received };
}

module.exports = { uploadFile, downloadToFile };