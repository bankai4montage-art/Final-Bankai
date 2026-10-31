/**
 * Seeds demo rows into the *copies* in ./data so the platform can be explored
 * without touching production data. Safe to run twice (idempotent).
 *
 *   node scripts/seed-demo.js
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* ------------------------------ roster ------------------------------ */
const rosterPath = path.join(DATA, 'roster.db');
if (fs.existsSync(rosterPath)) {
  const db = new Database(rosterPath);
  const count = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
  if (count === 0) {
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
    const ins = db.prepare(`INSERT INTO employees (name, employee_code, branch, shift, employment_type, day_off, active, phone, break_start, break_min, off_locked, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, 1, ?, '18:00', 60, 0, ?)`);
    const stamp = new Date().toISOString();
    staff.forEach(([name, code, branch, shift, type, off], i) => {
      ins.run(name, code, branch, shift, type, off, `0100000000${i}`, stamp);
    });

    db.prepare(`INSERT OR IGNORE INTO shift_defs (branch, name) VALUES ('QCD 1','08:00-16:00'),('QCD 1','14:00-22:00'),('QCD 2','12:00-20:00'),('QCD 2','06:00-14:00')`).run();

    const employees = db.prepare('SELECT id FROM employees').all();
    const att = db.prepare(`INSERT OR IGNORE INTO attendance (employee_id, attendance_date, status, fine, reason, note, updated_at)
                            VALUES (?, ?, ?, ?, '', '', ?)`);
    const statuses = ['Present', 'Present', 'Present', 'Late', 'Absent', 'Present', 'Excused', 'Present'];
    employees.forEach((e, i) => {
      const status = statuses[i % statuses.length];
      att.run(e.id, iso(today), status, status === 'Late' ? 25 : status === 'Absent' ? 50 : 0, new Date().toISOString());
      const y = new Date(today); y.setDate(y.getDate() - 1);
      att.run(e.id, iso(y), i % 3 ? 'Present' : 'Late', i % 3 ? 0 : 25, new Date().toISOString());
    });
    console.log(`✅ roster demo: ${employees.length} employees + 2 days of attendance`);
  } else {
    console.log(`ℹ️  roster already has ${count} employees — skipped`);
  }
  db.close();
}

/* ------------------------------ ticketing ------------------------------ */
const ticketPath = path.join(DATA, 'ticketing.db');
if (fs.existsSync(ticketPath)) {
  const db = new Database(ticketPath);
  const count = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
  if (count === 0) {
    const rows = [
      ['DAS-101', 'Ahmed Mahmoud', 'الشيفت', 'تأخير في الوردية', 'اتأخرت 20 دقيقة بسبب الزحمة', 'قيد المراجعة', 0],
      ['DAS-102', 'Sara Mostafa', 'السلف', 'طلب سلفة', 'محتاجة سلفة 500 جنيه', 'يتم المراجعة', 1],
      ['DAS-103', 'Omar Tarek', 'الرخصة', 'تجديد رخصة', 'الرخصة هتنتهي الشهر الجاي', 'لازم تيجي المكتب', 0],
      ['DAS-104', 'Mona Adel', 'الشيفت', 'تبديل وردية', 'محتاجة أبدل وردية الجمعة', 'اتحلت', 3],
      ['DAS-105', 'Youssef Khaled', 'أخرى', 'مشكلة في التطبيق', 'التطبيق بيقفل لوحده', 'قيد المراجعة', 0],
      ['DAS-106', 'Nour Hassan', 'السلف', 'تأخير في الصرف', 'السلفة اتأخرت أسبوع', 'اتحلت', 5],
      ['DAS-107', 'Khaled Zaki', 'الرخصة', 'رخصة منتهية', 'الرخصة منتهية من أسبوعين', 'قيد المراجعة', 0]
    ];
    const stamp = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO tickets (das_code, courier_name, category, sub_type, issue_date, description, status, rating, created_at, updated_at, archived)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
    rows.forEach((r, i) => {
      const d = new Date(today); d.setDate(d.getDate() - i);
      ins.run(r[0], r[1], r[2], r[3], iso(d), r[4], r[5], r[6], stamp, stamp);
    });
    console.log(`✅ ticketing demo: ${rows.length} tickets`);
  } else {
    console.log(`ℹ️  ticketing already has ${count} tickets — skipped`);
  }
  db.close();
}

console.log('\nDone. The originals were not touched — only the copies in ./data.');
