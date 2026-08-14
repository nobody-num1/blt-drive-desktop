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
  try {
    for (let i = 0; i < total; i++) {
      const length = Math.min(DISK_CHUNK, size - i * DISK_CHUNK);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, i * DISK_CHUNK);
      const enc = encSlice(buf, key);
      const posted = await postChunk(webhook, enc.bytes, chunkName());
      chunks.push({ url: posted.url, index: i, iv: enc.ivHex, tag: enc.tagHex, messageId: posted.messageId, channelId: posted.channelId, discordName: posted.attachmentId, size: enc.bytes.length });
      if (onProgress) onProgress(i + 1, total);
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

async function downloadToFile(api, key, fileId, destPath, onProgress) {
  const d = await api.chunks(fileId);
  const chunks = [...(d.chunks || [])].sort((a, b) => a.index - b.index);
  if (!chunks.length) throw new Error('Aucun bloc à télécharger');
  const fd = fs.openSync(destPath, 'w');
  try {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const r = await fetch(c.url);
      if (!r.ok) throw new Error('Téléchargement du bloc ' + r.status);
      const arr = await r.arrayBuffer();
      const plain = decryptBuf(Buffer.from(arr), c.iv, c.tag, key);
      fs.writeSync(fd, plain);
      if (onProgress) onProgress(i + 1, chunks.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  return chunks.length;
}

module.exports = { uploadFile, downloadToFile };