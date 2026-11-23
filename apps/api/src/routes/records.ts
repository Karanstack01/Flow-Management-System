import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conditionGroupSchema, formatValue, hasCapability, isAdmin, visibleFieldKeys } from '@fms/core';
import { prisma, toStageStates } from '@fms/db';
import { AppError, parse } from '../lib/errors.js';
import { aggregateSql, listSql, type ListQuery } from '../lib/record-sql.js';
import { workflowFor } from '../lib/workflows.js';
import type { AuthUser } from '../plugins/auth.js';
import { bulkUpdate, completeStage, createSubmission, getRecord, regenerateDocument, getRecordHistory, setArchived, setPlannedTime, toDto, updateRecord } from '../services/records.js';
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
  const myStages = wf.def.stages.filter((s) => s.responsibleGroups.some((g) => p.groups.includes(g))).map((s) => s.key);
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
  const aggregates = Object.fromEntries(
    query.numericKeys.map((k, i) => [k, { sum: a[`sum_${i}`] == null ? null : Number(a[`sum_${i}`]), avg: a[`avg_${i}`] == null ? null : Number(a[`avg_${i}`]) }]),
  );
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

  app.get('/workflows/:wf/records/export.csv', async (req, reply) => {
    if (!hasCapability(req.principal, 'EXPORT')) throw AppError.forbidden('You cannot export data');
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    const base = buildListQuery(wf, req.principal, { ...(req.query as object), page: 1, pageSize: 200 });
    const visible = visibleFieldKeys(wf.def.fields, req.principal, wf.def.stages);
    const fields = wf.def.fields.filter((f) => visible.has(f.key));
    const lines: string[] = [['Record #', 'Current Stage', ...fields.map((f) => f.label), 'Created At'].map(csvCell).join(',')];
    const stageName = new Map(wf.def.stages.map((s) => [s.key, s.name]));
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const rows = await prisma.$queryRaw<ListRow[]>(listSql({ ...base, limit: 1000, offset }));
      for (const r of rows) {
        const data = r.data as Record<string, unknown>;
        lines.push([r.number, stageName.get(r.currentStageKey ?? '') ?? 'Completed', ...fields.map((f) => data[f.key]), r.createdAt.toISOString()].map(csvCell).join(','));
      }
      if (rows.length < 1000) break;
    }
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
