# Final-Bankai — Deployment

## 1. Requirements

- Node.js ≥ 22
- A persistent disk for SQLite (a Railway **Volume** ideally)
- Environment variables from `.env.example`

## 2. Railway

1. Create a service from the `bankai4montage-art/Final-Bankai` repository (Nixpacks).
2. Add a **Volume** mounted at `/data` (500 MB is plenty to start).
3. Set variables:

```
NODE_ENV=production
DATA_DIR=/data
FINAL_DB=/data/final.db
ROSTER_DB=/data/roster.db
HIRING_DB=/data/hiring.db
TICKETING_DB=/data/ticketing.db
ADMIN_EMAIL=you@company.com
ADMIN_PASSWORD=<strong password>
SESSION_TTL_HOURS=12
```

4. **Seed the module databases once.** Either copy the live files into the volume
   (recommended) or start from the demo set:

```bash
# from a machine with access to the sources
scp bankai.db      root@…:/data/roster.db
scp bankai-hiring.db    root@…:/data/hiring.db
scp database.db         root@…:/data/ticketing.db
# or, inside the service shell:
node scripts/seed-demo.js
```

5. `POST /api/health` must answer `{ ok: true, modules: { roster, hiring, ticketing } }`.

## 3. Docker (any host)

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
VOLUME /data
EXPOSE 4000
CMD ["node", "server.js"]
```

```bash
docker build -t final-bankai .
docker run -d -p 4000:4000 -v fb-data:/data \
  -e ADMIN_EMAIL=admin@you.com -e ADMIN_PASSWORD='…' final-bankai
```

## 4. Local

```bash
npm install
npm run copy:databases     # snapshot the three source DBs into ./data
node scripts/seed-demo.js  # optional demo rows
npm start
```

## 5. Backup & recovery

SQLite is a single file per plane — back up all four (plus WAL):

```
/data/final.db     /data/final.db-wal
/data/roster.db    /data/roster.db-wal
/data/hiring.db    /data/hiring.db-wal
/data/ticketing.db /data/ticketing.db-wal
```

Nightly example (Railway cron or host crontab):

```bash
TS=$(date +%F)
tar czf /backups/final-bankai-$TS.tgz -C /data final.db* roster.db* hiring.db* ticketing.db*
find /backups -name 'final-bankai-*.tgz' -mtime +14 -delete
```

**Restore:** stop the service, replace the files, start it. The platform recreates
missing indexes/columns on boot without touching existing rows.

## 6. Upgrades

1. Back up (see above).
2. Deploy the new build.
3. On boot the platform runs additive migrations (`ALTER TABLE … ADD COLUMN` when
   missing, index creation) and never drops data.
4. Verify `/api/health` and sign in.

## 7. Health & observability

- `GET /api/health` — service + module connectivity.
- `GET /api/audit` (permission `audit.view`) — recent sensitive actions.
- Platform logs: authentication failures, adapter failures, unhandled errors
  (no personal data).

## 8. Rollback

Redeploy the previous deployment (Railway keeps the last successful build) and, if a
schema change was involved, restore the matching backup. Module databases are only
ever touched additively by Final-Bankai, so a rollback keeps working with the older
build.
