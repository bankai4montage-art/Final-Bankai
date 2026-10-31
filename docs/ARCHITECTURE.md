# Final-Bankai — Architecture

## 1. Shape

**Modular monolith.** One Node process owns:

```
┌───────────────────────────── Express (server.js) ──────────────────────────────┐
│  SPA (public/)  →  /api/*                                                      │
│  ┌──────────┬───────────┬──────────────┬──────────────┬──────────────────────┐ │
│  │ auth     │ audit     │ notifications│ search       │ module routes        │ │
│  │ sessions │ log       │ feed         │ (per mission)│ roster/hiring/tickets│ │
│  └────┬─────┴─────┬─────┴──────┬───────┴──────┬───────┴──────────┬───────────┘ │
│       │           │            │              │                  │             │
│  ┌────▼───────────▼────────────▼──────────────▼──────────────────▼─────────┐    │
│  │                          final.db (platform plane)                      │    │
│  │  users · sessions · permission_overrides · audit_log · notifications    │    │
│  │  links (candidate↔employee↔ticket) · ticket_comments · settings         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│       │                    │                      │                             │
│  ┌────▼─────┐        ┌─────▼──────┐        ┌──────▼───────┐                     │
│  │ roster.js│        │ hiring.js  │        │ ticketing.js │  ← adapters         │
│  └────┬─────┘        └─────┬──────┘        └──────┬───────┘                     │
└───────┼────────────────────┼──────────────────────┼──────────────────────────────┘
        ▼                    ▼                      ▼
   roster.db            hiring.db              ticketing.db
 (employees,          (couriers,             (tickets,
  attendance,          documents)             couriers)
  fines, shifts)
```

## 2. Planes & ownership

| Plane | File | Owner | Contents |
|---|---|---|---|
| Platform | `final.db` | Final-Bankai | identity, sessions, permissions, audit, notifications, cross-system links, ticket comments |
| Workforce | `roster.db` | Roster adapter | employees, attendance, fines, shifts, schedules |
| Recruitment | `hiring.db` | Hiring adapter | candidates, documents, events |
| Support | `ticketing.db` | Ticketing adapter | tickets, courier directory, cards, advances |

**Rule:** a plane is only written through its adapter. Cross-plane effects are
orchestrated in the route layer inside one request and recorded in `audit_log`.

## 3. Adapters

Each adapter:
- opens its database lazily (`better-sqlite3`, WAL),
- returns **API-shaped** objects (camelCase, normalised booleans),
- exposes only the operations the platform needs,
- degrades gracefully (`available()` → false) when the file is missing.

`roster.js` writes exactly two shapes:
1. `setAttendance()` — upsert one `attendance` row (`employee_id`, `attendance_date`,
   `status`, `fine`, `reason`, `note`, `updated_at`), identical to the original app.
2. `createEmployee()` — insert one `employees` row + allocate an unused code.

No schedule, week or payroll recalculation is reimplemented.

## 4. Identity model

```
users (id, email, name, password_hash, role, status, avatar_color, last_login_at)
permission_overrides (user_id, perm, allowed)   ← per-user allow/deny
sessions (token, user_id, csrf, expires_at, …)
```

- `role → permission[]` lives in `src/auth.js` (`ROLES`).
- Effective permissions = role set ± overrides, computed per request in `attachUser`.
- Route guard: `requireAuth` → `requireCsrf` → `requirePermission('…')`.

| Permission | Grants |
|---|---|
| `dashboard.view` | overview |
| `roster.view` / `roster.manage` / `attendance.manage` | workforce read / employee edits / attendance writes |
| `hiring.view` / `hiring.manage` / `hiring.convert` | candidates read / status changes / conversion |
| `tickets.view` / `tickets.manage` | ticket read / create-update |
| `reports.view`, `team.manage`, `settings.manage`, `audit.view` | analytics, users, settings, audit |

## 5. Cross-system flows

### Hiring → Roster (conversion)
```
POST /api/hiring/candidates/:id/convert
  ├─ guard: hiring.convert
  ├─ candidate = hiring.get(id)                       404 if missing
  ├─ links.find(candidate, employee) → 409 already converted
  ├─ roster.findByPhoneOrCode(phone|code) → 409 duplicate employee
  ├─ employee = roster.createEmployee({name, phone, branch, shift, type, code})
  ├─ links.add(candidate ↔ employee)
  ├─ hiring.setStatus(id, 'Active')   (+ event row in hiring.db)
  ├─ audit('candidate.converted')
  └─ notifyPermission('hiring.view', …)
```
Idempotent by construction: the link table has a unique index on the pair and the
phone/code guard blocks accidental duplicates created outside the flow.

### Tickets ↔ workforce
A ticket carries `das_code`. The detail view resolves it to an employee when
`employees.employee_code` matches — a **soft** link (rows are not modified).

### Global search
`GET /api/search?q=` queries each adapter **only if** the caller holds that module's
`*.view` permission, so results can never leak across permission boundaries.

## 6. Frontend

- Single `index.html` + `assets/app.js` (ES module) + `assets/styles.css`.
- Hash router (`#/overview`, `#/roster`, `#/hiring`, `#/tickets`, `#/reports`,
  `#/team`, `#/settings`), nav filtered by permissions.
- Views are rendered from JSON; drawers for details; no framework, no CDN.
- The cinematic intro is a canvas particle field + CSS reveal, stored in
  `localStorage` and replayable from Settings; skipped entirely for
  `prefers-reduced-motion`.

## 7. Failure behaviour

| Situation | Behaviour |
|---|---|
| Module DB missing | adapter returns empty data, UI shows “no data”, banner in Settings reports the module as offline |
| Session expired | API answers 401, SPA returns to the login screen |
| Duplicate conversion | 409 with the existing employee id |
| Ticketing DB locked | request fails with 400/500, audit records the attempt |

## 8. Scaling notes

- Every list endpoint is paginated server-side (`page`, `pageSize`).
- Adapters open one connection per process (WAL keeps readers non-blocking).
- The platform can later be split into services: each adapter already isolates a
  module behind a narrow interface.
