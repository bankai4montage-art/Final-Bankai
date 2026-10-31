/**
 * Bootstrap the three module databases inside DATA_DIR when they are missing.
 * Runs before `server.js` on boot so a fresh volume is immediately usable.
 *
 *   node scripts/bootstrap-data.js
 *
 * If a database already exists it is left untouched.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const rosterPath = process.env.ROSTER_DB || path.join(DATA, 'roster.db');
const hiringPath = process.env.HIRING_DB || path.join(DATA, 'hiring.db');
const ticketingPath = process.env.TICKETING_DB || path.join(DATA, 'ticketing.db');

const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = () => new Date().toISOString();

/* ------------------------------ roster ------------------------------ */
if (!fs.existsSync(rosterPath)) {
  const db = new Database(rosterPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(120), employee_code VARCHAR(60),
      branch VARCHAR(20), shift VARCHAR(80), employment_type VARCHAR(10), day_off VARCHAR(12),
      active BOOLEAN DEFAULT 1, phone VARCHAR(30), break_start VARCHAR(5), break_min INTEGER DEFAULT 60,
      off_locked BOOLEAN DEFAULT 0, created_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
      attendance_date DATE NOT NULL, status VARCHAR(20) NOT NULL, fine FLOAT DEFAULT 0,
      reason VARCHAR(500) DEFAULT '', note VARCHAR(500) DEFAULT '', updated_at DATETIME,
      UNIQUE (employee_id, attendance_date)
    );
    CREATE TABLE IF NOT EXISTS shift_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, branch VARCHAR(20), name VARCHAR(80));
    CREATE TABLE IF NOT EXISTS week_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT, week_start DATE, employee_id INTEGER,
      shift VARCHAR(80), day_off VARCHAR(12), break_start VARCHAR(5), break_min INTEGER, off_locked BOOLEAN
    );
    CREATE TABLE IF NOT EXISTS settings (key VARCHAR(60) PRIMARY KEY, value VARCHAR(500));
  `);

  const staff = [
    ['Ahmed Mahmoud', 'DAS-101', 'QCD 1', '08:00-16:00', 'FT', 'Friday'],
    ['Sara Mostafa', 'DAS-102', 'QCD 1', '14:00-22:00', 'FT', 'Saturday'],
    ['Omar Tarek', 'DAS-103', 'QCD 2', '12:00-20:00', 'PT', 'Monday'],
    ['Mona Adel', 'DAS-104', 'QCD 2', '08:00-16:00', 'FT', 'Tuesday'],
    ['Youssef Khaled', 'DAS-105', 'QCD 1', '16:00-00:00', 'PT', 'Sunday'],
    ['Nour Hassan', 'DAS-106', 'QCD 2', '06:00-14:00', 'FT', 'Wednesday'],
    ['Khaled Zaki', 'DAS-107', 'QCD 1', '14:00-22:00', 'FT', 'Thursday'],
    ['Mai Ibrahim', 'DAS-108', 'QCD 2', '10:00-18:00', 'FT', 'Friday']
  ];
  const ins = db.prepare(`INSERT INTO employees
    (name, employee_code, branch, shift, employment_type, day_off, active, phone, break_start, break_min, off_locked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, '18:00', 60, 0, ?)`);
  staff.forEach(([n, c, b, s, t, o], i) => ins.run(n, c, b, s, t, o, `010000000${String(i).padStart(2, '0')}`, now()));

  db.prepare(`INSERT INTO shift_defs (branch, name) VALUES
    ('QCD 1','08:00-16:00'),('QCD 1','14:00-22:00'),('QCD 2','12:00-20:00'),('QCD 2','06:00-14:00')`).run();

  const emps = db.prepare('SELECT id FROM employees').all();
  const att = db.prepare(`INSERT OR IGNORE INTO attendance (employee_id, attendance_date, status, fine, reason, note, updated_at)
                          VALUES (?, ?, ?, ?, '', '', ?)`);
  const statuses = ['Present', 'Present', 'Present', 'Late', 'Absent', 'Present', 'Excused', 'Present'];
  emps.forEach((e, i) => {
    const st = statuses[i % statuses.length];
    att.run(e.id, iso(today), st, st === 'Late' ? 25 : st === 'Absent' ? 50 : 0, now());
    const y = new Date(today); y.setDate(y.getDate() - 1);
    att.run(e.id, iso(y), i % 3 ? 'Present' : 'Late', i % 3 ? 0 : 25, now());
  });
  db.close();
  console.log(`✅ created roster.db with ${emps.length} employees`);
} else {
  console.log('ℹ️  roster.db already present');
}

/* ------------------------------ hiring ------------------------------ */
if (!fs.existsSync(hiringPath)) {
  const db = new Database(hiringPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS couriers (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT NOT NULL,
      national_id TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, employment_type TEXT NOT NULL,
      license_start TEXT NOT NULL, license_end TEXT NOT NULL, outlook TEXT DEFAULT '',
      plate TEXT DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, courier_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, data BLOB, created_at TEXT NOT NULL,
      thumb BLOB, thumb_size INTEGER, storage TEXT DEFAULT 'db', file_key TEXT, thumb_key TEXT
    );
    CREATE TABLE IF NOT EXISTS courier_events (
      id TEXT PRIMARY KEY, courier_id TEXT NOT NULL, type TEXT NOT NULL,
      from_status TEXT, to_status TEXT, note TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_courier ON documents(courier_id);
  `);
  const rows = [
    ['أحمد محمد سعيد', '01012345678', '29901011234567', 'QCD1', 'Full Time', '2024-11-01', '2027-10-31', 'ahmed.saeed@bankai.com', 'ABC 123', 'Active'],
    ['Youssef Khaled', '01123456789', '30005051234567', 'QCD2', 'Part Time', '2025-06-15', '2027-06-14', 'youssef.k@bankai.com', 'XYZ 456', 'Attended to D0'],
    ['محمود علي حسن', '01234567890', '29803031234567', 'QCD1', 'Full Time', '2024-01-10', '2027-01-09', '', 'JKL 789', 'Inactive'],
    ['Omar Tarek', '01098765432', '30109101234567', 'QCD2', 'Part Time', '2025-09-01', '2027-09-30', '', 'MNO 321', 'OnBoarding'],
    ['Mostafa Gamal', '01555555555', '30107071234567', 'QCD2', 'Full Time', '2024-02-01', '2027-12-31', '', 'QRS 654', 'OffBoarding'],
    ['Nour Hassan', '01511112222', '30202021234567', 'QCD1', 'Full Time', '2026-01-01', '2028-01-01', '', 'TUV 987', 'OnBoarding']
  ];
  const ins = db.prepare(`INSERT INTO couriers
    (id, full_name, phone, national_id, branch, employment_type, license_start, license_end, outlook, plate, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ev = db.prepare(`INSERT INTO courier_events (id, courier_id, type, from_status, to_status, note, created_at)
                         VALUES (?, ?, 'created', NULL, ?, 'seeded', ?)`);
  rows.forEach((r, i) => {
    const id = crypto.randomUUID();
    const stamp = new Date(Date.now() - i * 86400000 * 3).toISOString();
    ins.run(id, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], stamp, stamp);
    ev.run(crypto.randomUUID(), id, r[9], stamp);
  });
  db.close();
  console.log(`✅ created hiring.db with ${rows.length} candidates`);
} else {
  console.log('ℹ️  hiring.db already present');
}

/* ------------------------------ ticketing ------------------------------ */
if (!fs.existsSync(ticketingPath)) {
  const db = new Database(ticketingPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, das_code TEXT, courier_name TEXT, category TEXT,
      sub_type TEXT, issue_date TEXT, description TEXT, status TEXT, admin_note TEXT,
      created_at DATETIME, updated_at DATETIME, archived INTEGER DEFAULT 0,
      rating INTEGER, rating_note TEXT, rated_at DATETIME, seen_note TEXT, seen_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS couriers (das_code TEXT PRIMARY KEY, name TEXT, phone TEXT);
    CREATE TABLE IF NOT EXISTS advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, das_code TEXT, courier_name TEXT, amount REAL,
      reason TEXT, wallet TEXT, status TEXT, admin_note TEXT, created_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, button_text TEXT, button_url TEXT,
      audience TEXT, audience_value TEXT, start_date TEXT, end_date TEXT, active INTEGER DEFAULT 1,
      created_at DATETIME, sort_order INTEGER, choices TEXT
    );
  `);
  const rows = [
    ['DAS-101', 'Ahmed Mahmoud', 'الشيفت', 'تأخير في الوردية', 'اتأخرت 20 دقيقة بسبب الزحمة', 'قيد المراجعة'],
    ['DAS-102', 'Sara Mostafa', 'السلف', 'طلب سلفة', 'محتاجة سلفة 500 جنيه', 'يتم المراجعة'],
    ['DAS-103', 'Omar Tarek', 'الرخصة', 'تجديد رخصة', 'الرخصة هتنتهي الشهر الجاي', 'لازم تيجي المكتب'],
    ['DAS-104', 'Mona Adel', 'الشيفت', 'تبديل وردية', 'محتاجة أبدل وردية الجمعة', 'اتحلت'],
    ['DAS-105', 'Youssef Khaled', 'أخرى', 'مشكلة في التطبيق', 'التطبيق بيقفل لوحده', 'قيد المراجعة'],
    ['DAS-106', 'Nour Hassan', 'السلف', 'تأخير في الصرف', 'السلفة اتأخرت أسبوع', 'اتحلت'],
    ['DAS-107', 'Khaled Zaki', 'الرخصة', 'رخصة منتهية', 'الرخصة منتهية من أسبوعين', 'قيد المراجعة']
  ];
  const ins = db.prepare(`INSERT INTO tickets
    (das_code, courier_name, category, sub_type, issue_date, description, status, created_at, updated_at, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  rows.forEach((r, i) => {
    const d = new Date(today); d.setDate(d.getDate() - i);
    ins.run(r[0], r[1], r[2], r[3], iso(d), r[4], r[5], now(), now());
  });
  db.close();
  console.log(`✅ created ticketing.db with ${rows.length} tickets`);
} else {
  console.log('ℹ️  ticketing.db already present');
}

console.log('Bootstrap complete.');
