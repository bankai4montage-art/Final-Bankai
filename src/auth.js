/**
 * Final-Bankai — identity, sessions and authorisation.
 *
 * Passwords: scrypt with per-user salt.
 * Sessions:  random token in an httpOnly cookie + a server-side row (revocable).
 * Access:    role → permission set, with per-user allow/deny overrides.
 *            Every route goes through `requirePermission` — the UI never decides.
 */
import crypto from 'node:crypto';
import { sqlite, uid, now } from './db.js';
import config from './config.js';

/* ------------------------- permissions ------------------------- */

export const PERMISSIONS = [
  'dashboard.view',
  'roster.view', 'roster.manage', 'attendance.manage',
  'hiring.view', 'hiring.manage', 'hiring.convert',
  'tickets.view', 'tickets.manage',
  'reports.view',
  'team.manage', 'settings.manage', 'audit.view'
];

export const ROLES = {
  superadmin: {
    label: 'Super Admin',
    permissions: PERMISSIONS.slice()
  },
  admin: {
    label: 'Admin',
    permissions: [
      'dashboard.view', 'roster.view', 'roster.manage', 'attendance.manage',
      'hiring.view', 'hiring.manage', 'hiring.convert',
      'tickets.view', 'tickets.manage', 'reports.view', 'settings.manage', 'audit.view'
    ]
  },
  ops_manager: {
    label: 'Operations Manager',
    permissions: [
      'dashboard.view', 'roster.view', 'roster.manage', 'attendance.manage',
      'tickets.view', 'tickets.manage', 'reports.view'
    ]
  },
  hiring_manager: {
    label: 'Hiring Manager',
    permissions: ['dashboard.view', 'hiring.view', 'hiring.manage', 'hiring.convert', 'reports.view']
  },
  supervisor: {
    label: 'Supervisor',
    permissions: ['dashboard.view', 'roster.view', 'attendance.manage', 'tickets.view', 'tickets.manage']
  },
  employee: {
    label: 'Employee',
    permissions: ['dashboard.view']
  }
};

export const roleOf = (role) => ROLES[role] || ROLES.employee;

/** Effective permissions = role set ± per-user overrides. */
export function permissionsFor(user) {
  if (!user) return new Set();
  const set = new Set(roleOf(user.role).permissions);
  const overrides = sqlite.prepare('SELECT perm, allowed FROM permission_overrides WHERE user_id = ?').all(user.id);
  for (const o of overrides) o.allowed ? set.add(o.perm) : set.delete(o.perm);
  return set;
}

export const can = (user, perm) => permissionsFor(user).has(perm);

/* ------------------------- passwords ------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const computed = crypto.scryptSync(String(plain), salt, hash.length / 2, { N: +N, r: +r, p: +p });
    const expected = Buffer.from(hash, 'hex');
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

/* ------------------------- users ------------------------- */

const PUBLIC_USER = `id, email, name, role, status, avatar_color, last_login_at, created_at, updated_at`;

export const users = {
  byEmail(email) {
    return sqlite.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
  },
  byId(id) {
    return sqlite.prepare(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`).get(id);
  },
  list() {
    return sqlite.prepare(`SELECT ${PUBLIC_USER} FROM users ORDER BY created_at DESC`).all();
  },
  create({ email, name, password, role = 'employee' }) {
    const id = uid();
    sqlite.prepare(`INSERT INTO users (id, email, name, password_hash, role, avatar_color, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(email).trim(), String(name).trim(), hashPassword(password), role,
           colourFor(name), now(), now());
    return users.byId(id);
  },
  update(id, patch) {
    const current = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      role: patch.role ?? current.role,
      status: patch.status ?? current.status,
      email: patch.email ?? current.email
    };
    sqlite.prepare(`UPDATE users SET name = ?, role = ?, status = ?, email = ?, updated_at = ? WHERE id = ?`)
      .run(next.name, next.role, next.status, next.email, now(), id);
    if (patch.password) {
      sqlite.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(patch.password), now(), id);
    }
    return users.byId(id);
  },
  remove(id) {
    return sqlite.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  },
  count() {
    return sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  },
  overrides(id) {
    return sqlite.prepare('SELECT perm, allowed FROM permission_overrides WHERE user_id = ?').all(id);
  },
  setOverrides(id, list = []) {
    const del = sqlite.prepare('DELETE FROM permission_overrides WHERE user_id = ?');
    const ins = sqlite.prepare('INSERT INTO permission_overrides (user_id, perm, allowed) VALUES (?, ?, ?)');
    sqlite.transaction(() => {
      del.run(id);
      for (const o of list) if (PERMISSIONS.includes(o.perm)) ins.run(id, o.perm, o.allowed ? 1 : 0);
    })();
    return users.overrides(id);
  }
};

function colourFor(name) {
  const palette = ['#7C5CFF', '#14D9C4', '#F59E0B', '#EF4444', '#3B82F6', '#A855F7', '#10B981'];
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/* ------------------------- sessions ------------------------- */

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/',
  maxAge: config.session.ttlHours * 3600 * 1000
});

export const sessions = {
  create(user, req) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(18).toString('hex');
    const expires = new Date(Date.now() + config.session.ttlHours * 3600 * 1000).toISOString();
    sqlite.prepare(`INSERT INTO sessions (token, user_id, csrf, user_agent, ip, created_at, expires_at, last_seen_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, user.id, csrf, String(req.headers['user-agent'] || '').slice(0, 200),
           clientIp(req), now(), expires, now());
    return { token, csrf, expires };
  },
  get(token) {
    if (!token) return null;
    const row = sqlite.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      sessions.destroy(token);
      return null;
    }
    return row;
  },
  touch(token) {
    sqlite.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(now(), token);
  },
  destroy(token) {
    sqlite.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },
  destroyAllFor(userId) {
    sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  },
  cookieOptions
};

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/* ------------------------- middleware ------------------------- */

/** Resolves the session (if any) and attaches `req.user` + `req.perms`. */
export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie || '')[config.session.cookie];
  const row = sessions.get(token);
  if (row) {
    const user = users.byId(row.user_id);
    if (user && user.status === 'active') {
      sessions.touch(token);
      req.user = user;
      req.session = row;
      req.perms = permissionsFor(user);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

export function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!req.perms?.has(perm)) {
      return res.status(403).json({ error: `Missing permission: ${perm}` });
    }
    next();
  };
}

/** Blocks state-changing requests that don't carry the session CSRF token. */
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next(); // login/register are handled separately
  const token = req.headers['x-csrf-token'] || '';
  if (token !== req.session.csrf) return res.status(403).json({ error: 'Invalid CSRF token.' });
  next();
}

/** Ensures the first account exists (Super Admin from env). */
export function bootstrapOwner() {
  if (users.count() > 0) return null;
  const owner = users.create({
    email: config.bootstrap.email,
    name: config.bootstrap.name,
    password: config.bootstrap.password,
    role: 'superadmin'
  });
  console.log(`👑 Bootstrapped Super Admin: ${owner.email}`);
  return owner;
}
