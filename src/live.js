/**
 * Final-Bankai — live event hub (Server-Sent Events).
 *
 * Goal: any change inside ANY member system is heard here immediately.
 *
 * Sources (each with its own transport, all read-only):
 *   hiring   → its public /api/events recent-activity endpoint
 *   roster   → its long-poll /api/events?since=<rev> revision bus
 *              (authed with ROSTER_URL admin password — recorder-worthy role)
 *   tickets  → /api/admin/tickets + /api/admin/advances diffs
 *              (authed with the same HMAC token the admin UI derives)
 *   platform → internal audit log + notifications (final.db)
 *
 * Every normalised event is broadcast as `data: {…}` to subscribed tabs
 * over GET /api/live (requireAuth).
 */

import crypto from 'node:crypto';
import { sqlite } from './db.js';
import { SYSTEM_UPSTREAMS } from './proxy.js';

const UP = SYSTEM_UPSTREAMS;
const ROSTER_PASSWORD = process.env.ROSTER_PASSWORD || '';
const DAS_ADMIN_PASS = process.env.DAS_ADMIN_PASS || '';

const MODULE_COLOURS = { Hiring: 'var(--purple)', Roster: 'var(--turq)', Tickets: 'var(--info)', Platform: 'var(--text-2)' };

/* Rosette: roster kinds → readable titles */
const ROSTER_KIND = {
  employees: 'Employees',
  attendance: 'Attendance',
  fines: 'Fines',
  schedule: 'Schedule',
  settings: 'Settings'
};
const ROSTER_ACTIONS = {
  create: 'created', update: 'updated', move: 'moved', deactivate: 'deactivated',
  import: 'imported', 'import-schedule': 'schedule imported', 'shift-create': 'new shift added',
  'shift-delete': 'shift deleted', 'shift-rename': 'shift renamed'
};

class LiveHub {
  constructor() {
    this.clients = new Set();          // SSE responses
    this.buffer = [];                  // last 60 events for late tabs
    this.seq = Math.floor(Date.now() / 1000);
    this.rosterToken = '';
    this.rosterRev = 0;
    this.rosterReconnecting = false;
    this.hiringStamp = '';             // newest hiring event stamp
    this.dasSnapshot = new Map();      // id → { status, admin_note, updated_at }
    this.dasAdvSnapshot = new Map();
    this.auditLastId = 0;
    this.notifLastId = '';
  }

  /* ---- SSE plumbing ---- */
  subscribe(res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', user: user.name, buffer: this.buffer })}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20000);
    res.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  broadcast(ev) {
    // small buffer for late tabs & dedupe
    this.buffer.push(ev);
    if (this.buffer.length > 60) this.buffer.shift();
    for (const res of this.clients) {
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* gone */ }
    }
  }

  emit({ module, kind, title, body = '', at = new Date().toISOString(), link = '' }) {
    const ev = { type: 'event', id: ++this.seq, module, kind, colour: MODULE_COLOURS[module] || 'var(--purple)', title, body, at, link };
    this.broadcast(ev);
  }

  /* ---- platform (audit + notifications in final.db) ---- */
  pollPlatform() {
    try {
      const rows = sqlite.prepare(
        'SELECT id, action, module, entity, entity_id, detail, created_at, user_email FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT 20'
      ).all(this.auditLastId);
      for (const r of rows) {
        this.auditLastId = r.id;
        const who = (r.user_email || '').split('@')[0] || 'system';
        this.emit({
          module: 'Platform', kind: 'audit',
          title: this.nice(r.action, r.module),
          body: `${who} · ${r.module} · ${r.entity || ''}${r.entity_id ? ' #' + r.entity_id : ''}`,
          at: r.created_at, link: ''
        });
      }
    } catch (e) { /* db hiccup — next round */ }
  }

  nice(action, mod) {
    return String(action || mod || '').replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /* ---- hiring (public /api/events) ---- */
  async pollHiring() {
    if (!UP.hiring) return;
    try {
      const res = await fetch(`${UP.hiring.url}/api/events?limit=15`, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) { if (process.env.PROXY_DEBUG) console.log('[hub] hiring poll', res.status); return; }
      const items = await res.json();
      const list = Array.isArray(items) ? items : items.items || [];
      if (process.env.PROXY_DEBUG) console.log(`[hub] hiring poll → ${list.length} events (stamp: ${this.hiringStamp || '?'})`);
      for (const e of [...list].reverse()) {
        const stamp = e.createdAt || e.created_at || '';
        if (!stamp || stamp <= this.hiringStamp) continue;
        this.hiringStamp = stamp;
        const who = (e.user_name || e.userEmail || '') + '';
        this.emit({
          module: 'Hiring', kind: e.type || 'update',
          title: `${e.type === 'status' && e.toStatus ? `Status → ${e.toStatus}` : this.nice(e.type, 'record')}`,
          body: `${who} ${e.note ? '· ' + e.note : ''}`.trim(),
          at: stamp, link: '#/system/hiring'
        });
      }
    } catch { /* offline — silent */ }
  }

  /* ---- roster (long-poll revision bus, authed) ---- */
  async rosterLogin() {
    if (!ROSTER_PASSWORD) return false;
    try {
      const res = await fetch(`${UP.roster.url}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ROSTER_PASSWORD }), signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) return false;
      const data = await res.json();
      this.rosterToken = data.token || '';
      return !!this.rosterToken;
    } catch { return false; }
  }

  async rosterLongPoll() {
    if (!ROSTER_PASSWORD || !UP.roster) { setTimeout(() => this.rosterLongPoll(), 30000); return; }
    try {
      if (!this.rosterToken) {
        this.rosterToken = await this.rosterLogin() ? this.rosterToken : '';
        if (!this.rosterToken) { setTimeout(() => this.rosterLongPoll(), 30000); return; }
      }
      const res = await fetch(`${UP.roster.url}/api/events?since=${this.rosterRev}&wait=20`, {
        headers: { Authorization: `Bearer ${this.rosterToken}` }, signal: AbortSignal.timeout(29000)
      });
      if (res.status === 401) { this.rosterToken = ''; setTimeout(() => this.rosterLongPoll(), 4000); return; }
      if (!res.ok) { setTimeout(() => this.rosterLongPoll(), 6000); return; }
      const data = await res.json();
      if (data.reset) this.rosterRev = Math.max(0, data.rev - 1);
      for (const e of data.events || []) {
        if (e.rev) this.rosterRev = Math.max(this.rosterRev, e.rev);
        const label = ROSTER_KIND[e.kind] || e.kind;
        const action = ROSTER_ACTIONS[e.action] || e.action || '';
        let title = label + (action ? ` ${action}` : '');
        let body = '';
        if (e.kind === 'attendance') {
          title = `Attendance updated`;
          body = `${e.date || ''}${e.wipe ? ' · reset' : ''}`;
        } else if (Array.isArray(e.names) && e.names.length) {
          body = e.names.slice(0, 2).join(' · ') + (e.names.length > 2 ? ` +${e.names.length - 2}` : '') + (e.by ? ` · ${e.by}` : '');
        } else if (e.branch) {
          body = `${e.branch}${e.count != null ? ` · ${e.count}` : ''}${e.by ? ' · ' + e.by : ''}`;
        } else if (e.by) body = e.by;
        this.emit({ module: 'Roster', kind: e.kind + (e.action ? ':' + e.action : ''), title, body, at: e.at, link: '#/system/roster' });
      }
    } catch {
      // network hiccup: cool off a bit before the next long poll
      setTimeout(() => this.rosterLongPoll(), 6000);
      return;
    }
    this.rosterLongPoll();
  }

  /* ---- tickets (admin-scoped diffing) ---- */
  dasToken() {
    if (!DAS_ADMIN_PASS) return '';
    return crypto.createHmac('sha256', DAS_ADMIN_PASS).update('das-admin-session-v1').digest('hex');
  }

  async pollTickets() {
    if (!DAS_ADMIN_PASS || !UP.tickets) return;
    const token = this.dasToken();
    try {
      const res = await fetch(`${UP.tickets.url}/api/admin/tickets`, {
        headers: { 'x-admin-token': token }, signal: AbortSignal.timeout(7000)
      });
      if (!res.ok) return;
      const { tickets = [] } = await res.json();
      for (const t of tickets) {
        const prev = this.dasSnapshot.get(t.id);
        const now = t.status || '';
        if (prev) {
          if (prev.status !== now || prev.admin_note !== (t.admin_note || '')) {
            this.emit({
              module: 'Tickets', kind: 'ticket:status',
              title: `Ticket #${t.id} → ${now}`, body: `${t.courier_name || ''} · ${t.category || ''}`.trim(),
              at: t.updated_at, link: '#/system/tickets'
            });
          }
        } else if (tickets.length && !this.dasSnapshot.size) {
          // first snapshot: only light up NEW ones (id above max at boot is impossible; treat all as baseline)
        } else if (t.id > (this.dasSnapshotMax || 0)) {
          this.emit({
            module: 'Tickets', kind: 'ticket:new',
            title: `New ticket #${t.id}`, body: `${t.courier_name || ''} · ${t.category || ''}`.trim(),
            at: t.created_at, link: '#/system/tickets'
          });
        }
        this.dasSnapshot.set(t.id, { status: now, admin_note: t.admin_note || '' });
        this.dasSnapshotMax = Math.max(this.dasSnapshotMax || 0, t.id);
        if (this.dasSnapshot.size > 400) {
          const ids = [...this.dasSnapshot.keys()].sort((a, b) => b - a).slice(0, 200);
          this.dasSnapshot = new Map(ids.map((id) => [id, this.dasSnapshot.get(id)]));
        }
      }
    } catch { /* offline — silent */ }
  }

  async pollAdvances() {
    if (!DAS_ADMIN_PASS || !UP.tickets) return;
    try {
      const res = await fetch(`${UP.tickets.url}/api/admin/advances`, {
        headers: { 'x-admin-token': this.dasToken() }, signal: AbortSignal.timeout(7000)
      });
      if (!res.ok) return;
      const { advances = [] } = await res.json();
      for (const a of advances) {
        const prev = this.dasAdvSnapshot.get(a.id);
        const now = a.status || '';
        if (prev && prev.status !== now) {
          this.emit({
            module: 'Tickets', kind: 'advance:status',
            title: `Advance #${a.id} → ${now}`, body: `${a.courier_name || a.das_code || ''}`.trim(),
            at: a.updated_at || a.created_at, link: '#/system/tickets'
          });
        }
        this.dasAdvSnapshot.set(a.id, { status: now });
        if (this.dasAdvSnapshot.size > 300) {
          const ids = [...this.dasAdvSnapshot.keys()].sort((a, b) => b - a).slice(0, 150);
          this.dasAdvSnapshot = new Map(ids.map((id) => [id, this.dasAdvSnapshot.get(id)]));
        }
      }
    } catch { /* silent */ }
  }

  /* ---- boot ---- */
  async prime() {
    /* warm the cursors WITHOUT emitting the backlog (only forward changes count) */
    try {
      const row = sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').get();
      this.auditLastId = row?.id || 0;
    } catch { /* fresh db */ }
    try {
      const res = await fetch(`${UP.hiring.url}/api/events?limit=1`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const list = await res.json();
        const first = (Array.isArray(list) ? list : list.items || [])[0];
        this.hiringStamp = first?.createdAt || first?.created_at || '';
      }
    } catch { /* offline */ }
    try {
      await this.rosterLogin();
      const snap = await fetch(`${UP.roster.url}/api/events?since=2000000000&wait=0`, {
        headers: { Authorization: `Bearer ${this.rosterToken}` }, signal: AbortSignal.timeout(7000)
      });
      if (snap.ok) {
        const data = await snap.json();
        this.rosterRev = data.rev || 0;
      }
    } catch { /* long-poll loop will re-login lazily */ }
    try {
      const res = await fetch(`${UP.tickets.url}/api/admin/tickets`, {
        headers: { 'x-admin-token': this.dasToken() }, signal: AbortSignal.timeout(7000)
      });
      if (res.ok) {
        const { tickets = [] } = await res.json();
        for (const t of tickets) this.dasSnapshot.set(t.id, { status: t.status || '', admin_note: t.admin_note || '' });
        this.dasSnapshotMax = Math.max(0, ...tickets.map((t) => t.id));
        const adv = await fetch(`${UP.tickets.url}/api/admin/advances`, {
          headers: { 'x-admin-token': this.dasToken() }, signal: AbortSignal.timeout(7000)
        });
        if (adv.ok) {
          const { advances = [] } = await adv.json();
          for (const a of advances) this.dasAdvSnapshot.set(a.id, { status: a.status || '' });
        }
      }
    } catch { /* first diff pass will baseline */
    }
  }

  start() {
    const TICK = { platform: 3000, hiring: 6000, tickets: 6000, advances: 9000 };
    this.prime().finally(() => {
      this.pollPlatform(); setInterval(() => this.pollPlatform(), TICK.platform);
      this.pollHiring(); setInterval(() => this.pollHiring(), TICK.hiring);
      setInterval(() => this.pollTickets(), TICK.tickets);
      setInterval(() => this.pollAdvances(), TICK.advances);
      this.rosterLongPoll();
      console.log(`📡 live hub started (sources: hiring ✓ tickets ${DAS_ADMIN_PASS ? '✓' : '— no DAS_ADMIN_PASS'} roster ${ROSTER_PASSWORD ? '✓' : '— no ROSTER_PASSWORD'} platform ✓)`);
    });
  }
}

const live = new LiveHub();
export default live;
