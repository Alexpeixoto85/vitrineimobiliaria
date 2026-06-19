// =============================================================================
// Cartório de Imóveis — Painel Gerencial (admin-app.js)
// Conecta no MESMO projeto Firebase do app (Firestore + Storage) e mantém
// banners, corretores e métricas em sincronia em tempo real via onSnapshot.
// =============================================================================

// ----- Config (mesmas chaves do app, então herda a config salva no navegador) -
const FIREBASE_CONFIG_KEY = 'cartorio-imoveis-firebase-config';
const FIREBASE_DISABLED_KEY = 'cartorio-imoveis-firebase-disabled';
const ADMIN_SESSION_KEY = 'cartorio-imoveis-admin-session';

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAMkwZMmnCFIIPxDR1naAoUQXU52MEw7wE',
  authDomain: 'cartorio-imoveis.firebaseapp.com',
  projectId: 'cartorio-imoveis',
  storageBucket: 'cartorio-imoveis.firebasestorage.app',
  databaseURL: 'https://cartorio-imoveis-default-rtdb.firebaseio.com',
};

function getStoredConfig() {
  if (localStorage.getItem(FIREBASE_DISABLED_KEY) === '1') return DEFAULT_FIREBASE_CONFIG;
  try {
    const raw = localStorage.getItem(FIREBASE_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.apiKey && parsed.projectId) return parsed;
    }
  } catch (_) {}
  return DEFAULT_FIREBASE_CONFIG;
}

// ----- Estado --------------------------------------------------------------
let _app = null, _fs = null, _st = null;
let _appMod, _fsMod, _stMod;
let cloudOk = false;
let currentAdmin = null;

const state = {
  brokers: [],
  properties: [],
  banners: [],
  activeUsers: [],
  daily: {},        // { 'YYYYMMDD': {logins,impressions,clicks} }
  rangeDays: 30,
};
const unsub = [];

// ----- Helpers -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(n) { return (n || 0).toLocaleString('pt-BR'); }
function pct(n) { return (n || 0).toFixed(n >= 10 ? 0 : 1) + '%'; }

function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
}
function lastNDays(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    out.push({ key: dayKey(d), date: d });
  }
  return out;
}
function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : d + ' d';
}
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let toastT;
function toast(msg, isErr = false) {
  const wrap = $('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ----- Firebase SDK loader (espelha o app) ---------------------------------
async function loadSDK() {
  if (location.protocol === 'file:') {
    throw new Error('Abra o painel por http(s) — ex.: GitHub Pages ou "python3 -m http.server". O navegador bloqueia módulos via file://.');
  }
  const v = '10.12.2';
  // 1) pacote local (mesmo domínio)
  try {
    const local = await import('./firebase-bundle.js');
    if (local?.appMod?.initializeApp && local?.firestoreMod?.getFirestore) {
      _appMod = local.appMod; _fsMod = local.firestoreMod; _stMod = local.storageMod;
      return;
    }
  } catch (_) { /* segue para CDN */ }
  // 2) CDNs
  const bases = [
    { app: `https://www.gstatic.com/firebasejs/${v}/firebase-app.js`, fs: `https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`, st: `https://www.gstatic.com/firebasejs/${v}/firebase-storage.js` },
    { app: `https://esm.sh/firebase@${v}/app`, fs: `https://esm.sh/firebase@${v}/firestore`, st: `https://esm.sh/firebase@${v}/storage` },
  ];
  let lastErr;
  for (const u of bases) {
    try {
      const appMod = await import(u.app);
      const [fsMod, stMod] = await Promise.all([import(u.fs), import(u.st)]);
      if (typeof appMod.initializeApp === 'function' && typeof fsMod.getFirestore === 'function') {
        _appMod = appMod; _fsMod = fsMod; _stMod = stMod; return;
      }
    } catch (e) { lastErr = e; }
  }
  throw new Error('Não foi possível carregar o SDK do Firebase. ' + (lastErr?.message || ''));
}

async function initCloud() {
  const cfg = getStoredConfig();
  await loadSDK();
  const { initializeApp } = _appMod;
  const { getFirestore, collection, getDocs, query, limit } = _fsMod;
  const { getStorage } = _stMod;
  _app = initializeApp({
    apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId,
    storageBucket: cfg.storageBucket, appId: cfg.appId,
  }, 'admin-panel');
  _fs = getFirestore(_app);
  try { _st = getStorage(_app); } catch (_) { _st = null; }
  await getDocs(query(collection(_fs, 'brokers'), limit(1))); // testa leitura
  cloudOk = true;
  return cfg;
}

// ----- Boot ----------------------------------------------------------------
window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  bindUI();
  $('cloud-hint').textContent = 'Conectando à nuvem…';
  try {
    const cfg = await initCloud();
    setCloud(true, cfg.projectId);
    renderCloudConfig(cfg);
    // bootstrap: existe algum admin?
    const admins = await getAdmins();
    if (admins.length === 0) {
      showSetup();
    } else {
      $('cloud-hint').textContent = 'Nuvem conectada · ' + cfg.projectId;
      const sid = localStorage.getItem(ADMIN_SESSION_KEY);
      const found = sid && admins.find((a) => a.id === sid);
      if (found) { currentAdmin = found; enterPanel(); }
    }
  } catch (err) {
    setCloud(false, '');
    $('cloud-hint').textContent = 'Falha na nuvem: ' + (err.message || 'desconhecida');
    $('login-error').textContent = 'Sem conexão com a nuvem. Verifique a configuração do Firebase no app.';
    console.error(err);
  }
}

function setCloud(ok, project) {
  cloudOk = ok;
  ['cloud-dot', 'cloud-dot-2'].forEach((id) => { const e = $(id); if (e) e.className = 'cloud-dot ' + (ok ? 'online' : 'offline'); });
  $('cloud-label').textContent = ok ? `nuvem · ${project}` : 'nuvem offline';
  if ($('cloud-label-2')) $('cloud-label-2').textContent = ok ? `Conectado · ${project}` : 'Desconectado';
}
function renderCloudConfig(cfg) {
  const dl = $('cloud-config');
  if (!dl) return;
  dl.innerHTML = `
    <div>projectId: <b>${esc(cfg.projectId)}</b></div>
    <div>storageBucket: ${esc(cfg.storageBucket || '—')}</div>
    <div>authDomain: ${esc(cfg.authDomain || '—')}</div>`;
}

// =============================================================================
// AUTH — coleção "admins" (senha com hash SHA-256 + salt)
// =============================================================================
async function getAdmins() {
  const { collection, getDocs } = _fsMod;
  const snap = await getDocs(collection(_fs, 'admins'));
  return snap.docs.map((d) => d.data());
}

function showSetup() {
  $('cloud-hint').textContent = 'Nuvem conectada — primeiro acesso';
  $('form-admin-login').style.display = 'none';
  $('form-admin-setup').style.display = 'flex';
}

async function handleSetup(e) {
  e.preventDefault();
  const name = $('setup-name').value.trim();
  const email = $('setup-email').value.trim().toLowerCase();
  const pass = $('setup-password').value;
  const err = $('setup-error'); err.textContent = '';
  if (pass.length < 6) { err.textContent = 'A senha precisa ter ao menos 6 caracteres.'; return; }
  try {
    const existing = await getAdmins();
    if (existing.length) { err.textContent = 'Um administrador já foi criado. Recarregue a página.'; return; }
    const salt = uid('s_');
    const passHash = await sha256(salt + pass);
    const admin = { id: uid('admin_'), name, email, salt, passHash, createdAt: Date.now() };
    const { doc, setDoc } = _fsMod;
    await setDoc(doc(_fs, 'admins', admin.id), admin);
    currentAdmin = admin;
    localStorage.setItem(ADMIN_SESSION_KEY, admin.id);
    toast('Administrador criado.');
    enterPanel();
  } catch (e2) { err.textContent = 'Erro ao criar: ' + (e2.message || ''); console.error(e2); }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $('admin-email').value.trim().toLowerCase();
  const pass = $('admin-password').value;
  const err = $('login-error'); err.textContent = '';
  if (!cloudOk) { err.textContent = 'Sem conexão com a nuvem.'; return; }
  try {
    const admins = await getAdmins();
    const admin = admins.find((a) => a.email === email);
    if (!admin) { err.textContent = 'E-mail ou senha incorretos.'; return; }
    const hash = await sha256((admin.salt || '') + pass);
    if (hash !== admin.passHash) { err.textContent = 'E-mail ou senha incorretos.'; return; }
    currentAdmin = admin;
    localStorage.setItem(ADMIN_SESSION_KEY, admin.id);
    enterPanel();
  } catch (e2) { err.textContent = 'Erro ao entrar. Tente novamente.'; console.error(e2); }
}

function logout() {
  localStorage.removeItem(ADMIN_SESSION_KEY);
  currentAdmin = null;
  unsub.forEach((u) => { try { u(); } catch (_) {} });
  unsub.length = 0;
  $('view-admin').classList.remove('active');
  $('view-auth').classList.add('active');
  $('form-admin-login').reset();
}

// =============================================================================
// ENTRAR NO PAINEL — liga as assinaturas em tempo real
// =============================================================================
function enterPanel() {
  $('view-auth').classList.remove('active');
  $('view-admin').classList.add('active');
  $('admin-name-label').textContent = currentAdmin.name || currentAdmin.email;
  subscribeAll();
}

function subscribeAll() {
  const { collection, onSnapshot, doc } = _fsMod;

  unsub.push(onSnapshot(collection(_fs, 'brokers'), (snap) => {
    state.brokers = snap.docs.map((d) => d.data());
    $('badge-users').textContent = state.brokers.length;
    renderOverview(); renderUsers();
  }, errLog('brokers')));

  unsub.push(onSnapshot(collection(_fs, 'properties'), (snap) => {
    state.properties = snap.docs.map((d) => d.data());
    renderOverview(); renderUsers();
  }, errLog('properties')));

  unsub.push(onSnapshot(collection(_fs, 'banners'), (snap) => {
    state.banners = snap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $('badge-banners').textContent = state.banners.length;
    renderBanners(); renderOverview();
  }, errLog('banners')));

  unsub.push(onSnapshot(collection(_fs, 'active_users'), (snap) => {
    state.activeUsers = snap.docs.map((d) => d.data());
    renderOverview();
  }, errLog('active_users')));

  unsub.push(onSnapshot(collection(_fs, 'metrics_daily'), (snap) => {
    const m = {};
    snap.docs.forEach((d) => { m[d.id] = d.data(); });
    state.daily = m;
    renderOverview();
  }, errLog('metrics_daily')));
}
function errLog(name) {
  return (e) => { console.warn('onSnapshot', name, e?.message || e); };
}

// =============================================================================
// VISÃO GERAL
// =============================================================================
function rangeStartTs() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (state.rangeDays - 1));
  return d.getTime();
}
function sumDaily(field) {
  const days = lastNDays(state.rangeDays);
  return days.reduce((s, d) => s + (state.daily[d.key]?.[field] || 0), 0);
}

function renderOverview() {
  if (!$('metrics-grid')) return;
  const startTs = rangeStartTs();
  const dayAgo = Date.now() - 86400e3;
  const weekAgo = Date.now() - 7 * 86400e3;

  // — usuários ativos / logins —
  const activeDay = state.activeUsers.filter((u) => (u.lastSeen || 0) >= dayAgo).length;
  const activeWeek = state.activeUsers.filter((u) => (u.lastSeen || 0) >= weekAgo).length;
  const loginsRange = sumDaily('logins');

  // — imóveis cadastrados e atualizados —
  const totalProps = state.properties.length;
  const newProps = state.properties.filter((p) => (p.createdAt || 0) >= startTs).length;
  const updatedProps = state.properties.filter((p) => (p.updatedAt || 0) >= startTs && (p.updatedAt || 0) !== (p.createdAt || 0)).length;

  // — banners: cliques e impressões —
  const imps = state.banners.reduce((s, b) => s + (b.impressions || 0), 0);
  const clicks = state.banners.reduce((s, b) => s + (b.clicks || 0), 0);
  const ctr = imps ? (clicks / imps) * 100 : 0;
  const activeBanners = state.banners.filter((b) => b.active).length;

  $('metrics-grid').innerHTML = `
    <div class="metric olive">
      <span class="metric-accent"></span>
      <div class="metric-label">Usuários ativos / logins</div>
      <div class="metric-value">${fmt(activeDay)}</div>
      <div class="metric-meta"><b>${fmt(activeWeek)}</b> ativos em 7d · <b>${fmt(loginsRange)}</b> logins no período</div>
    </div>
    <div class="metric">
      <span class="metric-accent"></span>
      <div class="metric-label">Imóveis cadastrados</div>
      <div class="metric-value">${fmt(totalProps)}</div>
      <div class="metric-meta"><b>${fmt(newProps)}</b> novos · <b>${fmt(updatedProps)}</b> atualizados no período</div>
    </div>
    <div class="metric amber">
      <span class="metric-accent"></span>
      <div class="metric-label">Impressões de banners</div>
      <div class="metric-value">${fmt(imps)}</div>
      <div class="metric-meta"><b>${activeBanners}</b> banner(s) ativo(s) de ${state.banners.length}</div>
    </div>
    <div class="metric rust">
      <span class="metric-accent"></span>
      <div class="metric-label">Cliques de banners</div>
      <div class="metric-value">${fmt(clicks)}</div>
      <div class="metric-meta">CTR médio <b>${pct(ctr)}</b></div>
    </div>`;

  renderChart();
  renderActivity();
  renderBannerPerf();
}

function renderChart() {
  const wrap = $('chart-wrap'); if (!wrap) return;
  const days = lastNDays(state.rangeDays);
  const series = days.map((d) => ({
    label: d.date,
    logins: state.daily[d.key]?.logins || 0,
    impressions: state.daily[d.key]?.impressions || 0,
    clicks: state.daily[d.key]?.clicks || 0,
  }));
  const max = Math.max(1, ...series.flatMap((s) => [s.logins, s.impressions, s.clicks]));

  const W = 720, H = 220, padL = 34, padB = 26, padT = 10, padR = 8;
  const plotW = W - padL - padR, plotH = H - padB - padT;
  const n = series.length;
  const slot = plotW / n;
  const bw = Math.max(2, Math.min(9, slot / 3 - 1.5));
  const cols = { logins: '#5C6650', impressions: '#B7872E', clicks: '#B5512A' };
  const MONO = "'JetBrains Mono', monospace";

  let bars = '';
  series.forEach((s, i) => {
    const x0 = padL + i * slot + (slot - bw * 3) / 2;
    ['logins', 'impressions', 'clicks'].forEach((k, j) => {
      const h = (s[k] / max) * plotH;
      const x = x0 + j * bw;
      const y = padT + plotH - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${cols[k]}" rx="1"><title>${s.label.toLocaleDateString('pt-BR')} · ${k}: ${fmt(s[k])}</title></rect>`;
    });
  });

  // gridlines + y labels (3 níveis)
  let grid = '';
  for (let g = 0; g <= 2; g++) {
    const val = Math.round((max / 2) * g);
    const y = padT + plotH - (val / max) * plotH;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#E8E3D7" stroke-width="1"/>`;
    grid += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="${MONO}" font-size="9" fill="#5A5650">${fmt(val)}</text>`;
  }
  // x labels (a cada ~7 dias)
  let xl = '';
  const step = Math.ceil(n / 6);
  series.forEach((s, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    const x = padL + i * slot + slot / 2;
    xl += `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-family="${MONO}" font-size="9" fill="#5A5650">${s.label.getDate()}/${s.label.getMonth() + 1}</text>`;
  });

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" class="bar-g">${grid}${bars}${xl}</svg>`;
  $('chart-sub').textContent = `Logins, impressões e cliques por dia · últimos ${state.rangeDays} dias`;
}

function renderActivity() {
  const ul = $('recent-activity'); if (!ul) return;
  const rows = [...state.activeUsers].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).slice(0, 8);
  if (!rows.length) {
    ul.innerHTML = `<li class="meta">Ainda sem registros de acesso. Eles aparecem aqui quando corretores entram no app.</li>`;
    return;
  }
  ul.innerHTML = rows.map((u) => `
    <li>
      <span class="ava">${esc(initials(u.name))}</span>
      <span><div class="cell-strong">${esc(u.name || 'Corretor')}</div><div class="meta">${(u.loginCount || 0)} login(s) registrados</div></span>
      <time>${timeAgo(u.lastSeen)}</time>
    </li>`).join('');
}

function renderBannerPerf() {
  const tb = $('banner-perf-table').querySelector('tbody');
  if (!state.banners.length) {
    tb.innerHTML = `<tr><td colspan="5" class="meta">Nenhum banner cadastrado. Crie um para começar a monetizar.</td></tr>`;
    return;
  }
  const rows = [...state.banners].sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  tb.innerHTML = rows.map((b) => {
    const ctr = b.impressions ? (b.clicks / b.impressions) * 100 : 0;
    return `<tr>
      <td class="cell-strong">${esc(b.title || 'Sem nome')}</td>
      <td><span class="tag ${b.active ? 'on' : 'off'}">${b.active ? 'ATIVO' : 'PAUSADO'}</span></td>
      <td class="cell-mono">${fmt(b.impressions)}</td>
      <td class="cell-mono">${fmt(b.clicks)}</td>
      <td class="cell-mono">${pct(ctr)}</td>
    </tr>`;
  }).join('');
}

// =============================================================================
// BANNERS — CRUD
// =============================================================================
let editingBanner = null;

function renderBanners() {
  const grid = $('banner-grid'); const empty = $('banners-empty');
  if (!grid) return;
  if (!state.banners.length) { grid.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  grid.innerHTML = state.banners.map((b) => {
    const ctr = b.impressions ? (b.clicks / b.impressions) * 100 : 0;
    const places = (b.placements || []).map((p) => `<span class="tag">${esc(placeLabel(p))}</span>`).join('');
    const thumb = b.imageUrl
      ? `style="background-image:url('${esc(b.imageUrl)}')"`
      : '';
    return `<div class="banner-card">
      <div class="banner-thumb" ${thumb}>${b.imageUrl ? '' : 'sem imagem'}</div>
      <div class="banner-card-body">
        <div class="banner-card-title">${esc(b.title || 'Sem nome')} <span class="tag ${b.active ? 'on' : 'off'}">${b.active ? 'ATIVO' : 'PAUSADO'}</span></div>
        <div class="placements">${places || '<span class="tag">—</span>'}</div>
        <a class="banner-card-link" href="${esc(b.linkUrl || '#')}" target="_blank" rel="noopener">${esc(b.linkUrl || 'sem link')}</a>
        <div class="banner-stats">
          <div class="banner-stat"><div class="n">${fmt(b.impressions)}</div><div class="l">Impressões</div></div>
          <div class="banner-stat"><div class="n">${fmt(b.clicks)}</div><div class="l">Cliques</div></div>
          <div class="banner-stat"><div class="n">${pct(ctr)}</div><div class="l">CTR</div></div>
        </div>
      </div>
      <div class="banner-card-foot">
        <button class="btn btn-secondary btn-sm" data-edit-banner="${esc(b.id)}">Editar</button>
        <button class="btn btn-secondary btn-sm" data-toggle-banner="${esc(b.id)}">${b.active ? 'Pausar' : 'Ativar'}</button>
      </div>
    </div>`;
  }).join('');
}

function placeLabel(p) {
  return { all: 'Todas as áreas', dashboard: 'Meus imóveis', explore: 'Vitrine', chat: 'Mensagens', portal: 'Portal público', portfolio: 'Portfólio' }[p] || p;
}

function openBannerModal(banner) {
  editingBanner = banner || null;
  $('banner-modal-title').textContent = banner ? 'Editar banner' : 'Novo banner';
  $('btn-delete-banner').hidden = !banner;
  $('banner-error').textContent = '';
  $('b-title').value = banner?.title || '';
  $('b-image-url').value = banner?.imageUrl || '';
  $('b-image-file').value = '';
  $('b-link').value = banner?.linkUrl || '';
  $('b-weight').value = banner?.weight || 1;
  const active = banner ? !!banner.active : true;
  $('b-active').checked = active;
  $('b-active-label').textContent = active ? 'Ativo' : 'Pausado';
  const places = banner?.placements || ['all'];
  $('b-placements').querySelectorAll('input').forEach((cb) => {
    cb.checked = places.includes(cb.value);
    cb.closest('.check').classList.toggle('checked', cb.checked);
  });
  syncPlacementLock();
  updateBannerPreview();
  openModal('modal-banner');
}

function syncPlacementLock() {
  const boxes = [...$('b-placements').querySelectorAll('input')];
  const all = boxes.find((b) => b.value === 'all');
  const others = boxes.filter((b) => b.value !== 'all');
  others.forEach((o) => { o.disabled = all.checked; o.closest('.check').style.opacity = all.checked ? .45 : 1; });
}

function readBannerForm() {
  const boxes = [...$('b-placements').querySelectorAll('input:checked')].map((b) => b.value);
  const placements = boxes.includes('all') || boxes.length === 0 ? ['all'] : boxes;
  return {
    title: $('b-title').value.trim(),
    imageUrl: $('b-image-url').value.trim(),
    linkUrl: $('b-link').value.trim(),
    placements,
    active: $('b-active').checked,
    weight: Math.max(1, Math.min(10, parseInt($('b-weight').value) || 1)),
  };
}

function updateBannerPreview() {
  const d = readBannerForm();
  const img = d.imageUrl
    ? `<img src="${esc(d.imageUrl)}" alt="">`
    : `<div class="ad-fallback">${esc(d.title || 'Pré-visualização do banner')}</div>`;
  $('b-preview').innerHTML = `<a class="ad-banner" href="${esc(d.linkUrl || '#')}" onclick="return false">${img}<span class="ad-flag">Publicidade</span></a>`;
}

async function uploadBannerImage(file, bannerId) {
  if (!_st) throw new Error('Storage indisponível. Use uma URL de imagem.');
  const { ref, uploadBytes, getDownloadURL } = _stMod;
  const path = `banners/${bannerId}/${uid('img_')}_${file.name}`;
  const r = ref(_st, path);
  await uploadBytes(r, file);
  return await getDownloadURL(r);
}

async function saveBanner() {
  const err = $('banner-error'); err.textContent = '';
  const data = readBannerForm();
  if (!data.title) { err.textContent = 'Dê um nome ao banner.'; return; }
  const file = $('b-image-file').files[0];
  if (!data.imageUrl && !file && !editingBanner?.imageUrl) { err.textContent = 'Informe uma imagem (URL ou arquivo).'; return; }
  if (!data.linkUrl) { err.textContent = 'Informe o link de destino do clique.'; return; }

  const btn = $('btn-save-banner'); btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    const id = editingBanner?.id || uid('banner_');
    if (file) data.imageUrl = await uploadBannerImage(file, id);
    else if (!data.imageUrl && editingBanner?.imageUrl) data.imageUrl = editingBanner.imageUrl;

    const { doc, setDoc } = _fsMod;
    const payload = editingBanner
      ? { ...editingBanner, ...data, updatedAt: Date.now() }
      : { ...data, id, impressions: 0, clicks: 0, createdAt: Date.now(), updatedAt: Date.now() };
    await setDoc(doc(_fs, 'banners', id), payload);
    closeModal('modal-banner');
    toast(editingBanner ? 'Banner atualizado.' : 'Banner criado.');
  } catch (e) {
    err.textContent = 'Erro ao salvar: ' + (e.message || '');
    console.error(e);
  } finally { btn.disabled = false; btn.textContent = 'Salvar banner'; }
}

async function toggleBanner(id) {
  const b = state.banners.find((x) => x.id === id); if (!b) return;
  const { doc, updateDoc } = _fsMod;
  await updateDoc(doc(_fs, 'banners', id), { active: !b.active, updatedAt: Date.now() });
  toast(!b.active ? 'Banner ativado.' : 'Banner pausado.');
}

async function deleteBanner() {
  if (!editingBanner) return;
  confirmAction('Excluir banner', `Remover "${editingBanner.title}"? As métricas acumuladas serão perdidas.`, async () => {
    const { doc, deleteDoc } = _fsMod;
    await deleteDoc(doc(_fs, 'banners', editingBanner.id));
    closeModal('modal-banner');
    toast('Banner excluído.');
  });
}

// =============================================================================
// CORRETORES
// =============================================================================
let editingUser = null;

function propsCountByBroker(id) {
  return state.properties.filter((p) => p.brokerId === id).length;
}

function renderUsers() {
  const tb = $('users-table')?.querySelector('tbody'); if (!tb) return;
  const term = ($('user-search').value || '').toLowerCase().trim();
  let rows = [...state.brokers].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (term) rows = rows.filter((b) => [b.name, b.email, b.creci].some((v) => String(v || '').toLowerCase().includes(term)));
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6" class="meta" style="padding:1.4rem">${term ? 'Nenhum corretor encontrado.' : 'Nenhum corretor cadastrado ainda.'}</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((b) => `
    <tr>
      <td><div class="cell-strong">${esc(b.name || '—')}</div><div class="cell-mono">${esc(b.email || '')}</div></td>
      <td class="cell-mono">${esc(b.creci || '—')}</td>
      <td class="cell-mono">${esc(b.whatsapp || '—')}</td>
      <td class="cell-strong">${propsCountByBroker(b.id)}</td>
      <td class="cell-mono">${b.createdAt ? new Date(b.createdAt).toLocaleDateString('pt-BR') : '—'}</td>
      <td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-edit-user="${esc(b.id)}">Gerenciar</button></div></td>
    </tr>`).join('');
}

function openUserModal(broker) {
  editingUser = broker;
  $('user-error').textContent = '';
  $('u-name').value = broker.name || '';
  $('u-creci').value = broker.creci || '';
  $('u-whats').value = broker.whatsapp || '';
  $('u-email').value = broker.email || '';
  openModal('modal-user');
}

async function saveUser() {
  if (!editingUser) return;
  const err = $('user-error'); err.textContent = '';
  const updated = {
    ...editingUser,
    name: $('u-name').value.trim(),
    creci: $('u-creci').value.trim(),
    whatsapp: $('u-whats').value.replace(/\D/g, ''),
    email: $('u-email').value.trim().toLowerCase(),
  };
  try {
    const { doc, setDoc } = _fsMod;
    await setDoc(doc(_fs, 'brokers', editingUser.id), updated);
    closeModal('modal-user');
    toast('Corretor atualizado.');
  } catch (e) { err.textContent = 'Erro ao salvar: ' + (e.message || ''); }
}

function deleteUser() {
  if (!editingUser) return;
  const count = propsCountByBroker(editingUser.id);
  confirmAction('Excluir corretor', `Remover "${editingUser.name}"? ${count ? `Os ${count} imóveis deste corretor continuarão na base, mas ficarão órfãos.` : ''} Esta ação não pode ser desfeita.`, async () => {
    const { doc, deleteDoc } = _fsMod;
    await deleteDoc(doc(_fs, 'brokers', editingUser.id));
    closeModal('modal-user');
    toast('Corretor removido.');
  });
}

// =============================================================================
// CONFIGURAÇÕES — trocar senha
// =============================================================================
async function changePassword(e) {
  e.preventDefault();
  const err = $('cp-error'); err.textContent = '';
  const cur = $('cp-current').value, nw = $('cp-new').value;
  if (nw.length < 6) { err.textContent = 'A nova senha precisa ter ao menos 6 caracteres.'; return; }
  const curHash = await sha256((currentAdmin.salt || '') + cur);
  if (curHash !== currentAdmin.passHash) { err.textContent = 'Senha atual incorreta.'; return; }
  const salt = uid('s_');
  const passHash = await sha256(salt + nw);
  const updated = { ...currentAdmin, salt, passHash, updatedAt: Date.now() };
  try {
    const { doc, setDoc } = _fsMod;
    await setDoc(doc(_fs, 'admins', currentAdmin.id), updated);
    currentAdmin = updated;
    $('form-change-pass').reset();
    toast('Senha atualizada.');
  } catch (e2) { err.textContent = 'Erro ao atualizar: ' + (e2.message || ''); }
}

// =============================================================================
// MODAIS / CONFIRM
// =============================================================================
function openModal(id) { $(id).classList.add('active'); document.body.style.overflow = 'hidden'; }
function closeModal(id) { $(id).classList.remove('active'); document.body.style.overflow = ''; }
let confirmCb = null;
function confirmAction(title, text, cb) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  confirmCb = cb;
  openModal('modal-confirm');
}

// =============================================================================
// NAV / EVENTOS
// =============================================================================
function gotoPage(page) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  window.scrollTo(0, 0);
}

function bindUI() {
  $('form-admin-login').addEventListener('submit', handleLogin);
  $('form-admin-setup').addEventListener('submit', handleSetup);
  $('btn-admin-logout').addEventListener('click', logout);

  document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => gotoPage(n.dataset.page)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => gotoPage(b.dataset.goto)));

  $('range-select').addEventListener('change', (e) => { state.rangeDays = parseInt(e.target.value); renderOverview(); });

  // banners
  $('btn-new-banner').addEventListener('click', () => openBannerModal(null));
  $('btn-new-banner-empty').addEventListener('click', () => openBannerModal(null));
  $('btn-save-banner').addEventListener('click', saveBanner);
  $('btn-delete-banner').addEventListener('click', deleteBanner);
  ['b-title', 'b-image-url', 'b-link'].forEach((id) => $(id).addEventListener('input', updateBannerPreview));
  $('b-image-file').addEventListener('change', () => {
    const f = $('b-image-file').files[0];
    if (f) { const url = URL.createObjectURL(f); $('b-preview').querySelector('.ad-banner')?.remove(); $('b-preview').innerHTML = `<a class="ad-banner" onclick="return false"><img src="${url}"><span class="ad-flag">Publicidade</span></a>`; }
  });
  $('b-active').addEventListener('change', (e) => { $('b-active-label').textContent = e.target.checked ? 'Ativo' : 'Pausado'; });
  $('b-placements').addEventListener('change', (e) => {
    e.target.closest('.check').classList.toggle('checked', e.target.checked);
    if (e.target.value === 'all') syncPlacementLock();
    updateBannerPreview();
  });

  // delegação: cards de banner
  $('banner-grid').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-banner]');
    const tg = e.target.closest('[data-toggle-banner]');
    if (ed) openBannerModal(state.banners.find((b) => b.id === ed.dataset.editBanner));
    if (tg) toggleBanner(tg.dataset.toggleBanner);
  });

  // usuários
  $('user-search').addEventListener('input', renderUsers);
  $('users-table').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-user]');
    if (ed) openUserModal(state.brokers.find((b) => b.id === ed.dataset.editUser));
  });
  $('btn-save-user').addEventListener('click', saveUser);
  $('btn-delete-user').addEventListener('click', deleteUser);

  // settings
  $('form-change-pass').addEventListener('submit', changePassword);

  // modais
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal-overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) closeModal(o.id); }));
  $('confirm-ok').addEventListener('click', async () => {
    const cb = confirmCb; confirmCb = null; closeModal('modal-confirm');
    if (cb) try { await cb(); } catch (e) { toast('Erro: ' + (e.message || ''), true); }
  });
}
