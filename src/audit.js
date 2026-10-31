/**
 * Final-Bankai — audit trail + notifications (platform plane).
 */
import { sqlite, uid, now } from './db.js';

export function audit(req, { action, module, entity = null, entityId = null, detail = null }) {
  try {
    sqlite.prepare(`INSERT INTO audit_log (user_id, user_email, action, module, entity, entity_id, detail, ip, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req?.user?.id || null, req?.user?.email || null, action, module,
           entity, entityId != null ? String(entityId) : null,
           detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
           req?.ip || null, now());
  } catch (err) {
    console.warn('audit failed:', err?.message || err);
  }
}

export function listAudit({ limit = 50, module = '', q = '' } = {}) {
  const where = [];
  const params = [];
  if (module) { where.push('module = ?'); params.push(module); }
  if (q) { where.push('(action LIKE ? OR entity LIKE ? OR user_email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return sqlite.prepare(sql).all(...params, Math.min(500, Number(limit) || 50));
}

/* ------------------------- notifications ------------------------- */

export function notify({ userId = null, module, kind, title, body = null, link = null }) {
  const id = uid();
  sqlite.prepare(`INSERT INTO notifications (id, user_id, module, kind, title, body, link, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, module, kind, title, body, link, now());
  return id;
}

/** Broadcast to every active user who can see a given module permission. */
export function notifyPermission(perm, payload) {
  const targets = sqlite.prepare(`SELECT id, role FROM users WHERE status = 'active'`).all();
  for (const t of targets) {
    // role-level check is enough here (overrides are evaluated in the API layer)
    if (roleHasPerm(t.role, perm)) notify({ ...payload, userId: t.id });
  }
}

function roleHasPerm(role, perm) {
  const map = {
    superadmin: ['*'],
    admin: ['roster.*', 'hiring.*', 'tickets.*', 'reports.view', 'settings.manage'],
    ops_manager: ['roster.*', 'tickets.*', 'reports.view'],
    hiring_manager: ['hiring.*', 'reports.view'],
    supervisor: ['roster.view', 'attendance.manage', 'tickets.*'],
    employee: []
  };
  const list = map[role] || [];
  return list.includes('*') || list.some(p => p === perm || (p.endsWith('.*') && perm.startsWith(p.slice(0, -1))));
}

export function listNotifications(userId, { limit = 30, unreadOnly = false } = {}) {
  const where = ['(user_id = ? OR user_id IS NULL)'];
  const params = [userId];
  if (unreadOnly) where.push('read_at IS NULL');
  return sqlite.prepare(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, Math.min(200, Number(limit) || 30));
}

export function unreadCount(userId) {
  return sqlite.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL`)
    .get(userId).n;
}

export function markRead(userId, id = null) {
  if (id) sqlite.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)').run(now(), id, userId);
  else sqlite.prepare('UPDATE notifications SET read_at = ? WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL').run(now(), userId);
  return unreadCount(userId);
}
