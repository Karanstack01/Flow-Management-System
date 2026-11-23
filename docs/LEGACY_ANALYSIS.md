# Legacy System Analysis — CEOITBOX FMS (Google Apps Script)

This document records how the existing system works, reverse-engineered from
`code.gs` (~8,600 lines) and the seven HTML front-ends. It is the source of truth
for the migration: every behaviour listed here is either re-implemented in the new
platform or consciously dropped (see §9).

---

## 1. What the system is

**FMS = Flow Management System.** It tracks business *records* (orders, enquiries,
jobs, tickets…) through a fixed sequence of *stages* (steps). For every stage it
knows:

* **who** is responsible (user groups),
* **when** it should be done (*planned time*, computed from a TAT — turn-around time —
  in *working hours*, skipping holidays and off-shift time),
* **when** it was actually done (*actual time*, stamped automatically when a
  condition becomes true, e.g. `Status = "Dispatched"`),
* whether it is **pending / overdue / done on time / done late**.

Around that core it sends reminders (email + WhatsApp), produces management
reports (PDF), exports/forwards data to other sheets, generates documents from
templates, archives finished records, and provides web pages for data entry and
tracking.

It is configured entirely through a Google Sheet; there is no database — the
spreadsheet *is* the database, the config store and the UI for admins.

## 2. Storage model (the spreadsheet)

| Tab | Role |
|---|---|
| **Data** | One row per record. Col A = `Record #`. One column per field (order = Settings rows). After the fields: `Step N Completion Reminder` columns, `<Template> Reminder Status` columns, `Submission ID`. |
| **Settings** | Schema + all configuration (see §3). |
| **Messages** | Custom notification rules, one per row from row 3 (see §5.4). |
| **Holiday** | `D2` = comma list of holiday dates; `K2:L` = calendar (date, holiday-flag). Working day ⇔ `L` empty. |
| **Archive** | Finished records moved out of Data. `D1` = condition column, `H1` = condition value, `J1` = optional external archive sheet URL. |
| **Rep_Stage / Rep_Pending / Rep_Step / Rep_Activity_Funnel / Rep_Ord_Status** | Report canvases rebuilt on every report run, exported to PDF. |
| **Table View** | Named column sets ("views") with optional per-column HTML. |
| **Dashboard** | Report tiles: name, link, logo, visible-to groups. |
| **AI** | AI report rules (tab, columns, conditions, prompt, recipients). API key stored in a cell **note**. |
| **HTML** | HTML of the web pages stored in cell notes, compressed into DocumentProperties at deploy (`setHTML`). |

Cell **notes** are used as a key-value store: `Settings!A1` licence blob,
`B1` licence-server list, `D1` dropdown cache (JSON), `AA1` per-user "run function"
prefs, `AB1` per-user saved filters, `AI1`/`AE29` record and submission counters
(the counters actually live in `DocumentProperties`).

## 3. Settings sheet = schema + configuration

### 3.1 Field rows (`Settings!A2:P`, one row per Data column)

| Col | Meaning |
|---|---|
| A | Data column index (0-based; 0 = Record #) |
| B | Field label = Data header |
| C | Flags (substring match): `HIDDEN`, `HIDDEN_INPUT`, `REQUIRED`, `UNIQUE`, `UNIQUELABEL`, `FREEZE`, `SEARCHKEY` |
| D | Data type (§3.2) |
| E | Dropdown source: literal list (`a,b,c`) or a sheet range (`Lists!A2:A`) |
| F / G | Stage name / stage number (1 = intake form) |
| H | Dependency rules: `col:COND,col:COND` — COND ∈ `NULL`, `NOT NULL`, `TRUE`, `TIME` (base time column), `CONDITION` (TAT key column), `CHANGE`/`DEPEND` (dependent dropdown wiring), or a literal value |
| I | TAT hours. Number (negative = *before* the base time) or JSON map `{"Urgent":4,"Normal":24}` keyed by the `CONDITION` column's value |
| J / L | Stage background / font colour |
| K | Form question type: `Static-L`, `Static-R` (header fields), `Dynamic` (line-item fields) |
| M | Responsible groups (notified for this stage) |
| N / O | Groups that can **view** / **edit** this field (`ALL` allowed) |
| P | Column width (px) |
| S / T | Stage list: name (cell colour = stage colour) / number |

### 3.2 Field types (`Settings!D`)

* Inputs: `text`, `number`, `email`, `date`, `datetime-local`, `textarea`, `checkbox`, `file`, `useremail` (auto-filled with logged-in email), `send_status`.
* Choice: `dropdown_Itm` (static list), `dropdown_Rng` (sheet range), `dropdown-search` (searchable, strict), `dropdown-multiple-search` (multi-select), `dropdown-input` (suggestions, free text allowed), `dropdown-dependent` (2-col range parent→child).
* Computed: `formula`, `Formula-Nowrap`, `formula_long`, `htmlformula` — sheet formulas; the app blanks them on write so the sheet recalculates.
* Timeline: `TS_TAT` (planned, computed by `planningtime`), `TS_MANUAL` (planned, typed by user), `TS_Formula` (planned, sheet formula), `TS_Data` (actual, stamped by `timestamp`).

Each stage ≥ 2 must have exactly one planned column and every stage exactly one
actual column (`settingCheckData` validates this).

### 3.3 Users and access (`Settings!X:AC`)

`X` row filter (`col:value` AND-joined with `,`, OR-joined with `;`), `Y` groups
(comma list; special groups `CREATE`, `DELETE`, `RUNSCRIPT`), `Z` name, `AA` phone,
`AB` email, `AC` **plaintext password**.

### 3.4 Global configuration (`Settings!AE:AR`)

Shift start/end + working hours/day (`AF2:AH2`), timezone (`AF69`), WhatsApp
credentials (`AF6:AF7`, business API `AF73:AF78`), logo (`AF11:AF12`), default rows
(`AF15`), multi-item form settings (`AF22:AF27`), export unique column (`AF28`),
submission-ID mode (`AF29`), "send on holidays" (`AE18`), FMS-to-FMS post
connections (`AF46:AH52`, three slots), sort (`AF58`,`AF60`), row colour rules
(`AF64:AF66`), secure form (`AF80`), image columns (`AE83`), archive trigger
(`AF87:AH91`), custom form URL (`AF95`), audit-log sheet (`AF100`), report hours
(`AK7`, `AK12:AK15`), report recipients (`AK16:AK19`), Drive folder (`AK20`), sender
alias (`AK21`), reminder tiers (`AK3:AQ8`), report config (`AL12:AQ15`), deploy URL
and short URL (`AR1:AR3`).

## 4. Core engine

### 4.1 Planned time — `planningtime()`
For each `TS_TAT` field: select rows where all `H` conditions hold and the planned
cell is empty; take the base time from the `TIME` column; resolve hours (fixed or
via the `CONDITION` column JSON map); then add (or subtract for negative TAT)
**working hours**: start on the next working day if the base is a holiday, clamp to
shift start, roll overflow past shift end into the next working day(s), using
`Holiday!K:L` as the working-day calendar. Writes `dd/MMM/yyyy HH:mm`, then calls
`onformsubmit()`.

### 4.2 Actual time — `timestamp()`
For each `TS_Data` field: rows where all `H` conditions hold and the actual cell is
empty get `new Date()`. Triggered after every web update (`sheetUpdate → timestamp(true)`
→ `planningtime` → `onformsubmit`) and every 10 minutes (`updatetimestamp`).

### 4.3 Record numbering — `updatetimestamp()` / `dataSubmit()`
Counters kept in `DocumentProperties` (`recordno`, `submissionid`); rows that
arrived without a number (e.g. from Google Forms) get one.

### 4.4 Current-stage semantics (used by all reports)
A record is **pending at stage N** ⇔ planned(N) is set and actual(N) is empty.
**Overdue** ⇔ pending and planned < now. **Done on time** ⇔ actual ≤ planned.

## 5. Notifications

1. **Stage hand-off** (`onformsubmit`, `Settings!AL8:AP8`): when stage N is done and
   N+1 is planned but not done, email/WhatsApp stage N+1's responsible groups a table
   of their new tasks with deep links `?page=update&recordno=X&stage=N+1`; mark
   `Step N Completion Reminder`.
2. **Upcoming reminders** (`sendreminder`, tiers in `Settings` rows 3–6): notify
   when `planned − now` ≈ `TAT × multiplier` (10-minute window).
3. **Pending digest** (`sendpending`, row 7, daily at `AK7`): all overdue tasks per stage.
4. **Custom rules** (`send_custom_rem`, Messages tab): per rule — condition
   (column + value/NULL/NOT NULL), sender, to/cc/mobile (with `<<Field>>` tags),
   subject/body (or a Google Doc as body), attachments, optional document generation
   (Doc/Sheet/Slide template → PDF/DOCX/XLSX/PNG, "autocrat"), optional data export
   to another sheet, WhatsApp text or business-API template (campaign, tags,
   language), repeat schedule (`repatreminder` clears status columns every N days).
   Sent state = `<Rule> Reminder Status` column.
5. **Resend** (`send_individual_rem`): clears the status cell so the rule fires again.

Channels: Gmail (`GmailApp`), WhatsApp via the CEOITBOX `CBXWA2` library (text +
PDF) or the business API (`backend.api-wa.co`). HTML bodies are converted to PDF
via Drive for WhatsApp.

## 6. Reports (daily triggers, PDF via sheet export)

| Report | Content |
|---|---|
| `Rep_Stage` | Count per stage of pending tasks + detail rows (selected columns, stage, planned, delay hours) |
| `Rep_Pending` | Same, restricted to overdue |
| `Rep_Step` | For one chosen stage, which of its input fields are still empty |
| `Rep_Activity_Funnel` | Per stage: done on time, done late, overdue, upcoming, total (optional date range) |
| `Rep_Ord_Status` | Matrix record × stage with `D` (done) / `P` (pending) |
| AI report | Filter a tab, send the rows + a prompt to ChatGPT/Gemini/Claude/… every 30 min, email/WA the answer |

## 7. Other jobs

* **Archive** (`archiveall`) — move rows matching `Archive!D1/H1` to Archive (local or
  external sheet); manual or on a configurable trigger.
* **Post data** (`post_data`) — every 15 min push selected columns of matching rows
  to up to three external sheets; mark `Posted on …`.
* **Schema admin** — `addFields` / `deleteFields` / `addstage` / `deletestage`
  insert or remove columns and *renumber every column reference* in Settings,
  Messages, view conditions and post-connection config (necessary because rules
  reference columns by index).
* **Self-update** — `update_sheet`, `check_library_version`, `getcode` pull HTML and
  code from CEOITBOX master sheets/docs; `checklicence` validates a licence against
  `auth.ceoitbox.com` (cached 25 days in a base64 note).
* **Triggers** — `createtrigger` installs: reminders/custom rules/timestamps every
  10 min, post-data 15 min, dropdown cache 5 min, AI 30 min, reports daily.

## 8. Web app (`doGet` → `?page=`)

| Page | File | Purpose |
|---|---|---|
| `View Table` (default) | View Table.html | Main grid: pagination, global search, per-column filters (multi-select, number and date range sliders), sort, saved filter views, column aggregations (count/sum/unique/avg), inline edit, file upload, bulk delete (→archive), resend reminder, run admin functions, custom table views, dashboard tiles |
| `update` | update.html | Stage-wise update of one record: pick record + stage, edit only that stage's fields |
| `submit form` | submit form.htnl | Simple single-record intake form (+ edit) |
| `Form` | Form.html | Multi-item order form: header fields + repeating line items (add/clone/remove); one Data row per item, shared Submission ID |
| `EditResponse` | EditResponse.html / additional.html | Edit an existing submission's line items (add/update/delete rows) |
| `dashboard` | dashboard.html | Report tiles filtered by group, searchable, paged |

All pages call `returnuser(page)` which returns **the full Settings tab, all data
rows and all user credentials** as one JSON blob; filtering and permission checks
happen in the browser.

## 9. Problems the new platform must fix

**Security (critical)**
1. Plaintext passwords are stored in `Settings!AC` and **sent to every browser**
   (`returnuser → rightdata`); anyone who opens dev tools can read every login.
2. Authorisation is enforced only client-side: hidden columns, row filters and
   CREATE/DELETE rights are UI-only; `setDeleteRow`, `sheetUpdate`, `op_runfun` accept
   any caller.
3. Credentials in `localStorage`; deep links accept `user`/`pass` in the URL.
4. HTML built by string concatenation from data → stored XSS.
5. Uploaded files and generated documents are shared "anyone with link".
6. AI/WhatsApp API keys in cell notes.

**Correctness / reliability**
7. Everything is keyed by column *index*; inserting a column requires renumbering
   references in five places (bugs: `deleteFields` uses the wrong variable `t` for
   AF47/AF48).
8. Race conditions: counters read-modify-write without `LockService`; concurrent
   submits can duplicate record numbers; row-number based deletes shift under
   concurrent edits.
9. Working-hours maths duplicated ~10 times with inconsistent rules; uses both
   shift length and a separate "working hours" number, and `Math.min` over an
   empty holiday list yields an invalid date at the end of the calendar.
10. Bugs observed: `delete_item_record` references undefined `setting_sht` and
    `recordno`; the unique check in `dataSubmit` compares `filter > ''`; `wabodyfun`
    strips only the first `*`; `sheetUpdate` is defined twice.
11. Duplicate notifications or missed ones depend on status cells that users can edit.

**Scalability**
12. 6-minute script limit, ~20k cell sheets, per-cell `getRange().setValue()` in loops,
    whole-sheet reads every 10 minutes, every page load ships the whole dataset.

## 10. Feature mapping (legacy → new)

| Legacy | New platform |
|---|---|
| Data tab rows | `Record` rows (JSONB `data`) + `RecordStage` rows (planned/actual per stage) |
| Settings field rows | `Field` table (typed, stable `key`, no column indices) |
| Settings stage list | `Stage` table with `plannedRule` + `completionRule` JSON |
| `H`/`I` columns | Typed `Condition[]` + `TatRule` (fixed or keyed by field value) |
| Holiday tab, shift config | `BusinessCalendar` + `Holiday` tables (IANA timezone) |
| Users block X:AC | `User` (argon2id hash), `Group`, `UserGroup`, `User.rowFilter` |
| N/O view/edit groups | `Field.viewGroups` / `Field.editGroups`, enforced **server-side** |
| `planningtime`/`timestamp` | `@fms/core` `computeTimeline()` run in the same DB transaction as each write + periodic worker sweep |
| Counters in properties | Postgres sequences per workflow (atomic) |
| Messages tab | `NotificationRule` + `NotificationLog` (idempotency key, no status columns) |
| Reminder tiers / hand-off / pending | Built-in rules in worker (`stage-handoff`, `upcoming`, `overdue-digest`) |
| Rep_* tabs + PDF | `/reports/*` JSON APIs + React dashboards + scheduled email digests |
| Archive tab/trigger | `Record.archivedAt` + `ArchiveRule` job |
| Post data | Outbound webhooks (signed, retried) |
| Saved filters in notes | `SavedView` table |
| Table View / Dashboard tabs | `SavedView.columns` / `DashboardTile` |
| Audit log sheet | `AuditLog` table (who, what, diff) |
| Licence checks, self-update, short URLs | Dropped (normal SaaS deploy, own domain) |
| Autocrat document generation | Phase 2: HTML templates → PDF service |
| AI report | Phase 2: LLM summary job behind a provider interface |
