# Final-Bankai

> **One Platform. Three Systems. One Identity. One Command Center.**

Final-Bankai unifies three existing systems — **Roster & Attendance**, **Hiring**
and **DAS Ticketing** — behind a single identity, a single navigation and one
cinematic command center, without rewriting or damaging any of them.

| | |
|---|---|
| **Stack** | Node 22 · Express · SQLite (better-sqlite3) · vanilla ES modules |
| **Architecture** | Modular monolith: platform plane + three domain adapters |
| **Auth** | Session cookies, scrypt passwords, RBAC + per-user permission overrides |
| **UI** | Premium dark design system (purple / turquoise), cinematic intro, fully responsive |
| **Tests** | `npm test` — 18 API/integration/authorisation tests |

---

## ✨ What's inside

### One identity
- Single sign-in for every module, `httpOnly` session cookie, server-side revocation.
- Six roles (Super Admin, Admin, Operations Manager, Hiring Manager, Supervisor, Employee)
  and 13 permissions, with per-user allow/deny overrides.
- Every API route authorises **on the server**; the UI only reflects what is allowed.

### Unified dashboard
- Live numbers from all three databases: workforce (present/late/absent/unmarked/fines),
  hiring funnel and ticket backlog.
- 7-day attendance chart, pipeline breakdown, cross-system activity feed.

### Roster & Attendance
- Employees with branch / shift / FT-PT / day-off, searchable and paginated.
- Daily attendance grid: mark Present / Late / Absent / Excused in one click —
  writes to the original attendance table (fines included).

### Hiring
- Visual pipeline (OnBoarding → Attended to D0 → Active → Inactive → OffBoarding) with
  drag & drop, candidate drawer, documents and history.
- **Convert to employee** — the cross-system bridge: creates the roster employee,
  allocates an unused `DAS-###` code, links candidate ↔ employee, marks the candidate
  Active, and writes an audit entry. Idempotent and duplicate-safe.

### DAS Ticketing
- Ticket list with buckets (open / in review / action needed / resolved), search,
  detail drawer, status changes, admin notes and an internal comment timeline.

### Platform
- **Global search** across employees, candidates and tickets — permission-aware.
- **Notification centre** with unread counts, produced by real events
  (new ticket, ticket status change, candidate hired, attendance alerts).
- **Audit log** for every sensitive action (login, conversions, user changes…).
- **Team management** (create users, change roles, suspend, permission overrides).
- **Cinematic intro**: dark, particle-lit logo reveal, skippable, plays once,
  replayable from Settings, honours `prefers-reduced-motion`.

---

## 🚀 Quick start

```bash
git clone https://github.com/bankai4montage-art/Final-Bankai.git
cd Final-Bankai
npm install

# 1) copy the three module databases into ./data (originals untouched)
npm run copy:databases

# 2) optional: add demo rows to the copies
node scripts/seed-demo.js

# 3) run
cp .env.example .env      # then edit ADMIN_EMAIL / ADMIN_PASSWORD
npm start                 # → http://localhost:4000
```

First boot creates the Super Admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (only when
the users table is empty). Sign in, and the intro plays once.

### Tests

```bash
npm test
```

The suite boots the real server against a **temporary copy** of the module databases
and verifies auth, CSRF, RBAC, roster writes, ticket workflow, the hiring→roster
conversion and the audit trail.

---

## 🗂 Project structure

```
Final-Bankai/
├── server.js                 # Express app: auth, permissions, module APIs, SPA
├── src/
│   ├── config.js             # env + paths
│   ├── db.js                 # platform database (users, sessions, audit, links…)
│   ├── auth.js               # scrypt, sessions, RBAC, CSRF, bootstrap
│   ├── audit.js              # audit trail + notifications
│   └── adapters/
│       ├── roster.js         # employees, attendance, fines, codes
│       ├── hiring.js         # candidates, documents, stages
│       └── ticketing.js      # tickets, buckets, metrics
├── public/
│   ├── index.html            # shell + intro + login
│   └── assets/
│       ├── styles.css        # design system
│       └── app.js            # SPA router + views
├── scripts/
│   ├── copy-databases.js     # snapshot the three source DBs into ./data
│   └── seed-demo.js          # demo rows for the copies
├── tests/api.test.js
└── docs/
    ├── INTEGRATION_PLAN.md   # discovery + integration decisions
    ├── ARCHITECTURE.md
    ├── SECURITY.md
    └── DEPLOYMENT.md
```

---

## 🔌 API (summary)

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/api/health` | public |
| POST | `/api/auth/login` · `/api/auth/logout` | public / session |
| GET | `/api/auth/me` | session |
| POST | `/api/auth/password` | session |
| GET | `/api/dashboard` | `dashboard.view` |
| GET | `/api/roster/employees` · `/api/roster/employees/:id` | `roster.view` |
| GET | `/api/roster/attendance` · `/metrics` · `/fines` | `roster.view` |
| POST | `/api/roster/attendance` | `attendance.manage` |
| GET | `/api/hiring/candidates` · `/pipeline` · `/metrics` | `hiring.view` |
| POST | `/api/hiring/candidates/:id/status` | `hiring.manage` |
| POST | `/api/hiring/candidates/:id/convert` | `hiring.convert` |
| GET | `/api/tickets` · `/api/tickets/:id` · `/metrics` | `tickets.view` |
| POST | `/api/tickets` · PATCH `/api/tickets/:id` | `tickets.manage` |
| GET/POST | `/api/tickets/:id/comments` | `tickets.view` |
| GET | `/api/search` | session (filtered by permission) |
| GET/POST | `/api/notifications` · `/api/notifications/read` | session |
| GET/POST/PATCH/DELETE | `/api/users` | `team.manage` |
| GET | `/api/audit` | `audit.view` |
| GET/PUT | `/api/settings` | session |

---

## 🔐 Security highlights

- scrypt password hashing (per-user salt), timing-safe comparison.
- Server-side sessions stored in SQLite, 12 h TTL, revocable, cookie `httpOnly`
  + `SameSite=Lax` + `Secure` in production.
- CSRF token required on every state-changing request.
- Server-side validation on every write; parameterised SQL everywhere.
- Login rate limiting (8 attempts / minute / IP+email).
- Audit log for sensitive actions; no secrets or personal data in logs.
- Original databases are never altered structurally — adapters only read/write
  the documented rows.

See [`docs/SECURITY.md`](docs/SECURITY.md).

---

## 📚 Docs

- [Integration plan](docs/INTEGRATION_PLAN.md) — what each system is, how they were merged.
- [Architecture](docs/ARCHITECTURE.md) — planes, adapters, permission model.
- [Security](docs/SECURITY.md) — controls, threats, hardening checklist.
- [Deployment](docs/DEPLOYMENT.md) — Railway/local, volumes, backups, recovery.

## License

MIT
