# FMS Platform

Enterprise rebuild of the CEOITBOX **Flow Management System** (previously a Google
Sheet + Apps Script). Track records through configurable stages with working-hour
TATs, automatic hand-offs, reminders, digests and reports.

* **Stack:** React 19 · Vite · TanStack Query/Table · Tailwind 4 | Fastify 5 · Prisma 6 · PostgreSQL 17 | BullMQ · Redis | TypeScript end to end
* **Docs:** [Legacy analysis](docs/LEGACY_ANALYSIS.md) · [Architecture](docs/ARCHITECTURE.md)

## Quick start (Docker)

```bash
cp .env.example .env
# set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (48+ random chars each) and SEED_ADMIN_PASSWORD
docker compose up --build
```

* App: http://localhost:8080 — sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
* Outgoing email (Mailpit): http://localhost:8025

The seed creates an organization, groups (ADMINS, SALES, MANAGER, PRODUCTION, STORE,
ACCOUNTS), a calendar and a sample **Order to Delivery** workflow. The seed admin is the
**super admin**: the sidebar's *Platform* section lets them onboard client organizations,
set licence limits, suspend organizations, enter any organization and manage other super admins
(see "Roles" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

Break-glass (needs only `DATABASE_URL`):

```bash
npm run super-admin -w @fms/db -- grant  someone@company.com
npm run super-admin -w @fms/db -- revoke someone@company.com   # refuses to remove the last one
```

## Local development

Requirements: Node 22+, PostgreSQL 15+, Redis 7+.

```bash
npm install
cp .env.example .env                 # point DATABASE_URL / REDIS_URL at your services
cp .env packages/db/.env             # the Prisma CLI reads its .env from packages/db
npm run build:core && npm run db:generate
npm run db:migrate && npm run db:seed
npm run dev:api      # http://localhost:4000
npm run dev:worker
npm run dev:web      # http://localhost:5173 (proxies /api to the API)
```

Without a running API the web app falls back to an in-browser demo mock (development builds
only). `FMS_MOCK_API=1 npm run dev:web` forces the server-side mock even when the API is up.

### Security-relevant settings

| Variable | Default | |
|---|---|---|
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-For`. Keep `true` only when the API is reachable *only* through the reverse proxy (as in `docker-compose.yml`); otherwise set `false` or the proxy's IP, or clients can spoof their IP past the login rate limit. |
| `ALLOW_PRIVATE_OUTBOUND` | unset | Webhooks and the WhatsApp endpoint may not call private/internal addresses (SSRF guard). Set `true` only on-premise when they must post to intranet systems. |
| `CONNECTIONS_SECRET_KEY`, `JWT_*_SECRET` | — | Production refuses to start with the `.env.example` placeholder values. |
| `DOCUMENT_FONT_PATH`, `DOCUMENT_FONT_BOLD_PATH` | unset | A Unicode TTF (e.g. Noto Sans) for generated PDFs. Without it PDFs use the built-in Latin fonts (₹ becomes "Rs."). |

| Script | |
|---|---|
| `npm run typecheck` | Type-check every workspace |
| `npm test` | Unit tests (core engine, SQL builder, worker helpers, importer) |
| `npm run build` | Production builds of all apps |
| `npm run migrate:dev -w @fms/db` | Create a new migration after editing `schema.prisma` |

## Repository layout

```
packages/core          pure domain logic (calendar, timeline, permissions, validation…)
packages/db            Prisma schema, migrations, seed, shared DB helpers
apps/api               Fastify REST API (/api/v1)
apps/worker            BullMQ jobs: hand-offs, rules, reminders, digests, archive, sweep
apps/web               React SPA
tools/legacy-import    migrate an existing Google-Sheets FMS
deploy/nginx.conf      SPA hosting + API reverse proxy + CSP
```

## Migrating an existing sheet

1. In the legacy spreadsheet, download **Settings**, **Data** and **Archive** as CSV.
2. Dry run — review the warnings and generated definition:
   ```bash
   npm run convert -w @fms/legacy-import -- --settings Settings.csv --key orders --name "Orders" --out orders.json
   ```
3. Import (workflow + records with their historic planned/actual times):
   ```bash
   npm run load -w @fms/legacy-import -- --settings Settings.csv --data Data.csv --archive Archive.csv --key orders --name "Orders"
   ```
   Use `--date-order mdy` if the sheet used US dates. Historic active stages are
   marked as already handed off, so nobody is spammed on import.
4. Recreate users (passwords are never migrated — they were stored in plaintext), create
   any option sets the converter reports, and re-create Messages-tab rules in
   **Notification rules** (legacy `<<Field Label>>` tags still work).

## API overview

All endpoints are under `/api/v1` and need `Authorization: Bearer <token>` except login/refresh.

| | |
|---|---|
| `POST /auth/login` · `/auth/refresh` · `/auth/logout` · `GET /auth/me` | Sessions |
| `GET /workflows` · `GET /workflows/:wf` | Workflow list / per-user definition |
| `GET/POST /workflows/:wf/records` | List (paging, sort, search, `filters`, `status`, `stage`, `mine`) / create (with `items[]`) |
| `GET/PATCH /workflows/:wf/records/:id` · `GET …/history` | Read / update (optimistic `version`) / audit |
| `POST …/records/:id/stages/:stage/complete` · `PUT …/planned` | Complete a stage / set a manual plan |
| `POST /workflows/:wf/records/archive` · `/restore` · `GET …/export.csv` | Bulk archive / restore / export |
| `GET /workflows/:wf/reports/summary` · `/pending` · `/matrix` · `GET /me/tasks` | Reports & my tasks |
| `GET/POST/DELETE /workflows/:wf/views` | Saved views |
| `/workflows/:wf/rules[/:id][/resend]` | Notification rules |
| `POST …/records/bulk-update` · `POST …/records/:id/stages/:stage/document` | Stage bulk tool · generate a document step's file again |
| `GET/POST /public/forms/:token` | Public intake form (no sign-in; only when the flow switches it on) |
| `POST /files` · `GET /files/:id` | Attachments |
| `/admin/users` · `/admin/groups` · `/admin/calendars` · `/admin/option-sets` · `/admin/audit` · `/admin/jobs` | Administration |
| `POST /workflows` · `PUT /workflows/:wf/definition` · `GET …/versions` | Workflow publishing |

Errors are JSON: `{ "error": { "code", "message", "details"? } }` — `422` carries per-field messages.
