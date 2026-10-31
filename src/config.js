/**
 * Final-Bankai — runtime configuration.
 * Everything is env-driven so the same build runs locally, in tests and on Railway.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = (envKey, file) => process.env[envKey] || path.join(DATA_DIR, file);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  isProd: (process.env.NODE_ENV || 'development') === 'production',

  /** Platform database (identity, audit, notifications, links). */
  finalDb: dbPath('FINAL_DB', 'final.db'),

  /** Domain databases — point these at the live files/volumes in production. */
  rosterDb: dbPath('ROSTER_DB', 'roster.db'),
  hiringDb: dbPath('HIRING_DB', 'hiring.db'),
  ticketingDb: dbPath('TICKETING_DB', 'ticketing.db'),

  session: {
    cookie: 'fb_session',
    ttlHours: Number(process.env.SESSION_TTL_HOURS || 12)
  },

  bootstrap: {
    email: process.env.ADMIN_EMAIL || 'admin@final-bankai.local',
    password: process.env.ADMIN_PASSWORD || 'ChangeMe!2026',
    name: process.env.ADMIN_NAME || 'Platform Owner'
  },

  /** Slot length for the roster grid (minutes) — mirrors the roster defaults. */
  roster: {
    weekStartsOn: 0 // Sunday
  }
};

export default config;
