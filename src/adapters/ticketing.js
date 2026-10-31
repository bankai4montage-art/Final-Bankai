/**
 * Ticketing adapter — talks to the DAS Ticketing database (`tickets`, `couriers`).
 * Statuses are Arabic strings in the source system and are kept untouched; the
 * adapter only derives a coarse bucket (open / progress / resolved) for charts.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import config from '../config.js';

let db = null;
let openedPath = null;

function conn() {
  if (db && openedPath === config.ticketingDb) return db;
  if (!fs.existsSync(config.ticketingDb)) return null;
  db = new Database(config.ticketingDb, { readonly: false, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  openedPath = config.ticketingDb;
  return db;
}

export const ticketingAvailable = () => fs.existsSync(config.ticketingDb);

export const OPEN_STATUSES = ['قيد المراجعة', 'يتم المراجعة', 'لازم تيجي المكتب', 'مفتوحة', 'جديدة'];
export const RESOLVED_STATUSES = ['اتحلت', 'مرفوض', 'مغلق', 'تم الحل'];

export function bucketOf(status) {
  const s = String(status || '').trim();
  if (RESOLVED_STATUSES.includes(s)) return 'resolved';
  if (s === 'لازم تيجي المكتب') return 'action';
  if (s === 'يتم المراجعة') return 'progress';
  return 'open';
}

const map = (r) => ({
  id: r.id,
  code: r.das_code,
  courierName: r.courier_name,
  category: r.category,
  subType: r.sub_type,
  issueDate: r.issue_date,
  description: r.description,
  status: r.status,
  bucket: bucketOf(r.status),
  adminNote: r.admin_note || '',
  archived: !!r.archived,
  rating: r.rating,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export const ticketing = {
  available: ticketingAvailable,

  list({ q = '', status = '', category = '', bucket = '', archived = false, limit = 25, offset = 0 } = {}) {
    const c = conn();
    if (!c) return { items: [], total: 0 };
    const where = ['COALESCE(archived, 0) = ?'];
    const params = [archived ? 1 : 0];
    if (q) {
      where.push('(das_code LIKE ? OR courier_name LIKE ? OR description LIKE ? OR category LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) { where.push('status = ?'); params.push(status); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (bucket) {
      const sets = {
        open: OPEN_STATUSES, resolved: RESOLVED_STATUSES, progress: ['يتم المراجعة'], action: ['لازم تيجي المكتب']
      }[bucket] || [];
      if (sets.length) { where.push(`status IN (${sets.map(() => '?').join(',')})`); params.push(...sets); }
    }
    const w = `WHERE ${where.join(' AND ')}`;
    const total = c.prepare(`SELECT COUNT(*) AS n FROM tickets ${w}`).get(...params).n;
    const items = c.prepare(`SELECT * FROM tickets ${w} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(200, Number(limit) || 25), Number(offset) || 0).map(map);
    return { items, total };
  },

  get(id) {
    const c = conn();
    if (!c) return null;
    const row = c.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
    return row ? map(row) : null;
  },

  create({ code, courierName = '', category, subType = '', description = '', issueDate = null }) {
    const c = conn();
    if (!c) throw new Error('Ticketing database is not available.');
    const stamp = new Date().toISOString();
    const day = issueDate || stamp.slice(0, 10);
    const info = c.prepare(`INSERT INTO tickets (das_code, courier_name, category, sub_type, issue_date, description, status, created_at, updated_at, archived)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(String(code || '').trim().toUpperCase(), courierName, category, subType, day, description, 'قيد المراجعة', stamp, stamp);
    return ticketing.get(info.lastInsertRowid);
  },

  update(id, patch) {
    const c = conn();
    if (!c) throw new Error('Ticketing database is not available.');
    const row = c.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
    if (!row) throw new Error('Ticket not found.');
    const next = {
      status: patch.status ?? row.status,
      admin_note: patch.adminNote ?? row.admin_note,
      archived: patch.archived != null ? (patch.archived ? 1 : 0) : row.archived
    };
    c.prepare('UPDATE tickets SET status = ?, admin_note = ?, archived = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.admin_note, next.archived, new Date().toISOString(), Number(id));
    return ticketing.get(id);
  },

  metrics() {
    const c = conn();
    if (!c) return { total: 0, byStatus: {}, open: 0, progress: 0, resolved: 0, action: 0, overdue: 0, today: 0 };
    const rows = c.prepare(`SELECT status, COUNT(*) AS n FROM tickets WHERE COALESCE(archived,0)=0 GROUP BY status`).all();
    const byStatus = Object.fromEntries(rows.map(r => [r.status, r.n]));
    const total = rows.reduce((s, r) => s + r.n, 0);
    const buckets = rows.reduce((acc, r) => {
      const b = bucketOf(r.status);
      acc[b] = (acc[b] || 0) + r.n;
      return acc;
    }, { open: 0, progress: 0, action: 0, resolved: 0 });
    const today = new Date().toISOString().slice(0, 10);
    let todayCount = 0;
    try { todayCount = c.prepare('SELECT COUNT(*) AS n FROM tickets WHERE substr(created_at,1,10) = ?').get(today).n; } catch { /* ignore */ }
    // "overdue": open tickets older than 3 days
    const limit = new Date(Date.now() - 3 * 86400000).toISOString();
    let overdue = 0;
    try {
      overdue = c.prepare(`SELECT COUNT(*) AS n FROM tickets
                           WHERE COALESCE(archived,0)=0 AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
                             AND COALESCE(updated_at, created_at) < ?`).get(...OPEN_STATUSES, limit).n;
    } catch { /* ignore */ }
    return { total, byStatus, ...buckets, overdue, today: todayCount };
  },

  search(q, limit = 8) {
    const c = conn();
    if (!c) return [];
    return c.prepare(`SELECT id, das_code, courier_name, status, description FROM tickets
                      WHERE das_code LIKE ? OR courier_name LIKE ? OR description LIKE ?
                      ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`)
      .all(`%${q}%`, `%${q}%`, `%${q}%`, limit)
      .map(r => ({ id: r.id, title: `#${r.id} · ${r.courier_name || r.das_code}`, subtitle: (r.description || '').slice(0, 70), meta: r.status }));
  },

  categories() {
    const c = conn();
    if (!c) return [];
    return c.prepare('SELECT DISTINCT category FROM tickets WHERE category IS NOT NULL').all().map(r => r.category);
  }
};

export default ticketing;
