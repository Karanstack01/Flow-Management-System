import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conditionGroupSchema, formatValue, hasCapability, isAdmin, visibleFieldKeys, worksOnStage } from '@fms/core';
import { loadConnection, prisma, toStageStates, writeSheet } from '@fms/db';
import { AppError, parse } from '../lib/errors.js';
import { aggregateSql, distinctValuesSql, listSql, type ListQuery } from '../lib/record-sql.js';
import { publishRecordChanged } from '../lib/queue.js';
import { workflowFor } from '../lib/workflows.js';
import type { AuthUser } from '../plugins/auth.js';
import { addSubmissionItems, bulkUpdate, completeStage, createSubmission, importRecords, getRecord, regenerateDocument, getRecordHistory, setArchived, setPlannedTime, toDto, updateRecord } from '../services/records.js';
import type { LoadedWorkflow } from '@fms/db';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().max(64).default('number'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(200).optional(),
  stage: z.string().max(64).optional(),
  status: z.enum(['open', 'overdue', 'completed']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  mine: z.enum(['true', 'false']).default('false'),
  submissionId: z.string().max(40).optional(),
  /** JSON-encoded ConditionGroup over visible fields. */
  filters: z.string().max(10_000).optional(),
  /** Columns on screen (comma separated): they get filled / unique counts in the totals. */
  cols: z.string().max(4000).optional(),
});

const wfParams = z.object({ wf: z.string().min(1).max(64) });
const recParams = wfParams.extend({ id: z.string().min(1).max(40) });
const stageParams = recParams.extend({ stageKey: z.string().min(1).max(64) });

export function buildListQuery(wf: LoadedWorkflow, p: AuthUser, raw: unknown): ListQuery & { page: number; pageSize: number } {
  const q = parse(listQuerySchema, raw);
  const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
  let filters = null;
  if (q.filters) {
    let json: unknown;
    try {
      json = JSON.parse(q.filters);
    } catch {
      throw AppError.badRequest('filters must be JSON');
    }
    filters = parse(conditionGroupSchema, json);
    // Filtering on a field you cannot see would leak its values.
    const bad = filters.conditions.filter((c) => !visible.has(c.field));
    if (bad.length) throw AppError.badRequest(`Cannot filter on ${bad.map((c) => c.field).join(', ')}`);
  }
  const sortField = wf.def.fields.find((f) => f.key === q.sort);
  if (!['number', 'createdAt', 'updatedAt'].includes(q.sort) && !(sortField && visible.has(sortField.key))) throw AppError.badRequest('Invalid sort');
  const visibleFields = wf.def.fields.filter((f) => visible.has(f.key));
  const myStages = wf.def.stages.filter((s) => worksOnStage(s, p)).map((s) => s.key);
  return {
    workflowId: wf.id,
    archived: q.archived === 'true',
    rowFilter: isAdmin(p) ? null : p.rowFilter,
    filters,
    search: q.search || undefined,
    searchKeys: visibleFields.filter((f) => !['file', 'checkbox'].includes(f.type)).map((f) => f.key),
    stageKey: q.stage,
    status: q.status,
    activeStageKeys: q.mine === 'true' ? myStages : undefined,
    submissionId: q.submissionId,
    sort: { by: q.sort, dir: q.dir, field: sortField },
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    numericKeys: visibleFields.filter((f) => f.type === 'number' || f.type === 'computed').map((f) => f.key),
    countKeys: (q.cols ?? '').split(',').map((k) => k.trim()).filter((k, i, a) => k && visible.has(k) && a.indexOf(k) === i).slice(0, 60),
    page: q.page,
    pageSize: q.pageSize,
  };
}

type ListRow = Parameters<typeof toDto>[2];

export async function runList(wf: LoadedWorkflow, p: AuthUser, query: ListQuery) {
  const [rows, agg] = await Promise.all([prisma.$queryRaw<ListRow[]>(listSql(query)), prisma.$queryRaw<Record<string, unknown>[]>(aggregateSql(query))]);
  const stages = rows.length ? await prisma.recordStage.findMany({ where: { recordId: { in: rows.map((r) => r.id) } } }) : [];
  const now = new Date();
  const a = agg[0] ?? { count: 0 };
  const n = (v: unknown) => (v == null ? null : Number(v));
  const aggregates: Record<string, { sum?: number | null; avg?: number | null; min?: number | null; max?: number | null; filled?: number; unique?: number }> = Object.fromEntries(
    query.numericKeys.map((k, i) => [k, { sum: n(a[`sum_${i}`]), avg: n(a[`avg_${i}`]), min: n(a[`min_${i}`]), max: n(a[`max_${i}`]) }]),
  );
  for (const [i, k] of (query.countKeys ?? []).entries()) aggregates[k] = { ...aggregates[k], filled: Number(a[`filled_${i}`] ?? 0), unique: Number(a[`unique_${i}`] ?? 0) };
  return {
    items: rows.map((r) => toDto(wf, p, r, toStageStates(stages.filter((s) => s.recordId === r.id)), now)),
    total: Number(a.count ?? 0),
    aggregates,
  };
}

function csvCell(v: unknown) {
  const s = formatValue(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export default async function recordRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/workflows/:wf/records', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    const query = buildListQuery(wf, req.principal, req.query);
    const result = await runList(wf, req.principal, query);
    return { ...result, page: query.page, pageSize: query.pageSize };
  });

  /** Values used in one column, most common first (column filter lists). Row filter and field access apply. */
  app.get('/workflows/:wf/records/values', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const { field, archived } = parse(z.object({ field: z.string().min(1).max(64), archived: z.enum(['true', 'false']).default('false') }), req.query);
    const wf = await workflowFor(req.principal, key);
    if (!visibleFieldKeys(wf.def.fields, req.principal, wf.def.stages).has(field)) throw AppError.badRequest('Unknown field');
    const rows = await prisma.$queryRaw<{ value: string; count: number }[]>(distinctValuesSql(wf.id, field, isAdmin(req.principal) ? null : (req.principal.rowFilter ?? null), archived === 'true'));
    return { items: rows };
  });

  /** The filtered records as rows (header first), visible fields only — CSV and Google Sheets exports. */
  async function exportRows(wf: LoadedWorkflow, p: AuthUser, query: unknown): Promise<unknown[][]> {
    const base = buildListQuery(wf, p, { ...(query as object), page: 1, pageSize: 200 });
    const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
    const fields = wf.def.fields.filter((f) => visible.has(f.key));
    const out: unknown[][] = [['Record #', 'Current Stage', ...fields.map((f) => f.label), 'Created At']];
    const stageName = new Map(wf.def.stages.map((s) => [s.key, s.name]));
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const rows = await prisma.$queryRaw<ListRow[]>(listSql({ ...base, limit: 1000, offset }));
      for (const r of rows) {
        const data = r.data as Record<string, unknown>;
        out.push([r.number, stageName.get(r.currentStageKey ?? '') ?? 'Completed', ...fields.map((f) => data[f.key]), r.createdAt.toISOString()]);
      }
      if (rows.length < 1000) break;
    }
    return out;
  }

  /** Google Sheets export: what the dialog shows (is it set up, and the account to share with). */
  app.get('/workflows/:wf/records/export-sheet', async (req) => {
    if (!hasCapability(req.principal, 'EXPORT')) throw AppError.forbidden('You cannot export data');
    const conn = await loadConnection(prisma, req.principal.orgId, { kind: 'sheets', activeOnly: true });
    return conn?.provider === 'gsheets' ? { configured: true, clientEmail: conn.config.clientEmail } : { configured: false, clientEmail: null };
  });

  /** Write the filtered records into a tab of a Google Sheet shared with the service account (legacy pastedatafun). */
  app.post('/workflows/:wf/records/export-sheet', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!hasCapability(req.principal, 'EXPORT')) throw AppError.forbidden('You cannot export data');
    const { wf: key } = parse(wfParams, req.params);
    const body = parse(z.object({ url: z.string().trim().min(10).max(500), tab: z.string().trim().min(1).max(100).regex(/^[^[\]*?/\\:]+$/, 'A tab name can not contain [ ] * ? / \\ :'), query: z.record(z.string()).default({}) }), req.body);
    const wf = await workflowFor(req.principal, key);
    const conn = await loadConnection(prisma, req.principal.orgId, { kind: 'sheets', activeOnly: true });
    if (conn?.provider !== 'gsheets') throw AppError.badRequest('Google Sheets is not set up — an admin can add it in Settings › Connections');
    const rows = (await exportRows(wf, req.principal, body.query)).map((r) => r.map((v) => (typeof v === 'number' || typeof v === 'boolean' ? v : formatValue(v))));
    let result: { url: string; rows: number };
    try {
      result = await writeSheet(conn, body.url, body.tab, rows);
    } catch (e) {
      throw new AppError(502, 'SHEETS_FAILED', (e as Error).message);
    }
    await prisma.auditLog.create({ data: { orgId: wf.orgId, actorId: req.principal.userId, actorEmail: req.principal.email, action: 'records.exported', entityType: 'Workflow', entityId: wf.id, diff: { rows: result.rows, to: 'google-sheets' }, ip: req.ip } });
    return result;
  });

  app.get('/workflows/:wf/records/export.csv', async (req, reply) => {
    if (!hasCapability(req.principal, 'EXPORT')) throw AppError.forbidden('You cannot export data');
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    const lines = (await exportRows(wf, req.principal, req.query)).map((r) => r.map(csvCell).join(','));
    await prisma.auditLog.create({ data: { orgId: wf.orgId, actorId: req.principal.userId, actorEmail: req.principal.email, action: 'records.exported', entityType: 'Workflow', entityId: wf.id, diff: { rows: lines.length - 1 }, ip: req.ip } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${wf.key}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return '﻿' + lines.join('\r\n'); // BOM so Excel opens the file as UTF-8
  });

  app.post('/workflows/:wf/records', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { wf: key } = parse(wfParams, req.params);
    const body = parse(z.object({ data: z.record(z.unknown()).default({}), items: z.array(z.record(z.unknown())).optional() }), req.body);
    const wf = await workflowFor(req.principal, key);
    const records = await createSubmission(req.principal, wf, body, req.ip);
    reply.code(201);
    return { records };
  });

  /** CSV import (columns already mapped to field keys in the browser). `dryRun` checks without saving. */
  app.post('/workflows/:wf/records/import', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const body = parse(z.object({ rows: z.array(z.record(z.unknown())).min(1).max(1000), dryRun: z.boolean().default(true) }), req.body);
    const wf = await workflowFor(req.principal, key);
    return importRecords(req.principal, wf, body.rows, { dryRun: body.dryRun }, req.ip);
  });

  /** Add line items to the record's multi-item submission (legacy EditResponse "add row"). */
  app.post('/workflows/:wf/records/:id/items', async (req, reply) => {
    const { wf: key, id } = parse(recParams, req.params);
    const { items } = parse(z.object({ items: z.array(z.record(z.unknown())).min(1).max(50) }), req.body);
    const wf = await workflowFor(req.principal, key);
    const records = await addSubmissionItems(req.principal, wf, id, items, req.ip);
    reply.code(201);
    return { records };
  });

  app.get('/workflows/:wf/records/:id', async (req) => {
    const { wf: key, id } = parse(recParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return getRecord(req.principal, wf, id);
  });

  app.get('/workflows/:wf/records/:id/history', async (req) => {
    const { wf: key, id } = parse(recParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return { items: await getRecordHistory(req.principal, wf, id) };
  });

  /**
   * Deliveries for one record (admins): hand-offs, reminders, message rules and webhooks, with their
   * status and error, matched to the stage they belong to — the record page shows them per step.
   */
  app.get('/workflows/:wf/records/:id/notifications', async (req) => {
    if (!isAdmin(req.principal)) throw AppError.forbidden('Only admins can see delivery details');
    const { wf: key, id } = parse(recParams, req.params);
    const wf = await workflowFor(req.principal, key);
    await getRecord(req.principal, wf, id); // same visibility as the record itself
    const logs = await prisma.notificationLog.findMany({
      where: { recordId: id, kind: { not: 'handoff-marker' } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { rule: { select: { definition: true } } },
    });
    const stageKeys = new Set(wf.def.stages.map((s) => s.key));
    return {
      items: logs.map((l) => {
        const rule = l.rule?.definition as { name?: string; trigger?: { type: string; stageKey?: string } } | undefined;
        // handoff:<record>:<stage>[:r<n>]:<channel>:<to> · upcoming:<record>:<stage>:<time>:<channel>:<to>
        const fromKey = /^(?:handoff|upcoming):[^:]+:([^:]+)/.exec(l.dedupeKey)?.[1];
        const stageKey = rule?.trigger?.stageKey ?? (fromKey && stageKeys.has(fromKey) ? fromKey : null);
        return {
          id: l.id,
          kind: l.kind,
          channel: l.channel,
          recipient: l.recipient,
          status: l.status,
          error: l.error,
          attempts: l.attempts,
          stageKey,
          ruleName: rule?.name ?? null,
          event: rule?.trigger?.type ?? (l.kind === 'handoff' ? 'stage_activated' : l.kind === 'upcoming' ? 'stage_due_soon' : null),
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        };
      }),
    };
  });

  /**
   * Send one delivery again (admins; legacy "Resend reminder"). Forgetting it lets the next pass
   * re-send to that recipient only — others already reached keep their own record.
   */
  app.post('/workflows/:wf/records/:id/notifications/:logId/resend', async (req) => {
    if (!isAdmin(req.principal)) throw AppError.forbidden('Only admins can resend messages');
    const { wf: key, id, logId } = parse(recParams.extend({ logId: z.string().min(1).max(40) }), req.params);
    const wf = await workflowFor(req.principal, key);
    await getRecord(req.principal, wf, id);
    const log = await prisma.notificationLog.findFirst({ where: { id: logId, recordId: id } });
    if (!log) throw AppError.notFound('Delivery');
    if (log.kind === 'upcoming' || log.kind === 'digest' || log.kind === 'summary') throw AppError.badRequest('Reminders and digests are sent on their schedule; they can not be resent one by one');
    await prisma.$transaction(async (tx) => {
      await tx.notificationLog.delete({ where: { id: log.id } });
      // A hand-off is guarded by its per-stage marker: drop it too, so the hand-off runs again.
      const marker = /^(handoff:[^:]+:[^:]+(?::r\d+)?):/.exec(log.dedupeKey)?.[1];
      if (log.kind === 'handoff' && marker) await tx.notificationLog.deleteMany({ where: { dedupeKey: marker } });
    });
    await publishRecordChanged([id]);
    await prisma.auditLog.create({ data: { orgId: wf.orgId, actorId: req.principal.userId, actorEmail: req.principal.email, action: 'notification.resent', entityType: 'Record', entityId: id, diff: { kind: log.kind, channel: log.channel, recipient: log.recipient }, ip: req.ip } });
    return { ok: true };
  });

  const updateBody = z.object({ data: z.record(z.unknown()).default({}), version: z.number().int().optional() });

  app.patch('/workflows/:wf/records/:id', async (req) => {
    const { wf: key, id } = parse(recParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return updateRecord(req.principal, wf, id, parse(updateBody, req.body), req.ip);
  });

  app.post('/workflows/:wf/records/:id/stages/:stageKey/complete', async (req) => {
    const { wf: key, id, stageKey } = parse(stageParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return completeStage(req.principal, wf, id, stageKey, parse(updateBody, req.body ?? {}), req.ip);
  });

  app.put('/workflows/:wf/records/:id/stages/:stageKey/planned', async (req) => {
    const { wf: key, id, stageKey } = parse(stageParams, req.params);
    const { plannedAt } = parse(z.object({ plannedAt: z.string().datetime({ offset: true }) }), req.body);
    const wf = await workflowFor(req.principal, key);
    return setPlannedTime(req.principal, wf, id, stageKey, new Date(plannedAt), req.ip);
  });

  /** Document step: generate the document again (e.g. after correcting the data it uses). */
  app.post('/workflows/:wf/records/:id/stages/:stageKey/document', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { wf: key, id, stageKey } = parse(stageParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return regenerateDocument(req.principal, wf, id, stageKey);
  });

  /** Stage bulk tool (stages with "Bulk Update" on): same values, optionally mark done, for many records. */
  app.post('/workflows/:wf/records/bulk-update', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const body = parse(
      z.object({ ids: z.array(z.string().min(1).max(40)).min(1).max(200), stageKey: z.string().min(1).max(64), data: z.record(z.unknown()).default({}), complete: z.boolean().default(false) }),
      req.body,
    );
    const wf = await workflowFor(req.principal, key);
    return bulkUpdate(req.principal, wf, body, req.ip);
  });

  const idsBody = z.object({ ids: z.array(z.string().min(1).max(40)).min(1).max(500) });
  app.post('/workflows/:wf/records/archive', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return setArchived(req.principal, wf, parse(idsBody, req.body).ids, true, req.ip);
  });
  app.post('/workflows/:wf/records/restore', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    return setArchived(req.principal, wf, parse(idsBody, req.body).ids, false, req.ip);
  });

  /** Lightweight id → title lookup used by deep links from notifications (legacy ?page=update&recordno=). */
  app.get('/workflows/:wf/records/by-number/:number', async (req) => {
    const { wf: key, number } = parse(wfParams.extend({ number: z.coerce.number().int().min(1) }), req.params);
    const wf = await workflowFor(req.principal, key);
    const row = await prisma.record.findUnique({ where: { workflowId_number: { workflowId: wf.id, number } }, select: { id: true } });
    if (!row) throw AppError.notFound('Record');
    return getRecord(req.principal, wf, row.id);
  });
}
