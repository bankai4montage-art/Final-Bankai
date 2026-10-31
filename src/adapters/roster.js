/**
 * Roster adapter — talks to the Bankai Roster & Attendance database.
 *
 * Read: employees, branches, shifts, weekly schedule, attendance, fines.
 * Write (only what the platform needs):
 *   · upsert one attendance row for one employee/date (same columns as the app)
 *   · create an employee when a candidate is converted (no schedule rewrite)
 *
 * The adapter degrades gracefully when the database file is absent.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import config from '../config.js';

let db = null;
let openedPath = null;

function conn() {
  if (db && openedPath === config.rosterDb) return db;
  if (!fs.existsSync(config.rosterDb)) return null;
  db = new Database(config.rosterDb, { readonly: false, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  openedPath = config.rosterDb;
  return db;
}

export const rosterAvailable = () => fs.existsSync(config.rosterDb);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const iso = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export function weekStart(dateStr) {
  const d = new Date(`${dateStr || iso(new Date())}T00:00:00`);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return iso(d);
}

export const STATUSES = ['Present', 'Late', 'Absent', 'Excused'];

export const roster = {
  available: rosterAvailable,

  /** Employees with optional filters (server-side). */
  employees({ q = '', branch = '', shift = '', active = '', limit = 200, offset = 0 } = {}) {
    const c = conn();
    if (!c) return { items: [], total: 0 };
    const where = [];
    const params = [];
    if (q) { where.push('(name LIKE ? OR employee_code LIKE ? OR phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (branch) { where.push('branch = ?'); params.push(branch); }
    if (shift) { where.push('shift = ?'); params.push(shift); }
    if (active !== '' && active != null) { where.push('active = ?'); params.push(Number(active) ? 1 : 0); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = c.prepare(`SELECT COUNT(*) AS n FROM employees ${w}`).get(...params).n;
    const items = c.prepare(`SELECT * FROM employees ${w} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, Math.min(500, Number(limit) || 200), Number(offset) || 0)
      .map(mapEmployee);
    return { items, total };
  },

  employee(id) {
    const c = conn();
    if (!c) return null;
    const row = c.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));
    return row ? mapEmployee(row) : null;
  },

  findByPhoneOrCode({ phone, code } = {}) {
    const c = conn();
    if (!c) return null;
    if (code) {
      const byCode = c.prepare('SELECT * FROM employees WHERE employee_code = ?').get(String(code));
      if (byCode) return mapEmployee(byCode);
    }
    if (phone) {
      const byPhone = c.prepare('SELECT * FROM employees WHERE phone = ?').get(String(phone));
      if (byPhone) return mapEmployee(byPhone);
    }
    return null;
  },

  branches() {
    const c = conn();
    if (!c) return [];
    return c.prepare('SELECT branch, COUNT(*) AS n FROM employees WHERE active = 1 GROUP BY branch ORDER BY branch').all();
  },

  shifts() {
    const c = conn();
    if (!c) return [];
    return c.prepare('SELECT name FROM shift_defs ORDER BY name').all().map(r => r.name);
  },

  /** Attendance rows for a day (with the employee attached). */
  attendanceFor(dateStr) {
    const c = conn();
    if (!c) return [];
    const day = dateStr || iso(new Date());
    return c.prepare(`SELECT a.*, e.name, e.employee_code, e.branch, e.shift, e.employment_type, e.day_off, e.active
                      FROM attendance a JOIN employees e ON e.id = a.employee_id
                      WHERE a.attendance_date = ? ORDER BY e.name COLLATE NOCASE`).all(day)
      .map(r => ({
        id: r.id, employeeId: r.employee_id, employeeName: r.name, code: r.employee_code,
        branch: r.branch, shift: r.shift, employmentType: r.employment_type,
        dayOff: r.day_off, status: r.status, fine: r.fine, reason: r.reason, note: r.note,
        updatedAt: r.updated_at
      }));
  },

  /** Everybody expected to work on a date (employees whose day-off isn't that weekday). */
  expectedFor(dateStr) {
    const c = conn();
    if (!c) return [];
    const d = new Date(`${dateStr}T00:00:00`);
    const weekday = DAY_NAMES[d.getDay()];
    return c.prepare(`SELECT * FROM employees WHERE active = 1 AND (day_off IS NULL OR day_off != ?)
                      ORDER BY name COLLATE NOCASE`).all(weekday).map(mapEmployee);
  },

  /** Insert or update one attendance row. Mirrors the app's column set. */
  setAttendance({ employeeId, date, status, fine = 0, reason = '', note = '' }) {
    const c = conn();
    if (!c) throw new Error('Roster database is not available.');
    if (!STATUSES.includes(status)) throw new Error('Invalid attendance status.');
    const day = date || iso(new Date());
    const existing = c.prepare('SELECT id FROM attendance WHERE employee_id = ? AND attendance_date = ?')
      .get(Number(employeeId), day);
    const stamp = new Date().toISOString();
    if (existing) {
      c.prepare(`UPDATE attendance SET status = ?, fine = ?, reason = ?, note = ?, updated_at = ? WHERE id = ?`)
        .run(status, Number(fine) || 0, reason || '', note || '', stamp, existing.id);
      return { id: existing.id, created: false };
    }
    const info = c.prepare(`INSERT INTO attendance (employee_id, attendance_date, status, fine, reason, note, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(Number(employeeId), day, status, Number(fine) || 0, reason || '', note || '', stamp);
    return { id: info.lastInsertRowid, created: true };
  },

  /** Day totals used by the dashboard. */
  dayMetrics(dateStr) {
    const c = conn();
    if (!c) return { total: 0, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0, fines: 0, branches: [] };
    const day = dateStr || iso(new Date());
    const d = new Date(`${day}T00:00:00`);
    const weekday = DAY_NAMES[d.getDay()];
    const expected = c.prepare(`SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND (day_off IS NULL OR day_off != ?)`)
      .get(weekday).n;
    const rows = c.prepare(`SELECT status, COUNT(*) AS n, SUM(fine) AS f FROM attendance WHERE attendance_date = ? GROUP BY status`)
      .all(day);
    const by = Object.fromEntries(rows.map(r => [r.status, r.n]));
    const fines = rows.reduce((s, r) => s + (r.f || 0), 0);
    const marked = rows.reduce((s, r) => s + r.n, 0);
    const active = c.prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1').get().n;
    const branches = c.prepare('SELECT COUNT(DISTINCT branch) AS n FROM employees WHERE active = 1').get().n;
    return {
      total: active, expected, marked,
      present: by.Present || 0, late: by.Late || 0, absent: by.Absent || 0, excused: by.Excused || 0,
      unmarked: Math.max(0, expected - marked), fines, branches
    };
  },

  /** Last 7 days of attendance counts (for the dashboard chart). */
  weekTrend(dateStr) {
    const c = conn();
    if (!c) return [];
    const end = dateStr || iso(new Date());
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(`${end}T00:00:00`);
      d.setDate(d.getDate() - i);
      const day = iso(d);
      const rows = c.prepare('SELECT status, COUNT(*) AS n FROM attendance WHERE attendance_date = ? GROUP BY status').all(day);
      const by = Object.fromEntries(rows.map(r => [r.status, r.n]));
      out.push({ date: day, label: DAY_NAMES[d.getDay()].slice(0, 3), present: by.Present || 0, late: by.Late || 0, absent: by.Absent || 0 });
    }
    return out;
  },

  /** Highest unused numeric suffix for employee codes like DAS-123. */
  nextEmployeeCode() {
    const c = conn();
    if (!c) return 'DAS-101';
    const rows = c.prepare('SELECT employee_code FROM employees WHERE employee_code IS NOT NULL').all();
    const used = new Set(rows.map(r => String(r.employee_code)));
    let n = 101;
    while (used.has(`DAS-${n}`)) n++;
    return `DAS-${n}`;
  },

  /** Create an employee (used by the hiring → roster conversion). */
  createEmployee({ name, phone = '', branch = 'QCD 1', shift = '', employmentType = 'FT', dayOff = 'Friday', code }) {
    const c = conn();
    if (!c) throw new Error('Roster database is not available.');
    const employeeCode = code || roster.nextEmployeeCode();
    const info = c.prepare(`INSERT INTO employees
      (name, employee_code, branch, shift, employment_type, day_off, active, phone, break_start, break_min, off_locked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, 60, 0, ?)`)
      .run(String(name).trim(), employeeCode, branch, shift || '', employmentType, dayOff, phone || '', new Date().toISOString());
    return roster.employee(info.lastInsertRowid);
  },

  /** Employees that exist but have no attendance row for the day. */
  unmarkedFor(dateStr) {
    const c = conn();
    if (!c) return [];
    const day = dateStr || iso(new Date());
    const d = new Date(`${day}T00:00:00`);
    const weekday = DAY_NAMES[d.getDay()];
    return c.prepare(`SELECT e.* FROM employees e
                      WHERE e.active = 1 AND (e.day_off IS NULL OR e.day_off != ?)
                        AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.attendance_date = ?)
                      ORDER BY e.name COLLATE NOCASE`).all(weekday, day).map(mapEmployee);
  },

  /** Fines summary per employee for a period. */
  finesSummary({ from, to }) {
    const c = conn();
    if (!c) return [];
    return c.prepare(`SELECT e.id, e.name, e.employee_code, e.branch, SUM(a.fine) AS total, COUNT(*) AS days
                      FROM attendance a JOIN employees e ON e.id = a.employee_id
                      WHERE a.fine > 0 AND a.attendance_date BETWEEN ? AND ?
                      GROUP BY e.id ORDER BY total DESC`).all(from, to);
  }
};

function mapEmployee(r) {
  return {
    id: r.id, name: r.name, code: r.employee_code, branch: r.branch, shift: r.shift,
    employmentType: r.employment_type, dayOff: r.day_off, active: !!r.active, phone: r.phone || '',
    breakStart: r.break_start || '', breakMin: r.break_min, createdAt: r.created_at
  };
}

export default roster;
