const state = {
  files: [],
  driveVideos: [],
  accounts: [],
  activeAccountId: '',
  canImport: false,
  role: '',
  quotaRole: ''
};

try {
  window.addEventListener('error', e => { try { window.blt.log('UNCAUGHT: ' + String(e.message || e.error || e) + ' @' + (e.filename||'') + ':' + e.lineno); } catch {} });
  window.addEventListener('unhandledrejection', e => { try { window.blt.log('REJECTED: ' + String(e.reason && e.reason.message || e.reason)); } catch {} });
} catch {}

const $ = id => document.getElementById(id);

function fmtSize(n) {
  const num = parseFloat(n);
  if (!isFinite(num) || num <= 0) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = num;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function setBadge(text, cls) {
  const b = $('conn-badge');
  b.textContent = text;
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
      + '<span class="acc-name" title="' + a.id + '">' + (active ? '✓ ' : '') + a.label + '</span>'
      + '<span class="acc-act">'
      + (active ? '' : '<button class="btn tiny min" data-use="' + a.id + '">Utiliser</button>')
      + '<button class="btn tiny danger min" data-del="' + a.id + '">✕</button>'
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
  $('import-options').style.display = allow ? '' : 'none';
  $('import-locked').style.display = allow ? 'none' : '';
  $('btn-pick').disabled = !allow;
  $('btn-import').disabled = !allow;
  const lk = $('import-locked');
  if (!allow && state.activeAccountId) lk.textContent = 'Connecte-toi à un compte Discord pour importer des vidéos.';
  else if (!allow) lk.textContent = 'Connecte-toi à un compte Discord pour importer des vidéos\u2009— toute personne connectée peut importer et transcoder.';
  window.blt.log('applyRole: canImport=' + state.canImport + ' allow=' + allow + ' btnPick.disabled=' + $('btn-pick').disabled + ' btnImport.disabled=' + $('btn-import').disabled);
}

async function refresh(showErrors) {
  try {
    const s = await window.blt.getSettings();
    applySettings(s);
    const r = await window.blt.testConnection();
    clearError();
    window.blt.log('refresh: r.ok=' + r.ok + ' canImport=' + r.canImport + ' activeId=' + s.activeAccountId + ' accs=' + (s.accounts||[]).length);
    if (r.ok) {
      window.blt.log('refresh: ok-block, before applyRole');
      const acc = r.account ? r.account.label : 'Connecté';
      setBadge('✓ ' + acc, 'ok');
      const q = r.quota || {};
      const limitTxt = q.limit === '-1' || q.limit === '-1n' ? 'illimité' : fmtSize(q.limit);
      $('conn-info').textContent = 'Webhook ' + (r.webhook ? 'actif' : 'INACTIF') + ' · quota ' + (r.quotaRole || '') + ' · ' + fmtSize(q.usage) + ' / ' + limitTxt;
      applyRole(r);
    } else {
      setBadge(state.activeAccountId ? '✗ Connexion' : 'Non connecté', state.activeAccountId ? 'bad' : 'bad');
      $('conn-info').textContent = '';
      applyRole({ canImport: false });
      if (showErrors) showError(r.error);
    }
  } catch (e) { window.blt.log('refresh: CATCH ' + String(e && e.message || e)); }
}

async function doConnect() {
  clearError();
  const origin = $('in-origin').value.trim();
  await window.blt.saveSettings({ origin });
  const btn = $('btn-connect');
  btn.disabled = true;
  $('conn-info').textContent = 'Connexion… une page de connexion s\u2019ouvre dans ton navigateur. Autorise-y le compte Discord, puis reviens ici automatiquement.';
  try {
    const r = await window.blt.connectAccount();
    await refresh(true);
    if (!r.ok) showError(r.error);
  } finally { btn.disabled = false; }
}

function renderFiles() {
  const list = $('file-list');
  if (!state.files.length) { list.innerHTML = '<div class="muted">Aucun fichier choisi</div>'; return; }
  list.innerHTML = state.files.map(f => {
    const name = f.split(/[\\/]/).pop();
    return '<div class="fitem"><span class="nm">🎬 ' + name + '</span><span class="act"><button class="btn tiny danger" data-rm="' + f + '">Retirer</button></span></div>';
  }).join('');
  list.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    state.files = state.files.filter(x => x !== b.dataset.rm);
    renderFiles();
  });
}

async function renderDrive() {
  const list = $('drive-list');
  const btn = $('btn-refresh-drive');
  btn.disabled = true;
  btn.textContent = 'Chargement…';
  const r = await window.blt.listDrive();
  btn.disabled = false;
  btn.textContent = '🔄 Lister les vidéos';
  if (r.error) { list.innerHTML = '<div class="muted" style="color:var(--error)">' + r.error + '</div>'; return; }
  state.driveVideos = r.items || [];
  if (!state.driveVideos.length) { list.innerHTML = '<div class="muted">Aucune vidéo (original) sur le drive</div>'; return; }
  list.innerHTML = state.driveVideos.map(v => {
    return '<div class="fitem"><span class="nm" title="' + v.name + '">🎥 ' + v.name + '</span><span class="sz">' + fmtSize(v.size) + '</span><span class="act"><button class="btn tiny" data-drive="' + v.id + '">Transcoder</button></span></div>';
  }).join('');
  list.querySelectorAll('[data-drive]').forEach(b => b.onclick = () => runDriveImport(b.dataset.drive));
}

function jobEl(job) {
  let el = document.querySelector('.job[data-job="' + job + '"]');
  if (el) return el;
  const empty = document.querySelector('.job-empty');
  if (empty) empty.remove();
  el = document.createElement('div');
  el.className = 'job';
  el.dataset.job = job;
  el.innerHTML = '<div class="head"><span>' + job + '</span><span class="st">En attente</span></div><div class="detail">Préparation…</div><div class="track"><div class="fill"></div></div>';
  $('jobs').prepend(el);
  return el;
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

async function boot() {
  await refresh(false);
  try {
    const ver = await window.blt.getAppVersion();
    if (ver && ver.version) $('app-version').textContent = 'v' + ver.version;
    if (ver && ver.updatable) window.blt.checkUpdate();
  } catch {}
}

function updEls() {
  return { banner: $('update-banner'), msg: $('update-msg'), track: $('update-track'), fill: $('update-fill'), dl: $('btn-update-dl'), restart: $('btn-update-restart'), dismiss: $('btn-update-dismiss') };
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

$('btn-connect').onclick = doConnect;
$('btn-add').onclick = doConnect;
$('btn-test').onclick = async () => {
  await window.blt.saveSettings({ origin: $('in-origin').value.trim() });
  await refresh(true);
};

$('btn-pick').onclick = async () => {
  if (!state.canImport) { showError('Connecte-toi à un compte Discord pour importer des vidéos.'); return; }
  const paths = await window.blt.pickVideos();
  if (paths && paths.length) { state.files = paths; renderFiles(); }
};

$('btn-import').onclick = async () => {
  if (!state.canImport) { showError('Connecte-toi à un compte Discord pour importer des vidéos.'); return; }
  if (!state.files.length) { showError('Choisis d\u2019abord des vidéos'); return; }
  clearError();
  const q = collectQualities();
  if (!q.length) { showError('Sélectionne au moins une version à générer'); return; }
  const o = opts();
  o.qualities = q;
  const btn = $('btn-import');
  btn.disabled = true;
  try { await window.blt.importLocal(state.files, o); }
  catch (e) { showError(e.message); }
  finally { btn.disabled = false; refresh(false); }
};

$('btn-refresh-drive').onclick = () => renderDrive();

async function runDriveImport(id) {
  if (!state.canImport) { showError('Connecte-toi à un compte Discord pour importer des vidéos.'); return; }
  clearError();
  const q = collectQualities();
  if (!q.length) { showError('Sélectionne au moins une version à générer'); return; }
  const o = opts();
  o.qualities = q;
  try { await window.blt.importDrive(id, o); }
  catch (e) { showError(e.message); }
}

window.blt.onEvent(evt => {
  if (evt.type === 'job-start') updateJob(evt.job, { state: 'En cours', detail: 'Démarrage…' });
  else if (evt.type === 'phase') updateJob(evt.job, { detail: evt.detail, pct: evt.pct });
  else if (evt.type === 'job-end') updateJob(evt.job, { state: evt.ok ? 'Terminé' : 'Échec', detail: evt.ok ? 'Terminé' : (evt.error || 'Échec') });
  else if (evt.type === 'error') showError(evt.detail);
  else if (evt.type === 'update') handleUpdate(evt);
  else if (evt.type === 'account-connected') refresh(true);
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