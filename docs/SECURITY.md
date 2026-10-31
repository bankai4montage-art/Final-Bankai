# Final-Bankai — Security

## Controls in place

| Area | Control |
|---|---|
| Passwords | `scrypt` (N=16384, r=8, p=1), 16-byte random salt, timing-safe compare. Never logged, never returned. |
| Sessions | 32-byte random token; stored server-side in `sessions`; `httpOnly` + `SameSite=Lax` + `Secure` (production) cookie; 12 h TTL (configurable); revoked on logout, on password change and on every new login of the same user. |
| CSRF | Every state-changing request must send `x-csrf-token` matching the session; a missing/mismatched token is rejected with 403. |
| Authorization | `requireAuth` + `requirePermission(perm)` on **every** protected route. Roles and overrides are resolved server-side; the SPA only hides what the API already refuses. |
| Input validation | Server-side checks on all writes (required fields, formats, enumerations, lengths). The hiring adapter rejects unknown stages/statuses. |
| SQL injection | 100 % parameterised statements (`better-sqlite3` prepare + bind). No string interpolation of user data into SQL. |
| XSS | All rendered values pass through `esc()`; the SPA uses `innerHTML` with escaped interpolations only; no `eval`, no remote scripts. |
| Clickjacking / transport | `Secure` cookies in production; the app is served over HTTPS by the platform. |
| Rate limiting | Login: 8 attempts / minute per IP+email (in-memory bucket). |
| Audit | `audit_log` records login, logout, password change, attendance writes, candidate stage changes, conversions, ticket create/update, user changes and settings updates (user, e-mail, module, entity, IP, time). |
| Secrets | Only in environment variables / `.env` (git-ignored). `.env.example` contains placeholders only. |
| Data exposure | No personal data in logs; document binaries are served through authorised endpoints. |
| Least privilege | Six roles; `team.manage` and `audit.view` are not granted to operational roles. |
| Session hygiene | Sessions are deleted on password change and on re-login; expired sessions are pruned on access. |

## Threat model (brief)

| Threat | Mitigation |
|---|---|
| Stolen cookie | Server-side revocation, 12 h TTL, `httpOnly`, re-login invalidates previous sessions |
| Cross-site request forgery | Session-bound CSRF token on all writes |
| Privilege escalation | Permissions evaluated per request from the DB, never from the token |
| Data tampering across modules | Adapters are the only writers; conversions are audited and idempotent |
| Duplicate employee creation | Phone/code pre-check + unique link index |
| Brute force | Rate limit + timing-safe compares + generic error messages |
| Injection via file names / ids | IDs validated by type; filenames sanitised; no filesystem paths from user input |

## Hardening checklist for production

- [ ] `ADMIN_PASSWORD` changed from the placeholder and rotated after first login.
- [ ] `NODE_ENV=production` so cookies are `Secure`.
- [ ] HTTPS enforced by the platform (Railway terminates TLS).
- [ ] Database volume mounted at a persistent path; `DATA_DIR`/`*_DB` point at it.
- [ ] Nightly backups of the four SQLite files (`.db` + `-wal`).
- [ ] Restrict Railway project access to the operations team.
- [ ] Review `audit_log` periodically (module `audit.view`).
- [ ] Rotate `SESSION_TTL_HOURS` down for shared devices.

## Known limitations

- Login rate limiting is in-memory (per instance) — move to Redis if the app is
  scaled horizontally.
- No 2FA yet; the permission model is ready to carry a `mfa` flag.
- No password reset by e-mail (no SMTP configured): an admin resets the password
  from Team → Edit, which also revokes the user's sessions.
