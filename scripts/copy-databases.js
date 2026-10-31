/**
 * Copies the three source databases into ./data (never modifies the originals).
 * SQLite WAL files are copied too so uncommitted-but-checkpointed data is kept.
 *
 *   npm run copy:databases
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');

const SOURCES = {
  'roster.db': process.env.SOURCE_ROSTER_DB || 'C:/Users/youss/Bankai_Roster_Attendancee/bankai.db',
  'hiring.db': process.env.SOURCE_HIRING_DB || 'C:/Users/youss/Bankai-Hiring/data/bankai-hiring.db',
  'ticketing.db': process.env.SOURCE_TICKETING_DB || 'C:/Users/youss/das-ticketing-system/database.db'
};

fs.mkdirSync(DATA, { recursive: true });

for (const [target, source] of Object.entries(SOURCES)) {
  if (!fs.existsSync(source)) {
    console.log(`⚠️  missing source: ${source} (skipped)`);
    continue;
  }
  const dest = path.join(DATA, target);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = source + suffix;
    const to = dest + suffix;
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  }
  console.log(`✅ ${path.basename(source)} → data/${target}`);
}

console.log('\nSources were not modified. Point ROSTER_DB / HIRING_DB / TICKETING_DB at the live files in production.');
