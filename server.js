/**
 * Final-Bankai — platform server.
 * Modular monolith: identity/audit/notifications in `final.db`, domain data in the
 * three module databases through adapters.
 */
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import config from './src/config.js';
import { sqlite } from './src/db.js';
import {
  users, sessions, attachUser, requireAuth, requirePermission, requireCsrf,
  verifyPassword, permissionsFor, ROLES, PERMISSIONS, bootstrapOwner, clientIp
} from './src/auth.js';
import { audit, listAudit, notify, notifyPermission, listNotifications, unreadCount, markRead } from './src/audit.js';
import roster from './src/adapters/roster.js';
import hiring from './src/adapters/hiring.js';
import ticketing from './src/adapters/ticketing.js';
import { links, setting } from './src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

/* ------------------------------ rate limiting ------------------------------ */
const buckets = new Map();
function rateLimit(key, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count++;
  buckets.set(key, b);
  return b.count > max;
}

/* ------------------------------ helpers ------------------------------ */
const today = () => new Date().toISOString().slice(0, 10);
const ok = (res, data) => res.json(data);
const fail = (res, status, message) => res.status(status).json({ error: message });

function publicUser(user) {
  if (!user) return null;
  return { ...user, permissions: [...permissionsFor(user)] };
}

/* ================================ AUTH ================================ */

app.get('/api/health', (_req, res) => res.json({
  ok: true, service: 'final-bankai', version: '1.0.0',
  modules: { roster: roster.available(), hiring: hiring.available(), ticketing: ticketing.available() }
}));

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = `login:${clientIp(req)}:${String(email || '').toLowerCase()}`;
  if (rateLimit(key, 8, 60_000)) return fail(res, 429, 'Too many attempts. Try again in a minute.');

  const user = users.byEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit(req, { action: 'login.failed', module: 'auth', entity: 'user', entityId: email || null });
    return fail(res, 401, 'Invalid email or password.');
  }
  if (user.status !== 'active') return fail(res, 403, 'This account is suspended.');

  sessions.destroyAllFor(user.id);
  const session = sessions.create(user, req);
  sqlite.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  res.cookie(config.session.cookie, session.token, sessions.cookieOptions());

  const fresh = users.byId(user.id);
  audit({ ...req, user: fresh }, { action: 'login', module: 'auth', entity: 'user', entityId: user.id });
  ok(res, { user: publicUser(fresh), csrf: session.csrf });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) {
    audit(req, { action: 'logout', module: 'auth', entity: 'user', entityId: req.user?.id });
    sessions.destroy(req.session.token);
  }
  res.clearCookie(config.session.cookie, { path: '/' });
  ok(res, { ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return fail(res, 401, 'Not authenticated.');
  ok(res, { user: publicUser(req.user), csrf: req.session.csrf, roles: RoleList() });
});

app.post('/api/auth/password', requireAuth, requireCsrf, (req, res) => {
  const { current, next } = req.body || {};
  const row = sqlite.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, row.password_hash)) return fail(res, 400, 'Current password is incorrect.');
  if (!next || String(next).length < 8) return fail(res, 400, 'New password must be at least 8 characters.');
  users.update(req.user.id, { password: next });
  sessions.destroyAllFor(req.user.id);
  audit(req, { action: 'password.changed', module: 'auth', entity: 'user', entityId: req.user.id });
  res.clearCookie(config.session.cookie, { path: '/' });
  ok(res, { ok: true });
});

function RoleList() {
  return Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, permissions: r.permissions }));
}

/* ================================ DASHBOARD ================================ */

app.get('/api/dashboard', requireAuth, requirePermission('dashboard.view'), (req, res) => {
  const date = String(req.query.date || today());
  const workforce = roster.dayMetrics(date);
  const hiringMetrics = hiring.metrics();
  const ticketMetrics = ticketing.metrics();

  const activity = [
    ...sqlite.prepare(`SELECT id, action, module, entity, entity_id, detail, created_at, user_email FROM audit_log
                       ORDER BY id DESC LIMIT 12`).all()
      .map(a => ({ kind: 'audit', ...a })),
    ...(hiring.available() ? hiring.list({ limit: 5, sort: 'newest' }).items.map(c => ({
      kind: 'candidate', id: c.id, title: c.fullName, subtitle: c.status, createdAt: c.createdAt
    })) : []),
    ...(ticketing.available() ? ticketing.list({ limit: 5 }).items.map(t => ({
      kind: 'ticket', id: t.id, title: `#${t.id} ${t.courierName || t.code}`, subtitle: t.status, createdAt: t.createdAt
    })) : [])
  ].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 12);

  ok(res, {
    date,
    workforce,
    hiring: hiringMetrics,
    tickets: ticketMetrics,
    trend: roster.weekTrend(date),
    candidates: hiring.available() ? hiring.list({ limit: 5, sort: 'newest' }).items : [],
    activity,
    modules: { roster: roster.available(), hiring: hiring.available(), ticketing: ticketing.available() },
    users: users.count()
  });
});

/* ================================ ROSTER ================================ */

app.get('/api/roster/employees', requireAuth, requirePermission('roster.view'), (req, res) => {
  const { q = '', branch = '', shift = '', active = '', page = 1, pageSize = 25 } = req.query;
  const size = Math.min(200, Number(pageSize) || 25);
  const p = Math.max(1, Number(page) || 1);
  const data = roster.employees({ q, branch, shift, active, limit: size, offset: (p - 1) * size });
  ok(res, { ...data, page: p, pageSize: size, pages: Math.max(1, Math.ceil(data.total / size)) });
});

app.get('/api/roster/employees/:id', requireAuth, requirePermission('roster.view'), (req, res) => {
  const employee = roster.employee(req.params.id);
  if (!employee) return fail(res, 404, 'Employee not found.');
  ok(res, { employee, links: links.of('employee', employee.id) });
});

app.get('/api/roster/meta', requireAuth, requirePermission('roster.view'), (req, res) => {
  ok(res, {
    branches: roster.branches(),
    shifts: roster.shifts(),
    statuses: ['Present', 'Late', 'Absent', 'Excused'],
    available: roster.available()
  });
});

app.get('/api/roster/attendance', requireAuth, requirePermission('roster.view'), (req, res) => {
  const date = String(req.query.date || today());
  ok(res, {
    date,
    expected: roster.expectedFor(date),
    marked: roster.attendanceFor(date),
    unmarked: roster.unmarkedFor(date),
    metrics: roster.dayMetrics(date)
  });
});

app.post('/api/roster/attendance', requireAuth, requireCsrf, requirePermission('attendance.manage'), (req, res) => {
  const { employeeId, date, status, fine = 0, reason = '', note = '' } = req.body || {};
  try {
    const result = roster.setAttendance({ employeeId, date, status, fine, reason, note });
    audit(req, {
      action: result.created ? 'attendance.created' : 'attendance.updated', module: 'roster',
      entity: 'employee', entityId: employeeId, detail: { date, status, fine }
    });
    if (status === 'Absent' || status === 'Late') {
      notifyPermission('roster.view', {
        module: 'roster', kind: 'attendance',
        title: `${status}: employee #${employeeId}`,
        body: `${date} · fine ${fine}`, link: '#/roster'
      });
    }
    ok(res, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message || 'Could not save attendance.');
  }
});

app.get('/api/roster/metrics', requireAuth, requirePermission('roster.view'), (req, res) => {
  const date = String(req.query.date || today());
  ok(res, { date, metrics: roster.dayMetrics(date), branches: roster.branches(), trend: roster.weekTrend(date) });
});

app.get('/api/roster/fines', requireAuth, requirePermission('roster.view'), (req, res) => {
  const to = String(req.query.to || today());
  const from = String(req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  ok(res, { from, to, rows: roster.finesSummary({ from, to }) });
});

/* ================================ HIRING ================================ */

app.get('/api/hiring/candidates', requireAuth, requirePermission('hiring.view'), (req, res) => {
  const { q = '', status = '', branch = '', type = '', sort = 'newest', page = 1, pageSize = 25 } = req.query;
  const size = Math.min(200, Number(pageSize) || 25);
  const p = Math.max(1, Number(page) || 1);
  const data = hiring.list({ q, status, branch, type, sort, limit: size, offset: (p - 1) * size });
  ok(res, { ...data, page: p, pageSize: size, pages: Math.max(1, Math.ceil(data.total / size)) });
});

app.get('/api/hiring/metrics', requireAuth, requirePermission('hiring.view'), (_req, res) => {
  ok(res, hiring.metrics());
});

app.get('/api/hiring/candidates/:id', requireAuth, requirePermission('hiring.view'), (req, res) => {
  const candidate = hiring.get(req.params.id);
  if (!candidate) return fail(res, 404, 'Candidate not found.');
  const link = links.find('candidate', candidate.id, 'employee');
  ok(res, { candidate, link, draft: hiring.conversionDraft(candidate.id), suggestedCode: roster.nextEmployeeCode() });
});

app.post('/api/hiring/candidates/:id/status', requireAuth, requireCsrf, requirePermission('hiring.manage'), (req, res) => {
  const { status } = req.body || {};
  try {
    const before = hiring.get(req.params.id);
    const updated = hiring.setStatus(req.params.id, status);
    audit(req, { action: 'candidate.status', module: 'hiring', entity: 'candidate', entityId: req.params.id, detail: { from: before?.status, to: status } });
    if (status === 'Attended to D0') {
      notifyPermission('hiring.view', {
        module: 'hiring', kind: 'candidate', title: `Candidate reached D0: ${updated.fullName}`,
        body: updated.branch, link: `#/hiring?candidate=${updated.id}`
      });
    }
    ok(res, updated);
  } catch (err) {
    fail(res, 400, err.message || 'Could not update the candidate.');
  }
});

/** Hiring → Roster conversion (the critical cross-system action). */
app.post('/api/hiring/candidates/:id/convert', requireAuth, requireCsrf, requirePermission('hiring.convert'), (req, res) => {
  const candidateId = req.params.id;
  const { branch, employmentType, shift = '', code, dayOff = 'Friday' } = req.body || {};

  const candidate = hiring.get(candidateId);
  if (!candidate) return fail(res, 404, 'Candidate not found.');

  const existingLink = links.find('candidate', candidateId, 'employee');
  if (existingLink) return fail(res, 409, `Already converted to employee #${existingLink.right_id}.`);

  const duplicate = roster.findByPhoneOrCode({ phone: candidate.phone, code });
  if (duplicate) return fail(res, 409, `An employee with this phone/code already exists (#${duplicate.id} · ${duplicate.name}).`);

  try {
    const employee = roster.createEmployee({
      name: candidate.fullName,
      phone: candidate.phone,
      branch: branch === 'QCD 2' || branch === 'QCD2' ? 'QCD 2' : 'QCD 1',
      shift,
      employmentType: employmentType === 'PT' || employmentType === 'Part Time' ? 'PT' : 'FT',
      dayOff,
      code: code || roster.nextEmployeeCode()
    });

    links.add({ leftKind: 'candidate', leftId: candidateId, rightKind: 'employee', rightId: employee.id, meta: { name: candidate.fullName }, by: req.user.email });
    hiring.markHired(candidateId);

    audit(req, {
      action: 'candidate.converted', module: 'hiring', entity: 'candidate', entityId: candidateId,
      detail: { employeeId: employee.id, code: employee.code, branch: employee.branch }
    });
    notifyPermission('hiring.view', {
      module: 'hiring', kind: 'hired', title: `Hired: ${candidate.fullName}`,
      body: `Employee ${employee.code} created in ${employee.branch}`, link: `#/roster?employee=${employee.id}`
    });

    ok(res, { employee, candidate: hiring.get(candidateId) });
  } catch (err) {
    fail(res, 400, err.message || 'Conversion failed.');
  }
});

// Candidate document proxy (images live in the hiring database)
app.get('/api/hiring/documents/:id', requireAuth, requirePermission('hiring.view'), (req, res) => {
  const doc = hiring.document(req.params.id);
  if (!doc) return fail(res, 404, 'Document not found.');
  const wantThumb = req.query.thumb != null && doc.thumb;
  res.setHeader('Content-Type', doc.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(wantThumb ? doc.thumb : doc.data);
});

/* ================================ TICKETS ================================ */

app.get('/api/tickets', requireAuth, requirePermission('tickets.view'), (req, res) => {
  const { q = '', status = '', category = '', bucket = '', archived = '', page = 1, pageSize = 25 } = req.query;
  const size = Math.min(200, Number(pageSize) || 25);
  const p = Math.max(1, Number(page) || 1);
  const data = ticketing.list({
    q, status, category, bucket, archived: String(archived) === '1',
    limit: size, offset: (p - 1) * size
  });
  ok(res, { ...data, page: p, pageSize: size, pages: Math.max(1, Math.ceil(data.total / size)), categories: ticketing.categories() });
});

app.get('/api/tickets/metrics', requireAuth, requirePermission('tickets.view'), (_req, res) => ok(res, ticketing.metrics()));

app.get('/api/tickets/:id', requireAuth, requirePermission('tickets.view'), (req, res) => {
  const ticket = ticketing.get(req.params.id);
  if (!ticket) return fail(res, 404, 'Ticket not found.');
  const employee = ticket.code ? roster.findByPhoneOrCode({ code: ticket.code }) : null;
  const comments = sqlite.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(String(ticket.id));
  ok(res, { ticket, employee, comments, link: links.of('ticket', ticket.id) });
});

app.post('/api/tickets', requireAuth, requireCsrf, requirePermission('tickets.manage'), (req, res) => {
  const { code, courierName = '', category, subType = '', description = '', issueDate = null } = req.body || {};
  if (!code) return fail(res, 400, 'Courier code is required.');
  if (!category) return fail(res, 400, 'Category is required.');
  try {
    const ticket = ticketing.create({ code, courierName, category, subType, description, issueDate });
    audit(req, { action: 'ticket.created', module: 'tickets', entity: 'ticket', entityId: ticket.id, detail: { category, code } });
    notifyPermission('tickets.view', {
      module: 'tickets', kind: 'ticket', title: `New ticket #${ticket.id}`,
      body: `${ticket.courierName || ticket.code} · ${ticket.category}`, link: `#/tickets?ticket=${ticket.id}`
    });
    ok(res, ticket);
  } catch (err) {
    fail(res, 400, err.message || 'Could not create the ticket.');
  }
});

app.patch('/api/tickets/:id', requireAuth, requireCsrf, requirePermission('tickets.manage'), (req, res) => {
  try {
    const before = ticketing.get(req.params.id);
    const ticket = ticketing.update(req.params.id, req.body || {});
    audit(req, {
      action: 'ticket.updated', module: 'tickets', entity: 'ticket', entityId: ticket.id,
      detail: { from: before?.status, to: ticket.status, note: !!req.body?.adminNote }
    });
    if (before && before.status !== ticket.status) {
      notifyPermission('tickets.view', {
        module: 'tickets', kind: 'ticket', title: `Ticket #${ticket.id} → ${ticket.status}`,
        body: ticket.courierName || ticket.code, link: `#/tickets?ticket=${ticket.id}`
      });
    }
    ok(res, ticket);
  } catch (err) {
    fail(res, 400, err.message || 'Could not update the ticket.');
  }
});

app.get('/api/tickets/:id/comments', requireAuth, requirePermission('tickets.view'), (req, res) => {
  ok(res, sqlite.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(String(req.params.id)));
});

app.post('/api/tickets/:id/comments', requireAuth, requireCsrf, requirePermission('tickets.view'), (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return fail(res, 400, 'Comment is empty.');
  const id = crypto.randomUUID();
  sqlite.prepare(`INSERT INTO ticket_comments (id, ticket_id, user_id, user_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, String(req.params.id), req.user.id, req.user.name, body, new Date().toISOString());
  audit(req, { action: 'ticket.commented', module: 'tickets', entity: 'ticket', entityId: req.params.id });
  ok(res, { id, body, userName: req.user.name, createdAt: new Date().toISOString() });
});

/* ================================ SEARCH / NOTIFICATIONS ================================ */

app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return ok(res, { query: q, results: [] });
  const groups = [];

  if (req.perms.has('roster.view') && roster.available()) {
    const { items } = roster.employees({ q, limit: 6 });
    if (items.length) groups.push({
      module: 'roster', label: 'Employees',
      items: items.map(e => ({ id: e.id, title: e.name, subtitle: `${e.code || ''} · ${e.branch || ''}`, link: `#/roster?employee=${e.id}` }))
    });
  }
  if (req.perms.has('hiring.view') && hiring.available()) {
    const items = hiring.search(q, 6);
    if (items.length) groups.push({
      module: 'hiring', label: 'Candidates',
      items: items.map(c => ({ ...c, link: `#/hiring?candidate=${c.id}` }))
    });
  }
  if (req.perms.has('tickets.view') && ticketing.available()) {
    const items = ticketing.search(q, 6);
    if (items.length) groups.push({
      module: 'tickets', label: 'Tickets',
      items: items.map(t => ({ ...t, link: `#/tickets?ticket=${t.id}` }))
    });
  }
  if (req.perms.has('roster.view') && roster.available()) {
    const branches = roster.branches().filter(b => String(b.branch).toLowerCase().includes(q.toLowerCase()));
    if (branches.length) groups.push({
      module: 'roster', label: 'Branches',
      items: branches.map(b => ({ id: b.branch, title: b.branch, subtitle: `${b.n} active`, link: `#/roster?branch=${encodeURIComponent(b.branch)}` }))
    });
  }
  ok(res, { query: q, results: groups });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  ok(res, {
    items: listNotifications(req.user.id, { limit: Number(req.query.limit) || 30, unreadOnly: req.query.unread === '1' }),
    unread: unreadCount(req.user.id)
  });
});

app.post('/api/notifications/read', requireAuth, requireCsrf, (req, res) => {
  ok(res, { unread: markRead(req.user.id, req.body?.id || null) });
});

/* ================================ TEAM / AUDIT ================================ */

app.get('/api/users', requireAuth, requirePermission('team.manage'), (_req, res) => {
  const list = users.list().map(u => ({
    ...u,
    permissions: [...permissionsFor(u)],
    overrides: users.overrides(u.id)
  }));
  ok(res, { users: list, roles: RoleList(), permissions: PERMISSIONS });
});

app.post('/api/users', requireAuth, requireCsrf, requirePermission('team.manage'), (req, res) => {
  const { email, name, password, role = 'employee', overrides = [] } = req.body || {};
  if (!email || !name || !password) return fail(res, 400, 'Email, name and password are required.');
  if (String(password).length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
  if (!ROLES[role]) return fail(res, 400, 'Unknown role.');
  if (users.byEmail(email)) return fail(res, 409, 'Email already exists.');
  try {
    const user = users.create({ email, name, password, role });
    if (overrides.length) users.setOverrides(user.id, overrides);
    audit(req, { action: 'user.created', module: 'team', entity: 'user', entityId: user.id, detail: { role } });
    ok(res, { user: { ...user, permissions: [...permissionsFor(user)] } });
  } catch (err) {
    fail(res, 400, err.message || 'Could not create the user.');
  }
});

app.patch('/api/users/:id', requireAuth, requireCsrf, requirePermission('team.manage'), (req, res) => {
  const target = users.byId(req.params.id);
  if (!target) return fail(res, 404, 'User not found.');
  if (target.role === 'superadmin' && req.user.id !== target.id && req.user.role !== 'superadmin') {
    return fail(res, 403, 'Only a Super Admin can modify another Super Admin.');
  }
  const { name, role, status, password, overrides } = req.body || {};
  if (role && !ROLES[role]) return fail(res, 400, 'Unknown role.');
  const updated = users.update(req.params.id, { name, role, status, password });
  if (Array.isArray(overrides)) users.setOverrides(req.params.id, overrides);
  audit(req, { action: 'user.updated', module: 'team', entity: 'user', entityId: req.params.id, detail: { role, status } });
  ok(res, { user: { ...updated, permissions: [...permissionsFor(updated)], overrides: users.overrides(updated.id) } });
});

app.delete('/api/users/:id', requireAuth, requireCsrf, requirePermission('team.manage'), (req, res) => {
  if (req.params.id === req.user.id) return fail(res, 400, 'You cannot delete your own account.');
  const target = users.byId(req.params.id);
  if (!target) return fail(res, 404, 'User not found.');
  users.remove(req.params.id);
  audit(req, { action: 'user.deleted', module: 'team', entity: 'user', entityId: req.params.id, detail: { email: target.email } });
  ok(res, { ok: true });
});

app.get('/api/audit', requireAuth, requirePermission('audit.view'), (req, res) => {
  ok(res, { items: listAudit({ limit: Number(req.query.limit) || 60, module: String(req.query.module || ''), q: String(req.query.q || '') }) });
});

/* ================================ SETTINGS ================================ */

app.get('/api/settings', requireAuth, (req, res) => {
  ok(res, {
    intro: setting.get(`intro_seen:${req.user.id}`, '0') === '1',
    notifications: setting.get(`notifications:${req.user.id}`, '1') === '1',
    system: {
      version: '1.0.0',
      env: config.env,
      modules: { roster: roster.available(), hiring: hiring.available(), ticketing: ticketing.available() },
      storage: { final: config.finalDb, roster: config.rosterDb, hiring: config.hiringDb, ticketing: config.ticketingDb }
    }
  });
});

app.put('/api/settings', requireAuth, requireCsrf, (req, res) => {
  const { intro, notifications } = req.body || {};
  if (intro != null) setting.set(`intro_seen:${req.user.id}`, intro ? '1' : '0');
  if (notifications != null) setting.set(`notifications:${req.user.id}`, notifications ? '1' : '0');
  audit(req, { action: 'settings.updated', module: 'settings', detail: { intro, notifications } });
  ok(res, { ok: true });
});

/* ================================ STATIC SPA ================================ */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ================================ ERRORS ================================ */

app.use((err, _req, res, _next) => {
  console.error('unhandled:', err?.message || err);
  res.status(500).json({ error: 'Internal error.' });
});

/* ================================ BOOT ================================ */

bootstrapOwner();

const server = app.listen(config.port, () => {
  console.log(`🛰  Final-Bankai on http://localhost:${config.port}  (${config.env})`);
  console.log(`   roster:${roster.available()}  hiring:${hiring.available()}  ticketing:${ticketing.available()}`);
});

export { app, server };
