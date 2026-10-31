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
  user: null, csrf: '', perms: new Set(), route: 'overview',
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
const intro = {
  el: $('#intro'), canvas: $('#introCanvas'), raf: 0,
  seenKey: 'fb.intro.seen',
  hasSeen() { try { return localStorage.getItem(this.seenKey) === '1'; } catch { return false; } },
  markSeen() { try { localStorage.setItem(this.seenKey, '1'); } catch { /* private mode */ } },

  play({ force = false, done = () => {} } = {}) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!force && (this.hasSeen() || reduced)) { this.markSeen(); done(); return; }
    this.el.classList.remove('done');
    this.el.style.display = 'grid';
    this.startParticles(reduced);
    const finish = () => {
      this.stopParticles();
      this.markSeen();
      this.el.classList.add('done');
      setTimeout(() => { this.el.style.display = 'none'; done(); }, 650);
    };
    this.finish = finish;
    clearTimeout(this.timer);
    this.timer = setTimeout(finish, reduced ? 350 : 4200);
  },

  skip() { if (this.finish) this.finish(); },

  startParticles(reduced) {
    const c = this.canvas;
    if (!c || reduced) return;
    const ctx = c.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; };
    resize();
    const parts = Array.from({ length: 70 }, () => ({
      x: Math.random(), y: Math.random(),
      r: Math.random() * 1.8 + .4,
      vx: (Math.random() - .5) * .0006,
      vy: (Math.random() - .5) * .0006,
      hue: Math.random() > .5 ? '124,92,255' : '20,217,196'
    }));
    let t = 0;
    const step = () => {
      t += 1;
      ctx.clearRect(0, 0, c.width, c.height);
      // soft core light
      const g = ctx.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, c.width * .45);
      g.addColorStop(0, `rgba(124,92,255,${.10 + Math.sin(t / 90) * .03})`);
      g.addColorStop(.5, 'rgba(20,217,196,.04)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);

      for (const p of parts) {
        p.x = (p.x + p.vx + 1) % 1;
        p.y = (p.y + p.vy + 1) % 1;
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, p.r * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.hue},${.25 + Math.sin(t / 40 + p.x * 6) * .25})`;
        ctx.fill();
      }
      this.raf = requestAnimationFrame(step);
    };
    step();
    this.onResize = () => { resize(); };
    addEventListener('resize', this.onResize);
  },

  stopParticles() {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
  }
};

$('#introSkip').addEventListener('click', () => intro.skip());

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
    navigate(location.hash || '#/overview', { replace: true });
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
const ROUTES = [
  { id: 'overview', label: 'Overview', icon: 'grid', perm: 'dashboard.view' },
  { id: 'roster', label: 'Roster & Attendance', icon: 'users', perm: 'roster.view' },
  { id: 'hiring', label: 'Hiring', icon: 'hire', perm: 'hiring.view' },
  { id: 'tickets', label: 'DAS Ticketing', icon: 'ticket', perm: 'tickets.view' },
  { id: 'reports', label: 'Reports', icon: 'chart', perm: 'reports.view' },
  { id: 'team', label: 'Team', icon: 'team', perm: 'team.manage' },
  { id: 'settings', label: 'Settings', icon: 'settings', perm: null }
];

function renderNav() {
  const visible = ROUTES.filter(r => !r.perm || S.perms.has(r.perm));
  $('#nav').innerHTML = visible.map(r => `
    <a class="nav-item ${S.route === r.id ? 'on' : ''}" href="#/${r.id}" data-route="${r.id}">
      ${icon(r.icon)}<span>${r.label}</span>
    </a>`).join('');
}

/* ------------------------------ ROUTER ------------------------------ */
const TITLES = {
  overview: ['Overview', 'Unified operations across all three systems'],
  roster: ['Roster & Attendance', 'Employees, shifts and daily attendance'],
  hiring: ['Hiring', 'Candidate pipeline and conversion'],
  tickets: ['DAS Ticketing', 'Support tickets and requests'],
  reports: ['Reports', 'Cross-system analytics'],
  team: ['Team', 'Users, roles and permissions'],
  settings: ['Settings', 'Profile, appearance and system']
};

function navigate(hash, { replace = false } = {}) {
  const [routePart, query] = String(hash || '#/overview').replace(/^#\/?/, '').split('?');
  const route = ROUTES.find(r => r.id === routePart && (!r.perm || S.perms.has(r.perm)))?.id || 'overview';
  S.params = Object.fromEntries(new URLSearchParams(query || ''));
  if (replace) history.replaceState(null, '', `#/${route}${query ? '?' + query : ''}`);
  S.route = route;
  const [title, sub] = TITLES[route] || TITLES.overview;
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  renderNav();
  closeDrawer();
  renderRoute();
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
  view.innerHTML = `<div class="card"><div class="card-body"><div class="skeleton" style="height:90px"></div></div></div>`;
  const fn = {
    overview: viewOverview, roster: viewRoster, hiring: viewHiring,
    tickets: viewTickets, reports: viewReports, team: viewTeam, settings: viewSettings
  }[S.route];
  (fn || viewOverview)(view).catch(err => {
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
  requestAnimationFrame(() => {
    $('#drawer').classList.add('open');
    $('#drawerOverlay').classList.add('open');
  });
  return el;
}
function closeDrawer() {
  const el = $('#drawer');
  if (el) el.classList.remove('open');
  $('#drawerOverlay').classList.remove('open');
}
$('#drawerOverlay').addEventListener('click', closeDrawer);

/* ------------------------------ NOTIFICATIONS ------------------------------ */
async function loadNotifications() {
  try {
    const data = await api('/api/notifications?limit=20');
    S.notifications = data.items || [];
    S.unread = data.unread || 0;
    $('#notifDot').hidden = !S.unread;
    $('#notifPanel').innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)">
        <b style="font-size:12px">Notifications</b><div style="flex:1"></div>
        <button class="btn sm ghost" id="markAllRead">Mark all read</button>
      </div>
      ${S.notifications.length ? S.notifications.map(n => `
        <div class="notif-item ${n.read_at ? '' : 'unread'}">
          <span class="chip ${n.module === 'tickets' ? 'turq' : n.module === 'hiring' ? 'purple' : 'mute'}" style="height:18px"></span>
          <div style="min-width:0">
            <b>${esc(n.title)}</b>
            <small>${esc(n.body || '')} · ${ago(n.created_at)}</small>
          </div>
        </div>`).join('') : '<div class="empty">No notifications yet</div>'}`;
    $('#markAllRead')?.addEventListener('click', async () => {
      const r = await api('/api/notifications/read', { method: 'POST', body: {} });
      S.unread = r.unread; $('#notifDot').hidden = !S.unread; loadNotifications();
    });
  } catch { /* ignore */ }
}
$('#notifBtn').addEventListener('click', () => $('#notifPanel').classList.toggle('open'));

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

/* ------------------------------ OVERVIEW ------------------------------ */
async function viewOverview(root) {
  const d = await api('/api/dashboard');
  const w = d.workforce || {}, h = d.hiring || {}, t = d.tickets || {};

  const trend = d.trend || [];
  const maxTrend = Math.max(1, ...trend.map(x => x.present + x.late + x.absent));

  root.innerHTML = `
    <div class="section-title"><h2>Workforce</h2><div class="line"></div><span class="chip turq">${d.date}</span></div>
    <div class="stats">
      ${statCard({ label: 'Employees', value: w.total, icon: 'users', colour: 'var(--turq)', foot: `<span class="pill">${w.branches || 0}</span> branches` })}
      ${statCard({ label: 'Present today', value: w.present, icon: 'check', colour: 'var(--ok)', foot: `${w.late || 0} late · ${w.absent || 0} absent` })}
      ${statCard({ label: 'Unmarked', value: w.unmarked, icon: 'clock', colour: 'var(--warn)', foot: `${w.marked || 0} / ${w.expected || 0} marked` })}
      ${statCard({ label: 'Fines today', value: w.fines || 0, icon: 'alert', colour: 'var(--bad)', foot: 'EGP' })}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Attendance · last 7 days</h2><div class="spacer" style="flex:1"></div>
          <span class="chip ok">Present</span><span class="chip warn">Late</span><span class="chip bad">Absent</span></div>
        <div class="card-body">
          <svg class="chart" viewBox="0 0 700 190" preserveAspectRatio="none" role="img" aria-label="Attendance trend">
            ${trend.map((x, i) => {
              const total = x.present + x.late + x.absent;
              const hgt = (v) => Math.round((v / maxTrend) * 140);
              const bx = 24 + i * 94;
              const p = hgt(x.present), l = hgt(x.late), a = hgt(x.absent);
              return `<g>
                <rect class="bar" x="${bx}" y="${150 - p}" width="22" height="${p}" rx="4" fill="#14D9C4" opacity=".85"/>
                <rect class="bar" x="${bx + 24}" y="${150 - l}" width="22" height="${l}" rx="4" fill="#F59E0B" opacity=".85"/>
                <rect class="bar" x="${bx + 48}" y="${150 - a}" width="22" height="${a}" rx="4" fill="#EF4444" opacity=".8"/>
                <text x="${bx + 35}" y="172" text-anchor="middle" fill="#6E6D85" font-size="10">${x.label}</text>
                <text x="${bx + 35}" y="${140 - Math.max(p, l, a)}" text-anchor="middle" fill="#A7A6BC" font-size="9">${total}</text>
              </g>`;
            }).join('')}
          </svg>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Hiring pipeline</h2></div>
        <div class="card-body">
          ${Object.entries(h.byStatus || {}).map(([k, v]) => `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
              <span style="width:104px;font-size:11.5px;color:var(--text-2)">${esc(k)}</span>
              <div style="flex:1;height:7px;border-radius:99px;background:rgba(255,255,255,.06);overflow:hidden">
                <i style="display:block;height:100%;width:${Math.round((v / Math.max(1, h.total)) * 100)}%;background:linear-gradient(90deg,var(--purple),var(--turq))"></i>
              </div>
              <b style="font-size:12px;width:24px;text-align:end">${v}</b>
            </div>`).join('') || '<div class="empty">No candidates yet</div>'}
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
            <span class="chip purple">${h.total || 0} total</span>
            <span class="chip turq">${h.newThisWeek || 0} new this week</span>
            <span class="chip ok">${h.hired || 0} hired</span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-3">
      ${statCard({ label: 'Candidates', value: h.total, icon: 'hire', colour: 'var(--purple)', foot: `${h.newThisWeek || 0} new this week` })}
      ${statCard({ label: 'Open tickets', value: t.open + (t.progress || 0) + (t.action || 0), icon: 'ticket', colour: 'var(--turq)', foot: `${t.resolved || 0} resolved` })}
      ${statCard({ label: 'Overdue', value: t.overdue || 0, icon: 'alert', colour: 'var(--bad)', foot: 'older than 3 days' })}
    </div>

    <div class="card">
      <div class="card-head"><h2>Recent activity</h2><div style="flex:1"></div>
        <button class="btn sm ghost" id="refreshFeed">${icon('refresh')} Refresh</button></div>
      <div class="card-body feed">
        ${(d.activity || []).map(a => `
          <div class="feed-item">
            <span class="dot" style="background:${a.kind === 'ticket' ? 'var(--turq)' : a.kind === 'candidate' ? 'var(--purple)' : 'var(--text-3)'}"></span>
            <span class="t">${a.kind === 'audit'
              ? `<b>${esc(a.user_email || 'system')}</b> · ${esc(a.action)} ${a.entity ? `<span style="color:var(--text-3)">${esc(a.entity)}</span>` : ''}`
              : a.kind === 'candidate'
                ? `New candidate <b>${esc(a.title)}</b> <span style="color:var(--text-3)">${esc(a.subtitle || '')}</span>`
                : `Ticket <b>${esc(a.title)}</b> <span style="color:var(--text-3)">${esc(a.subtitle || '')}</span>`}</span>
            <time>${ago(a.createdAt || a.created_at)}</time>
          </div>`).join('') || '<div class="empty">No activity yet</div>'}
      </div>
    </div>`;

  $('#refreshFeed')?.addEventListener('click', renderRoute);
}

/* ------------------------------ ROSTER ------------------------------ */
const rosterState = { q: '', branch: '', shift: '', page: 1, date: new Date().toISOString().slice(0, 10) };

async function viewRoster(root) {
  const [meta, data, att] = await Promise.all([
    S.cache.rosterMeta ? Promise.resolve(S.cache.rosterMeta) : api('/api/roster/meta'),
    api(`/api/roster/employees?q=${encodeURIComponent(rosterState.q)}&branch=${encodeURIComponent(rosterState.branch)}&shift=${encodeURIComponent(rosterState.shift)}&page=${rosterState.page}&pageSize=12`),
    api(`/api/roster/attendance?date=${rosterState.date}`)
  ]);
  S.cache.rosterMeta = meta;
  const marked = new Map((att.marked || []).map(m => [String(m.employeeId), m]));
  const m = att.metrics || {};

  root.innerHTML = `
    <div class="stats">
      ${statCard({ label: 'Employees', value: m.total, icon: 'users', colour: 'var(--turq)', foot: `${m.branches || 0} branches` })}
      ${statCard({ label: 'Present', value: m.present, icon: 'check', colour: 'var(--ok)', foot: `${m.marked || 0} marked` })}
      ${statCard({ label: 'Late', value: m.late, icon: 'clock', colour: 'var(--warn)', foot: `${m.absent || 0} absent` })}
      ${statCard({ label: 'Unmarked', value: m.unmarked, icon: 'alert', colour: 'var(--purple)', foot: `${m.expected || 0} expected` })}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Employees</h2>
        <div style="flex:1"></div>
        <div class="toolbar">
          <input class="input-sm" id="rSearch" placeholder="Search name / code / phone" value="${attr(rosterState.q)}" />
          <select class="select" id="rBranch">
            <option value="">All branches</option>
            ${(meta.branches || []).map(b => `<option value="${attr(b.branch)}" ${rosterState.branch === b.branch ? 'selected' : ''}>${esc(b.branch)} (${b.n})</option>`).join('')}
          </select>
          <select class="select" id="rShift">
            <option value="">All shifts</option>
            ${(meta.shifts || []).map(s => `<option ${rosterState.shift === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="card-body">
        <div class="table-wrap">
          <table class="tbl"><thead><tr>
            <th>Employee</th><th>Code</th><th>Branch</th><th>Shift</th><th>Type</th><th>Day off</th><th>Today</th>
          </tr></thead><tbody>
            ${(data.items || []).map(e => {
              const st = marked.get(String(e.id));
              return `<tr data-emp="${e.id}" style="cursor:pointer">
                <td><div style="display:flex;align-items:center;gap:9px">
                  <span class="avatar" style="width:28px;height:28px;font-size:11px;background:linear-gradient(135deg,#7C5CFF,#14D9C4)">${initials(e.name)}</span>
                  <span class="strong">${esc(e.name)}</span></div></td>
                <td class="num">${esc(e.code || '—')}</td>
                <td>${esc(e.branch || '—')}</td>
                <td class="num">${esc(e.shift || '—')}</td>
                <td>${e.employmentType || '—'}</td>
                <td>${esc(e.dayOff || '—')}</td>
                <td>${st ? statusChip(st.status) : '<span class="chip mute">unmarked</span>'}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="7"><div class="empty"><b>No employees</b>Try another filter.</div></td></tr>'}
          </tbody></table>
        </div>
        ${pager(data)}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Attendance · ${att.date}</h2><div style="flex:1"></div>
        <input type="date" class="input-sm" id="attDate" value="${att.date}" /></div>
      <div class="card-body">
        <div class="table-wrap">
          <table class="tbl"><thead><tr><th>Employee</th><th>Shift</th><th>Status</th><th>Fine</th><th>Mark</th></tr></thead><tbody>
            ${(att.marked || []).map(a => `<tr>
              <td class="strong">${esc(a.employeeName)}</td><td class="num">${esc(a.shift || '—')}</td>
              <td>${statusChip(a.status)}</td>
              <td class="num">${a.fine ? a.fine + ' EGP' : '—'}</td>
              <td>${attButtons(a.employeeId)}</td>
            </tr>`).join('')}
            ${(att.unmarked || []).map(e => `<tr>
              <td class="strong">${esc(e.name)}</td><td class="num">${esc(e.shift || '—')}</td>
              <td><span class="chip mute">unmarked</span></td><td>—</td>
              <td>${attButtons(e.id)}</td>
            </tr>`).join('')}
            ${(att.marked || []).length + (att.unmarked || []).length ? '' : '<tr><td colspan="5"><div class="empty">Nobody expected today</div></td></tr>'}
          </tbody></table>
        </div>
      </div>
    </div>`;

  $('#rSearch')?.addEventListener('input', debounce(() => {
    rosterState.q = $('#rSearch').value; rosterState.page = 1; viewRoster(root);
  }, 280));
  $('#rBranch')?.addEventListener('change', (e) => { rosterState.branch = e.target.value; rosterState.page = 1; viewRoster(root); });
  $('#rShift')?.addEventListener('change', (e) => { rosterState.shift = e.target.value; rosterState.page = 1; viewRoster(root); });
  $('#attDate')?.addEventListener('change', (e) => { rosterState.date = e.target.value; viewRoster(root); });
  wirePager(root, data, (p) => { rosterState.page = p; viewRoster(root); });

  $$('[data-emp]', root).forEach(tr => tr.addEventListener('click', () => openEmployee(tr.dataset.emp)));
  $$('[data-mark]', root).forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const { emp, mark } = b.dataset;
    const status = mark;
    try {
      await api('/api/roster/attendance', { method: 'POST', body: { employeeId: Number(emp), date: rosterState.date, status, fine: status === 'Late' ? 25 : status === 'Absent' ? 50 : 0 } });
      toast(`${status} saved`);
      viewRoster(root);
    } catch { /* toast shown */ }
  }));
}

function attButtons(employeeId) {
  return `<div style="display:flex;gap:4px;flex-wrap:wrap">
    ${['Present', 'Late', 'Absent', 'Excused'].map(s => `<button class="btn sm" data-mark="${s}" data-emp="${employeeId}" style="padding:4px 8px;font-size:10.5px">${s[0]}</button>`).join('')}
  </div>`;
}

async function openEmployee(id) {
  const data = await api(`/api/roster/employees/${id}`);
  const e = data.employee;
  openDrawer(e.name, `
    <div style="display:flex;gap:14px;align-items:center">
      <span class="avatar" style="width:52px;height:52px;font-size:18px;background:linear-gradient(135deg,#7C5CFF,#14D9C4)">${initials(e.name)}</span>
      <div><b style="font-size:15px">${esc(e.name)}</b><div style="color:var(--text-3);font-size:12px">${esc(e.code || '')} · ${esc(e.branch || '')}</div></div>
    </div>
    <dl class="kv">
      <dt>Employee code</dt><dd>${esc(e.code || '—')}</dd>
      <dt>Branch</dt><dd>${esc(e.branch || '—')}</dd>
      <dt>Shift</dt><dd>${esc(e.shift || '—')}</dd>
      <dt>Type</dt><dd>${e.employmentType === 'PT' ? 'Part Time' : 'Full Time'}</dd>
      <dt>Day off</dt><dd>${esc(e.dayOff || '—')}</dd>
      <dt>Phone</dt><dd>${esc(e.phone || '—')}</dd>
      <dt>Status</dt><dd>${e.active ? '<span class="chip ok">Active</span>' : '<span class="chip mute">Inactive</span>'}</dd>
    </dl>`);
}

/* ------------------------------ HIRING ------------------------------ */
const hiringState = { q: '', status: '', mode: 'board' };

async function viewHiring(root) {
  const [metrics, list] = await Promise.all([
    api('/api/hiring/metrics'),
    api(`/api/hiring/candidates?q=${encodeURIComponent(hiringState.q)}&status=${encodeURIComponent(hiringState.status)}&pageSize=60`)
  ]);
  const byStatus = {};
  for (const c of list.items || []) (byStatus[c.status] = byStatus[c.status] || []).push(c);
  const stages = ['OnBoarding', 'Attended to D0', 'Active', 'Inactive', 'OffBoarding'];

  root.innerHTML = `
    <div class="stats">
      ${statCard({ label: 'Candidates', value: metrics.total, icon: 'hire', colour: 'var(--purple)', foot: `${metrics.newThisWeek || 0} new this week` })}
      ${statCard({ label: 'Hired', value: metrics.hired, icon: 'check', colour: 'var(--ok)', foot: 'Active + D0' })}
      ${statCard({ label: 'On boarding', value: metrics.byStatus?.OnBoarding || 0, icon: 'clock', colour: 'var(--warn)', foot: 'in pipeline' })}
      ${statCard({ label: 'Licence ≤ 30d', value: metrics.licenseExpiring || 0, icon: 'alert', colour: 'var(--bad)', foot: 'need renewal' })}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Recruitment pipeline</h2><div style="flex:1"></div>
        <input class="input-sm" id="hSearch" placeholder="Search candidates" value="${attr(hiringState.q)}" />
        <select class="select" id="hStatus">
          <option value="">All stages</option>
          ${stages.map(s => `<option ${hiringState.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="card-body">
        <div class="board">
          ${stages.map(stage => `
            <section class="col" data-stage="${attr(stage)}">
              <header class="col-head"><span class="dot" style="width:7px;height:7px;border-radius:99px;background:${stageColour(stage)}"></span>
                <b>${esc(stage)}</b><span class="n">${(byStatus[stage] || []).length}</span></header>
              <div class="col-body">
                ${(byStatus[stage] || []).map(c => `
                  <article class="kcard" draggable="true" data-cand="${attr(c.id)}">
                    <b>${esc(c.fullName)}</b>
                    <small>${esc(c.nationalId)}</small>
                    <div class="row">
                      <span class="chip mute">${esc(c.branch)}</span>
                      <span class="chip ${c.employmentType === 'Full Time' ? 'purple' : 'turq'}">${c.employmentType === 'Full Time' ? 'FT' : 'PT'}</span>
                    </div>
                  </article>`).join('') || '<div class="empty" style="padding:14px">Drop here</div>'}
              </div>
            </section>`).join('')}
        </div>
      </div>
    </div>`;

  $('#hSearch')?.addEventListener('input', debounce(() => { hiringState.q = $('#hSearch').value; viewHiring(root); }, 280));
  $('#hStatus')?.addEventListener('change', (e) => { hiringState.status = e.target.value; viewHiring(root); });

  $$('[data-cand]', root).forEach(card => {
    card.addEventListener('click', () => openCandidate(card.dataset.cand, () => viewHiring(root)));
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.cand);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  $$('.col', root).forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault(); col.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      try {
        await api(`/api/hiring/candidates/${id}/status`, { method: 'POST', body: { status: col.dataset.stage } });
        toast(`Moved to ${col.dataset.stage}`);
        viewHiring(root);
      } catch { /* handled */ }
    });
  });
}

const stageColour = (s) => ({
  OnBoarding: '#7C5CFF', 'Attended to D0': '#3B82F6', Active: '#22C55E', Inactive: '#6E6D85', OffBoarding: '#EF4444'
}[s] || '#7C5CFF');

async function openCandidate(id, refresh) {
  const data = await api(`/api/hiring/candidates/${id}`);
  const c = data.candidate;
  const converted = data.link;
  const docs = (c.documents || []).map(d => `
    <a href="/api/hiring/documents/${d.id}" target="_blank" style="display:block;border-radius:10px;overflow:hidden;border:1px solid var(--line)">
      <img src="/api/hiring/documents/${d.id}${d.hasThumb ? '?thumb=1' : ''}" alt="${attr(d.kind)}" style="width:100%;height:78px;object-fit:cover;display:block" />
      <div style="padding:5px 7px;font-size:10px;color:var(--text-3)">${esc(d.kind.replace('_', ' '))}</div>
    </a>`).join('');

  openDrawer(c.fullName, `
    <div style="display:flex;gap:14px;align-items:center">
      ${c.photo
        ? `<img src="/api/hiring/documents/${c.photo}${c.hasThumb ? '?thumb=1' : ''}" style="width:54px;height:54px;border-radius:14px;object-fit:cover" alt="" />`
        : `<span class="avatar" style="width:54px;height:54px;font-size:18px;background:linear-gradient(135deg,#7C5CFF,#14D9C4)">${initials(c.fullName)}</span>`}
      <div><b style="font-size:15px">${esc(c.fullName)}</b>
        <div style="margin-top:4px">${statusChip(c.status)}</div></div>
    </div>
    <dl class="kv">
      <dt>National ID</dt><dd class="num">${esc(c.nationalId)}</dd>
      <dt>Phone</dt><dd class="num">${esc(c.phone)}</dd>
      <dt>Branch</dt><dd>${esc(c.branch)}</dd>
      <dt>Type</dt><dd>${esc(c.employmentType)}</dd>
      <dt>Licence</dt><dd>${fmtDate(c.licenseStart)} → ${fmtDate(c.licenseEnd)}</dd>
      <dt>Plate</dt><dd>${esc(c.plate || '—')}</dd>
      <dt>Outlook</dt><dd>${esc(c.outlook || '—')}</dd>
    </dl>
    ${docs ? `<div><div class="nav-label" style="padding:0 0 6px">Documents</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${docs}</div></div>` : ''}
    ${(c.events || []).length ? `<div><div class="nav-label" style="padding:0 0 6px">History</div>
      <div class="feed">${c.events.slice(0, 8).map(e => `<div class="feed-item">
        <span class="dot" style="background:var(--purple)"></span>
        <span class="t">${e.type === 'status' ? `Status → <b>${esc(e.toStatus)}</b>` : esc(e.type)}</span>
        <time>${ago(e.createdAt)}</time></div>`).join('')}</div></div>` : ''}
    ${converted ? `<div class="chip ok" style="justify-self:start">Already an employee · #${esc(converted.right_id)}</div>` : ''}`,
    `<button class="btn" data-close>Close</button>
     ${!converted && S.perms.has('hiring.convert') && ['Attended to D0', 'Active'].includes(c.status)
        ? `<button class="btn primary" id="convertBtn">${icon('arrow')} Convert to employee</button>` : ''}`);

  $('#convertBtn')?.addEventListener('click', () => openConvert(c, data.suggestedCode, () => { closeDrawer(); refresh?.(); }));
}

function openConvert(c, suggestedCode, done) {
  openDrawer(`Convert · ${c.fullName}`, `
    <div class="chip purple" style="justify-self:start">${icon('hire')} Hiring → Roster</div>
    <p style="font-size:12.5px;color:var(--text-2);margin:0">
      A new employee record will be created in the Roster system and linked to this candidate.
      This runs once and is fully audited.</p>
    <div class="field"><label>Employee name</label><input class="input" id="cvName" value="${attr(c.fullName)}" /></div>
    <div class="field"><label>Phone</label><input class="input" id="cvPhone" value="${attr(c.phone)}" /></div>
    <div class="field"><label>Branch</label>
      <select class="input" id="cvBranch">
        <option value="QCD 1" ${c.branch === 'QCD1' ? 'selected' : ''}>QCD 1</option>
        <option value="QCD 2" ${c.branch === 'QCD2' ? 'selected' : ''}>QCD 2</option>
      </select></div>
    <div class="field"><label>Employment type</label>
      <select class="input" id="cvType">
        <option value="FT" ${c.employmentType === 'Full Time' ? 'selected' : ''}>Full Time</option>
        <option value="PT" ${c.employmentType === 'Part Time' ? 'selected' : ''}>Part Time</option>
      </select></div>
    <div class="field"><label>Shift</label><input class="input" id="cvShift" placeholder="e.g. 08:00-16:00" /></div>
    <div class="field"><label>Employee code</label><input class="input num" id="cvCode" value="${attr(suggestedCode || '')}" /></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="cvSubmit">Convert & create employee</button>`);

  $('#cvSubmit').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api(`/api/hiring/candidates/${c.id}/convert`, {
        method: 'POST',
        body: {
          branch: $('#cvBranch').value, employmentType: $('#cvType').value,
          shift: $('#cvShift').value.trim(), code: $('#cvCode').value.trim(), dayOff: 'Friday'
        }
      });
      toast(`Employee ${res.employee.code} created`);
      done?.();
      loadNotifications();
    } catch { btn.disabled = false; }
  });
}

/* ------------------------------ TICKETS ------------------------------ */
const ticketState = { q: '', bucket: '', page: 1 };

async function viewTickets(root) {
  const [metrics, data] = await Promise.all([
    api('/api/tickets/metrics'),
    api(`/api/tickets?q=${encodeURIComponent(ticketState.q)}&bucket=${encodeURIComponent(ticketState.bucket)}&page=${ticketState.page}&pageSize=12`)
  ]);

  root.innerHTML = `
    <div class="stats">
      ${statCard({ label: 'Open', value: metrics.open, icon: 'ticket', colour: 'var(--info)', foot: `${metrics.progress || 0} in review` })}
      ${statCard({ label: 'Action needed', value: metrics.action, icon: 'alert', colour: 'var(--warn)', foot: 'come to office' })}
      ${statCard({ label: 'Resolved', value: metrics.resolved, icon: 'check', colour: 'var(--ok)', foot: `of ${metrics.total}` })}
      ${statCard({ label: 'New today', value: metrics.today, icon: 'spark', colour: 'var(--turq)', foot: `${metrics.overdue || 0} overdue` })}
    </div>

    <div class="card">
      <div class="card-head"><h2>Tickets</h2><div style="flex:1"></div>
        <input class="input-sm" id="tSearch" placeholder="Search code / name / text" value="${attr(ticketState.q)}" />
        <select class="select" id="tBucket">
          <option value="">All</option>
          <option value="open" ${ticketState.bucket === 'open' ? 'selected' : ''}>Open</option>
          <option value="progress" ${ticketState.bucket === 'progress' ? 'selected' : ''}>In review</option>
          <option value="action" ${ticketState.bucket === 'action' ? 'selected' : ''}>Action needed</option>
          <option value="resolved" ${ticketState.bucket === 'resolved' ? 'selected' : ''}>Resolved</option>
        </select>
        ${S.perms.has('tickets.manage') ? `<button class="btn primary sm" id="newTicket">${icon('plus')} New ticket</button>` : ''}
      </div>
      <div class="card-body">
        <div class="table-wrap">
          <table class="tbl"><thead><tr>
            <th>#</th><th>Courier</th><th>Category</th><th>Status</th><th>Updated</th>
          </tr></thead><tbody>
            ${(data.items || []).map(t => `<tr data-ticket="${t.id}" style="cursor:pointer">
              <td class="num">#${t.id}</td>
              <td><span class="strong">${esc(t.courierName || t.code)}</span><br><small style="color:var(--text-3)">${esc(t.code)}</small></td>
              <td>${esc(t.category)}${t.subType ? ` · <span style="color:var(--text-3)">${esc(t.subType)}</span>` : ''}</td>
              <td>${statusChip(t.status)}</td>
              <td style="white-space:nowrap">${ago(t.updatedAt || t.createdAt)}</td>
            </tr>`).join('') || '<tr><td colspan="5"><div class="empty"><b>No tickets</b>Nothing matches these filters.</div></td></tr>'}
          </tbody></table>
        </div>
        ${pager(data)}
      </div>
    </div>`;

  $('#tSearch')?.addEventListener('input', debounce(() => { ticketState.q = $('#tSearch').value; ticketState.page = 1; viewTickets(root); }, 280));
  $('#tBucket')?.addEventListener('change', (e) => { ticketState.bucket = e.target.value; ticketState.page = 1; viewTickets(root); });
  wirePager(root, data, (p) => { ticketState.page = p; viewTickets(root); });
  $$('[data-ticket]', root).forEach(tr => tr.addEventListener('click', () => openTicket(tr.dataset.ticket, () => viewTickets(root))));
  $('#newTicket')?.addEventListener('click', () => newTicket(() => viewTickets(root)));
}

async function openTicket(id, refresh) {
  const data = await api(`/api/tickets/${id}`);
  const t = data.ticket;
  openDrawer(`Ticket #${t.id}`, `
    <div style="display:flex;gap:8px;flex-wrap:wrap">${statusChip(t.status)}
      <span class="chip mute">${esc(t.category)}</span>
      ${data.employee ? `<span class="chip turq">${esc(data.employee.name)}</span>` : ''}</div>
    <dl class="kv">
      <dt>Courier</dt><dd>${esc(t.courierName || '—')} · ${esc(t.code)}</dd>
      <dt>Issue date</dt><dd>${fmtDate(t.issueDate)}</dd>
      <dt>Description</dt><dd>${esc(t.description || '—')}</dd>
      <dt>Admin note</dt><dd>${esc(t.adminNote || '—')}</dd>
    </dl>
    <div id="ticketActions"></div>
    <div><div class="nav-label" style="padding:0 0 6px">Timeline</div>
      <div class="feed" id="ticketComments">
        ${data.comments.map(c => `<div class="feed-item"><span class="dot" style="background:var(--turq)"></span>
          <span class="t"><b>${esc(c.user_name || 'system')}</b> ${esc(c.body)}</span><time>${ago(c.created_at)}</time></div>`).join('')
          || '<div class="empty" style="padding:12px">No comments yet</div>'}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input class="input" id="commentBox" placeholder="Add a comment…" />
        <button class="btn sm" id="commentSend">Send</button>
      </div>
    </div>`,
    S.perms.has('tickets.manage') ? `
      <select class="select" id="tStatus" style="flex:1">
        ${['قيد المراجعة', 'يتم المراجعة', 'لازم تيجي المكتب', 'اتحلت', 'مرفوض'].map(s => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <button class="btn primary" id="tSave">Save</button>` : '');

  $('#commentSend')?.addEventListener('click', async () => {
    const body = $('#commentBox').value.trim();
    if (!body) return;
    await api(`/api/tickets/${t.id}/comments`, { method: 'POST', body: { body } });
    $('#commentBox').value = '';
    openTicket(t.id, refresh);
  });
  $('#tSave')?.addEventListener('click', async () => {
    await api(`/api/tickets/${t.id}`, { method: 'PATCH', body: { status: $('#tStatus').value } });
    toast('Ticket updated');
    closeDrawer(); refresh?.();
  });
}

function newTicket(done) {
  openDrawer('New ticket', `
    <div class="field"><label>Courier DAS code</label><input class="input" id="ntCode" placeholder="DAS-105" /></div>
    <div class="field"><label>Courier name</label><input class="input" id="ntName" placeholder="Optional" /></div>
    <div class="field"><label>Category</label>
      <select class="input" id="ntCat"><option>الشيفت</option><option>السلف</option><option>الرخصة</option><option>أخرى</option></select></div>
    <div class="field"><label>Subject</label><input class="input" id="ntSub" placeholder="Short subject" /></div>
    <div class="field"><label>Description</label><textarea class="input" id="ntDesc" rows="4" placeholder="What happened?"></textarea></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ntSave">Create ticket</button>`);
  $('#ntSave').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('/api/tickets', {
        method: 'POST',
        body: {
          code: $('#ntCode').value.trim(), courierName: $('#ntName').value.trim(),
          category: $('#ntCat').value, subType: $('#ntSub').value.trim(), description: $('#ntDesc').value.trim()
        }
      });
      toast('Ticket created');
      closeDrawer(); done?.(); loadNotifications();
    } catch { e.currentTarget.disabled = false; }
  });
}

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
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Users</h2><div style="flex:1"></div>
        <button class="btn primary sm" id="newUser">${icon('plus')} New user</button></div>
      <div class="card-body"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Permissions</th><th>Last login</th><th></th></tr></thead>
        <tbody>${data.users.map(u => `<tr>
          <td><div style="display:flex;align-items:center;gap:9px">
            <span class="avatar" style="width:28px;height:28px;font-size:11px;background:${esc(u.avatar_color || '#7C5CFF')}">${initials(u.name)}</span>
            <div><span class="strong">${esc(u.name)}</span><br><small style="color:var(--text-3)">${esc(u.email)}</small></div></div></td>
          <td><span class="chip purple">${esc(u.role.replace('_', ' '))}</span></td>
          <td>${u.status === 'active' ? '<span class="chip ok">active</span>' : '<span class="chip bad">suspended</span>'}</td>
          <td class="num">${u.permissions.length}</td>
          <td>${u.last_login_at ? ago(u.last_login_at) : 'never'}</td>
          <td><button class="btn sm" data-edit="${u.id}">Edit</button></td>
        </tr>`).join('')}</tbody></table></div></div>
    </div>`;
  $('#newUser')?.addEventListener('click', () => userForm(null, data, () => viewTeam(root)));
  $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => {
    userForm(data.users.find(u => u.id === b.dataset.edit), data, () => viewTeam(root));
  }));
}

function userForm(user, data, done) {
  const isNew = !user;
  openDrawer(isNew ? 'New user' : `Edit · ${user.name}`, `
    <div class="field"><label>Name</label><input class="input" id="uName" value="${attr(user?.name || '')}" /></div>
    <div class="field"><label>Email</label><input class="input" id="uEmail" value="${attr(user?.email || '')}" ${isNew ? '' : 'disabled'} /></div>
    <div class="field"><label>${isNew ? 'Password' : 'New password (optional)'}</label>
      <input class="input" id="uPass" type="password" placeholder="${isNew ? 'At least 8 characters' : 'Leave empty to keep'}" /></div>
    <div class="field"><label>Role</label><select class="input" id="uRole">
      ${data.roles.map(r => `<option value="${r.key}" ${user?.role === r.key ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Status</label><select class="input" id="uStatus">
      <option value="active" ${user?.status !== 'suspended' ? 'selected' : ''}>Active</option>
      <option value="suspended" ${user?.status === 'suspended' ? 'selected' : ''}>Suspended</option>
    </select></div>
    ${isNew ? '' : `<div><div class="nav-label" style="padding:0 0 6px">Permission overrides</div>
      <div style="display:grid;gap:4px">${data.permissions.map(p => `<label style="display:flex;gap:8px;align-items:center;font-size:12px">
        <input type="checkbox" data-perm="${p}" ${user?.permissions?.includes(p) ? 'checked' : ''} /> ${p}</label>`).join('')}</div></div>`}`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="uSave">${isNew ? 'Create' : 'Save'}</button>`);

  $('#uSave').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      if (isNew) {
        await api('/api/users', {
          method: 'POST',
          body: { name: $('#uName').value.trim(), email: $('#uEmail').value.trim(), password: $('#uPass').value, role: $('#uRole').value }
        });
      } else {
        const body = { name: $('#uName').value.trim(), role: $('#uRole').value, status: $('#uStatus').value };
        if ($('#uPass').value) body.password = $('#uPass').value;
        const overrides = $$('[data-perm]').map(cb => ({ perm: cb.dataset.perm, allowed: cb.checked }));
        if (overrides.length) body.overrides = overrides;
        await api(`/api/users/${user.id}`, { method: 'PATCH', body });
      }
      toast(isNew ? 'User created' : 'User updated');
      closeDrawer(); done?.();
    } catch { e.currentTarget.disabled = false; }
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
  // The intro plays once per browser (skippable), then the login/app appears.
  intro.play({ done: () => {} });
  try {
    const me = await api('/api/auth/me', { quiet: true });
    setSession(me.user, me.csrf);
    showApp();
    navigate(location.hash || '#/overview', { replace: true });
  } catch {
    showLogin();
  }
})();
