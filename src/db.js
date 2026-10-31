/**
 * Final-Bankai — platform database (`final.db`).
 *
 * Owns identity, permissions, sessions, notifications, audit trail and the
 * cross-system link table. Domain data lives in the three module databases and
 * is only reached through the adapters.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

fs.mkdirSync(path.dirname(config.finalDb), { recursive: true });

export const sqlite = new Database(config.finalDb);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',   -- active | suspended
    avatar_color  TEXT DEFAULT '#7C5CFF',
    last_login_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS permission_overrides (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    perm       TEXT NOT NULL,
    allowed    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, perm)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf        TEXT NOT NULL,
    user_agent  TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT,
    user_email  TEXT,
    action      TEXT NOT NULL,
    module      TEXT NOT NULL,
    entity      TEXT,
    entity_id   TEXT,
    detail      TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    module      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    link        TEXT,
    read_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);

  /** Cross-system links: candidate ↔ employee ↔ ticket. */
  CREATE TABLE IF NOT EXISTS links (
    id           TEXT PRIMARY KEY,
    left_kind    TEXT NOT NULL,          -- candidate | employee | ticket
    left_id      TEXT NOT NULL,
    right_kind   TEXT NOT NULL,
    right_id     TEXT NOT NULL,
    meta         TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_links_pair ON links(left_kind, left_id, right_kind, right_id);

  /** Ticket comments live in the platform plane (the ticket DB has no comments table). */
  CREATE TABLE IF NOT EXISTS ticket_comments (
    id          TEXT PRIMARY KEY,
    ticket_id   TEXT NOT NULL,
    user_id     TEXT,
    user_name   TEXT,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_comments ON ticket_comments(ticket_id, created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

/* ------------------------- small helpers ------------------------- */

export const setting = {
  get(key, fallback = null) {
    const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  set(key, value) {
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
};

export const links = {
  add({ leftKind, leftId, rightKind, rightId, meta = null, by = null }) {
    const id = uid();
    sqlite.prepare(`INSERT OR IGNORE INTO links (id, left_kind, left_id, right_kind, right_id, meta, created_by, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, leftKind, String(leftId), rightKind, String(rightId), meta ? JSON.stringify(meta) : null, by, now());
    return sqlite.prepare(`SELECT * FROM links WHERE left_kind = ? AND left_id = ? AND right_kind = ? AND right_id = ?`)
      .get(leftKind, String(leftId), rightKind, String(rightId));
  },
  of(kind, id) {
    return sqlite.prepare(`SELECT * FROM links WHERE (left_kind = ? AND left_id = ?) OR (right_kind = ? AND right_id = ?)`)
      .all(kind, String(id), kind, String(id));
  },
  find(kind, id, otherKind) {
    return sqlite.prepare(`SELECT * FROM links WHERE ((left_kind = ? AND left_id = ? AND right_kind = ?)
                                                     OR (right_kind = ? AND right_id = ? AND left_kind = ?)) LIMIT 1`)
      .get(kind, String(id), otherKind, kind, String(id), otherKind);
  }
};

export default sqlite;
