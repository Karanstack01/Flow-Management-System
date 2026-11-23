# Architecture

The legacy FMS was a Google Sheet + Apps Script: the sheet was the database, the
configuration store and the admin UI; time triggers did all processing; web pages
received the entire dataset (and every user's password) and enforced permissions in
the browser. See [LEGACY_ANALYSIS.md](LEGACY_ANALYSIS.md).

The new platform keeps the *product* (configurable stages, TAT in working hours,
hand-offs, reminders, reports) and replaces the *mechanics*.

```
            ┌──────────────┐  HTTPS   ┌───────────────────────── nginx (web) ──┐
 Browser ──►│ React SPA    │─────────►│ static assets + /api reverse proxy     │
            └──────────────┘          └───────────────┬────────────────────────┘
                                                      │
                                     ┌────────────────▼───────────────┐
                                     │ API  (Fastify, stateless, N×)   │
                                     │ auth · RBAC · validation · SQL  │
                                     └───────┬───────────────┬─────────┘
                              transactions   │               │ enqueue "record-changed"
                                     ┌───────▼──────┐   ┌────▼─────┐
                                     │ PostgreSQL   │   │  Redis   │
                                     └───────▲──────┘   └────┬─────┘
                                             │               │ BullMQ
                                     ┌───────┴───────────────▼─────────┐
                                     │ Worker (N×): hand-offs, rules,   │──► SMTP / WhatsApp / webhooks
                                     │ reminders, digests, archive,     │
                                     │ sweep (self-healing)             │
                                     └─────────────────────────────────┘
        @fms/core (pure TS) is shared by the SPA, API, worker and importer.
```

## Packages

| Package | Responsibility |
|---|---|
| `packages/core` | Pure domain logic, no I/O: workflow schema (zod), `BusinessCalendar`, `computeTimeline`, condition DSL, permissions, validation & coercion, safe formula evaluator, templates, report maths, queue contract. 51 unit tests. |
| `packages/db` | Prisma schema + migrations + seed, shared helpers (`loadWorkflow`, `principalFromUser`, `saveStageStates`). |
| `apps/api` | Fastify 5 REST API under `/api/v1`. |
| `apps/worker` | BullMQ consumer + schedulers (replaces Apps Script triggers). |
| `apps/web` | React 19 + Vite + TanStack Query/Table + Tailwind 4. |
| `tools/legacy-import` | Converts the legacy Settings/Data/Archive CSV exports into a workflow + records. |

## Domain model

* **Workflow** — versioned JSON definition (`stages[]`, `fields[]`) + automation `settings`. Every publish writes an immutable `WorkflowVersion`. Fields and rules reference each other by stable `key`, so adding a field never requires renumbering (the legacy `addFields`/`deleteFields` rewrite).
* **Stage** — `planned` rule (`none` · `manual` · `tat` from previous stage / creation / a date field, fixed hours or hours keyed by a field value, negative allowed), `completion` rule (`on_create` · `manual` · `conditions`), optional `applicableWhen` (skip), `responsibleGroups`.
* **Record** — JSONB `data`, per-stage `RecordStage` (status, planned, actual, completedBy), denormalised `currentStageKey`, optimistic `version`, `archivedAt`. Multi-item forms create one record per item linked by a `Submission`.
* **Calendar** — IANA timezone, shift window, weekly offs, holidays. All TAT and delay maths is in working hours.

### Timeline engine
`computeTimeline()` is a pure function run inside the same transaction as every
write (and by the worker sweep). Stages are sequential; reaching a stage either skips
it or activates it and fixes its planned time once; condition stages are auto-stamped;
actual times are never erased. It returns the events (`stage_activated`,
`stage_completed`, `stage_skipped`) that drive notifications and the audit trail.

## Security model

| Concern | Implementation |
|---|---|
| Passwords | argon2id (`@node-rs/argon2`), lockout after 5 failures, timing-safe unknown-user path |
| Sessions | 15-min JWT access token in memory; rotating opaque refresh token (HMAC-hashed at rest) in an `httpOnly; SameSite=Strict` cookie scoped to `/api/v1/auth`; reuse of a rotated token revokes the whole family |
| Authorisation | Server-side only. Capabilities per group (`ADMIN`, `CREATE`, `DELETE`, `RUN_JOBS`, `EXPORT`, `MANAGE_RULES`); field view/edit groups; per-user row filters compiled to SQL; fields of unreached stages are not writable; stage completion requires responsibility |
| Data minimisation | Responses are projected to visible fields; search, filters and sort are restricted to visible fields so hidden values cannot be inferred |
| Injection | All SQL parameterised (`Prisma.sql`), field keys are bind parameters *and* whitelisted; formulas use a tiny parser (no `eval`); CSV export neutralises spreadsheet formula injection |
| XSS | React escaping; templates escape values in HTML email; uploads limited to an allow-list of MIME types and served with `nosniff` + sandbox CSP; SPA served with a strict CSP |
| Abuse | Global + per-route rate limits, body/upload size limits |
| Audit | Append-only `AuditLog` for logins, record changes (field diffs), archive, exports, config changes, job triggers |
| Attachments | A file id is not a key: a file opens only for admins, its uploader, or someone who can see a record holding it in a file field visible to them. New attachments must be the saver's own uploads |
| Drafts | Draft flows are visible to admins only; for everyone else every record, report and view route answers 404 |
| Outbound calls (SSRF) | Webhook URLs and the WhatsApp endpoint must resolve to public addresses; redirects are not followed (`guardedFetch`, `ALLOW_PRIVATE_OUTBOUND` for on-premise) |
| Message bodies | Sanitised server-side before sending and in the browser (DOMParser) before the rich-text editor renders them; non-admin rule authors can only use fields they can see |
| Tokens | HS256 pinned for sign and verify; production refuses placeholder secrets |
| Multi-tenancy | Every business row carries `orgId`; every query is scoped to the caller's organization. Access tokens are bound to one organization (`org` claim); manual job runs by an organization admin only process that organization |

## Roles: super admin → organization admin → user

The legacy system had no role above "whoever can edit the spreadsheet". In practice there were three levels:
the CEOITBOX licence holder who owns every client's FMS sheet, the client's sheet editor who uses the
**CEOITBOX › Admin** menu, and the web-app users listed in `Settings!X:AC`. The platform makes those levels explicit.

| Level | Legacy | Who grants it | Can do |
|---|---|---|---|
| **Super admin** (`User.isSuperAdmin`) | Licence holder / owner of all FMS sheets; `checklicence()`; "Setup Sheet" for a new client | Another super admin, the seed, or the `super-admin` CLI. Never a group capability, so an organization admin can not grant it | Everything below, in **every** organization. Plus: create organizations (with first admin, `ADMINS` group and calendar); set licence limits (max users, max workflows, expiry); suspend and reactivate; enter any organization; search users across organizations; grant or revoke super admin; sign a user out everywhere; run jobs for the whole platform; see platform health and the `platform.*` audit trail |
| **Organization admin** (`ADMIN` capability via a group) | Sheet editor using the Admin menu | An organization admin | Workflows, users and groups, calendars, rules, audit and jobs **in their organization only**. Can not edit or reset a super admin account. Limited by the organization's licence |
| **User** | Row in `Settings!X:AC` | An organization admin | Group capabilities (`CREATE`, `DELETE`, `EXPORT`, `RUN_JOBS`, `MANAGE_RULES`), field view/edit groups and row filter |

How it works:

* **Entering an organization.** `POST /auth/switch-org` stores `User.activeOrgId` and returns an access token bound to that
  organization. Older tokens stop working at once (organization mismatch → the client refreshes into the new organization).
  The UI shows a permanent banner while visiting. Every change is audited in the visited organization, along with
  `platform.org_entered` and `platform.org_returned`. Home group memberships and row filters do not carry over; a super admin
  bypasses field and row restrictions anyway.
* **Suspension and licence expiry.** Users of a suspended or expired organization can not sign in or refresh. Requests with a
  still-valid access token get `403 SUSPENDED` / `LICENSE_EXPIRED`, and their refresh tokens are revoked as the organization
  closes. The worker pauses hand-offs, reminders, digests and archiving for that organization. Pending hand-offs are delivered
  by the sweep after reactivation. Super admins can still enter it.
* **Licence limits.** `maxUsers` is checked when a user is created or reactivated (super admins never use a seat).
  `maxWorkflows` is checked when a workflow is created. Both return `402 LICENSE_LIMIT`.
* **Lock-out safety.** A super admin can not revoke their own access or suspend their own organization, and the last active
  super admin can not be revoked. If every super admin is locked out, the `super-admin` CLI works with only `DATABASE_URL`.
  The first migration step promotes the oldest active `ADMIN` user when no super admin exists, so an upgraded installation
  always has one.

## Flows, templates and the node editor

* **All Flows** (`/flows`) lists every flow with Primary / Drafts / Trash tabs, search, label, status and date filters,
  per-user favourites, open and overdue counts, bulk trash/restore, duplicate, save-as-template, activate/deactivate,
  and permanent delete. Permanent delete works only from the trash and requires typing the flow key.
* **Templates** (`/templates`) are copyable blueprints (`WorkflowTemplate`). Built-ins come from `@fms/core`
  (`BUILT_IN_TEMPLATES`) and are upserted by the seed. Organization admins can save their own flows as organization
  templates; super admins can publish them for every organization. Webhook URLs and secrets are never copied.
* **New flows start as drafts.** Drafts are hidden from non-admins and run no automation. Publishing them in the editor
  makes them live.
* **Flow editor** (`/flows/:key/editor`, React Flow). The engine still runs one ordered chain of stages, like the legacy
  FMS. The canvas is a visual way to author it (`packages/core/src/canvas.ts`):

  | Node | Compiles to |
  |---|---|
  | Stage | a stage, with its form fields, owners and completion rule (inspector) |
  | Depends on | a **switch**: one output per path the author adds (1–10), plus an optional **Otherwise** output. Paths are checked top to bottom and a record follows the first that matches. Every stage behind an output gets the guard `{ cases, take: i \| 'else' }` (`stage.guards`, outermost first). Outputs rejoin at the first step all of them reach; an unconnected output ends the flow for those records. Old `{ when, negate }` guards and `yes`/`no` edges are still read (`normalizeGuard`, `normalizeHandle`). |
  | Stage Jump | a `stage.jumps` entry on the stage connected into it: *when this stage is done and the condition holds, go to stage X*. **Forward** — the stages in between are skipped. **Back** — the target … source stages are reopened for another round (`RecordStage.round` + 1), the chosen fields are cleared, owners are notified again (dedupe keys get `:r{round}`); capped at 20 rounds. Emits `stage_jumped` / `stage_reopened`. |
  | Delay/Timer | the next stage's planned time: TAT in working hours from the previous stage, creation or a date field |
  | Message | a notification rule (`NotificationRule.canvasNodeId`) fired when its stage starts, finishes or is late. The inspector has field **Tags** (`{{field_key}}`) on To / Cc / Subject / body / WhatsApp variables, a rich-text or HTML email body (sanitised by `sanitizeEmailHtml` before sending), and a **Preview** with sample values |
  | Webhook | a `settings.webhooks` entry with `afterStage` |
  | Document | a stage with `stage.document` (legacy autocrat): when the stage starts, the body (rich text with `{{field}}` tags, or an automatic all-fields table) is filled with the record and saved as **PDF** (pdfkit, `apps/api/src/lib/pdf.ts`) or **Word** (.doc) into the step's file field, through the same storage as uploads (Cloudinary or local). *Require review* → the stage waits for "Approve & continue"; otherwise it completes as soon as the file exists (`completion: conditions not_empty`). Generated in the API right after every write (`generateDocuments`), loops through consecutive document steps; a failure never fails the user's save — the record page shows **Generate document / Generate again**. `POST /flows/:key/document-preview` returns a sample file. |
  | Note | canvas only; old placeholder Document nodes (no stage) are kept as warnings |

  **Stage › General.**
  * *Basic settings* — name, **description** and **instruction video** (YouTube / Drive / Vimeo / Loom, embedded above the
    stage's form on the record page, new-record page and public form), stage colour, **header colour** for the stage's
    columns in the records table, and **Lock editing after completion** (enforced in `applyChange` for everyone, admins included).
  * *Public Form Access* (intake only) — `/f/{publicFormId}` without sign-in (`routes/public.ts`): only fields every
    group may edit, no file uploads, rate-limited, record numbers only in the answer. Copies of a flow start private.
  * *Stage Access Control* — `stageAccessRestricted` + `stageUsers` (Viewer / Editor): combined into `fieldAccess` /
    `visibleFieldKeys` (pass the stages) and checked for completion, planning and document regeneration.
  * *Stage update options* — **Single item update** off → only the bulk tool (or an admin) edits/completes the stage;
    **Bulk update** on → *Records › select rows › Bulk update* (`POST /workflows/:wf/records/bulk-update`, per-record results).
  * *Thank you message* (intake) — shown after the public form and the New record page.

  The editor's settings panel can be resized by dragging its left edge or widened with one click (remembered per browser),
  and every step has a **Preview** (eye on the node, or ⋮ menu): the working form, the document on an A4 page, the paths of
  a Depends-on, a timer's due rule, a jump, a message as sent, a webhook's JSON.

  **Stage › Form fields.** Each field has name, type, placeholder, default value (`TODAY` / `NOW` for dates; pre-filled
  on the intake form and on the active stage), hidden / required / unique / record-title flags, repeating rows (intake
  only), multiple files, and:
  * **Field access control** — *Allow only assigned users* replaces the group rules with a per-field list of users,
    each **Viewer** (sees it) or **Editor** (can change it); everyone else gets the field projected away by the API
    (`fieldAccess` in `core/permissions.ts`). Admins always see it.
  * **Validation rule** — a spreadsheet-style formula (`core/rule.ts`: tokenizer → AST → evaluator, no `eval`)
    run on the server for every non-blank value written. TRUE / blank = valid, FALSE = invalid, other text = the
    error shown on the field. Names: field keys, `value`, `RECORD_NUMBER`, `CREATED_BY`, `CREATED_AT`, `CURRENT_STAGE`,
    `FLOW_NAME`. The editor has Insert Field / Insert Record / Examples / Functions Guide / Test Formula; rules with
    syntax errors or unknown fields are rejected when the flow is saved.

  `compileCanvas` checks the graph and returns node-level errors and warnings, live in the editor and again on the server
  (`PUT /flows/:key/editor`, in one transaction with the rules). `reconcileCanvas` regenerates the canvas when a flow was
  changed elsewhere (form editor, JSON), keeping node positions and notes.

## Connections (Settings › Connections)

Per-organization external services, managed by organization admins (`/admin/connections`, `Connection` table):

| Kind | Provider | Used for | How |
|---|---|---|---|
| Storage | Cloudinary | Record attachments | Signed uploads as **authenticated** (private) assets. Downloads stream through the API after the permission check, using a signed delivery URL. Each `FileObject` records its `storageProvider`, so switching storage never breaks existing files. |
| Email | Google | Hand-offs, reminders, digests, Message nodes | `smtp.gmail.com:465` with a 16-letter app password (account needs 2-Step Verification). |
| Email | Microsoft | same | **Microsoft 365 app** (recommended): client-credentials token + Graph `users/{mailbox}/sendMail` (Mail.Send application permission). Or **SMTP** `smtp.office365.com:587` with an app password — Microsoft is retiring basic auth for Microsoft 365 SMTP. |
| WhatsApp | RedLava | Message nodes / rules | `POST {endpoint}/{phoneNumberId}/messages` in the WhatsApp Cloud API format (text or approved template with body variables), with `Authorization: Bearer` or a custom header. RedLava's public API reference was not available, so the request lives in one function (`sendWhatsApp` in `packages/db/src/connections.ts`) to adjust to their docs. |

* One active connection per kind; for email that is the Google ⇄ Microsoft switch. With none active, the worker uses the server defaults (`SMTP_*`, `WHATSAPP_*`).
* Secrets are AES-256-GCM encrypted with `CONNECTIONS_SECRET_KEY`, never returned to the browser (masked to the last four characters), and an empty field on save keeps the stored value. The audit log records which fields changed, never their values.
* **Test** buttons run a real round trip and store the result on the card: Cloudinary does ping + private upload + signed download + delete; email and WhatsApp send a test message.
* The worker caches each organization's channels for 60 seconds, so changes apply within a minute.

## Reliability

* **Atomic numbering** — `UPDATE … SET recordSeq = recordSeq + n RETURNING` (legacy counters raced).
* **Unique fields** — checked under a per-workflow advisory lock inside the write transaction.
* **Optimistic concurrency** — `version` on records; stale edits get `409` instead of silently overwriting.
* **Exactly-once notifications** — every message claims a unique `NotificationLog.dedupeKey` before sending; jobs are safe to retry and re-run.
* **Self-healing** — the 5-minute sweep recomputes open timelines and dispatches any hand-off the event path missed (e.g. Redis down). Redis outages never block API writes.
* **Webhooks** — HMAC-signed (`x-fms-signature`), retried with exponential backoff, logged on success.
* **Graceful shutdown** for API and worker; health (`/healthz`) and readiness (`/readyz`) probes.

## Scaling

API and worker are stateless and scale horizontally (worker concurrency via
`WORKER_CONCURRENCY`; BullMQ distributes jobs). Lists, filters, search, sort and
aggregates execute in Postgres with pagination. Reports scan at most 20k open records
per request — beyond that, move them to materialised daily snapshots (roadmap).
File storage is behind a `Storage` interface; swap `LocalDiskStorage` for S3/GCS/Azure
when running more than one API node.

## Legacy feature coverage

| Legacy | New |
|---|---|
| `planningtime`, `timestamp`, `updatetimestamp` | `computeTimeline` in every write + worker sweep |
| `onformsubmit` hand-off emails | worker `handoffs` (email/WhatsApp, deep link to the stage) |
| `sendreminder` tiers | `settings.upcoming` (working-hours horizon) |
| `sendpending` | `settings.overdueDigest` (per-user, respects row filters) |
| `send_custom_rem` + Messages tab, `repatreminder`, `send_individual_rem` | Notification rules (condition / stage started / completed / overdue, repeat N days, resend) |
| `Rep_Stage`, `Rep_Pending`, `Rep_Activity_Funnel`, `Rep_Ord_Status` | `/reports/summary`, `/reports/pending`, `/reports/matrix`, Reports page, daily summary email |
| `archiveall` + trigger | Archive/restore (DELETE capability) + `settings.archive` job |
| `post_data` | Outbound webhooks |
| View Table page | Records grid: server paging, search, stage/status/my-tasks filters, condition filter builder, saved views, column picker, totals, CSV export, bulk archive |
| update page | Record detail: stage timeline, stage form, mark done, manual planning, history |
| Form / submit form / EditResponse | New record page with line items; edits via record detail |
| dashboard page | My work (tasks across workflows) |
| Settings tab editing | Node-based flow editor plus the advanced form/JSON editor; versioned publishing |
| Copying a client's FMS sheet to start a new process | Templates and Duplicate |
| Users block, groups | Users & groups admin, row-filter builder |
| Holiday tab | Calendars & holidays admin; option lists replace dropdown ranges |
| `op_runfun`, "Send Reminder" menu | `POST /admin/jobs/:name/run` (RUN_JOBS, this organization only); super admin: `POST /platform/jobs/:name/run` (all or one organization) |
| `settingCheck` | Definitions are validated by schema on publish — invalid configs cannot be saved |
| `checklicence`, "License Status" | Organization licence (max users / workflows, expiry) and suspension, managed by super admins |
| "Setup Sheet" (`createdatasheet`) for a new client | Platform › Organizations › New organization |
| Self-update, short URLs, HTML-in-notes | Removed (regular deployments, own domain) |

## Roadmap (not yet built)

1. **Documents, next steps**: images in PDFs, real .docx output, and a bundled Unicode font (today non-Latin text needs `DOCUMENT_FONT_PATH`).
2. **AI summaries** (legacy AI tab): scheduled LLM summary of filtered records behind a provider interface.
3. **SSO** (OIDC/SAML, e.g. Google Workspace / Entra ID) and SCIM provisioning.
4. **OpenAPI spec** generated from the zod schemas; typed client for integrations.
5. **Object storage** adapter (S3/GCS) and antivirus scanning for uploads.
6. **Integration & E2E tests** (Testcontainers Postgres + Playwright) — the CI workflow already provisions Postgres and verifies migrations and seeding.
7. **Report snapshots** for very large workflows; OpenTelemetry traces/metrics.
8. **Stage reopen** (admin) and per-stage SLA escalation chains.
