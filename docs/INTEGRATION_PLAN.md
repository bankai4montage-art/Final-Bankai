# Final-Bankai — Integration Plan

> One Platform. Three Systems. One Identity. One Command Center.

This document records the discovery of the three source systems, the integration
strategy, and the decisions/risks that shaped Final-Bankai.

---

## 1. Source systems (as found)

| # | System | Stack | Storage | Auth | Scale |
|---|--------|-------|---------|------|-------|
| 1 | **Bankai Roster & Attendance** (`Bankai_Roster_Attendancee`) | Python · FastAPI · uvicorn · openpyxl | SQLite `bankai.db` | single admin password (env `ADMIN_PASSWORD`) + supervisor password → bearer token | 60–200 employees, weekly schedules |
| 2 | **Bankai-Hiring** (`Bankai-Hiring`) | Node 22 · Express · better-sqlite3 · Tailwind (self-hosted) | SQLite `data/bankai-hiring.db` | **none** (open dashboard) | tens of candidates |
| 3 | **DAS Ticketing System** (`das-ticketing-system`) | Node · Express · sqlite3 · web-push | SQLite `database.db` | admin password (env) → `x-admin-token`, courier code login | ~150 couriers, tickets |

### 1.1 Schemas (verbatim, before integration)

**Roster** (`bankai.db`)
- `employees(id, name, employee_code, branch, shift, employment_type, day_off, active, phone, break_start, break_min, off_locked, created_at)`
- `attendance(id, employee_id, attendance_date, status, fine, reason, note, updated_at)` — unique on `(employee_id, attendance_date)`
- `week_schedule(id, week_start, employee_id, shift, day_off, break_start, break_min, off_locked)`
- `shift_defs(id, branch, name)`, `settings(key, value)`
- Business rules: weeks run Sunday→Saturday, first open of a week copies the previous week, attendance statuses are `Present/Late/Absent/Excused`, fines are monetary and also recomputed from lateness.

**Hiring** (`bankai-hiring.db`)
- `couriers(id, full_name, phone, national_id UNIQUE, branch, employment_type, license_start, license_end, outlook, plate, status, created_at, updated_at)`
- `documents(id, courier_id, kind, mime, size, data BLOB, created_at)` + v2 columns (`thumb`, `storage`, `file_key`, `thumb_key`)
- `courier_events(id, courier_id, type, from_status, to_status, note, created_at)`
- Statuses: `Active, OnBoarding, Inactive, OffBoarding, Attended to D0, Not Attended to D0`
- v2 API: pagination, Arabic-normalised search, metrics, S3/R2 capable storage.

**Ticketing** (`database.db`)
- `tickets(id, das_code, courier_name, category, sub_type, issue_date, description, status, admin_note, created_at, updated_at, archived, rating, rating_note, rated_at, seen_note, seen_at)`
- `couriers(das_code PK, name, phone)`, `advances(...)`, `cards(...)`, `card_picks(...)`, `push_subs(...)`
- Statuses seen in the UI: `قيد المراجعة`, `يتم المراجعة`, `لازم تيجي المكتب`, `اتحلت`, `مرفوض` …
- Couriers sign in with their DAS code; admins see every ticket.

### 1.2 What is genuinely valuable in each system

- **Roster**: the only source of truth for *who works today*, shifts, day-offs, fines and weekly schedules.
- **Hiring**: the candidate pipeline, documents (ID/licence images) and licence expiry.
- **Ticketing**: the operational feedback loop (complaints, advances, announcements) tied to a DAS code.

---

## 2. Integration strategy

### 2.1 Options considered

| Option | How | Verdict |
|---|---|---|
| A. Iframes / links | embed the three UIs | ❌ explicitly rejected by the brief, no shared identity, no cross-system data |
| B. API gateway + 3 services | keep each app, proxy APIs, SSO at the edge | ✅ preserves logic 100 % but needs 4 deployments + 4 volumes and still duplicates user tables |
| C. **Modular monolith + adapters** | one Node service (Final-Bankai) owning identity/audit/notifications, reading & writing the three SQLite files through per-module adapters | ✅ **chosen** — single deploy, real cross-module features, original apps untouched |

### 2.2 Decision: Modular Monolith with per-module adapters

```
┌──────────────────────────── Final-Bankai (Node 22 / Express) ───────────────────────────┐
│  Unified SPA (design system, intro, shell, modules)                                     │
│        │  cookie session                                                                 │
│  ┌─────▼──────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────────────────┐     │
│  │ Auth + RBAC│   │ Audit        │   │ Notifications │   │ Global search / activity │     │
│  └─────┬──────┘   └──────────────┘   └───────────────┘   └──────────────────────────┘     │
│        │                                                                                 │
│  ┌─────▼─────────────────────── adapters (one per system) ───────────────────────────┐   │
│  │ roster.js  (SQLite bankai.db)   hiring.js (bankai-hiring.db)   ticketing.js (…)   │   │
│  └──────────────────────────────────────────────────────────────────────────────────┘   │
│  final.db: users · roles · sessions · permissions overrides · notifications ·           │
│            audit_log · links (candidate ↔ employee ↔ ticket) · ticket_comments          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why not one merged database?** The three schemas encode different domains and
different invariants (weekly schedules vs. candidate stages vs. ticket workflow).
Merging them would force rewrites of business rules and risk data loss. Instead:
**one identity/audit plane** (`final.db`) + **three domain planes** accessed through
adapters, which is exactly "database schema separation + controlled synchronisation".

### 2.3 Data ownership & safety rules

1. **The originals are never modified.** Final-Bankai works on copies placed in
   `data/` (env-configurable: `ROSTER_DB`, `HIRING_DB`, `TICKETING_DB`). Switching to
   the live volumes is a path change, not a code change.
2. **Additive-only changes.** Final-Bankai may add tables/indexes **inside `final.db`**
   only. It never alters the three domain schemas.
3. **Single writer per table.** Roster tables are written only through `roster.js`
   (attendance upsert, employee creation); hiring tables only through `hiring.js`;
   ticket tables only through `ticketing.js`. Cross-domain actions are orchestrated in
   the route layer and recorded in `audit_log` + `links`.
4. **No destructive bulk operations** are exposed in the UI.

### 2.4 Cross-system integration points

| Integration | Implementation |
|---|---|
| **Hiring → Roster (convert)** | Explicit admin action. Creates the employee in `employees` (name, phone, branch, shift, FT/PT, active), allocates an unused `employee_code`, links `candidate_id ↔ employee_id` in `links`, sets the candidate status to `Active`, writes audit + notification. Idempotent: refuses if a link exists or the phone already belongs to an employee. |
| Roster ↔ Ticketing | Tickets keep their original `das_code`; Final-Bankai resolves a ticket to an employee when the code matches `employees.employee_code`, and shows that link — no forced relation. |
| Hiring ↔ Ticketing | `links` can attach a ticket to a candidate (`candidate:<id>`). |
| Identity | One user directory (`final.db`) with per-module permissions; module sessions are no longer needed. |

---

## 3. Authentication & permissions

- Passwords: `scrypt` (N=16384, r=8, p=1) with per-user salt, stored as `scrypt$N$r$p$salt$hash`.
- Sessions: random 32-byte token in an `httpOnly`, `SameSite=Lax`, `Secure` (prod) cookie;
  server-side `sessions` table with expiry (12 h default, sliding renewal).
- Roles → permission sets, plus per-user allow/deny overrides.
- **Every route** resolves the session server-side and checks a permission string;
  the frontend never decides access (it only hides what the API already refuses).

| Role | Intended scope |
|---|---|
| `superadmin` | everything, including team & security |
| `admin` | all modules, no role editing beyond granted |
| `ops_manager` | roster + tickets + reports |
| `hiring_manager` | hiring + convert + reports |
| `supervisor` | roster read/attendance + tickets |
| `employee` | own dashboard only |

Permissions: `dashboard.view`, `roster.view`, `roster.manage`, `attendance.manage`,
`hiring.view`, `hiring.manage`, `hiring.convert`, `tickets.view`, `tickets.manage`,
`reports.view`, `team.manage`, `settings.manage`, `audit.view`.

---

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Writing into a domain DB with foreign rules (roster weeks/fines) | Only the documented operations are exposed (attendance upsert for a date, employee creation); no schedule/fine recalculation is reimplemented |
| Duplicate employees on convert | Unique link + phone/code checks; conversion is idempotent and audited |
| Data drift between the originals and Final-Bankai | Adapters point at the same files; deployment uses a single volume mounted at `data/` |
| Ticket statuses are Arabic strings | Treated as opaque values, normalised only for grouping/labels |
| Missing documents/thumbnails for old uploads | UI falls back to the full image (`hasThumb` flag) |
| Large tables (150+ employees, many tickets) | Server-side pagination + search in every list endpoint |
| Secrets in the repo | `.env` only; `.env.example` documented; nothing sensitive committed |

---

## 5. Delivery phases

1. Discovery & schema maps (this document).
2. Platform core: `final.db`, auth, RBAC, audit, notifications.
3. Adapters + module APIs (roster, hiring, ticketing, dashboard, search, team).
4. Design system + cinematic intro + unified SPA.
5. Cross-system features (convert, links, global search, activity feed).
6. Tests (unit/integration/authorisation), documentation, deployment.
