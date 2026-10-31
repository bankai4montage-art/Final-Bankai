/* ============================================================================
   Final-Bankai — unified frontend
   Vanilla ES module SPA: auth, cinematic intro, router, modules.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = esc;
const num = (n) => Number(n || 0).toLocaleString('en-US');
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(String(v).length <= 10 ? `${v}T00:00:00` : v);
  return isNaN(d) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const ago = (v) => {
  const t = new Date(String(v).replace(' ', 'T')).getTime();
  if (!t || isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const initials = (name) => (String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
const icon = (id, cls = '') => `<svg class="${cls}" width="16" height="16" aria-hidden="true"><use href="#i-${id}"/></svg>`;

const S = {
  user: null, csrf: '', perms: new Set(), route: 'system/hiring',
  notifications: [], unread: 0, params: {},
  cache: { rosterMeta: null }
};

/* ------------------------------ API ------------------------------ */
async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = S.csrf;
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('Session expired.'); }
  if (!res.ok) {
    if (!quiet) toast(data.error || `Request failed (${res.status})`, 'err');
    throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  }
  return data;
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'err' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; setTimeout(() => el.remove(), 250); }, 3200);
}

/* ------------------------------ INTRO ------------------------------ */
/* Professional cinematic opening. Plays on every visit (skippable):
   mark draws itself → wordmark letters sharpen → hairline sweep →
   the three systems fan out → progress completes → graceful zoom-out. */
const intro = (() => {
  const el = $('#intro');
  const word = $('#inWord');
  const BAR_MS = matchMedia('(prefers-reduced-motion: reduce)').matches ? 400 : 2650;
  let finishTimer = 0, finished = false;

  /* build the wordmark once: one span per letter for the stagger effect */
  if (word && !word.dataset.built) {
    word.dataset.built = '1';
    word.innerHTML = [...'Rawahel'].map((ch, i) =>
      ch === ' ' ? '<span class="in-gap"> </span>' : `<span style="--i:${i}">${ch}</span>`).join('');
  }

  function reset() {
    finished = false;
    clearTimeout(finishTimer);
    el.classList.remove('out', 'fast');
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(finishTimer);
    el.classList.add('out');
    // done() fires once the katana cut fully clears the screen
    setTimeout(() => { el.classList.remove('out'); el.style.display = 'none'; el._done?.(); el._done = null; }, 640);
  }

  function play({ force = false, done = () => {} } = {}) {
    el._done = done;
    if (force) reset();                      // Settings → Replay
    finished = false;
    clearTimeout(finishTimer);
    el.classList.remove('out');
    el.style.display = 'grid';
    // force a reflow so the entrance animations restart from frame 0
    void el.offsetWidth;
    finishTimer = setTimeout(finish, BAR_MS);
  }

  function skip() {
    if (el._done) { el.classList.add('fast'); finish(); }
  }

  $('#introSkip').addEventListener('click', skip);
  el.addEventListener('click', skip);
  document.addEventListener('keydown', (e) => { if (el.style.display !== 'none' && !finished) { if (['Escape', 'Enter', ' '].includes(e.key)) skip(); } });

  return { play, skip };
})();

/* ------------------------------ AUTH ------------------------------ */
function showLogin() {
  $('#app').classList.remove('ready');
  $('#login').classList.remove('hidden');
  $('#password').value = '';
  setTimeout(() => $('#email').focus(), 120);
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.add('ready');
  $('#userName').textContent = S.user.name;
  $('#userRole').textContent = S.user.role.replace('_', ' ');
  $('#userAvatar').textContent = initials(S.user.name);
  $('#userAvatar').style.background = S.user.avatar_color || 'linear-gradient(135deg,#7C5CFF,#14D9C4)';
  renderNav();
  loadNotifications();
}

function setSession(user, csrf) {
  S.user = user; S.csrf = csrf || S.csrf;
  S.perms = new Set(user.permissions || []);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const err = $('#loginError');
  err.textContent = '';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span class="label">Signing in…</span>';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign-in failed.');
    setSession(data.user, data.csrf);
    showApp();
    navigate(location.hash || '#/system/hiring', { replace: true });
    toast(`Welcome back, ${data.user.name.split(' ')[0]}`);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="label">Sign in</span>';
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  S.user = null; S.csrf = ''; S.perms = new Set();
  showLogin();
});

/* ------------------------------ NAV ------------------------------ */
/* The three member systems open COMPLETE inside the platform (proxy + iframe).
   Management pages stay native. No "summary" views — systems run for real. */
const SYSTEMS = [
  {
    key: 'roster', label: 'Roster & Attendance', icon: 'users', colour: 'var(--turq)', perm: 'roster.view',
    desc: 'Employees, shifts and daily attendance',
    tabs: [
      { id: 'dashboard',  label: 'Overview' },
      { id: 'attendance', label: 'Attendance' },
      { id: 'schedule',   label: 'Schedule' },
      { id: 'employees',  label: 'Employees' },
      { id: 'reports',    label: 'Reports' },
      { id: 'fines',      label: 'Fines' }
    ]
  },
  {
    key: 'hiring', label: 'Hiring', icon: 'hire', colour: 'var(--purple)', perm: 'hiring.view',
    desc: 'Candidates, documents and conversion',
    tabs: [] // single-list layout since the kanban was retired
  },
  {
    key: 'tickets', label: 'DAS Ticketing', icon: 'ticket', colour: 'var(--info)', perm: 'tickets.view',
    desc: 'Support tickets and requests',
    tabs: [
      { id: 'index', label: 'Portal' },
      { id: 'admin', label: 'Admin' }
    ]
  }
];

const PAGES = [
  { id: 'reports',  label: 'Reports',  icon: 'chart',    perm: 'reports.view' },
  { id: 'team',     label: 'Team',     icon: 'team',     perm: 'team.manage' },
  { id: 'settings', label: 'Settings', icon: 'settings', perm: null }
];

const systemBy = (key) => SYSTEMS.find(s => s.key === key);
const routeAllowed = (r) => !r.perm || S.perms.has(r.perm);

function renderNav() {
  const sys = SYSTEMS.filter(routeAllowed);
  const pages = PAGES.filter(routeAllowed);
  $('#nav').innerHTML = `
    <div class="nav-group-label">Systems</div>
    ${sys.map(r => `
      <a class="nav-item system ${S.route === 'system/' + r.key ? 'on' : ''}" href="#/system/${r.key}"
         data-route="system/${r.key}" data-key="${r.key}" style="--c:${r.colour}">
        <span class="nav-tile">${icon(r.icon)}</span>
        <span class="nav-text">
          <b>${r.label}</b>
          <small>${r.desc}</small>
        </span>
        ${icon('arrow', 'nav-chev')}
      </a>`).join('')}
    <div class="nav-group-label">Manage</div>
    ${pages.map(r => `
      <a class="nav-item ${S.route === r.id ? 'on' : ''}" href="#/${r.id}" data-route="${r.id}">
        ${icon(r.icon)}<span>${r.label}</span>
      </a>`).join('')}`;
}

/* ------------------------------ ROUTER ------------------------------ */
const TITLES = {
  'system/roster':  ['Roster & Attendance', 'Employees, shifts and daily attendance'],
  'system/hiring':  ['Hiring', 'Candidate pipeline and conversion'],
  'system/tickets': ['DAS Ticketing', 'Support tickets and requests'],
  reports:  ['Reports', 'Cross-system analytics'],
  team:     ['Team', 'Users, roles and permissions'],
  settings: ['Settings', 'Profile, appearance and system']
};

/* legacy deep links (notifications / bookmarks) → their system view */
const LEGACY = { roster: 'system/roster', hiring: 'system/hiring', tickets: 'system/tickets' };

function navigate(hash, { replace = false } = {}) {
  const [routePart, query] = String(hash || '#/system/hiring').replace(/^#\/?/, '').split('?');
  let route = routePart;
  if (LEGACY[route]) { route = LEGACY[route]; hash = `#/${route}${query ? '?' + query : ''}`; }
  const permitted = route.startsWith('system/')
    ? routeAllowed(systemBy(route.slice(7)) || {})
    : routeAllowed(PAGES.find(p => p.id === route) || {});
  if (!permitted) route = firstSystemRoute();
  S.params = Object.fromEntries(new URLSearchParams(query || ''));
  if (replace) history.replaceState(null, '', `#/${route}${query ? '?' + query : ''}`);
  S.route = route;
  const [title, sub] = TITLES[route] || ['', ''];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  renderNav();
  closeDrawer();
  renderRoute();
}

function firstSystemRoute() {
  const first = SYSTEMS.find(routeAllowed);
  return first ? `system/${first.key}` : 'settings';
}

addEventListener('hashchange', () => navigate(location.hash));
$('#nav').addEventListener('click', (e) => {
  const a = e.target.closest('[data-route]');
  if (a) {
    e.preventDefault();
    $('#sidebar').classList.remove('open');
    if (location.hash === a.getAttribute('href')) renderRoute();
    else location.hash = a.getAttribute('href');
  }
});

function renderRoute() {
  const view = $('#view');
  S.sysTab = S.sysTab || {};

  /* system workspaces persist their iframe across visits (no reload flash) */
  if (S.route.startsWith('system/')) {
    const sys = systemBy(S.route.slice(7));
    return viewSystem(view, sys);
  }
  hideSystemView();

  view.innerHTML = `<div class="card"><div class="card-body"><div class="skeleton" style="height:90px"></div></div></div>`;
  const fn = { reports: viewReports, team: viewTeam, settings: viewSettings }[S.route];
  (fn || viewSettings)(view).catch(err => {
    console.error(err);
    view.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><b>Could not load this view</b>${esc(err.message)}</div></div></div>`;
  });
}

/* ------------------------------ SHARED UI ------------------------------ */
function statCard({ label, value, foot, icon: ic, colour = 'var(--purple)' }) {
  return `<div class="stat" style="--c:${colour}">
    <div class="ico">${icon(ic)}</div>
    <div class="lbl">${esc(label)}</div>
    <div class="val">${typeof value === 'number' ? num(value) : esc(value)}</div>
    ${foot ? `<div class="foot">${foot}</div>` : ''}
  </div>`;
}

function statusChip(status) {
  const s = String(status || '');
  const map = {
    Present: 'ok', Late: 'warn', Absent: 'bad', Excused: 'info',
    Active: 'ok', OnBoarding: 'purple', Inactive: 'mute', OffBoarding: 'bad', 'Attended to D0': 'info', 'Not Attended to D0': 'warn',
    'اتحلت': 'ok', 'قيد المراجعة': 'info', 'يتم المراجعة': 'purple', 'لازم تيجي المكتب': 'warn', 'مرفوض': 'bad'
  };
  return `<span class="chip ${map[s] || 'mute'}"><span class="dot"></span>${esc(s || '—')}</span>`;
}

function pager(data, onPage) {
  if (!data || data.pages <= 1) return '';
  const cur = data.page, last = data.pages;
  const pages = [];
  const add = (n) => pages.push(`<button data-page="${n}" class="${n === cur ? 'on' : ''}">${n}</button>`);
  add(1);
  for (let n = Math.max(2, cur - 1); n <= Math.min(last - 1, cur + 1); n++) add(n);
  if (last > 1) add(last);
  return `<div class="pager"><span class="info">${num(data.total)} total</span>
    <button data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>‹</button>${pages.join('')}
    <button data-page="${cur + 1}" ${cur >= last ? 'disabled' : ''}>›</button></div>`;
}

function wirePager(root, data, onPage) {
  $$('.pager [data-page]', root).forEach(b => b.addEventListener('click', () => {
    const p = Number(b.dataset.page);
    if (p >= 1 && p <= data.pages && p !== data.page) onPage(p);
  }));
}

/* ------------------------------ DRAWER ------------------------------ */
function openDrawer(title, body, foot = '') {
  let el = $('#drawer');
  if (!el) {
    el = document.createElement('aside');
    el.id = 'drawer';
    el.className = 'drawer';
    el.innerHTML = `<div class="drawer-head"><h2 id="drawerTitle"></h2><div style="flex:1"></div>
        <button class="icon-btn" data-close><svg><use href="#i-x"/></svg></button></div>
      <div class="drawer-body" id="drawerBody"></div><div class="drawer-foot" id="drawerFoot"></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeDrawer();
    });
  }
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = body;
  $('#drawerFoot').innerHTML = foot;
  // a timeout (not rAF) so backgrounded tabs also slide the drawer in
  setTimeout(() => {
    $('#drawer').classList.add('open');
    $('#drawerOverlay').classList.add('open');
  }, 50);
  return el;
}
function closeDrawer() {
  const el = $('#drawer');
  if (el) el.classList.remove('open');
  $('#drawerOverlay').classList.remove('open');
}
$('#drawerOverlay').addEventListener('click', closeDrawer);

/* ------------------------------ NOTIFICATIONS + LIVE HUB ------------------------------ */
/* The platform listens to its own notifications AND (through the SSE /api/live
   channel) to every change happening inside the three member systems. */
const live = {
  stream: null, connected: false, items: [], seen: new Set(), unreadLive: 0, retry: 0
};

function liveItem(ev) {
  return `
    <div class="notif-item live ${live.seen.has(ev.id) ? '' : 'unread'}">
      <span class="chip live" style="--c:${ev.colour || 'var(--purple)'}"></span>
      <div style="min-width:0">
        <b>${esc(ev.title)}</b>
        <small>${esc(ev.body || '')} · ${ago(ev.at)}</small>
      </div>
    </div>`;
}

function renderLiveFeed() {
  $('#notifPanel').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)">
      <b style="font-size:12px">Live</b>
      <span class="live-pill ${live.connected ? 'ok' : ''}">${live.connected ? 'connected' : 'connecting'}</span>
      <div style="flex:1"></div>
      <button class="btn sm ghost" id="markAllRead">Clear all</button>
    </div>
    ${live.items.length ? live.items.slice(0, 24).map(liveItem).join('') : '<div class="empty">Listening to the systems…</div>'}
    ${S.notifications.length ? `<div class="nav-label" style="padding:10px 14px 4px">Earlier</div>
      ${S.notifications.map(n => `
        <div class="notif-item ${n.read_at ? '' : 'unread'}">
          <span class="chip ${n.module === 'tickets' ? 'info' : n.module === 'hiring' ? 'purple' : 'mute'}" style="height:18px"></span>
          <div style="min-width:0"><b>${esc(n.title)}</b><small>${esc(n.body || '')} · ${ago(n.created_at)}</small></div>
        </div>`).join('')}` : ''}`;
  $('#markAllRead')?.addEventListener('click', () => {
    live.items = []; live.seen.clear(); live.unreadLive = 0;
    S.unread = 0; $('#notifDot').hidden = true;
    renderLiveFeed();
  });
}

function pushLive(ev) {
  const key = ev.id || `${ev.module}|${ev.title}|${ev.at}`;
  if (live.seen.has(key)) return;
  live.seen.add(key);
  if (live.seen.size > 400) live.seen = new Set([...live.seen].slice(-200));
  live.items.unshift(ev);
  if (live.items.length > 120) live.items.length = 120;

  /* toast only if the panel is closed (opening the bell shows everything inline) */
  const panelOpen = $('#notifPanel').classList.contains('open');
  if (!panelOpen) {
    live.unreadLive++; S.unread = (S.unread || 0) + 1; $('#notifDot').hidden = false;
    toastLive(ev);
  } else {
    renderLiveFeed();
  }
  /* live data, live: the open system's own refresh hook (same-origin direct call) */
  const sys = systemBy(String(ev.module || '').toLowerCase());
  try {
    console.log('[live] push:', ev.module, '→', sys?.key, 'route:', S.route, 'fn:', typeof sysFrameOf(sys?.key || '')?.contentWindow?.bkRefresh);
    if (sys && S.route === `system/${sys.key}`) {
      const w = sysFrameOf(sys.key)?.contentWindow;
      if (typeof w?.bkRefresh === 'function') w.bkRefresh(); else w?.postMessage({ type: 'bk:refresh' }, '*');
      $('#tabsbar')?.classList.add('pulse');
      setTimeout(() => $('#tabsbar')?.classList.remove('pulse'), 1600);
    }
  } catch (e) { console.error('[live] refresh nudge failed:', e.message); }
}

function toastLive(ev) {
  const el = document.createElement('div');
  el.className = 'toast live';
  el.style.setProperty('--c', ev.colour || 'var(--purple)');
  el.innerHTML = `<span class="dot"></span><span><b>${esc(ev.module)}</b> · ${esc(ev.title)}${ev.body ? `<small>${esc(ev.body)}</small>` : ''}</span>`;
  el.addEventListener('click', () => { if (ev.link) location.hash = ev.link; });
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; setTimeout(() => el.remove(), 250); }, 4600);
}

function connectLive() {
  if (!('EventSource' in window) || live.stream) return;
  const open = () => {
    live.stream = new EventSource('/api/live');
    live.stream.onopen = () => { live.connected = true; if ($('#notifPanel').classList.contains('open')) renderLiveFeed(); };
    live.stream.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.type === 'hello') {
          live.connected = true;
          for (const ev of (d.buffer || []).slice(-12)) pushLive({ ...ev, silent: true });
        } else if (d.type === 'event') {
          pushLive(d);
        }
      } catch { /* ignore malformed */ }
    };
    live.stream.onerror = () => {
      live.connected = false;
      live.stream.close(); live.stream = null;
      live.retry = Math.min(30000, (live.retry || 2000) * 2);
      setTimeout(() => { if (!live.stream) open(); }, live.retry);
    };
  };
  open();
}
$('#notifBtn').addEventListener('click', () => {
  const opening = !$('#notifPanel').classList.contains('open');
  $('#notifPanel').classList.toggle('open');
  if (opening) { live.unreadLive = 0; renderLiveFeed(); }
});

async function loadNotifications() {
  try {
    const data = await api('/api/notifications?limit=20');
    S.notifications = data.items || [];
    $('#notifDot').hidden = !((S.unread || 0) + live.unreadLive);
    renderLiveFeed();
    connectLive();
  } catch { /* ignore */
  }
}

/* ------------------------------ GLOBAL SEARCH ------------------------------ */
let searchTimer;
$('#globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (!data.results.length) return;
      openDrawer(`Search · “${q}”`, data.results.map(g => `
        <div>
          <div class="nav-label" style="padding:0 0 6px">${esc(g.label)}</div>
          <div style="display:grid;gap:4px">
            ${g.items.map(it => `
              <a class="kcard" style="cursor:pointer" data-link="${attr(it.link)}">
                <b>${esc(it.title)}</b><small>${esc(it.subtitle || '')} ${it.meta ? '· ' + esc(it.meta) : ''}</small>
              </a>`).join('')}
          </div>
        </div>`).join(''));
      $$('#drawer [data-link]').forEach(a => a.addEventListener('click', () => {
        closeDrawer();
        location.hash = a.dataset.link;
      }));
    } catch { /* ignore */ }
  }, 320);
});

/* ------------------------------ SYSTEM WORKSPACES ------------------------------ */
/* Each member system runs COMPLETE inside the platform shell (own UI, own data)
   through /sys/<key> — the platform's transparent proxy. A floating tab bar
   mirrors each system's internal sections in both directions (click a tab →
   the system switches; switch inside the system → the tab bar follows). */

/** URL for a system tab (roster pages live behind hashes, hiring honours
 *  ?layout=, the ticketing portal and admin are separate pages). */
function sysUrl(sys, tab) {
  const base = `/sys/${sys.key}/`;
  if (sys.key === 'roster')   return base + (tab && tab !== 'dashboard' ? `#${tab}` : '');
  if (sys.key === 'hiring')   return base + (tab === 'kanban' ? '?layout=kanban' : '');
  if (sys.key === 'tickets')  return base + (tab === 'admin' ? 'admin.html' : '');
  return base;
}

const sysFrameOf = (key) => document.getElementById(`sysFrame-${key}`);

function showSystemView(sysKey) {
  $('#view').hidden = true; // native page container
  $('#sysStage').hidden = false;
  $('#sysHost').hidden = false;
  $('#sysHost').className = `sys-host c-${sysKey || ''}`;
  renderTabsbar(systemBy(sysKey), S.sysTab?.[sysKey]);
}

function hideSystemView() {
  $('#sysStage').hidden = true;
  $('#view').hidden = false;
  $('#tabsbar').hidden = true;
  $('#tabsbar').innerHTML = '';
}

/** Build (once) and (re)mount the iframe that runs the system. */
function mountFrame(sys) {
  const host = $('#sysHost');
  let frame = sysFrameOf(sys.key);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = `sysFrame-${sys.key}`;
    frame.title = sys.label;
    frame.allow = 'camera; clipboard-write; fullscreen';
    frame.setAttribute('referrerpolicy', 'same-origin');
    const loader = document.createElement('div');
    loader.className = 'sys-loading';
    loader.id = `sysLoading-${sys.key}`;
    loader.innerHTML = `<div class="sys-load-ring"></div><span>Connecting to ${esc(sys.label)}…</span>`;
    host.appendChild(loader);
    frame.addEventListener('load', () => loader.remove());
    frame.addEventListener('error', () => loader.remove());
    host.appendChild(frame);
  } else {
    const kept = frame; // preserved across render — browser keeps it in the document
    return kept;
  }
  return frame;
}

function renderTabsbar(sys, active) {
  const bar = $('#tabsbar');
  /* systems without internal tabs (single-view apps) get no floating bar */
  if (!sys.tabs.length) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  bar.style.setProperty('--c', sys.colour);
  bar.innerHTML = `
    <span class="tabs-sys">${icon(sys.icon)}<b>${esc(sys.label)}</b></span>
    <span class="tabs-sep"></span>
    ${sys.tabs.map(t => `
      <button type="button" class="tabs-tab ${t.id === active ? 'on' : ''}" data-sys="${sys.key}" data-tab="${t.id}">
        ${esc(t.label)}
      </button>`).join('')}
    <div class="flex:1"></div>
    <a class="tabs-open" href="${attr(sysUrl(sys, active))}" target="_blank" title="Open ${esc(sys.label)} full screen">
      ${icon('arrow')}<span>Full view</span>
    </a>`;
}

function setSystemTab(sys, tab, { fromFrame = false } = {}) {
  S.sysTab[sys.key] = tab;
  if (!fromFrame) {
    const frame = sysFrameOf(sys.key);
    if (frame) {
      try {
        const win = frame.contentWindow;
        if (sys.key === 'roster' && win) win.location.hash = tab === 'dashboard' ? '' : `#${tab}`;
        else if (sys.key === 'hiring' && win) win.postMessage({ type: 'bk:setView', view: tab }, '*');
        else frame.src = sysUrl(sys, tab); // ticketing portal ⇄ admin page
      } catch {
        frame.src = sysUrl(sys, tab);
      }
    }
  } else if (sys.key === 'tickets') {
    const frame = sysFrameOf(sys.key);
    if (frame) frame.src = sysUrl(sys, tab);
  }
  renderTabsbar(sys, tab);
  const base = `#/system/${sys.key}`;
  const first = tab === sys.tabs[0]?.id;
  const next = first ? base : `${base}?tab=${tab}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

/** Main view for every member system: floating tab bar + embedded workspace. */
function viewSystem(_view, sys) {
  if (!sys) return;
  showSystemView(sys.key); // native container hides; the embed stage shows

  /* Returning to a system resumes it exactly where the user left it —
     only an EXPLICIT ?tab=… in the URL moves the frame.
     NB: detect first mount BEFORE calling mountFrame (it creates the frame). */
  const mounted = !sysFrameOf(sys.key);
  const frame = mountFrame(sys);
  setActiveFrame(sys); // exactly one visible frame in the persistent host

  const explicit = sys.tabs.length && S.params.tab && sys.tabs.some(t => t.id === S.params.tab)
    ? S.params.tab
    : null;
  if (mounted) {
    S.sysTab[sys.key] = explicit || sys.tabs[0]?.id;
    frame.src = sysUrl(sys, S.sysTab[sys.key]);
  } else if (explicit && explicit !== S.sysTab[sys.key]) {
    setSystemTab(sys, explicit); // deep link: jump inside the running system
  }
  S.sysTab[sys.key] = S.sysTab[sys.key] || sys.tabs[0]?.id;
  renderTabsbar(sys, S.sysTab[sys.key]);

  $('#tabsbar').onclick = (e) => {
    const b = e.target.closest('.tabs-tab[data-tab]');
    if (b) setSystemTab(sys, b.dataset.tab);
  };
}

/* exactly ONE visible iframe inside the persistent host (hidden frames stay alive) */
function setActiveFrame(sys) {
  const host = $('#sysHost');
  if (!host) return;
  const active = `sysFrame-${sys.key}`;
  for (const el of [...host.children]) {
    if (el.tagName === 'IFRAME') el.hidden = el.id !== active;
    else if (el.classList?.contains('sys-loading')) el.hidden = el.id !== `sysLoading-${sys.key}`;
  }
}

/* first visit in this app session (before the system's iframe exists) */
function isFirstMount(sys) {
  return !sysFrameOf(sys.key);
}

/* the embedded systems report their own navigation ("the tab bar follows along") */
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data || {};
  if (d.type !== 'fb:tab' || !d.sys) return;
  const sys = systemBy(d.sys);
  const tab = String(d.tab || '');
  if (!sys || !sys.tabs.some(t => t.id === tab) || S.route !== `system/${sys.key}`) return;
  if (S.sysTab[sys.key] === tab) return;
  setSystemTab(sys, tab, { fromFrame: true });
  for (const b of $$('#tabsbar .tabs-tab')) b.classList.toggle('on', b.dataset.tab === tab);
});
/* ------------------------------ REPORTS ------------------------------ */
async function viewReports(root) {
  const [dash, fines] = await Promise.all([api('/api/dashboard'), api('/api/roster/fines')]);
  const branches = (dash.trend || []).reduce((s, d) => s + d.present, 0);
  root.innerHTML = `
    <div class="stats">
      ${statCard({ label: 'Attendance (7d)', value: branches, icon: 'chart', colour: 'var(--turq)', foot: 'present marks' })}
      ${statCard({ label: 'Open tickets', value: (dash.tickets?.open || 0) + (dash.tickets?.progress || 0), icon: 'ticket', colour: 'var(--info)', foot: `${dash.tickets?.resolved || 0} resolved` })}
      ${statCard({ label: 'Hired', value: dash.hiring?.hired || 0, icon: 'hire', colour: 'var(--ok)', foot: `${dash.hiring?.total || 0} candidates` })}
      ${statCard({ label: 'Fines (30d)', value: fines.rows.reduce((s, r) => s + (r.total || 0), 0), icon: 'alert', colour: 'var(--bad)', foot: 'EGP' })}
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Attendance trend</h2></div>
        <div class="card-body"><div class="table-wrap"><table class="tbl">
          <thead><tr><th>Day</th><th>Present</th><th>Late</th><th>Absent</th></tr></thead>
          <tbody>${(dash.trend || []).map(d => `<tr><td>${fmtDate(d.date)}</td><td class="num">${d.present}</td><td class="num">${d.late}</td><td class="num">${d.absent}</td></tr>`).join('')}</tbody>
        </table></div></div></div>
      <div class="card"><div class="card-head"><h2>Top fines (30 days)</h2></div>
        <div class="card-body"><div class="table-wrap"><table class="tbl">
          <thead><tr><th>Employee</th><th>Branch</th><th>Days</th><th>Total</th></tr></thead>
          <tbody>${fines.rows.slice(0, 8).map(r => `<tr><td class="strong">${esc(r.name)}</td><td>${esc(r.branch)}</td><td class="num">${r.days}</td><td class="num">${r.total} EGP</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">No fines</div></td></tr>'}</tbody>
        </table></div></div></div>
    </div>`;
}

/* ------------------------------ TEAM ------------------------------ */
async function viewTeam(root) {
  const data = await api('/api/users');
  const roleLabel = (k) => (data.roles || []).find(r => r.key === k)?.label || k;
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Users</h2><div style="flex:1"></div>
        <button class="btn primary sm" id="newUser">${icon('plus')} Add user</button></div>
      <div class="card-body"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Permissions</th><th>Last login</th><th></th></tr></thead>
        <tbody>${data.users.map(u => `<tr>
          <td><div style="display:flex;align-items:center;gap:9px">
            <span class="avatar" style="width:28px;height:28px;font-size:11px;background:${esc(u.avatar_color || '#7C5CFF')}">${initials(u.name)}</span>
            <div><span class="strong">${esc(u.name)}</span><br><small style="color:var(--text-3)">${esc(u.email)}</small></div></div></td>
          <td><span class="chip purple">${esc(roleLabel(u.role))}</span></td>
          <td>${u.status === 'active' ? '<span class="chip ok">active</span>' : '<span class="chip bad">suspended</span>'}</td>
          <td><span class="num" title="${attr(u.permissions.map(p => PERM_LABELS[p] || p).join(' · '))}">${u.permissions.length}</span></td>
          <td>${u.last_login_at ? ago(u.last_login_at) : 'never'}</td>
          <td><button class="btn sm" data-edit="${u.id}">Edit</button></td>
        </tr>`).join('')}</tbody></table></div></div>
    </div>`;
  $('#newUser')?.addEventListener('click', () => userForm(null, data, () => viewTeam(root)));
  $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => {
    userForm(data.users.find(u => u.id === b.dataset.edit), data, () => viewTeam(root));
  }));
}

const PERM_LABELS = {
  'dashboard.view': 'Dashboard',
  'roster.view': 'Roster · view', 'roster.manage': 'Roster · manage', 'attendance.manage': 'Attendance · mark',
  'hiring.view': 'Hiring · view', 'hiring.manage': 'Hiring · manage', 'hiring.convert': 'Hiring · convert',
  'tickets.view': 'Tickets · view', 'tickets.manage': 'Tickets · manage',
  'reports.view': 'Reports', 'team.manage': 'Team · manage', 'settings.manage': 'Settings', 'audit.view': 'Audit log'
};
const PERM_GROUPS = [
  ['Roster & Attendance', ['roster.view', 'roster.manage', 'attendance.manage']],
  ['Hiring', ['hiring.view', 'hiring.manage', 'hiring.convert']],
  ['DAS Ticketing', ['tickets.view', 'tickets.manage']],
  ['Platform', ['dashboard.view', 'reports.view', 'team.manage', 'settings.manage', 'audit.view']]
];

const genPassword = () => {
  const words = ['Bankai', 'Rawahel', 'Courier', 'Shift', 'Dynamo'], yr = new Date().getFullYear();
  const w = words[Math.floor(Math.random() * words.length)];
  const x = Math.floor(Math.random() * 90) + 10;
  const s = '!@#$%'.charAt(Math.floor(Math.random() * 5));
  return `${w}${x}${yr % 100}${s}`;
};

function userForm(user, data, done) {
  const isNew = !user;
  const roleOfThis = data.roles.find(r => r.key === (user?.role || ''));

  openDrawer(isNew ? 'Add user' : `Edit · ${user.name}`, `
    <div class="field"><label>Name</label><input class="input" id="uName" value="${attr(user?.name || '')}" placeholder="Full name" /></div>
    <div class="field"><label>Email</label><input class="input" id="uEmail" type="email" value="${attr(user?.email || '')}" placeholder="name@company.com" ${isNew ? '' : 'disabled'} /></div>
    <div class="field">
      <label>${isNew ? 'Password' : 'New password (optional)'}</label>
      <div style="display:flex;gap:6px">
        <input class="input" id="uPass" type="text" value="${isNew ? genPassword() : ''}"
               placeholder="${isNew ? 'auto-generated — edit or keep' : 'leave empty to keep current'}" ${isNew ? '' : ''} />
        <button class="btn sm" id="uGen" title="Generate another" style="flex:none">${icon('spark')}</button>
      </div>
      <small style="color:var(--text-3);font-size:11px">min 8 characters · copy it right after creating (it is not shown again).</small>
    </div>
    <div class="field"><label>Role</label><select class="input" id="uRole">
      ${data.roles.map(r => `<option value="${r.key}" ${user?.role === r.key ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Status</label><select class="input" id="uStatus">
      <option value="active" ${user?.status !== 'suspended' ? 'selected' : ''}>Active</option>
      <option value="suspended" ${user?.status === 'suspended' ? 'selected' : ''}>Suspended</option>
    </select></div>
    <div>
      <div style="display:flex;align-items:center;gap:8px;padding:0 0 8px">
        <b style="font-size:12px">Permissions</b>
        <button class="btn sm ghost" id="uRoleDefaults" title="Check exactly this role's permissions">Load ${esc((user?.role ? data.roles.find(r => r.key === user.role)?.label : data.roles.find(r => r.key === $('#uRole')?.value)?.label) || 'role')} defaults</button>
      </div>
      <div style="display:grid;gap:10px">
        ${PERM_GROUPS.map(([label, perms]) => `
          <div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px">
            <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-3);padding-bottom:6px">${esc(label)}</div>
            <div style="display:grid;gap:5px">
              ${perms.map(p => { const on = isNew ? roleOfThis?.permissions?.includes(p) : user?.permissions?.includes(p); return `
                <label style="display:flex;gap:9px;align-items:center;font-size:12.5px;color:var(--text-2)">${PERM_LABELS[p] || p}
                  <input type="checkbox" data-perm="${p}" ${on ? 'checked' : ''} style="margin-inline-start:auto;accent-color:var(--purple);width:15px;height:15px" />
                </label>`; }).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="uSave">${isNew ? 'Create user' : 'Save'}</button>`);

  // refresh the "Load defaults" label whenever the role changes (initial sync too)
  const roleSel = $('#uRole');
  const genBtn = $('#uGen');
  const syncRoleLabel = () => { const r = data.roles.find(x => x.key === roleSel.value); if (r) $('#uRoleDefaults').textContent = `Load ${r.label} defaults`; };
  roleSel.addEventListener('change', syncRoleLabel);
  genBtn.addEventListener('click', () => { $('#uPass').value = genPassword(); });
  syncRoleLabel();

  $('#uRoleDefaults').addEventListener('click', () => {
    const role = data.roles.find(r => r.key === roleSel.value);
    $$('[data-perm]').forEach(cb => { cb.checked = !!role.permissions.includes(cb.dataset.perm); });
    toast(`Loaded ${role.label} permissions`);
  });

  const collectOverrides = () => $$('#drawer [data-perm]').map(cb => ({ perm: cb.dataset.perm, allowed: cb.checked }));

  $('#uSave').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const name = $('#uName').value.trim();
    const pass = $('#uPass').value;
    if (name.length < 2) { toast('Name is too short.', 'err'); return; }
    if (isNew && pass.length < 8) { toast('Password must be at least 8 characters.', 'err'); return; }
    if (!isNew && pass && pass.length < 8) { toast('New password must be at least 8 characters.', 'err'); return; }
    btn.disabled = true;
    try {
      let created = user;
      if (isNew) {
        const res = await api('/api/users', { method: 'POST', body: { name, email: $('#uEmail').value.trim(), password: pass, role: roleSel.value } });
        created = res.user;
        // permissions chosen at creation are applied as overrides on the fresh record
        const overrides = collectOverrides();
        const rolePerms = data.roles.find(r => r.key === roleSel.value).permissions;
        const differs = overrides.filter(o => rolePerms.includes(o.perm) !== o.allowed);
        if (differs.length) await api(`/api/users/${created.id}`, { method: 'PATCH', body: { overrides } });
        try { await navigator.clipboard.writeText(pass); toast(`User created — password copied: ${pass}`); }
        catch { toast('User created — copy the password from the form before closing'); }
      } else {
        const body = { name, role: roleSel.value, status: $('#uStatus').value };
        if (pass) body.password = pass;
        body.overrides = collectOverrides();
        await api(`/api/users/${user.id}`, { method: 'PATCH', body });
        toast(pass ? 'User updated — share the new password securely' : 'User updated');
      }
      closeDrawer(); done?.(); loadNotifications();
    } catch { btn.disabled = false; }
  });
}

/* ------------------------------ SETTINGS ------------------------------ */
async function viewSettings(root) {
  const s = await api('/api/settings');
  root.innerHTML = `
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Profile</h2></div>
        <div class="card-body" style="display:grid;gap:12px">
          <div style="display:flex;gap:12px;align-items:center">
            <span class="avatar" style="width:48px;height:48px;font-size:17px;background:${esc(S.user.avatar_color || '#7C5CFF')}">${initials(S.user.name)}</span>
            <div><b>${esc(S.user.name)}</b><div style="color:var(--text-3);font-size:12px">${esc(S.user.email)}</div>
              <div style="margin-top:4px"><span class="chip purple">${esc(S.user.role.replace('_', ' '))}</span></div></div>
          </div>
          <div class="field"><label>Current password</label><input class="input" type="password" id="pwCurrent" /></div>
          <div class="field"><label>New password</label><input class="input" type="password" id="pwNext" placeholder="At least 8 characters" /></div>
          <button class="btn primary" id="pwSave" style="justify-self:start">Update password</button>
        </div></div>

      <div class="card"><div class="card-head"><h2>Experience</h2></div>
        <div class="card-body" style="display:grid;gap:14px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="flex:1"><b style="font-size:13px">Cinematic intro</b>
              <div style="color:var(--text-3);font-size:11.5px">Replay the opening sequence.</div></div>
            <button class="btn" id="replayIntro">Replay</button>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <div style="flex:1"><b style="font-size:13px">Notifications</b>
              <div style="color:var(--text-3);font-size:11.5px">In-app alerts for hiring, attendance and tickets.</div></div>
            <label class="chip ${s.notifications ? 'ok' : 'mute'}" style="cursor:pointer">
              <input type="checkbox" id="notifToggle" ${s.notifications ? 'checked' : ''} style="accent-color:#7C5CFF" />
              ${s.notifications ? 'On' : 'Off'}
            </label>
          </div>
        </div></div>
    </div>

    <div class="card"><div class="card-head"><h2>System</h2></div>
      <div class="card-body"><dl class="kv">
        <dt>Version</dt><dd>${esc(s.system.version)}</dd>
        <dt>Environment</dt><dd>${esc(s.system.env)}</dd>
        <dt>Roster</dt><dd>${s.system.modules.roster ? '<span class="chip ok">connected</span>' : '<span class="chip bad">offline</span>'}</dd>
        <dt>Hiring</dt><dd>${s.system.modules.hiring ? '<span class="chip ok">connected</span>' : '<span class="chip bad">offline</span>'}</dd>
        <dt>Ticketing</dt><dd>${s.system.modules.ticketing ? '<span class="chip ok">connected</span>' : '<span class="chip bad">offline</span>'}</dd>
      </dl></div></div>`;

  $('#replayIntro').addEventListener('click', () => intro.play({ force: true }));
  $('#notifToggle').addEventListener('change', async (e) => {
    await api('/api/settings', { method: 'PUT', body: { notifications: e.target.checked } });
    toast(`Notifications ${e.target.checked ? 'on' : 'off'}`);
    viewSettings(root);
  });
  $('#pwSave').addEventListener('click', async () => {
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: $('#pwCurrent').value, next: $('#pwNext').value } });
      toast('Password updated — please sign in again');
      S.user = null; showLogin();
    } catch { /* handled */ }
  });
}

/* ------------------------------ MISC ------------------------------ */
function debounce(fn, ms = 260) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#refreshBtn').addEventListener('click', () => { renderRoute(); loadNotifications(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDrawer(); $('#notifPanel').classList.remove('open'); $('#sidebar').classList.remove('open'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#globalSearch').focus(); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) $('#notifPanel').classList.remove('open');
});

/* ------------------------------ BOOT ------------------------------ */
(async function boot() {
  /* Cinematic intro on every visit — but the session never waits for it:
     auth runs in parallel, whatever resolves later is revealed first. */
  const appReady = (async () => {
    try {
      const me = await api('/api/auth/me', { quiet: true });
      setSession(me.user, me.csrf);
      showApp();
      navigate(location.hash || '#/system/hiring', { replace: true });
    } catch {
      showLogin();
    }
  })();
  intro.play({ done: () => { /* app is already rendered underneath */ } });
  await appReady;
})();
