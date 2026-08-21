class DriveApi {
  constructor(origin, credential = '') {
    this.origin = String(origin || '').replace(/\/+$/, '');
    this.credential = credential;
    this.cookie = '';
    this.key = '';
    this.webhook = '';
  }

  setCookie(cookie) { this.cookie = cookie; this.credential = ''; }

  setCredential(token) { this.credential = token; this.cookie = ''; }

  async request(path, opts = {}) {
    const headers = { 'X-Requested-With': 'blt-drive-desktop' };
    if (this.cookie) headers['Cookie'] = 'drive_sid=' + this.cookie;
    else if (this.credential) headers['Authorization'] = 'Bearer ' + this.credential;
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(this.origin + path, { method: opts.method || 'GET', headers, body });
    if (res.status === 401) throw new Error('Session invalide ou expirée — reconnecte-toi via « Se connecter »');
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let m = 'Erreur ' + res.status;
      try { const j = JSON.parse(t); if (j && j.error) m = j.error; } catch {}
      throw new Error(m);
    }
    const ct = (res.headers.get('content-type') || '');
    return ct.includes('application/json') ? res.json() : res;
  }

  async config() {
    const c = await this.request('/api/disk/config');
    this.key = c.key;
    this.webhook = c.webhook;
    return c;
  }

  tree() { return this.request('/api/disk/tree'); }
  chunks(id) { return this.request('/api/disk/chunks/' + id); }
  complete(body) { return this.request('/api/disk/complete', { method: 'POST', body }); }
  mkdir(name, parentId) { return this.request('/api/disk/mkdir', { method: 'POST', body: { name, parentId } }); }
  rename(id, name) { return this.request('/api/disk/rename/' + id, { method: 'POST', body: { name } }); }
  move(id, parentId) { return this.request('/api/disk/move/' + id, { method: 'POST', body: { parentId } }); }
  del(id) { return this.request('/api/disk/delete/' + id, { method: 'DELETE' }); }
  shares() { return this.request('/api/disk/shares'); }
  sharedWithMe() { return this.request('/api/disk/shared-with-me'); }
  createShare(body) { return this.request('/api/disk/shares', { method: 'POST', body }); }
  deleteShare(id) { return this.request('/api/disk/shares/' + id, { method: 'DELETE' }); }
  zip(id) { return this.request('/api/disk/zip/' + id); }
  download(id, range) {
    const headers = { 'X-Requested-With': 'blt-drive-desktop' };
    if (this.cookie) headers['Cookie'] = 'drive_sid=' + this.cookie;
    else if (this.credential) headers['Authorization'] = 'Bearer ' + this.credential;
    if (range) headers['Range'] = range;
    return fetch(this.origin + '/api/disk/download/' + id, { method: 'GET', headers });
  }
  preview(id, range) {
    const headers = { 'X-Requested-With': 'blt-drive-desktop' };
    if (this.cookie) headers['Cookie'] = 'drive_sid=' + this.cookie;
    else if (this.credential) headers['Authorization'] = 'Bearer ' + this.credential;
    if (range) headers['Range'] = range;
    return fetch(this.origin + '/api/disk/preview/' + id, { method: 'GET', headers });
  }
}

module.exports = { DriveApi };
