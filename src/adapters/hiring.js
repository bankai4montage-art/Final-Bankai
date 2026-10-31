/**
 * Hiring adapter — talks to the Bankai-Hiring database (`couriers` + `documents`).
 * Read-only except for status changes and the "hired" stamp, which the platform
 * needs for the pipeline and the conversion flow.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import crypto from 'node:crypto';
import config from '../config.js';

let db = null;
let openedPath = null;

function conn() {
  if (db && openedPath === config.hiringDb) return db;
  if (!fs.existsSync(config.hiringDb)) return null;
  db = new Database(config.hiringDb, { readonly: false, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  openedPath = config.hiringDb;
  return db;
}

export const hiringAvailable = () => fs.existsSync(config.hiringDb);

const HAS = (c, table, col) => {
  try { return c.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col); }
  catch { return false; }
};

function columns(c) {
  const cols = {
    thumb: HAS(c, 'documents', 'thumb'),
    thumbSize: HAS(c, 'documents', 'thumb_size')
  };
  return cols;
}

export const STAGES = ['OnBoarding', 'Attended to D0', 'Active', 'Inactive', 'OffBoarding'];

const map = (r, hasThumb = false) => ({
  id: r.id,
  fullName: r.full_name,
  phone: r.phone,
  nationalId: r.national_id,
  branch: r.branch,
  employmentType: r.employment_type,
  licenseStart: r.license_start,
  licenseEnd: r.license_end,
  outlook: r.outlook || '',
  plate: r.plate || '',
  status: r.status,
  photo: r.photo_doc || null,
  hasThumb: !!hasThumb,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export const hiring = {
  available: hiringAvailable,

  list({ q = '', status = '', branch = '', type = '', sort = 'newest', limit = 25, offset = 0 } = {}) {
    const c = conn();
    if (!c) return { items: [], total: 0 };
    const cols = columns(c);
    const where = [];
    const params = [];
    if (q) {
      where.push('(c.full_name LIKE ? OR c.phone LIKE ? OR c.national_id LIKE ? OR c.plate LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) { where.push('c.status = ?'); params.push(status); }
    if (branch) { where.push('c.branch = ?'); params.push(branch); }
    if (type) { where.push('c.employment_type = ?'); params.push(type); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = {
      newest: 'c.created_at DESC', oldest: 'c.created_at ASC',
      name: 'c.full_name COLLATE NOCASE', license: 'c.license_end ASC'
    }[sort] || 'c.created_at DESC';

    const total = c.prepare(`SELECT COUNT(*) AS n FROM couriers c ${w}`).get(...params).n;
    const rows = c.prepare(`SELECT c.*, (SELECT d.id FROM documents d WHERE d.courier_id = c.id AND d.kind = 'photo' LIMIT 1) AS photo_doc,
                            ${cols.thumb ? `(SELECT d.thumb_size FROM documents d WHERE d.courier_id = c.id AND d.kind = 'photo' LIMIT 1)` : 'NULL'} AS photo_thumb
                            FROM couriers c ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, Math.min(200, Number(limit) || 25), Number(offset) || 0);
    return { items: rows.map(r => map(r, !!r.photo_thumb)), total };
  },

  get(id) {
    const c = conn();
    if (!c) return null;
    const cols = columns(c);
    const row = c.prepare(`SELECT c.*, (SELECT d.id FROM documents d WHERE d.courier_id = c.id AND d.kind = 'photo' LIMIT 1) AS photo_doc,
                           ${cols.thumb ? `(SELECT d.thumb_size FROM documents d WHERE d.courier_id = c.id AND d.kind = 'photo' LIMIT 1)` : 'NULL'} AS photo_thumb
                           FROM couriers c WHERE c.id = ?`).get(id);
    if (!row) return null;
    const out = map(row, !!row.photo_thumb);
    out.documents = c.prepare(`SELECT id, kind, mime, size, ${cols.thumbSize ? 'thumb_size' : 'NULL AS thumb_size'}, created_at
                               FROM documents WHERE courier_id = ? ORDER BY created_at`).all(id)
      .map(d => ({ id: d.id, kind: d.kind, mime: d.mime, size: d.size, hasThumb: !!d.thumb_size, createdAt: d.created_at }));
    try {
      out.events = c.prepare('SELECT * FROM courier_events WHERE courier_id = ? ORDER BY created_at DESC LIMIT 30').all(id)
        .map(e => ({ id: e.id, type: e.type, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, createdAt: e.created_at }));
    } catch { out.events = []; }
    return out;
  },

  metrics() {
    const c = conn();
    if (!c) return { total: 0, byStatus: {}, newThisWeek: 0, hired: 0, licenseExpiring: 0 };
    const total = c.prepare('SELECT COUNT(*) AS n FROM couriers').get().n;
    const byStatus = Object.fromEntries(c.prepare('SELECT status, COUNT(*) AS n FROM couriers GROUP BY status').all().map(r => [r.status, r.n]));
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    let newThisWeek = 0;
    try { newThisWeek = c.prepare('SELECT COUNT(*) AS n FROM couriers WHERE created_at >= ?').get(weekAgo).n; } catch { /* old db */ }
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    let licenseExpiring = 0;
    try { licenseExpiring = c.prepare('SELECT COUNT(*) AS n FROM couriers WHERE license_end BETWEEN ? AND ?').get(new Date().toISOString().slice(0, 10), soon).n; } catch { /* ignore */ }
    return {
      total, byStatus, newThisWeek,
      hired: (byStatus.Active || 0) + (byStatus['Attended to D0'] || 0),
      licenseExpiring
    };
  },

  setStatus(id, status) {
    const c = conn();
    if (!c) throw new Error('Hiring database is not available.');
    if (!STAGES.includes(status)) throw new Error('Invalid candidate status.');
    const before = c.prepare('SELECT status FROM couriers WHERE id = ?').get(id);
    if (!before) throw new Error('Candidate not found.');
    const stamp = new Date().toISOString();
    c.prepare('UPDATE couriers SET status = ?, updated_at = ? WHERE id = ?').run(status, stamp, id);
    try {
      c.prepare(`INSERT INTO courier_events (id, courier_id, type, from_status, to_status, created_at)
                 VALUES (?, ?, 'status', ?, ?, ?)`)
        .run(crypto.randomUUID(), id, before.status, status, stamp);
    } catch { /* older schema without events */ }
    return hiring.get(id);
  },

  /** Candidate + documents payload used to prefill the conversion form. */
  conversionDraft(id) {
    const c = conn();
    if (!c) return null;
    const row = c.prepare('SELECT * FROM couriers WHERE id = ?').get(id);
    if (!row) return null;
    return {
      candidateId: row.id,
      name: row.full_name,
      phone: row.phone,
      nationalId: row.national_id,
      branch: row.branch === 'QCD2' ? 'QCD 2' : 'QCD 1',
      employmentType: row.employment_type === 'Part Time' ? 'PT' : 'FT',
      suggestedCode: null,
      licenseEnd: row.license_end,
      status: row.status
    };
  },

  markHired(id) {
    try { hiring.setStatus(id, 'Active'); } catch { /* already active / missing */ }
  },

  /** Image bytes for a document (used by the platform's image proxy). */
  document(id) {
    const c = conn();
    if (!c) return null;
    return c.prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
  },

  search(q, limit = 8) {
    const c = conn();
    if (!c) return [];
    return c.prepare(`SELECT id, full_name, national_id, phone, status FROM couriers
                      WHERE full_name LIKE ? OR phone LIKE ? OR national_id LIKE ?
                      ORDER BY created_at DESC LIMIT ?`).all(`%${q}%`, `%${q}%`, `%${q}%`, limit)
      .map(r => ({ id: r.id, title: r.full_name, subtitle: r.national_id, meta: r.status }));
  }
};

export default hiring;
