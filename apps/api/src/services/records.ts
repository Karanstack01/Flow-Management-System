/**
 * Record service — all writes go through here so that validation, permissions,
 * unique checks, numbering, timeline computation and audit happen atomically in
 * one transaction (legacy: dataSubmit / sheetUpdate / updatedata / setDeleteRow /
 * pre_fill_Submit + planningtime + timestamp, spread across triggers).
 */
import {
  applySystemFields,
  canSeeRecord,
  computeTimeline,
  defaultFieldValues,
  editableFieldKeys,
  evaluateGroup,
  hasCapability,
  isAdmin,
  isEmptyValue,
  canActOnStage,
  projectData,
  recordTitle,
  stageAccess,
  staleDependents,
  uniqueValues,
  validateRecordInput,
  visibleFieldKeys,
  type FieldDef,
  type RecordData,
  type StageState,
} from '@fms/core';
import { prisma, Prisma, saveStageStates, toStageStates, type LoadedWorkflow, type Record as RecordRow, type RecordStage, type Tx } from '@fms/db';
import type { AuthUser } from '../plugins/auth.js';
import { audit, diffData } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { renderDocument } from '../lib/docgen.js';
import { storeBuffer } from '../lib/filestore.js';
import { publishRecordChanged } from '../lib/queue.js';

const MAX_ITEMS = 200;

/** Ends a dry-run transaction without writing. */
class DryRunDone extends Error {}

export interface StageDto {
  stageKey: string;
  status: StageState['status'];
  plannedAt: string | null;
  actualAt: string | null;
  overdue: boolean;
}

export interface RecordDto {
  id: string;
  number: number;
  title: string;
  submissionId: string | null;
  data: RecordData;
  currentStageKey: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  stages: StageDto[];
  /** Records table colour from the flow's row colour rules (null = none matched). */
  rowColor: { color: string; label: string | null } | null;
}

type RowLike = Pick<RecordRow, 'id' | 'number' | 'submissionId' | 'data' | 'currentStageKey' | 'completedAt' | 'archivedAt' | 'createdAt' | 'updatedAt' | 'version'>;

export function toDto(wf: LoadedWorkflow, p: AuthUser, row: RowLike, stages: readonly StageState[], now = new Date()): RecordDto {
  const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
  const data = projectData(row.data as RecordData, visible);
  const byKey = new Map(stages.map((s) => [s.stageKey, s]));
  // Row colour (Flow settings › Records table): the first matching rule. Rules that test a field this
  // user can not see are skipped, so a colour never gives a hidden value away.
  const colour = wf.settings.table.rowColors.find((r) => r.when.conditions.length > 0 && r.when.conditions.every((c) => visible.has(c.field)) && evaluateGroup(r.when, data));
  return {
    id: row.id,
    number: row.number,
    title: recordTitle(wf.def.fields.filter((f) => visible.has(f.key)), data, row.number),
    submissionId: row.submissionId,
    data,
    rowColor: colour ? { color: colour.color, label: colour.label ?? null } : null,
    currentStageKey: row.currentStageKey,
    completedAt: row.completedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    stages: wf.def.stages.map((st) => {
      const s = byKey.get(st.key);
      return {
        stageKey: st.key,
        status: s?.status ?? 'waiting',
        plannedAt: s?.plannedAt?.toISOString() ?? null,
        actualAt: s?.actualAt?.toISOString() ?? null,
        overdue: s?.status === 'active' && !!s.plannedAt && s.plannedAt.getTime() < now.getTime(),
      };
    }),
  };
}

function intakeFields(wf: LoadedWorkflow) {
  const intake = wf.def.stages[0]!.key;
  const fields = wf.def.fields.filter((f) => f.stageKey === intake);
  return { header: fields.filter((f) => !f.lineItem), items: fields.filter((f) => f.lineItem) };
}

/** Serialise writes per workflow while checking unique fields (prevents check-then-insert races). */
async function lockForUnique(tx: Tx, wf: LoadedWorkflow) {
  if (wf.def.fields.some((f) => f.unique)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wf.id}))`;
}

async function assertUnique(tx: Tx, wf: LoadedWorkflow, rows: RecordData[], excludeId?: string) {
  const errors: Record<string, string> = {};
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const u of uniqueValues(wf.def.fields, row)) {
      const norm = u.value.toLowerCase();
      const set = seen.get(u.key) ?? new Set();
      if (set.has(norm)) errors[u.key] = `${u.label} must be unique (duplicated in this submission)`;
      set.add(norm);
      seen.set(u.key, set);
      const clash = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Record"
        WHERE "workflowId" = ${wf.id} AND "archivedAt" IS NULL AND lower(trim("data"->>${u.key})) = ${norm}
          ${excludeId ? Prisma.sql`AND "id" <> ${excludeId}` : Prisma.empty}
        LIMIT 1`;
      if (clash.length) errors[u.key] = `${u.label} "${u.value}" already exists`;
    }
  }
  if (Object.keys(errors).length) throw AppError.validation(errors);
}

function stageStateData(s: StageState) {
  return { stageKey: s.stageKey, status: s.status, plannedAt: s.plannedAt, actualAt: s.actualAt };
}

// ---------------------------------------------------------------- create

export interface CreateInput {
  data: Record<string, unknown>;
  items?: Record<string, unknown>[];
}

/**
 * Add line items to an existing multi-item submission (legacy EditResponse): new records in the same
 * submission, with the submission's header values copied from one of its records.
 */
export async function addSubmissionItems(p: AuthUser, wf: LoadedWorkflow, recordId: string, items: Record<string, unknown>[], ip?: string): Promise<RecordDto[]> {
  const row = await prisma.record.findFirst({ where: { id: recordId, workflowId: wf.id } });
  if (!row || !canSeeRecord(p, row.data as RecordData)) throw AppError.notFound('Record');
  if (!row.submissionId) throw AppError.badRequest('This record is not part of a multi-item submission');
  const { header, items: itemFields } = intakeFields(wf);
  if (!itemFields.length) throw AppError.badRequest('This workflow has no line items');
  const count = await prisma.record.count({ where: { submissionId: row.submissionId, archivedAt: null } });
  if (count + items.length > MAX_ITEMS) throw AppError.badRequest(`At most ${MAX_ITEMS} items per submission`);
  const data = row.data as RecordData;
  const headerData = Object.fromEntries(header.filter((f) => f.key in data).map((f) => [f.key, data[f.key]])) as RecordData;
  return createSubmission(p, wf, { data: {}, items }, ip, { submissionId: row.submissionId, header: headerData });
}

/**
 * CSV import: each row becomes a record (a one-item submission when the flow has line items),
 * with the same validation, defaults, unique checks and timeline as the form. `dryRun` checks
 * every row and saves nothing. Rows are independent: one bad row does not stop the others.
 */
export async function importRecords(p: AuthUser, wf: LoadedWorkflow, rows: Record<string, unknown>[], opts: { dryRun: boolean }, ip?: string) {
  const { items: itemFields } = intakeFields(wf);
  const itemKeys = new Set(itemFields.map((f) => f.key));
  const results: { row: number; ok: boolean; number?: number; errors?: Record<string, string>; message?: string }[] = [];
  for (const [i, raw] of rows.entries()) {
    const header = Object.fromEntries(Object.entries(raw).filter(([k]) => !itemKeys.has(k)));
    const item = Object.fromEntries(Object.entries(raw).filter(([k]) => itemKeys.has(k)));
    try {
      const created = await createSubmission(p, wf, { data: header, ...(itemFields.length ? { items: [item] } : {}) }, ip, undefined, { dryRun: opts.dryRun, quiet: true });
      results.push({ row: i + 1, ok: true, number: created[0]?.number });
    } catch (e) {
      const errors = e instanceof AppError && e.details ? Object.fromEntries(Object.entries(e.details as Record<string, string>).map(([k, v]) => [k.replace(/^items\.0\./, ''), v])) : undefined;
      results.push({ row: i + 1, ok: false, errors, message: (e as Error).message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  if (!opts.dryRun && ok) await audit(prisma, { orgId: wf.orgId, actor: p, action: 'records.imported', entityType: 'Workflow', entityId: wf.id, diff: { rows: rows.length, created: ok }, ip });
  return { total: rows.length, ok, failed: rows.length - ok, results: results.filter((r) => !r.ok).slice(0, 500) };
}

export async function createSubmission(p: AuthUser, wf: LoadedWorkflow, input: CreateInput, ip?: string, into?: { submissionId: string; header: RecordData }, mode: { dryRun?: boolean; quiet?: boolean } = {}): Promise<RecordDto[]> {
  if (!wf.isActive) throw AppError.conflict('This workflow is not accepting new records');
  if (!hasCapability(p, 'CREATE')) throw AppError.forbidden('You cannot create records in this workflow');

  const { header, items: itemFields } = intakeFields(wf);
  const editable = editableFieldKeys(wf.def.fields, p, wf.def.stages);
  const tz = wf.calendar.config.timezone;
  const errors: Record<string, string> = {};
  const ruleContext = { CREATED_BY: p.email, CREATED_AT: new Date().toISOString(), CURRENT_STAGE: wf.def.stages[0]?.name ?? null, FLOW_NAME: wf.name, RECORD_NUMBER: null };

  // Defaults fill whatever the submission left out (hidden fields get their value only this way).
  // `required` is enforced for fields this user can fill in or that have a default: a hidden or
  // restricted required field would otherwise make the form impossible to submit for everyone.
  const defaultsFor = (fields: readonly FieldDef[], given: Record<string, unknown>) => {
    const all = defaultFieldValues(fields, { timezone: tz, options: wf.options });
    return Object.fromEntries(Object.entries(all).filter(([k]) => !(k in given))) as RecordData;
  };
  const requiredFor = (fields: readonly FieldDef[], defaults: RecordData) => new Set(fields.filter((f) => editable.has(f.key) || f.key in defaults).map((f) => f.key));

  const headerIn = input.data ?? {};
  const headerDefaults = defaultsFor(header, headerIn);
  // Adding to an existing submission: its header is already validated and saved.
  const h = into ? { data: { ...into.header }, errors: {} } : validateRecordInput(header, headerIn, { mode: 'create', editable, requiredScope: requiredFor(header, headerDefaults), existing: headerDefaults, options: wf.options, timezone: tz, ruleContext });
  if (!into) h.data = { ...headerDefaults, ...h.data };
  Object.assign(errors, h.errors);

  const rawItems = input.items ?? [];
  if (!itemFields.length && rawItems.length) throw AppError.badRequest('This workflow has no line items');
  if (itemFields.length && rawItems.length === 0) throw AppError.validation({ items: 'Add at least one item' });
  if (rawItems.length > MAX_ITEMS) throw AppError.badRequest(`At most ${MAX_ITEMS} items per submission`);

  const rows: RecordData[] = [];
  if (itemFields.length) {
    rawItems.forEach((item, i) => {
      const itemDefaults = defaultsFor(itemFields, item);
      const r = validateRecordInput(itemFields, item, { mode: 'create', editable, requiredScope: requiredFor(itemFields, itemDefaults), options: wf.options, existing: { ...h.data, ...itemDefaults }, timezone: tz, ruleContext });
      for (const [k, v] of Object.entries(r.errors)) errors[`items.${i}.${k}`] = v;
      rows.push({ ...h.data, ...itemDefaults, ...r.data });
    });
  } else {
    rows.push(h.data);
  }
  if (Object.keys(errors).length) throw AppError.validation(errors);

  const finalRows = rows.map((r) => applySystemFields(wf.def.fields, r, { isCreate: true, userEmail: p.email, timezone: tz }));
  await assertFilesOwned(p, wf.orgId, wf.def.fields, finalRows);
  if (mode.dryRun) {
    // Check unique values too, then roll back: nothing is written in a dry run.
    await prisma.$transaction(async (tx) => {
      await assertUnique(tx, wf, finalRows);
      throw new DryRunDone();
    }).catch((e) => {
      if (!(e instanceof DryRunDone)) throw e;
    });
    return finalRows.map((_, i) => ({ number: 0, id: `dry-${i}` }) as RecordDto);
  }

  const created = await prisma.$transaction(async (tx) => {
    await lockForUnique(tx, wf);
    await assertUnique(tx, wf, finalRows);

    const seq = await tx.$queryRaw<{ recordSeq: number }[]>`
      UPDATE "Workflow" SET "recordSeq" = "recordSeq" + ${finalRows.length} WHERE "id" = ${wf.id} RETURNING "recordSeq"`;
    const recordSeq = seq[0]!.recordSeq;
    let submissionId: string | null = into?.submissionId ?? null;
    if (itemFields.length && !into) {
      const sub = await tx.$queryRaw<{ submissionSeq: number }[]>`
        UPDATE "Workflow" SET "submissionSeq" = "submissionSeq" + 1 WHERE "id" = ${wf.id} RETURNING "submissionSeq"`;
      submissionId = (await tx.submission.create({ data: { workflowId: wf.id, number: sub[0]!.submissionSeq, createdById: p.userId } })).id;
    }

    const now = new Date();
    const out: Array<{ row: RecordRow; stages: StageState[] }> = [];
    for (const [i, data] of finalRows.entries()) {
      const timeline = computeTimeline({ stages: wf.def.stages, data, createdAt: now, now, calendar: wf.calendar });
      const row = await tx.record.create({
        data: {
          orgId: wf.orgId,
          workflowId: wf.id,
          number: recordSeq - finalRows.length + 1 + i,
          submissionId,
          data: data as Prisma.InputJsonObject,
          currentStageKey: timeline.currentStageKey,
          completedAt: timeline.currentStageKey ? null : now,
          createdById: p.userId,
          createdAt: now,
          stages: { create: timeline.states.map(stageStateData) },
        },
      });
      await audit(tx, { orgId: wf.orgId, actor: p, action: 'record.created', entityType: 'Record', entityId: row.id, diff: { number: row.number }, ip });
      out.push({ row, stages: timeline.states });
    }
    return out;
  });

  await publishRecordChanged(created.map((c) => c.row.id));
  const ids = created.map((c) => c.row.id);
  const regenerated = await afterWrite(p, wf, ids);
  // Imports only need the numbers.
  if (mode.quiet) return created.map((c) => ({ id: c.row.id, number: c.row.number }) as RecordDto);
  if (regenerated) return Promise.all(ids.map((id) => getRecord(p, wf, id)));
  return created.map((c) => toDto(wf, p, c.row, c.stages));
}

const fileIds = (fields: readonly FieldDef[], rows: RecordData[]) => {
  const keys = fields.filter((f) => f.type === 'file').map((f) => f.key);
  return new Set(rows.flatMap((r) => keys.flatMap((k) => (Array.isArray(r[k]) ? (r[k] as string[]) : []))));
};

/**
 * Newly attached file ids must be uploads of this organization made by the person saving
 * (admins excepted). Ids already on the record stay valid. Otherwise anyone who learned a file
 * id could attach it to their own record and read a file they were never shown.
 */
async function assertFilesOwned(p: AuthUser, orgId: string, fields: readonly FieldDef[], rows: RecordData[], existing?: RecordData) {
  const already = existing ? fileIds(fields, [existing]) : new Set<string>();
  const ids = [...fileIds(fields, rows)].filter((id) => !already.has(id));
  if (!ids.length) return;
  const found = await prisma.fileObject.count({ where: { orgId, id: { in: ids }, ...(isAdmin(p) ? {} : { uploadedById: p.userId }) } });
  if (found !== ids.length) throw AppError.validation({ files: 'One or more attachments are invalid' });
}

// ---------------------------------------------------------------- update / complete

async function loadForWrite(tx: Tx, wf: LoadedWorkflow, p: AuthUser, id: string) {
  const row = await tx.record.findFirst({ where: { id, workflowId: wf.id }, include: { stages: true } });
  if (!row || !canSeeRecord(p, row.data as RecordData)) throw AppError.notFound('Record');
  if (row.archivedAt) throw AppError.conflict('Archived records are read-only');
  // "Inactive (read-only)" means exactly that: no edits, stage completions or re-planning.
  if (!wf.isActive) throw AppError.conflict('This flow is inactive, so its records are read-only. Activate it on All Flows to make changes.');
  return row;
}

export interface UpdateInput {
  data?: Record<string, unknown>;
  /** Optimistic concurrency: the version the client edited. */
  version?: number;
}

interface ChangeOptions {
  completeStageKey?: string;
  ip?: string;
  /** Called from the bulk tool (stages with "Single item update" off are edited only this way). */
  bulk?: boolean;
  /** Values written by the server itself (generated documents): no validation or permission checks. */
  systemPatch?: RecordData;
  /** Audit action override. */
  action?: string;
}

async function applyChange(p: AuthUser, wf: LoadedWorkflow, id: string, input: UpdateInput, opts: ChangeOptions): Promise<RecordDto> {
  const result = await prisma.$transaction(async (tx) => {
    await lockForUnique(tx, wf);
    const row = await loadForWrite(tx, wf, p, id);
    if (input.version !== undefined && input.version !== row.version) {
      throw AppError.conflict('This record was changed by someone else. Reload and try again.', { currentVersion: row.version });
    }
    const existing = row.data as RecordData;
    const previous = toStageStates(row.stages);
    const statusOf = new Map(previous.map((s) => [s.stageKey, s.status]));

    const editable = editableFieldKeys(wf.def.fields, p, wf.def.stages);
    const stageOf = new Map(wf.def.stages.map((s) => [s.key, s]));
    for (const f of wf.def.fields) {
      const st = statusOf.get(f.stageKey);
      const sd = stageOf.get(f.stageKey);
      // Fields of stages that have not been reached yet cannot be filled in (admins excepted).
      if (!isAdmin(p) && st !== 'active' && st !== 'done') editable.delete(f.key);
      // "Lock editing after this stage is completed" holds for everyone, admins included.
      if (sd?.lockAfterComplete && st === 'done') editable.delete(f.key);
      // A stage with "Single item update" off is filled in from the bulk tool only.
      if (sd?.singleUpdate === false && !opts.bulk && !isAdmin(p)) editable.delete(f.key);
      // A generated document is replaced by generating it again, not by hand.
      if (sd?.document?.fieldKey === f.key) editable.delete(f.key);
    }

    const v = opts.systemPatch ? { data: opts.systemPatch, errors: {} as Record<string, string> } : validateRecordInput(wf.def.fields, input.data ?? {}, {
      mode: 'update',
      editable,
      requiredScope: new Set(wf.def.fields.map((f) => f.key)),
      existing,
      options: wf.options,
      timezone: wf.calendar.config.timezone,
      ruleContext: {
        RECORD_NUMBER: row.number,
        CREATED_AT: row.createdAt.toISOString(),
        CREATED_BY:
          row.createdById === p.userId
            ? p.email
            : row.createdById && wf.def.fields.some((f) => f.validationRule?.includes('CREATED_BY'))
              ? ((await tx.user.findUnique({ where: { id: row.createdById }, select: { email: true } }))?.email ?? null)
              : null,
        CURRENT_STAGE: wf.def.stages.find((s) => s.key === row.currentStageKey)?.name ?? null,
        FLOW_NAME: wf.name,
      },
    });
    if (Object.keys(v.errors).length) throw AppError.validation(v.errors);

    // A changed parent clears dependent dropdown values it no longer offers (down the chain).
    const changedKeys = Object.keys(v.data).filter((k) => v.data[k] !== existing[k]);
    const next = { ...existing, ...v.data };
    const merged = applySystemFields(wf.def.fields, { ...next, ...staleDependents(wf.def.fields, next, changedKeys) }, { isCreate: false, timezone: wf.calendar.config.timezone });
    if (!opts.systemPatch) await assertFilesOwned(p, wf.orgId, wf.def.fields, [merged], existing);
    const changedUnique = wf.def.fields.filter((f) => f.unique && f.key in v.data && merged[f.key] !== existing[f.key]);
    if (changedUnique.length) {
      await assertUnique(tx, { ...wf, def: { ...wf.def, fields: changedUnique } }, [merged], row.id);
    }

    const now = new Date();
    let prevForTimeline = previous;
    if (opts.completeStageKey) {
      const stage = wf.def.stages.find((s) => s.key === opts.completeStageKey);
      if (!stage) throw AppError.notFound('Stage');
      if (statusOf.get(stage.key) !== 'active') throw AppError.conflict(`"${stage.name}" is not the active stage`);
      if (stage.completion.kind === 'on_create') throw AppError.badRequest('This stage completes automatically');
      if (stage.singleUpdate === false && !opts.bulk && !isAdmin(p)) throw AppError.badRequest(`"${stage.name}" is updated in bulk from the records table`);
      const stageFields = wf.def.fields.filter((f) => f.stageKey === stage.key);
      // Restricted stage → its assigned Editors; owned stage → its groups; unowned → anyone who may fill
      // in one of its fields (a stage without fields would otherwise be completable by admins only).
      const unowned = !stage.stageAccessRestricted && !stage.responsibleGroups.length;
      const canAct = canActOnStage(stage, p) && (!unowned || isAdmin(p) || !stageFields.length || stageFields.some((f) => editableFieldKeys([f], p, wf.def.stages).size > 0));
      if (!canAct) throw AppError.forbidden(`You are not responsible for "${stage.name}"`);
      // Hidden fields are never shown in a form, so they can not hold a stage up.
      const missing = stageFields.filter((f) => f.required && !f.hidden && f.type !== 'computed' && (isEmptyValue(merged[f.key]) || merged[f.key] === false));
      if (missing.length) throw AppError.validation(Object.fromEntries(missing.map((f) => [f.key, `${f.label} is required to complete this stage`])));
      prevForTimeline = previous.map((s) => (s.stageKey === stage.key ? { ...s, actualAt: now } : s));
    }

    const timeline = computeTimeline({ stages: wf.def.stages, data: merged, createdAt: row.createdAt, now, calendar: wf.calendar, previous: prevForTimeline });
    // A backward Stage Jump clears the fields that must be filled in again.
    const finalData: RecordData = timeline.dataPatch ? { ...merged, ...timeline.dataPatch } : merged;
    const diff = diffData(existing, finalData);
    if (!Object.keys(diff).length && !timeline.events.length) return { row, stages: previous, changed: false };

    const updated = await tx.record.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        data: finalData as Prisma.InputJsonObject,
        version: { increment: 1 },
        currentStageKey: timeline.currentStageKey,
        completedAt: timeline.currentStageKey ? null : (row.completedAt ?? now),
      },
    });
    if (updated.count !== 1) throw AppError.conflict('This record was changed by someone else. Reload and try again.');
    await saveStageStates(tx, row.id, previous, timeline.states, opts.completeStageKey ? { stageKey: opts.completeStageKey, userId: p.userId } : undefined);
    await audit(tx, {
      orgId: wf.orgId,
      actor: p,
      action: opts.action ?? (opts.completeStageKey ? 'record.stage_completed' : 'record.updated'),
      entityType: 'Record',
      entityId: row.id,
      diff: { fields: diff, events: timeline.events.map((e) => ({ type: e.type, stageKey: e.stageKey })) } as Prisma.InputJsonObject,
      ip: opts.ip,
    });
    const fresh = await tx.record.findUniqueOrThrow({ where: { id: row.id } });
    return { row: fresh, stages: timeline.states, changed: true };
  });

  if (result.changed) await publishRecordChanged([result.row.id]);
  return toDto(wf, p, result.row, result.stages);
}

export async function updateRecord(p: AuthUser, wf: LoadedWorkflow, id: string, input: UpdateInput, ip?: string) {
  const dto = await applyChange(p, wf, id, input, { ip });
  return (await afterWrite(p, wf, [id])) ? getRecord(p, wf, id) : dto;
}

export async function completeStage(p: AuthUser, wf: LoadedWorkflow, id: string, stageKey: string, input: UpdateInput, ip?: string) {
  const dto = await applyChange(p, wf, id, input, { completeStageKey: stageKey, ip });
  return (await afterWrite(p, wf, [id])) ? getRecord(p, wf, id) : dto;
}

// ---------------------------------------------------------------- bulk update

/** Stage bulk tool: the same values (and optionally "mark done") for many records of one stage. */
export async function bulkUpdate(p: AuthUser, wf: LoadedWorkflow, input: { ids: string[]; stageKey: string; data: Record<string, unknown>; complete: boolean }, ip?: string) {
  const stage = wf.def.stages.find((s) => s.key === input.stageKey);
  if (!stage) throw AppError.notFound('Stage');
  if (!stage.bulkUpdate) throw AppError.badRequest(`Bulk update is switched off for "${stage.name}"`);
  const own = new Set(wf.def.fields.filter((f) => f.stageKey === stage.key).map((f) => f.key));
  const foreign = Object.keys(input.data).filter((k) => !own.has(k));
  if (foreign.length) throw AppError.badRequest(`Only fields of "${stage.name}" can be updated here`);
  const rows = await prisma.record.findMany({ where: { id: { in: input.ids }, workflowId: wf.id }, select: { id: true, number: true } });
  const failed: { id: string; number: number | null; message: string }[] = [];
  let updated = 0;
  for (const id of input.ids) {
    const number = rows.find((r) => r.id === id)?.number ?? null;
    try {
      await applyChange(p, wf, id, { data: input.data }, { bulk: true, completeStageKey: input.complete ? stage.key : undefined, ip });
      await afterWrite(p, wf, [id]);
      updated++;
    } catch (e) {
      const details = e instanceof AppError && e.details && typeof e.details === 'object' ? Object.values(e.details as Record<string, string>)[0] : undefined;
      failed.push({ id, number, message: details ?? (e as Error).message });
    }
  }
  return { updated, failed };
}

// ---------------------------------------------------------------- document steps

const documentExtra = (wf: LoadedWorkflow, row: Pick<RecordRow, 'id' | 'number' | 'data' | 'currentStageKey'>) => ({
  record_number: row.number,
  record_title: recordTitle(wf.def.fields, row.data as RecordData, row.number),
  workflow_name: wf.name,
  current_stage: wf.def.stages.find((s) => s.key === row.currentStageKey)?.name ?? 'Completed',
  link: `${(process.env.APP_URL ?? '').replace(/\/$/, '')}/w/${wf.key}/records/${row.id}`,
});

/**
 * Document steps that are active and have no file yet get one: the body is filled with the
 * record, saved as PDF / Word, and written into the step's file field. A step without review then
 * completes by itself, which may start the next document step — hence the loop.
 * `force` regenerates that step's document even if it already has one.
 */
export async function generateDocuments(p: AuthUser, wf: LoadedWorkflow, recordId: string, force?: string): Promise<boolean> {
  if (!wf.def.stages.some((s) => s.document)) return false;
  let generated = false;
  for (let round = 0; round < 5; round++) {
    const row = await prisma.record.findUnique({ where: { id: recordId }, include: { stages: true } });
    if (!row || row.archivedAt) break;
    const data = row.data as RecordData;
    const active = new Set(row.stages.filter((s) => s.status === 'active').map((s) => s.stageKey));
    const stage = wf.def.stages.find((s) => s.document && active.has(s.key) && (s.key === force || isEmptyValue(data[s.document.fieldKey])));
    if (!stage?.document) break;
    force = undefined;
    const doc = await renderDocument(stage.document, { fields: wf.def.fields, data, extra: documentExtra(wf, row) });
    const file = await storeBuffer({ orgId: wf.orgId, buffer: doc.buffer, name: doc.fileName, mimeType: doc.mimeType, uploadedById: null });
    await applyChange(p, wf, recordId, {}, { systemPatch: { [stage.document.fieldKey]: [file.id] }, action: 'record.document_generated' });
    generated = true;
  }
  return generated;
}

/** Runs after a write. A failed generation never fails the user's save: the step shows "Generate document". */
async function afterWrite(p: AuthUser, wf: LoadedWorkflow, ids: string[]): Promise<boolean> {
  let any = false;
  for (const id of ids) {
    try {
      any = (await generateDocuments(p, wf, id)) || any;
    } catch (e) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'document generation failed', recordId: id, err: (e as Error).message }));
    }
  }
  return any;
}

/** Record page button: generate (again) the document of an active document step. */
export async function regenerateDocument(p: AuthUser, wf: LoadedWorkflow, id: string, stageKey: string) {
  const stage = wf.def.stages.find((s) => s.key === stageKey);
  if (!stage?.document) throw AppError.notFound('Document step');
  const row = await prisma.record.findFirst({ where: { id, workflowId: wf.id }, include: { stages: true } });
  if (!row || !canSeeRecord(p, row.data as RecordData)) throw AppError.notFound('Record');
  if (row.archivedAt) throw AppError.conflict('Archived records are read-only');
  if (!wf.isActive) throw AppError.conflict('This flow is inactive, so its records are read-only.');
  if (row.stages.find((s) => s.stageKey === stageKey)?.status !== 'active') throw AppError.conflict(`"${stage.name}" is not the active step`);
  const allowed = canActOnStage(stage, p) && stageAccess(stage, p).edit;
  if (!allowed) throw AppError.forbidden(`You are not responsible for "${stage.name}"`);
  await generateDocuments(p, wf, id, stageKey);
  return getRecord(p, wf, id);
}

/** Planned time for stages with planned.mode = manual (legacy TS_MANUAL). */
export async function setPlannedTime(p: AuthUser, wf: LoadedWorkflow, id: string, stageKey: string, plannedAt: Date, ip?: string) {
  const stage = wf.def.stages.find((s) => s.key === stageKey);
  if (!stage) throw AppError.notFound('Stage');
  if (stage.planned.mode !== 'manual') throw AppError.badRequest('This stage is planned automatically');
  if (!canActOnStage(stage, p) || !stageAccess(stage, p).edit) throw AppError.forbidden(`You are not responsible for "${stage.name}"`);
  await prisma.$transaction(async (tx) => {
    const row = await loadForWrite(tx, wf, p, id);
    const st = row.stages.find((s) => s.stageKey === stageKey);
    if (st?.status !== 'active') throw AppError.conflict('Stage is not active');
    await tx.recordStage.update({ where: { id: st.id }, data: { plannedAt } });
    await tx.record.update({ where: { id: row.id }, data: { version: { increment: 1 } } });
    await audit(tx, { orgId: wf.orgId, actor: p, action: 'record.planned_set', entityType: 'Record', entityId: row.id, diff: { stageKey, plannedAt: plannedAt.toISOString() }, ip });
  });
  await publishRecordChanged([id]);
  return getRecord(p, wf, id);
}

// ---------------------------------------------------------------- archive

export async function setArchived(p: AuthUser, wf: LoadedWorkflow, ids: string[], archived: boolean, ip?: string) {
  if (!hasCapability(p, 'DELETE')) throw AppError.forbidden('You cannot archive records');
  const rows = await prisma.record.findMany({ where: { id: { in: ids }, workflowId: wf.id }, select: { id: true, data: true } });
  const allowed = rows.filter((r) => canSeeRecord(p, r.data as RecordData)).map((r) => r.id);
  await prisma.$transaction(async (tx) => {
    await tx.record.updateMany({ where: { id: { in: allowed } }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    await tx.auditLog.createMany({
      data: allowed.map((entityId) => ({ orgId: wf.orgId, actorId: p.userId, actorEmail: p.email, action: archived ? 'record.archived' : 'record.restored', entityType: 'Record', entityId, ip })),
    });
  });
  return { count: allowed.length };
}

// ---------------------------------------------------------------- read

export async function getRecord(p: AuthUser, wf: LoadedWorkflow, id: string) {
  const row = await prisma.record.findFirst({ where: { id, workflowId: wf.id }, include: { stages: true } });
  if (!row || !canSeeRecord(p, row.data as RecordData)) throw AppError.notFound('Record');
  return toDto(wf, p, row, toStageStates(row.stages));
}

export async function getRecordHistory(p: AuthUser, wf: LoadedWorkflow, id: string) {
  await getRecord(p, wf, id); // access check
  const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
  const logs = await prisma.auditLog.findMany({ where: { orgId: wf.orgId, entityType: 'Record', entityId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
  return logs.map((l) => {
    const diff = (l.diff ?? {}) as { fields?: Record<string, unknown>; events?: unknown };
    const fields = diff.fields ? Object.fromEntries(Object.entries(diff.fields).filter(([k]) => visible.has(k))) : undefined;
    return { id: l.id, action: l.action, actorEmail: l.actorEmail, createdAt: l.createdAt.toISOString(), fields, events: diff.events };
  });
}

export function stagesFor(rows: readonly RecordStage[], recordId: string) {
  return toStageStates(rows.filter((s) => s.recordId === recordId));
}
