const state = {
  items: [],
  folders: [],
  currentId: null,
  path: [],
  selection: new Set(),
  sort: { key: 'name', dir: 1 },
  history: [],
  historyIdx: -1,
  view: 'drive', // 'drive' | 'shares' | 'shared'
  accounts: [],
  activeAccountId: '',
  canImport: false,
  role: '',
  quotaRole: '',
  files: [],
  connOk: false
};

try {
  window.addEventListener('error', e => { try { window.blt.log('UNCAUGHT: ' + String(e.message || e.error || e) + ' @' + (e.filename||'') + ':' + e.lineno); } catch {} });
  window.addEventListener('unhandledrejection', e => { try { window.blt.log('REJECTED: ' + String(e.reason && e.reason.message || e.reason)); } catch {} });
} catch {}

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSize(n) {
  const num = parseFloat(n);
  if (!isFinite(num) || num <= 0) return '';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = num;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function cutName(s, max) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
}

function setBadge(text, cls) {
  const b = $('conn-badge');
  const t = b.querySelector('.conn-txt');
  if (t) t.textContent = text;
  else b.textContent = text;
  b.className = 'conn' + (cls ? ' ' + cls : '');
}

function showError(msg) {
  const e = $('conn-error');
  e.textContent = msg;
  e.style.display = 'block';
}

function clearError() {
  const e = $('conn-error');
  e.style.display = 'none';
}

function opts() {
  return {
    includeOriginal: $('opt-orig').checked,
    includeTracks: $('opt-tracks').checked,
    crf: parseInt($('opt-crf').value, 10) || 23
  };
}

function collectQualities() {
  const q = [];
  if ($('opt-720').checked) q.push(720);
  if ($('opt-480').checked) q.push(480);
  if ($('opt-360').checked) q.push(360);
  return q;
}

function applySettings(s) {
  $('in-origin').value = s.origin || '';
  state.accounts = s.accounts || [];
  state.activeAccountId = s.activeAccountId || '';
  renderAccounts();
}

function renderAccounts() {
  const el = $('account-list');
  if (!state.accounts.length) { el.innerHTML = '<div class="muted acc-empty">Aucun compte connecté — clique « Se connecter ».</div>'; return; }
  el.innerHTML = state.accounts.map(a => {
    const active = a.id === state.activeAccountId;
    return '<div class="acc-item' + (active ? ' active' : '') + '">'
      + '<span class="acc-name" title="' + esc(a.id) + '">' + (active ? '✓ ' : '') + esc(a.label) + '</span>'
      + '<span class="acc-act">'
      + (active ? '' : '<button class="btn tiny min" data-use="' + esc(a.id) + '">Utiliser</button>')
      + '<button class="btn tiny danger min" data-del="' + esc(a.id) + '">✕</button>'
      + '</span></div>';
  }).join('');
  el.querySelectorAll('[data-use]').forEach(b => b.onclick = async () => {
    await window.blt.setActiveAccount(b.dataset.use);
    await refresh(true);
  });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await window.blt.disconnectAccount(b.dataset.del);
    await refresh(true);
  });
}

function applyRole(r) {
  state.canImport = !!r.canImport;
  state.role = r.role || '';
  state.quotaRole = r.quotaRole || '';
  const allow = state.canImport;
  $('btn-pick').disabled = !allow;
  var bpf = $('btn-pick-folder'); if (bpf) bpf.disabled = !allow;
  $('btn-new-folder').disabled = !allow;
  $('btn-move').disabled = !allow;
  const lk = $('import-locked');
  if (!allow && state.activeAccountId) lk.textContent = 'Connecte-toi à un compte Discord pour importer des fichiers.';
  else if (!allow) lk.textContent = 'Connecte-toi à un compte Discord pour importer des fichiers\u2009— toute personne connectée peut importer et transcoder.';
}

async function refresh(showErrors) {
  try {
    const s = await window.blt.getSettings();
    applySettings(s);
    const r = await window.blt.testConnection();
    clearError();
    state.connOk = !!r.ok;
    if (r.ok) {
      var ls = document.getElementById('login-screen'); if (ls) ls.style.display = 'none';
      const acc = r.account ? r.account.label : 'Connecté';
      setBadge('✓ ' + acc, 'ok');
      const q = r.quota || {};
      const limitTxt = q.limit === '-1' || q.limit === '-1n' ? 'illimité' : fmtSize(q.limit);
      $('status-quota').textContent = 'Quota ' + (r.quotaRole || '') + ' · ' + fmtSize(q.usage) + ' / ' + limitTxt;
      applyRole(r);
      await loadTree();
    } else {
      var ls = document.getElementById('login-screen'); if (ls) ls.style.display = 'flex';
      setBadge(state.activeAccountId ? '✗ Connexion' : 'Non connecté', 'bad');
      $('status-quota').textContent = '';
      $('list-empty').style.display = 'block';
      $('list-empty').textContent = 'Connecte-toi à un compte Discord pour parcourir le drive.';
      $('list').innerHTML = '';
      applyRole({ canImport: false });
      if (showErrors) showError(r.error);
    }
  } catch (e) { window.blt.log('refresh: CATCH ' + String(e && e.message || e)); }
}

async function loadTree() {
  const r = await window.blt.explorerTree();
  if (r.error) { showError(r.error); return; }
  state.items = r.items || [];
  state.folders = state.items.filter(i => i.type === 'folder');
  renderTree();
  if (!state.path.length) { state.currentId = null; state.path = []; }
  renderList();
}

function visibleItems(parentId) {
  return state.items.filter(i => (i.parentId || null) === parentId && !i.renditionOf && !i.subtitleOf);
}

function itemById(id) {
  return state.items.find(i => i.id === id) || null;
}

function folderPath(id) {
  const parts = [];
  let cur = id;
  let guard = 0;
  while (cur && guard++ < 100) {
    const it = itemById(cur);
    if (!it) break;
    parts.unshift(it);
    if (!it.parentId) break;
    cur = it.parentId;
  }
  return parts;
}

function pathLabel() {
  if (state.view === 'shares') return ['Mes partages'];
  if (state.view === 'shared') return ['Partagés avec moi'];
  if (!state.path.length) return ['Mon Drive'];
  return ['Mon Drive', ...state.path.map(i => i.name)];
}

// ── Navigation ────────────────────────────────────────────────
function navigateTo(id, pushHist) {
  if (state.view !== 'drive') { state.view = 'drive'; state.selection.clear(); }
  state.currentId = id;
  state.path = folderPath(id);
  state.selection.clear();
  if (pushHist) {
    state.history = state.history.slice(0, state.historyIdx + 1);
    state.history.push({ view: 'drive', id });
    state.historyIdx = state.history.length - 1;
  }
  renderList();
  renderTree();
}

function goUp() {
  if (state.view !== 'drive') { navigateTo(null, true); return; }
  if (!state.currentId) return;
  const it = itemById(state.currentId);
  navigateTo(it ? it.parentId || null : null, true);
}

function goBack() {
  if (state.historyIdx > 0) { state.historyIdx--; applyHistory(); }
}

function goForward() {
  if (state.historyIdx < state.history.length - 1) { state.historyIdx++; applyHistory(); }
}

function applyHistory() {
  const h = state.history[state.historyIdx];
  if (!h) return;
  state.view = h.view || 'drive';
  state.currentId = h.id || null;
  state.path = folderPath(h.id || null);
  state.selection.clear();
  renderList();
  renderTree();
}

function setView(v) {
  state.view = v;
  state.currentId = null;
  state.path = [];
  state.selection.clear();
  renderList();
  renderTree();
}

// ── Rendu de l'arborescence ───────────────────────────────────
function renderTree() {
  const el = $('tree');
  const roots = state.folders.filter(f => !f.parentId);
  const activePathIds = new Set(state.path.map(i => i.id));
  if (state.view === 'drive' && state.currentId) activePathIds.add(state.currentId);
  const html = [];
  html.push(treeRow('root', null, 'Mon Drive', '◇', state.view === 'drive' && !state.currentId));
  html.push(treeRow('shares', null, 'Mes partages', '🔗', state.view === 'shares'));
  html.push(treeRow('shared', null, 'Partagés avec moi', '📥', state.view === 'shared'));
  if (roots.length) {
    html.push('<div class="tree-sep" style="margin:6px 0;border-top:1px solid var(--border)"></div>');
    html.push(roots.map(f => treeNode(f, activePathIds, 0)).join(''));
  }
  el.innerHTML = html.join('');
  el.querySelectorAll('[data-nav]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const v = b.dataset.nav;
    if (v === 'root') navigateTo(null, true);
    else if (v === 'shares') setView('shares');
    else if (v === 'shared') setView('shared');
  });
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    navigateTo(b.dataset.open, true);
  });
  el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const id = b.dataset.toggle;
    const kids = el.querySelector('[data-kids="' + id + '"]');
    if (kids) kids.style.display = kids.style.display === 'none' ? '' : 'none';
  });
  el.querySelectorAll('.thead[data-open]').forEach(b => attachDropTarget(b, b.dataset.open));
  const rootRow = el.querySelector('.thead[data-nav="root"]');
  if (rootRow) attachDropTarget(rootRow, null);
}

function treeNode(f, activePathIds, depth) {
  const kids = state.folders.filter(x => x.parentId === f.id);
  const open = activePathIds.has(f.id);
  const hasKids = kids.length > 0;
  return '<div class="tnode">'
    + '<div class="thead' + (state.view === 'drive' && state.currentId === f.id ? ' sel' : '') + '" data-open="' + f.id + '" style="padding-left:' + (6 + depth * 14) + 'px">'
    + (hasKids ? '<span class="twist" data-toggle="' + f.id + '">' + (open ? '▾' : '▸') + '</span>' : '<span class="twist"></span>')
    + '<span class="ticon icon dir">📁</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + '</span></div>'
    + (hasKids ? '<div class="kids" data-kids="' + f.id + '" style="' + (open ? '' : 'display:none') + '">' + kids.map(k => treeNode(k, activePathIds, depth + 1)).join('') + '</div>' : '')
    + '</div>';
}

function treeRow(kind, id, label, icon, sel) {
  return '<div class="thead' + (sel ? ' sel' : '') + '" data-nav="' + kind + '"><span class="twist"></span><span class="ticon icon ' + (kind === 'root' ? 'dir' : 'file') + '">' + icon + '</span><span>' + label + '</span></div>';
}

// ── Rendu de la liste ─────────────────────────────────────────
function renderList() {
  const list = $('list');
  const empty = $('list-empty');
  $('folder-title').textContent = pathLabel()[pathLabel().length - 1] || 'Mon Drive';
  renderAddress();

  let rows = [];
  if (state.view === 'shares') rows = buildSharesRows();
  else if (state.view === 'shared') rows = buildSharedRows();
  else rows = buildDriveRows();

  if (!rows.length) {
    empty.style.display = 'block';
    empty.textContent = state.view === 'shares' ? 'Aucun partage créé — clic droit sur un fichier/dossier puis « Partager ».' : (state.view === 'shared' ? 'Aucun partage reçu.' : 'Dossier vide');
  } else empty.style.display = 'none';

  list.innerHTML = rows.join('');
  list.querySelectorAll('[data-row]').forEach(row => {
    const id = row.dataset.row;
    row.onclick = e => {
      if (e.ctrlKey) { toggleSelect(id); return; }
      selectOnly(id);
      rowClicks(row, id);
    };
    row.oncontextmenu = e => { e.preventDefault(); selectOnly(id); showCtxMenu(id, e); };
    if (state.view === 'drive') {
      attachDragSource(row, id);
      if (row.dataset.type === 'folder') attachDropTarget(row, id);
    }
  });

  const btnUp = $('btn-up');
  btnUp.disabled = !(state.view === 'drive' && state.currentId);
  $('btn-back').disabled = state.historyIdx <= 0;
  $('btn-forward').disabled = state.historyIdx >= state.history.length - 1;
  const n = state.selection.size || rows.length;
  $('status-count').textContent = (state.selection.size ? state.selection.size + ' sélectionné(s) sur ' + rows.length : rows.length) + ' élément(s)';
  if (state.view !== 'drive') refreshSharesRows();
}

// ── Détection double / triple-clic ────────────────────────────
const clickState = { id: null, n: 0, t: null };
function rowClicks(row, id) {
  const type = row.dataset.type;
  if (clickState.id !== id) { clickState.id = id; clickState.n = 0; }
  clickState.n++;
  if (clickState.t) { clearTimeout(clickState.t); clickState.t = null; }
  if (clickState.n >= 3) {
    clickState.id = null;
    clickState.n = 0;
    tripleAction(id, type);
  } else {
    clickState.t = setTimeout(() => {
      const n = clickState.n;
      const cid = clickState.id;
      clickState.id = null;
      clickState.n = 0;
      if (n === 2) doubleAction(cid, type);
    }, 450);
  }
}

function doubleAction(id, type) {
  const it = itemById(id);
  if (type === 'folder') navigateTo(id, true);
  else if (type === 'share') openShareLink(id);
  else if (type === 'sfile') openPreview(id);
  else doOpenExternal(id, it ? it.name : '');
}

function tripleAction(id, type) {
  const it = itemById(id);
  if (type === 'folder') navigateTo(id, true);
  else if (type === 'share') openShareLink(id);
  else openPreview(id);
}

function buildDriveRows() {
  const items = visibleItems(state.currentId);
  const { key, dir } = state.sort;
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (key === 'name') return dir * (a.name || '').localeCompare(b.name || '');
    if (key === 'size') return dir * ((a.size || 0) - (b.size || 0));
    if (key === 'date') return dir * ((a.updatedAt || a.uploadedAt || '') < (b.updatedAt || b.uploadedAt || '') ? -1 : 1);
    return dir * (a.name || '').localeCompare(b.name || '');
  });
  return items.map(i => rowHtml(i));
}

function buildSharesRows() {
  const list = [];
  state.myShares = state.myShares || [];
  state.myShares.forEach(s => list.push(shareRow(s, 'share')));
  return list;
}

function buildSharedRows() {
  const list = [];
  state.inboundShares = state.inboundShares || [];
  state.inboundShares.forEach(s => list.push(shareRow(s, 'sfile')));
  return list;
}

function shareRow(s, type) {
  const isDir = s.type === 'folder';
  const name = isDir ? (s.folderName || 'Dossier') : (s.fileName || 'Fichier');
  const who = s.targetUser ? ' → ' + s.targetUser : (s.everyone ? ' → Tout le monde' : '');
  const acc = (s.accessCount || 0) + (s.maxAccess > 0 ? '/' + s.maxAccess : '') + ' accès';
  const icon = isDir ? '<span class="icon dir">📁</span>' : '<span class="icon file">🔗</span>';
  const sub = (s.subtitleOf || s.renditionOf) ? '<span class="icon sub">▤</span>' : '';
  const sel = state.selection.has('share:' + s.id) ? ' sel' : '';
  return '<div class="row-item' + sel + '" data-row="' + s.id + '" data-type="' + type + '" data-share="1">'
    + '<div class="c-name">' + icon + sub + '<span class="fname" title="' + esc(name) + '">' + esc(cutName(name, 60)) + who + '</span></div>'
    + '<div class="c-size">' + (isDir ? ((s.files || []).length + ' fichier(s)') : fmtSize(s.fileSize)) + '</div>'
    + '<div class="c-type">Partage</div>'
    + '<div class="c-date">' + acc + '</div>'
    + '</div>';
}

async function refreshSharesRows() {
  try {
    if (state.view === 'shares') {
      const d = await window.blt.diskShares();
      state.myShares = (d.shares || []).filter(s => !s.subtitleOf && !s.renditionOf);
    } else if (state.view === 'shared') {
      const d = await window.blt.diskSharedWithMe();
      state.inboundShares = (d.shares || []).filter(s => !s.subtitleOf && !s.renditionOf);
    }
    renderList();
  } catch {}
}

function openShareLink(id) {
  const s = (state.myShares || []).find(x => x.id === id) || (state.inboundShares || []).find(x => x.id === id);
  if (!s) return;
  const base = ($('in-origin').value || '').trim().replace(/\/+$/, '');
  const url = base + '/share/' + id;
  navigator.clipboard.writeText(url).catch(() => {});
  dlgAlert('Lien du partage :\n\n' + url + '\n\n(copié dans le presse-papiers)');
}

function rowHtml(i) {
  const isDir = i.type === 'folder';
  const isVideo = !isDir && (i.mime || '').startsWith('video/');
  const isImage = !isDir && (i.mime || '').startsWith('image/');
  const isPdf = !isDir && ((i.mime || '') === 'application/pdf' || /\.pdf$/i.test(i.name || ''));
  const isSub = !isDir && (i.subtitleOf || i.renditionOf);
  const icon = isDir ? '<span class="icon dir">📁</span>' : isVideo ? '<span class="icon video">🎬</span>' : isImage ? '<span class="icon img">🖼</span>' : isPdf ? '<span class="icon pdf">📕</span>' : isSub ? '<span class="icon sub">▤</span>' : '<span class="icon file">📄</span>';
  const type = isDir ? 'Dossier' : isVideo ? 'Vidéo' : isImage ? 'Image' : isPdf ? 'PDF' : isSub ? 'Sous-titre' : 'Fichier';
  const sel = state.selection.has(i.id) ? ' sel' : '';
  return '<div class="row-item' + sel + '" data-row="' + i.id + '" data-type="' + (isDir ? 'folder' : isVideo ? 'video' : isImage ? 'image' : isPdf ? 'pdf' : 'file') + '">'
    + '<div class="c-name">' + icon + '<span class="fname" title="' + esc(i.name) + '">' + esc(cutName(i.name, 60)) + '</span></div>'
    + '<div class="c-size">' + fmtSize(isDir ? folderSize(i.id) : (i.size || 0)) + '</div>'
    + '<div class="c-type">' + type + '</div>'
    + '<div class="c-date">' + fmtDateShort(i.updatedAt || i.uploadedAt) + '</div>'
    + '</div>';
}

function folderSize(id) {
  let t = 0;
  const walk = pid => visibleItems(pid).forEach(i => { if (i.type === 'folder') walk(i.id); else t += (i.size || 0); });
  walk(id);
  return t;
}

function selectOnly(id) {
  state.selection = new Set([id]);
  renderSelection();
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  renderSelection();
}

function renderSelection() {
  document.querySelectorAll('.row-item').forEach(r => r.classList.toggle('sel', state.selection.has(r.dataset.row)));
  const rows = document.querySelectorAll('.row-item').length;
  $('status-count').textContent = (state.selection.size ? state.selection.size + ' sélectionné(s) sur ' + rows : rows) + ' élément(s)';
}

function renderAddress() {
  const el = $('address');
  const parts = pathLabel();
  el.innerHTML = parts.map((p, i) => {
    const last = i === parts.length - 1;
    return (i ? '<span class="sep">›</span>' : '') + '<span class="crumb' + (last ? ' cur' : '') + '" data-addr="' + i + '">' + esc(p) + '</span>';
  }).join('');
  el.querySelectorAll('[data-addr]').forEach(c => c.onclick = () => {
    const idx = parseInt(c.dataset.addr, 10);
    if (state.view !== 'drive') { navigateTo(null, true); return; }
    const target = state.path[idx - 1]; // index 0 = Mon Drive (root)
    navigateTo(target ? target.id : null, true);
  });
}

// ── Tri ───────────────────────────────────────────────────────
function setSort(key) {
  if (state.sort.key === key) state.sort.dir *= -1;
  else { state.sort.key = key; state.sort.dir = 1; }
  document.querySelectorAll('.col').forEach(c => c.classList.toggle('sorted', c.dataset.sort === key));
  document.querySelectorAll('.col .arrow').forEach(a => a.remove());
  const col = document.querySelector('.col[data-sort="' + key + '"]');
  if (col) col.insertAdjacentHTML('beforeend', '<span class="arrow">' + (state.sort.dir > 0 ? '▲' : '▼') + '</span>');
  renderList();
}

// ── Menu contextuel ───────────────────────────────────────────
let ctxId = null;
function showCtxMenu(id, evt) {
  ctxId = id;
  const it = itemById(id);
  if (!it) return;
  const isDir = it.type === 'folder';
  const isVideo = !isDir && (it.mime || '').startsWith('video/');
  closeCtxMenu();
  const items = [];
  if (isDir) items.push({ label: '📂 Ouvrir', act: () => navigateTo(id, true) });
  else {
    items.push({ label: '📂 Ouvrir dans l\'application', act: () => doOpenExternal(id, it.name) });
    items.push({ label: isVideo ? '▶ Aperçu' : '👁 Aperçu', act: () => openPreview(id) });
  }
  items.push({ label: '⬇ Télécharger', act: () => doDownload(id, it.name) });
  if (isDir) items.push({ label: '🗜 ZIP', act: () => doZip(id, it.name) });
  if (isVideo) items.push({ label: '⚡ Transcoder', act: () => runDriveImport(id) });
  items.push(
    { label: '✏ Renommer', act: () => promptRename(id, it.name) },
    { label: '📦 Déplacer', act: () => promptMove(id) },
    { label: '🔗 Partager', act: () => promptShare(id) },
    { label: '🗑 Supprimer', act: () => confirmDelete(id, it.name, isDir) }
  );
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.cssText = 'position:fixed;z-index:80;background:var(--glass-strong);border:1px solid var(--border-strong);border-radius:var(--r-sm);box-shadow:var(--shadow-card);padding:4px;min-width:170px';
  items.forEach((itm, i) => {
    const b = document.createElement('button');
    b.className = 'btn tiny ghost';
    b.style.cssText = 'display:block;width:100%;text-align:left;border:none;background:transparent;padding:6px 10px;border-radius:4px;font-size:12px';
    b.textContent = itm.label;
    b.onmouseenter = () => { b.style.background = 'rgba(96,24,233,0.25)'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    b.onclick = () => { closeCtxMenu(); itm.act(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const mw = 180, mh = items.length * 30 + 10;
  menu.style.left = Math.min(evt.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(evt.clientY, window.innerHeight - mh - 8) + 'px';
}

function closeCtxMenu() {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
}

// ── Actions ───────────────────────────────────────────────────
async function doDownload(id, name) {
  try { await window.blt.diskDownload(id, name); }
  catch (e) { showError(e.message); }
}

async function doOpenExternal(id, name) {
  try {
    clearError();
    const it = itemById(id);
    openModal('Ouverture en cours…', false);
    $('modal-body').innerHTML = '<div class="muted">Téléchargement de « ' + esc(name || 'fichier') + ' » depuis le drive…</div>'
      + '<div class="job" style="margin-top:14px"><div class="detail" id="open-progress-txt">Démarrage…</div><div class="track"><div class="fill" id="open-progress-bar"></div></div></div>';
    openingBusy = true;
    const r = await window.blt.diskOpenExternal(id, name, it ? { mime: it.mime || '', parentId: it.parentId || null, size: it.size || 0 } : {});
    openingBusy = false;
    if (r && r.busy) { closeModal(); showError('Ce fichier est déjà en cours d\'ouverture.'); return; }
    if (r && r.error) { closeModal(); showError(r.error); return; }
    if (r && r.ok) {
      openModal('Ouvert dans une application', false);
      $('modal-body').innerHTML = '<div class="muted">« ' + esc(name || 'fichier') + ' » a été ouvert avec le programme installé.</div>'
        + '<div class="hint">✏️ Modifie le fichier puis <b>enregistre-le</b> (Ctrl+S) : il sera <b>réimporté automatiquement</b> dans le drive à ta place, et la copie temporaire sera supprimée. Tu peux fermer cette fenêtre.</div>';
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Fermer';
      btn.onclick = closeModal;
      $('modal-actions').appendChild(btn);
    }
  } catch (e) { openingBusy = false; closeModal(); showError(e.message); }
}

async function doZip(id, name) {
  try { await window.blt.diskZip(id, (name || 'dossier').replace(/[\\/:*?"<>|]+/g, '_') + '.zip'); }
  catch (e) { showError(e.message); }
}

// ── Boîtes de dialogue (remplace prompt/confirm/alert natifs, inopérants dans Electron) ──
let dlgResolve = null;
let openingBusy = false;

function dlgShow(title, bodyHtml, actions) {
  openModal(title, false);
  $('modal-body').innerHTML = bodyHtml;
  $('modal-actions').innerHTML = '';
  (actions || []).forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.cls || '');
    b.textContent = a.label;
    b.onclick = () => { dlgClose(a.value); };
    $('modal-actions').appendChild(b);
  });
  const inp = document.getElementById('dlg-input');
  if (inp) { inp.focus(); inp.select(); }
}

function dlgClose(value) {
  const r = dlgResolve;
  dlgResolve = null;
  closeModal();
  if (r) r(value);
}

function dlgPrompt(message, def) {
  return new Promise(resolve => {
    dlgResolve = resolve;
    dlgShow('Demande', '<div class="muted" style="margin-bottom:12px">' + esc(message).replace(/\n/g, '<br>') + '</div>'
      + '<input id="dlg-input" type="text" value="' + esc(def || '') + '">',
      [{ label: 'Annuler', value: null, cls: 'ghost' }, { label: 'OK', value: '__ok__', cls: 'primary' }]);
    const inp = document.getElementById('dlg-input');
    inp.onkeydown = ev => {
      if (ev.key === 'Enter') dlgClose(inp.value);
      else if (ev.key === 'Escape') dlgClose(null);
    };
    const ok = [...$('modal-actions').children].find(b => b.textContent === 'OK');
    if (ok) ok.onclick = () => dlgClose(inp.value);
  });
}

function dlgConfirm(message) {
  return new Promise(resolve => {
    dlgResolve = resolve;
    dlgShow('Confirmation', '<div class="muted">' + esc(message).replace(/\n/g, '<br>') + '</div>',
      [{ label: 'Annuler', value: false, cls: 'ghost' }, { label: 'OK', value: true, cls: 'primary' }]);
  });
}

function dlgAlert(message) {
  return new Promise(resolve => {
    dlgResolve = resolve;
    dlgShow('Information', '<div class="muted">' + esc(message).replace(/\n/g, '<br>') + '</div>',
      [{ label: 'OK', value: true, cls: 'primary' }]);
  });
}

function promptNewFolder() {
  dlgPrompt('Nom du nouveau dossier :', 'Nouveau dossier').then(name => {
    if (!name || !name.trim()) return;
    window.blt.diskMkdir(name.trim(), state.currentId).then(r => {
      if (r.error) showError(r.error); else loadTree();
    });
  });
}

function promptRename(id, curName) {
  dlgPrompt('Nouveau nom :', curName || '').then(name => {
    if (!name || !name.trim() || name === curName) return;
    window.blt.diskRename(id, name.trim()).then(r => {
      if (r.error) showError(r.error); else loadTree();
    });
  });
}

function promptMove(ids) {
  const single = typeof ids === 'string';
  const targets = (single ? [ids] : (ids && ids.length ? ids : [...state.selection])).filter(Boolean);
  if (!targets.length) { showError('Sélectionne un élément à déplacer'); return; }
  openModal('Déplacer', true);
  const body = $('modal-body');
  body.innerHTML = '<div class="muted" style="margin-bottom:12px">Choisis le dossier de destination :</div><div id="move-picker" class="move-picker"></div>';
  const picker = body.querySelector('#move-picker');
  let chosen = null;

  const buildTree = (parentId, depth) => {
    const kids = state.folders.filter(f => (f.parentId || null) === parentId);
    if (!kids.length) return '';
    return kids.map(f => {
      const sub = buildTree(f.id, depth + 1);
      const blocked = targets.includes(f.id);
      return '<div class="move-folder' + (chosen === f.id ? ' sel' : '') + (blocked ? ' blocked' : '') + '" data-id="' + f.id + '" style="padding-left:' + (8 + depth * 14) + 'px">'
        + (sub ? '<span class="mtwist">▾</span>' : '<span class="mtwist"></span>') + '<span class="mticon">📁</span>' + esc(f.name) + '</div>'
        + (sub ? '<div class="move-kids">' + sub + '</div>' : '');
    }).join('');
  };

  const render = () => {
    picker.innerHTML = '<div class="move-folder' + (chosen === null ? ' sel' : '') + '" data-id="root" style="padding-left:8px"><span class="mtwist"></span><span class="mticon">🏠</span>Mon Drive (racine)</div>'
      + buildTree(null, 1);
    picker.querySelectorAll('.move-folder').forEach(el => {
      el.onclick = () => {
        if (el.classList.contains('blocked')) { showError('Impossible de déplacer un dossier dans lui-même.'); return; }
        chosen = el.dataset.id === 'root' ? null : el.dataset.id;
        render();
      };
    });
  };
  render();

  const ok = document.createElement('button');
  ok.className = 'btn primary';
  ok.textContent = 'Déplacer ici';
  ok.onclick = () => { closeModal(); moveItemsTo(targets, chosen); };
  $('modal-actions').appendChild(ok);
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = 'Annuler';
  cancel.onclick = closeModal;
  $('modal-actions').appendChild(cancel);
}

// ── Glisser-déposer (déplacer fichiers/dossiers) ─────────────
let dragIds = null;

function folderDescendants(id) {
  const out = new Set();
  const walk = pid => state.items.forEach(i => { if (i.type === 'folder' && (i.parentId || null) === pid && !out.has(i.id)) { out.add(i.id); walk(i.id); } });
  walk(id);
  return out;
}

function clearDropHover() {
  document.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
}

function moveDragSelection(targetId) {
  const ids = (dragIds || []).filter(x => x && x !== targetId);
  dragIds = null;
  clearDropHover();
  if (!ids.length) return;
  moveItemsTo(ids, targetId);
}

function moveItemsTo(ids, targetId) {
  const list = (ids || []).filter(x => x && x !== targetId);
  if (!list.length) return;
  for (const id of list) {
    const f = itemById(id);
    if (f && f.type === 'folder' && targetId && folderDescendants(id).has(targetId)) {
      showError('Impossible de déplacer « ' + f.name + ' » dans son propre contenu.');
      return;
    }
  }
  (async () => {
    for (const id of list) {
      const it = itemById(id);
      if (it && (it.parentId || null) === targetId) continue;
      try { const r = await window.blt.diskMove(id, targetId || null); if (r.error) { showError(r.error); return; } }
      catch (e) { showError(e.message); return; }
    }
    state.selection.clear();
    await loadTree();
    if (targetId) navigateTo(targetId, true);
  })();
}

function attachDragSource(row, id) {
  row.draggable = true;
  row.classList.add('draggable');
  row.addEventListener('dragstart', e => {
    const sel = [...state.selection];
    dragIds = sel.length && sel.includes(id) ? sel : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragIds.join(','));
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => { dragIds = null; row.classList.remove('dragging'); clearDropHover(); });
}

function attachDropTarget(row, id) {
  row.addEventListener('dragover', e => {
    if (!dragIds) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-hover');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-hover'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-hover');
    moveDragSelection(id);
  });
}

function confirmDelete(id, name, isDir) {
  dlgConfirm('Supprimer « ' + name + ' »' + (isDir ? ' et tout son contenu' : '') + ' ?').then(ok => {
    if (!ok) return;
    window.blt.diskDelete(id).then(r => {
      if (r.error) showError(r.error); else loadTree();
    });
  });
}

function promptShare(id) {
  const it = itemById(id);
  if (!it) return;
  const isDir = it.type === 'folder';
  dlgConfirm('Partager à tout le monde (les modérateurs) ?\nAnnuler = lien privé (rien ni personne).').then(everyone => {
    dlgPrompt('Mot de passe optionnel (vide = aucun) :', '').then(password => {
      if (password === null) return;
      dlgPrompt('Partager avec un utilisateur ? (pseudo Discord ou ID, vide = lien public) :', '').then(targetUser => {
        if (targetUser === null) return;
        const targetUserId = targetUser && /^\d{10,25}$/.test(targetUser.trim()) ? targetUser.trim() : undefined;
        window.blt.diskShareCreate({ fileId: id, everyone, password: password || undefined, videoMode: isDir ? 'normal' : 'player', targetUser: targetUser && targetUser.trim() ? targetUser.trim() : undefined, targetUserId }).then(r => {
          if (r.error) { showError(r.error); return; }
          const base = ($('in-origin').value || '').trim().replace(/\/+$/, '');
          const link = base + '/share/' + r.id;
          navigator.clipboard.writeText(link).catch(() => {});
          dlgAlert('Partage créé !\n\nLien copié : ' + link);
        });
      });
    });
  });
}

// ── Aperçu (vidéo / image / PDF) ──────────────────────────────
let pvCurrent = null;
async function openPreview(id) {
  const it = itemById(id);
  if (!it) return;
  const mime = (it.mime || '').toLowerCase();
  const name = (it.name || '').toLowerCase();
  if (mime.startsWith('image/')) return openImage(it);
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return openPdf(it);
  if (mime.startsWith('audio/')) return openAudio(it);
  if (mime.startsWith('video/')) return openVideo(it.id);
  return openGeneric(it);
}

function openModal(title, wide) {
  $('modal-title').innerHTML = title;
  $('modal-body').innerHTML = '';
  $('modal-actions').innerHTML = '';
  $('modal').classList.toggle('wide', !!wide);
  $('modal-overlay').style.display = 'flex';
}

function openImage(it) {
  openModal('Image — ' + esc(it.name), true);
  $('modal-body').innerHTML = '<div class="img-wrap"><img id="pv-img" src="' + window.blt.previewUrl(it.id) + '" alt=""></div>'
    + '<div class="hint">Double-clic ou clic droit → « Ouvrir dans l\'application » pour la visionneuse système.</div>';
  const img = document.getElementById('pv-img');
  if (img) img.onerror = () => { img.outerHTML = '<div class="hint warn">Impossible d\'afficher cette image.</div>'; };
}

function openAudio(it) {
  openModal('Audio — ' + esc(it.name));
  $('modal-body').innerHTML = '<div class="player-wrap"><audio id="pv-audio" controls autoplay src="' + window.blt.previewUrl(it.id) + '" style="width:100%"></audio></div>'
    + '<div class="hint">Lecture en streaming depuis le drive (bltdrive://).</div>';
}

async function openPdf(it) {
  openModal('PDF — ' + esc(it.name), true);
  const body = $('modal-body');
  body.innerHTML = '<div class="pdf-wrap"><div class="pdf-loading">Chargement du PDF…</div></div>'
    + '<div class="hint">Affichage intégré. Pour la visionneuse système : clic droit → « Ouvrir dans l\'application ».</div>';
  try {
    const r = await fetch(window.blt.previewUrl(it.id));
    if (!r.ok) throw new Error('Erreur ' + r.status);
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const wrap = body.querySelector('.pdf-wrap');
    wrap.innerHTML = '<iframe id="pv-pdf" src="' + url + '" type="application/pdf"></iframe>';
  } catch (e) {
    body.querySelector('.pdf-wrap').innerHTML = '<div class="hint warn">Impossible de charger le PDF : ' + esc(e.message) + '</div>';
  }
}

function openGeneric(it) {
  openModal('Fichier — ' + esc(it.name));
  const body = $('modal-body');
  body.innerHTML = '<div class="hint">Aucun aperçu pour ce type de fichier.</div>'
    + '<div class="hint">Double-clic ou « Ouvrir dans l\'application » pour l\'ouvrir avec un programme installé.</div>';
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '⬇ Télécharger';
  btn.onclick = () => doDownload(it.id, it.name);
  $('modal-actions').appendChild(btn);
  const btn2 = document.createElement('button');
  btn2.className = 'btn';
  btn2.textContent = '📂 Ouvrir dans l\'application';
  btn2.onclick = () => { closeModal(); doOpenExternal(it.id, it.name); };
  $('modal-actions').appendChild(btn2);
}

function openVideo(id) {
  const it = itemById(id);
  if (!it) return;
  const rends = state.items.filter(r => r.renditionOf === id);
  const subs = state.items.filter(r => r.subtitleOf === id).sort((a, b) => (a.subtitleIndex || 0) - (b.subtitleIndex || 0));
  const tracks = {};
  rends.forEach(r => { const t = r.audioTrack || 1; if (!tracks[t] || (r.size || 0) > (tracks[t].size || 0)) tracks[t] = r; });
  const qualities = rends.filter(r => (r.audioTrack || 1) === 1).sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));

  openModal('Aperçu — ' + esc(it.name));
  const body = $('modal-body');
  const qbar = qualities.length ? qualities.map((q, i) => '<button class="qbtn' + (i === 0 ? ' active' : '') + '" data-q="' + q.id + '">' + q.quality + '</button>').join('') : '';
  const tbar = Object.keys(tracks).length > 1 ? Object.keys(tracks).map(t => '<button class="qbtn' + (t === '1' ? ' active' : '') + '" data-track="' + t + '">Piste ' + t + '</button>').join('') : '';
  const sbar = subs.length ? '<button class="qbtn" data-sub="0">Sous-titres off</button>' + subs.map(s => '<button class="qbtn" data-sub="' + s.id + '">' + esc(s.label || ('Sub ' + s.subtitleIndex)) + '</button>').join('') : '';
  body.innerHTML = '<div class="player-wrap"><div class="player-loading" id="pv-loading">Chargement du streaming…</div><video id="pv" controls autoplay style="width:100%;display:none"></video></div>'
    + (qbar ? '<div class="player-bar"><span class="plbl">Qualité</span>' + qbar + '</div>' : '')
    + (tbar ? '<div class="player-bar"><span class="plbl">Audio</span>' + tbar + '</div>' : '')
    + (sbar ? '<div class="player-bar"><span class="plbl">Sous-titres</span>' + sbar + '</div>' : '')
    + '<div class="hint">Lecture en streaming depuis le drive (bltdrive://).</div>';

  const pv = body.querySelector('#pv');
  const loading = body.querySelector('#pv-loading');
  const subTracks = subs.map(s => '<track kind="subtitles" srclang="" data-subtrack="' + s.id + '" label="' + esc(s.label || ('Sous-titres ' + s.subtitleIndex)) + '" src="' + window.blt.previewUrl(s.id) + '">').join('');
  let stalled = false;
  let stallTimer = null;
  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
  const showError = msg => {
    clearStall();
    loading.textContent = msg;
    loading.classList.add('warn');
    const actions = $('modal-actions');
    actions.innerHTML = '';
    if (!rends.length) {
      const tc = document.createElement('button');
      tc.className = 'btn primary';
      tc.textContent = '⚡ Transcoder cette vidéo';
      tc.onclick = async () => { closeModal(); await runDriveImport(it.id); };
      actions.appendChild(tc);
    }
    const fall = document.createElement('button');
    fall.className = 'btn' + (rends.length ? ' primary' : '');
    fall.textContent = '📂 Ouvrir dans l\'application';
    fall.onclick = () => { closeModal(); doOpenExternal(it.id, it.name); };
    actions.appendChild(fall);
    const dl = document.createElement('button');
    dl.className = 'btn';
    dl.textContent = '⬇ Télécharger l\'original';
    dl.onclick = () => { closeModal(); doDownload(it.id, it.name); };
    actions.appendChild(dl);
  };
  const setSrc = qid => {
    loading.classList.remove('warn');
    loading.textContent = 'Chargement du streaming…';
    loading.style.display = '';
    pv.style.display = 'none';
    pv.innerHTML = subTracks;
    pv.src = window.blt.previewUrl(qid || id);
    pv.load();
    clearStall();
    stallTimer = setTimeout(() => { if (pv.readyState < 2 && !pv.error) showError('Le chargement du streaming semble bloqué. Essaie de transcoder la vidéo ou de l\'ouvrir dans l\'application.'); }, 12000);
  };
  pv.oncanplay = () => { clearStall(); loading.style.display = 'none'; pv.style.display = ''; };
  pv.onwaiting = () => { if (!stalled) loading.style.display = ''; };
  pv.onplaying = () => { stalled = false; clearStall(); loading.style.display = 'none'; };
  pv.onerror = () => {
    if (pv.error && pv.error.code === 4) { showError('Le format de cette vidéo n\'est pas lisible dans l\'application (codec non supporté).'); return; }
    showError('Impossible de lire ce streaming. Essaie de transcoder la vidéo ou de l\'ouvrir dans l\'application.');
  };
  // Formats connus non décodables par Chromium (pas de codec HEVC/x265) : avertir d'emblée si pas de rendition.
  const nameL = (it.name || '').toLowerCase();
  const isHardFormat = /\.(mkv|flv|avi|wmv|ts|m2ts|vob|rmvb|mov)$/i.test(nameL) || /x265|hevc/i.test(nameL);
  setSrc(qualities.length ? qualities[0].id : id);
  if (!qualities.length && isHardFormat) {
    setTimeout(() => { if (pv.readyState < 2 && !pv.error) showError('Cette vidéo (' + (nameL.match(/\.[^.]+$/) || [''])[0].slice(1).toUpperCase() + '/x265) n\'est généralement pas lisible directement. Transcris-la en MP4.'); }, 600);
  }
  body.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    body.querySelectorAll('.qbtn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    setSrc(b.dataset.q);
  });
  body.querySelectorAll('[data-track]').forEach(b => b.onclick = () => {
    body.querySelectorAll('[data-track]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const t = tracks[b.dataset.track];
    setSrc(t ? t.id : id);
  });
  body.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => {
    body.querySelectorAll('[data-sub]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (b.dataset.sub === '0') {
      pv.querySelectorAll('track').forEach(tr => tr.track.mode = 'hidden');
    } else {
      pv.querySelectorAll('track').forEach(tr => tr.track.mode = tr.getAttribute('data-subtrack') === b.dataset.sub ? 'showing' : 'hidden');
    }
  });
  pvCurrent = pv;
}

// ── Tâches / jobs ─────────────────────────────────────────────
function jobEl(job) {
  let el = document.querySelector('.job[data-job="' + CSS.escape(job) + '"]');
  if (el) return el;
  const empty = document.querySelector('.job-empty');
  if (empty) empty.remove();
  el = document.createElement('div');
  el.className = 'job';
  el.dataset.job = job;
  el.innerHTML = '<div class="head"><span>' + esc(job) + '</span><span class="st">En attente</span></div><div class="detail">Préparation…</div><div class="track"><div class="fill"></div></div>';
  $('jobs').prepend(el);
  updateJobCount();
  return el;
}

function updateJobCount() {
  const n = document.querySelectorAll('.job').length;
  $('job-count').textContent = n ? '(' + n + ')' : '';
}

function updateJob(job, data) {
  const el = jobEl(job);
  const st = el.querySelector('.st');
  const detail = el.querySelector('.detail');
  const fill = el.querySelector('.fill');
  if (data.state) { st.textContent = data.state; st.className = 'st' + (data.state === 'Terminé' ? ' done' : (data.state === 'Échec' ? ' err' : '')); }
  if (data.detail) detail.textContent = data.detail;
  if (typeof data.pct === 'number') {
    fill.classList.remove('indet');
    fill.style.width = data.pct + '%';
    if (data.pct > 0 && st.textContent === 'En cours') detail.textContent = data.detail + ' — ' + data.pct + '%';
  } else {
    fill.classList.add('indet');
    fill.style.width = '';
  }
}

// ── Import ────────────────────────────────────────────────────
function isVideoFile(p) {
  const base = String(p).split(/[\\/]/).pop() || '';
  const ext = (base.split('.').pop() || '').toLowerCase();
  return ['mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'ogv', '3gp', 'ogg'].includes(ext);
}

async function doPick() {
  if (!state.canImport) { showError('Connecte-toi à un compte Discord pour importer des fichiers.'); return; }
  const paths = await window.blt.pickFiles();
  if (paths && paths.length) {
    const q = collectQualities();
    const hasVideo = paths.some(p => isVideoFile(p));
    if (hasVideo && !q.length) { showError('Sélectionne au moins une version à générer'); return; }
    const o = opts();
    o.qualities = q;
    o.parentId = state.currentId;
    try { await window.blt.importLocal(paths, o); }
    catch (e) { showError(e.message); }
    setTimeout(() => refresh(false), 800);
  }
}

async function doPickFolder() {
  if (!state.canImport) { showError('Connecte-toi à un compte Discord pour importer.'); return; }
  const paths = await window.blt.pickFolder();
  if (paths && paths.length) {
    const q = collectQualities();
    const o = opts();
    o.qualities = q;
    o.parentId = state.currentId;
    try { await window.blt.importLocal(paths, o); }
    catch (e) { showError(e.message); }
    setTimeout(() => refresh(false), 800);
  }
}

async function runDriveImport(id) {
  if (!state.canImport) { showError('Connecte-toi à un compte Discord pour importer des fichiers.'); return; }
  clearError();
  const q = collectQualities();
  if (!q.length) { showError('Sélectionne au moins une version à générer'); return; }
  const o = opts();
  o.qualities = q;
  try { await window.blt.importDrive(id, o); }
  catch (e) { showError(e.message); }
  setTimeout(() => refresh(false), 800);
}

// ── Modale ────────────────────────────────────────────────────
function closeModal() {
  if (openingBusy) return;
  if (dlgResolve) { const r = dlgResolve; dlgResolve = null; closeModalNow(); r(null); return; }
  closeModalNow();
}
function closeModalNow() {
  $('modal-overlay').style.display = 'none';
  const pv = document.getElementById('pv');
  if (pv) { try { pv.pause(); } catch {} pv.removeAttribute('src'); pv.load(); }
  const au = document.getElementById('pv-audio');
  if (au) { try { au.pause(); } catch {} au.removeAttribute('src'); au.load(); }
  pvCurrent = null;
}

// ── Réglages drawer ───────────────────────────────────────────
function toggleSettings() {
  const d = $('settings-drawer');
  d.style.display = d.style.display === 'none' ? 'flex' : 'none';
}

// ── Boot ──────────────────────────────────────────────────────
async function doConnect() {
  clearError();
  const origin = $('in-origin').value.trim();
  await window.blt.saveSettings({ origin });
  const btn = $('btn-connect');
  btn.disabled = true;
  try {
    const r = await window.blt.connectAccount();
    await refresh(true);
    if (!r.ok) showError(r.error);
  } finally { btn.disabled = false; }
}

function handleUpdate(evt) {
  const e = updEls();
  if (evt.state === 'available') {
    e.banner.style.display = 'flex';
    e.msg.textContent = 'Nouvelle version ' + (evt.version || '') + ' disponible.';
    e.dl.style.display = '';
    e.restart.style.display = 'none';
    e.dismiss.style.display = '';
    e.track.style.display = 'none';
  } else if (evt.state === 'progress') {
    e.banner.style.display = 'flex';
    e.dl.style.display = 'none';
    e.restart.style.display = 'none';
    e.dismiss.style.display = '';
    e.track.style.display = '';
    e.fill.style.width = (evt.percent || 0) + '%';
    e.msg.textContent = 'Téléchargement de la mise à jour : ' + Math.round(evt.percent || 0) + '%';
  } else if (evt.state === 'downloaded') {
    e.banner.style.display = 'flex';
    e.dl.style.display = 'none';
    e.restart.style.display = '';
    e.dismiss.style.display = '';
    e.track.style.display = 'none';
    e.msg.textContent = 'Mise à jour téléchargée (v' + (evt.version || '') + '). Redémarre pour installer.';
  } else if (evt.state === 'error') {
    e.banner.style.display = 'flex';
    e.dl.style.display = 'none';
    e.restart.style.display = 'none';
    e.dismiss.style.display = '';
    e.track.style.display = 'none';
    e.msg.textContent = 'Erreur de mise à jour : ' + (evt.detail || '');
  }
}

function updEls() {
  return { banner: $('update-banner'), msg: $('update-msg'), track: $('update-track'), fill: $('update-fill'), dl: $('btn-update-dl'), restart: $('btn-update-restart'), dismiss: $('btn-update-dismiss') };
}

async function boot() {
  await refresh(false);
  try {
    const ver = await window.blt.getAppVersion();
    if (ver && ver.version) $('app-version').textContent = 'v' + ver.version;
    if (ver && ver.updatable) window.blt.checkUpdate();
  } catch {}
}

// OS file/folder drag-and-drop import
document.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', async e => {
  e.preventDefault();
  if (!state.canImport) { showError('Connecte-toi pour importer.'); return; }
  const files = [];
  // Note: webkitGetAsEntry is the standard way to get file paths in Electron
  const items = e.dataTransfer.items;
  if (items) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        const paths = await readEntry(entry);
        files.push(...paths);
      }
    }
  }
  // Fallback: use dataTransfer.files
  if (!files.length && e.dataTransfer.files) {
    for (const f of e.dataTransfer.files) {
      if (f.path) files.push(f.path);
    }
  }
  if (!files.length) return;
  const q = collectQualities();
  const hasVideo = files.some(p => isVideoFile(p));
  if (hasVideo && !q.length) { showError('Sélectionne au moins une version à générer'); return; }
  const o = opts();
  o.qualities = q;
  o.parentId = state.currentId;
  try { await window.blt.importLocal(files, o); } catch (err) { showError(err.message); }
  setTimeout(() => refresh(false), 800);
});

function readEntry(entry) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => { resolve(f.path ? [f.path] : []); }, () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => {
        reader.readEntries(async entries => {
          if (!entries.length) { resolve(all); return; }
          for (const e of entries) {
            const p = await readEntry(e);
            all.push(...p);
          }
          readBatch();
        }, () => resolve(all));
      };
      readBatch();
    } else resolve([]);
  });
}

// ── Événements ────────────────────────────────────────────────
document.addEventListener('click', closeCtxMenu);
document.addEventListener('keydown', e => {
  if (e.key === 'F5') { e.preventDefault(); refresh(false); }
  else if (e.altKey && e.key === 'ArrowLeft') goBack();
  else if (e.altKey && e.key === 'ArrowRight') goForward();
  else if (e.altKey && e.key === 'ArrowUp') goUp();
  else if (e.key === 'Escape') closeCtxMenu();
});

$('btn-settings').onclick = toggleSettings;
$('btn-settings-close').onclick = toggleSettings;
$('modal-close').onclick = closeModal;
$('modal-overlay').onclick = e => { if (e.target === $('modal-overlay')) closeModal(); };

$('btn-back').onclick = goBack;
$('btn-forward').onclick = goForward;
$('btn-up').onclick = goUp;
$('btn-refresh').onclick = () => refresh(false);
$('btn-new-folder').onclick = promptNewFolder;
$('btn-move').onclick = () => promptMove();
$('btn-pick').onclick = doPick;
$('btn-pick-folder').onclick = doPickFolder;

document.querySelectorAll('.col').forEach(c => c.onclick = () => setSort(c.dataset.sort));

$('btn-connect').onclick = doConnect;
$('btn-add').onclick = doConnect;
$('btn-test').onclick = async () => {
  await window.blt.saveSettings({ origin: $('in-origin').value.trim() });
  await refresh(true);
};

// Login screen handler
(function() {
  var loginBtn = document.getElementById('login-btn');
  if (!loginBtn) return;
  loginBtn.onclick = async function() {
    var errEl = document.getElementById('login-error');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Connexion...';
    if (errEl) errEl.style.display = 'none';
    try {
      var r = await window.blt.connectAccount();
      await refresh(true);
      if (r && !r.ok && errEl) { errEl.textContent = r.error || 'Erreur de connexion'; errEl.style.display = 'block'; }
    } catch (e) { if (errEl) { errEl.textContent = e.message || 'Erreur'; errEl.style.display = 'block'; } }
    finally { loginBtn.disabled = false; loginBtn.textContent = 'Se connecter'; }
  };
})();

window.blt.onEvent(evt => {
  if (evt.type === 'job-start') updateJob(evt.job, { state: 'En cours', detail: 'Démarrage…' });
  else if (evt.type === 'phase') updateJob(evt.job, { detail: evt.detail, pct: evt.pct });
  else if (evt.type === 'job-end') updateJob(evt.job, { state: evt.ok ? 'Terminé' : 'Échec', detail: evt.ok ? 'Terminé' : (evt.error || 'Échec') });
  else if (evt.type === 'error') showError(evt.detail);
  else if (evt.type === 'update') handleUpdate(evt);
  else if (evt.type === 'account-connected') refresh(true);
  else if (evt.type === 'open-progress') {
    const bar = document.getElementById('open-progress-bar');
    if (!bar) return;
    const txt = document.getElementById('open-progress-txt');
    const sz = (evt.received ? fmtSize(evt.received) : '0');
    if (typeof evt.pct === 'number' && evt.pct >= 0) {
      const pct = Math.min(100, Math.max(0, evt.pct));
      bar.classList.remove('indet');
      bar.style.width = pct + '%';
      if (txt) txt.textContent = pct + '%' + (evt.total ? ' — ' + sz + ' / ' + fmtSize(evt.total) : ' — ' + sz);
    } else {
      bar.classList.add('indet');
      bar.style.width = '';
      if (txt) txt.textContent = sz + ' téléchargés…';
    }
  }
  else if (evt.type === 'reimport-start') setBadge('Réimport : ' + (evt.name || 'fichier') + '…', 'busy');
  else if (evt.type === 'reimport-ok') {
    setBadge('Connecté', 'ok');
    if ($('conn-error').style.display === 'block') clearError();
    const title = $('modal-title');
    if (title && title.textContent && title.textContent.indexOf('Ouvert dans une application') === 0) {
      $('modal-body').innerHTML = '<div class="muted">✓ <b>' + esc(evt.name || 'fichier') + '</b> a été modifié et <b>réimporté dans le drive</b>. La copie temporaire a été supprimée.</div>'
        + '<div class="hint">La version mise à jour est maintenant sur le drive.</div>';
    }
    refresh(false);
  }
});

$('btn-update-dl').onclick = async () => {
  const e = updEls();
  e.dl.disabled = true;
  e.msg.textContent = 'Téléchargement…';
  try { await window.blt.downloadUpdate(); }
  catch (err) { e.msg.textContent = 'Erreur de téléchargement : ' + err.message; e.dl.disabled = false; }
};
$('btn-update-restart').onclick = () => window.blt.quitInstall();
$('btn-update-dismiss').onclick = () => { const e = updEls(); e.banner.style.display = 'none'; };

boot();
