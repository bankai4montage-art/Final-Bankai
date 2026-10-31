/**
 * Final-Bankai — API tests (node:test).
 *
 * Boots the real server against a throw-away copy of the three module databases
 * and exercises auth, RBAC, the roster/ticketing workflows and the
 * hiring → roster conversion.
 *
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'final-bankai-test-'));
const PORT = Number(process.env.TEST_PORT || 4099);
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN = { email: 'owner@test.local', password: 'OwnerPass!2026' };
let server;
let cookie = '';
let csrf = '';

/* copy the three MODULE databases (never the platform db, never dev/prod state) */
for (const file of readdirSync(path.join(ROOT, 'data'))) {
  if (!/^(roster|hiring|ticketing)\.db(-wal|-shm)?$/.test(file)) continue;
  copyFileSync(path.join(ROOT, 'data', file), path.join(TMP, file));
}

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'x-csrf-token': csrf } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) if (c.startsWith('fb_session=')) cookie = c.split(';')[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function login(email, password) {
  cookie = ''; csrf = '';
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(r.status, 200, `login failed for ${email}`);
  assert.ok(cookie, 'session cookie missing');
  csrf = r.body.csrf;
  return r;
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: TMP,
      FINAL_DB: path.join(TMP, 'final.db'),
      ROSTER_DB: path.join(TMP, 'roster.db'),
      HIRING_DB: path.join(TMP, 'hiring.db'),
      TICKETING_DB: path.join(TMP, 'ticketing.db'),
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      NODE_ENV: 'test'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});

after(() => {
  try { server?.kill(); } catch { /* gone */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
});

/* ------------------------------------------------------------ auth */

test('rejects a wrong password', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { email: ADMIN.email, password: 'nope' } });
  assert.equal(r.status, 401);
});

test('signs in the bootstrapped super admin', async () => {
  const r = await login(ADMIN.email, ADMIN.password);
  assert.equal(r.body.user.role, 'superadmin');
  assert.ok(r.body.user.permissions.includes('hiring.convert'));
  assert.ok(csrf);
});

test('serves the current session', async () => {
  const r = await call('/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, ADMIN.email);
});

test('blocks unauthenticated access', async () => {
  const saved = cookie;
  cookie = '';
  const r = await call('/api/dashboard');
  assert.equal(r.status, 401);
  cookie = saved;
});

/* ------------------------------------------------------------ dashboard */

test('dashboard aggregates the three systems', async () => {
  const r = await call('/api/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.body.workforce.total >= 1, 'roster employees');
  assert.ok(typeof r.body.hiring.total === 'number');
  assert.ok(typeof r.body.tickets.total === 'number');
  assert.ok(Array.isArray(r.body.activity));
  assert.equal(r.body.modules.roster, true);
});

/* ------------------------------------------------------------ roster */

test('lists employees with pagination', async () => {
  const r = await call('/api/roster/employees?pageSize=5');
  assert.equal(r.status, 200);
  assert.ok(r.body.total >= 1);
  assert.ok(r.body.items.length <= 5);
});

test('marks attendance and reports it back', async () => {
  const list = await call('/api/roster/employees?pageSize=1');
  const id = list.body.items[0].id;
  const date = new Date().toISOString().slice(0, 10);

  const saved = await call('/api/roster/attendance', {
    method: 'POST', body: { employeeId: id, date, status: 'Late', fine: 25, reason: 'traffic' }
  });
  assert.equal(saved.status, 200);

  const day = await call(`/api/roster/attendance?date=${date}`);
  const row = day.body.marked.find(m => String(m.employeeId) === String(id));
  assert.ok(row, 'attendance row present');
  assert.equal(row.status, 'Late');
  assert.equal(row.fine, 25);
});

test('rejects an invalid attendance status', async () => {
  const list = await call('/api/roster/employees?pageSize=1');
  const r = await call('/api/roster/attendance', {
    method: 'POST', body: { employeeId: list.body.items[0].id, status: 'Sleeping' }
  });
  assert.equal(r.status, 400);
});

/* ------------------------------------------------------------ hiring + conversion */

test('lists candidates and changes a stage', async () => {
  const list = await call('/api/hiring/candidates?pageSize=5');
  assert.equal(list.status, 200);
  assert.ok(list.body.total >= 1);
  const candidate = list.body.items[0];

  const moved = await call(`/api/hiring/candidates/${candidate.id}/status`, {
    method: 'POST', body: { status: 'Attended to D0' }
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.status, 'Attended to D0');
});

test('converts a candidate into a roster employee (once)', async () => {
  const list = await call('/api/hiring/candidates?pageSize=50');
  const candidates = list.body.items.filter(c => !['Inactive', 'OffBoarding'].includes(c.status));

  let converted = null, candidate = null;
  for (const c of candidates) {
    const res = await call(`/api/hiring/candidates/${c.id}/convert`, {
      method: 'POST', body: { branch: 'QCD 1', employmentType: 'FT', shift: '08:00-16:00', dayOff: 'Friday' }
    });
    if (res.status === 200) { converted = res; candidate = c; break; }
    assert.equal(res.status, 409, res.body.error);
  }
  assert.ok(converted, 'at least one candidate convertible');
  assert.ok(converted.body.employee.id);
  assert.match(converted.body.employee.code, /^DAS-\d+$/);

  // the employee really exists in the roster database
  const employee = await call(`/api/roster/employees/${converted.body.employee.id}`);
  assert.equal(employee.status, 200);
  assert.equal(employee.body.employee.name, candidate.fullName);

  // and the candidate is now Active + linked
  const profile = await call(`/api/hiring/candidates/${candidate.id}`);
  assert.equal(profile.body.candidate.status, 'Active');
  assert.ok(profile.body.link);

  // converting again is refused
  const again = await call(`/api/hiring/candidates/${candidate.id}/convert`, {
    method: 'POST', body: { branch: 'QCD 1' }
  });
  assert.equal(again.status, 409);
});

/* ------------------------------------------------------------ tickets */

test('creates, updates and comments on a ticket', async () => {
  const created = await call('/api/tickets', {
    method: 'POST',
    body: { code: 'DAS-999', courierName: 'Test Courier', category: 'الشيفت', subType: 'delayed', description: 'test ticket' }
  });
  assert.equal(created.status, 200);
  const id = created.body.id;

  const updated = await call(`/api/tickets/${id}`, { method: 'PATCH', body: { status: 'يتم المراجعة' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'يتم المراجعة');

  const comment = await call(`/api/tickets/${id}/comments`, { method: 'POST', body: { body: 'Looking into it' } });
  assert.equal(comment.status, 200);

  const detail = await call(`/api/tickets/${id}`);
  assert.equal(detail.body.comments.length, 1);
});

test('validates ticket creation', async () => {
  const r = await call('/api/tickets', { method: 'POST', body: { category: 'الشيفت' } });
  assert.equal(r.status, 400);
});

/* ------------------------------------------------------------ search + notifications + audit */

test('global search only returns permitted modules', async () => {
  const r = await call('/api/search?q=DAS');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.results));
  assert.ok(r.body.results.every(g => ['roster', 'hiring', 'tickets'].includes(g.module)));
});

test('notifications are produced by actions', async () => {
  const r = await call('/api/notifications');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 1);
});

test('audit log records the session activity', async () => {
  const r = await call('/api/audit');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some(a => a.action === 'login'));
  assert.ok(r.body.items.some(a => a.action === 'candidate.converted'));
});

/* ------------------------------------------------------------ RBAC */

test('a role without a permission is refused server-side', async () => {
  const created = await call('/api/users', {
    method: 'POST',
    body: { email: 'ops@test.local', name: 'Ops', password: 'OpsPass!2026', role: 'ops_manager' }
  });
  assert.equal(created.status, 200);

  await login('ops@test.local', 'OpsPass!2026');

  assert.equal((await call('/api/hiring/candidates')).status, 403, 'hiring blocked');
  assert.equal((await call('/api/users')).status, 403, 'team blocked');
  assert.equal((await call('/api/roster/employees')).status, 200, 'roster allowed');

  // fresh admin session for the remaining tests
  await login(ADMIN.email, ADMIN.password);
});

test('CSRF is required for state-changing requests', async () => {
  const saved = csrf;
  csrf = '';
  const r = await call('/api/users', {
    method: 'POST', body: { email: 'x@test.local', name: 'X', password: 'Xpass!1234', role: 'employee' }
  });
  assert.equal(r.status, 403);
  csrf = saved;
});

/* ------------------------------------------------------------ settings */

test('settings round-trip', async () => {
  const r = await call('/api/settings', { method: 'PUT', body: { intro: true } });
  assert.equal(r.status, 200);
  const s = await call('/api/settings');
  assert.equal(s.body.intro, true);
  assert.ok(s.body.system.modules.roster);
});
