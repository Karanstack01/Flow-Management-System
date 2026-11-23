import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isAdmin,
  pendingTasks,
  recordTitle,
  stageSummary,
  statusMatrix,
  visibleFieldKeys,
  workflowDefSchema,
  workflowSettingsSchema,
  type ReportRecord,
} from '@fms/core';
import { prisma, Prisma, toStageStates, type LoadedWorkflow } from '@fms/db';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';
import { assertWorkflowSlot } from '../lib/license.js';
import { groupSql } from '../lib/record-sql.js';
import { describeWorkflow, getWorkflow, invalidateWorkflow, workflowFor } from '../lib/workflows.js';
import type { AuthUser } from '../plugins/auth.js';

const wfParams = z.object({ wf: z.string().min(1).max(64) });
const REPORT_LIMIT = 20_000;

/** Non-archived records the principal may see, with their stages (row filter applied in SQL). */
async function reportRecords(wf: LoadedWorkflow, p: AuthUser, range?: { from?: Date; to?: Date }): Promise<ReportRecord[]> {
  const rowFilter = isAdmin(p) ? null : p.rowFilter;
  const rows = await prisma.$queryRaw<{ id: string; number: number; data: Record<string, unknown> }[]>`
    SELECT r."id", r."number", r."data" FROM "Record" r
    WHERE r."workflowId" = ${wf.id} AND r."archivedAt" IS NULL AND ${groupSql(rowFilter)}
      ${range?.from ? Prisma.sql`AND r."createdAt" >= ${range.from}` : Prisma.empty}
      ${range?.to ? Prisma.sql`AND r."createdAt" <= ${range.to}` : Prisma.empty}
    ORDER BY r."number" DESC LIMIT ${REPORT_LIMIT}`;
  const stages = rows.length ? await prisma.recordStage.findMany({ where: { recordId: { in: rows.map((r) => r.id) } } }) : [];
  const byRecord = new Map<string, typeof stages>();
  for (const s of stages) byRecord.set(s.recordId, [...(byRecord.get(s.recordId) ?? []), s]);
  const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
  const titleFields = wf.def.fields.filter((f) => visible.has(f.key));
  return rows.map((r) => ({ id: r.id, number: r.number, title: recordTitle(titleFields, r.data as never, r.number), stages: toStageStates(byRecord.get(r.id) ?? []) }));
}

export default async function workflowRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/workflows', async (req) => {
    const rows = await prisma.workflow.findMany({
      where: { orgId: req.principal.orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, key: true, name: true, description: true, isActive: true, isDraft: true, label: true },
    });
    const admin = isAdmin(req.principal);
    return { items: rows.filter((w) => admin || (w.isActive && !w.isDraft)) };
  });

  app.get('/workflows/:wf', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    return describeWorkflow(await workflowFor(req.principal, key), req.principal);
  });

  // ---------------- admin: definitions (versioned)
  const admin = { preHandler: app.requireCapability('ADMIN') };

  app.get('/workflows/:wf/definition', admin, async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    return { id: wf.id, version: wf.version, calendarId: wf.calendarId, isActive: wf.isActive, definition: wf.def, settings: wf.settings };
  });

  app.get('/workflows/:wf/versions', admin, async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    const items = await prisma.workflowVersion.findMany({ where: { workflowId: wf.id }, orderBy: { version: 'desc' }, select: { version: true, createdAt: true, createdById: true } });
    return { items };
  });

  const saveBody = z.object({
    definition: z.unknown(),
    settings: z.unknown().optional(),
    calendarId: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
  });

  app.post('/workflows', admin, async (req, reply) => {
    const body = parse(saveBody, req.body);
    const definition = parse(workflowDefSchema, body.definition);
    const settings = parse(workflowSettingsSchema, body.settings ?? {});
    const calendarId = body.calendarId ?? (await prisma.businessCalendar.findFirst({ where: { orgId: req.principal.orgId }, select: { id: true } }))?.id;
    if (!calendarId) throw AppError.badRequest('Create a business calendar first');
    await assertCalendar(req.principal.orgId, calendarId);
    const created = await prisma.$transaction(async (tx) => {
      await assertWorkflowSlot(tx, req.principal.orgId);
      const wf = await tx.workflow.create({
        data: {
          orgId: req.principal.orgId,
          key: definition.key,
          name: definition.name,
          description: definition.description,
          definition: definition as Prisma.InputJsonObject,
          settings: settings as Prisma.InputJsonObject,
          calendarId,
          createdById: req.principal.userId,
          versions: { create: { version: 1, definition: definition as Prisma.InputJsonObject, settings: settings as Prisma.InputJsonObject, createdById: req.principal.userId } },
        },
      });
      await audit(tx, { orgId: wf.orgId, actor: req.principal, action: 'workflow.created', entityType: 'Workflow', entityId: wf.id, ip: req.ip });
      return wf;
    });
    reply.code(201);
    return { id: created.id, key: created.key };
  });

  app.put('/workflows/:wf/definition', admin, async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const body = parse(saveBody, req.body);
    const wf = await getWorkflow(req.principal.orgId, key);
    const definition = parse(workflowDefSchema, body.definition);
    if (definition.key !== wf.key) throw AppError.badRequest('The workflow key cannot be changed');
    const settings = parse(workflowSettingsSchema, body.settings ?? wf.settings);
    if (body.calendarId) await assertCalendar(req.principal.orgId, body.calendarId);
    const version = await prisma.$transaction(async (tx) => {
      const row = await tx.workflow.update({
        where: { id: wf.id },
        data: {
          name: definition.name,
          description: definition.description,
          definition: definition as Prisma.InputJsonObject,
          settings: settings as Prisma.InputJsonObject,
          calendarId: body.calendarId ?? undefined,
          isActive: body.isActive ?? undefined,
          version: { increment: 1 },
        },
      });
      await tx.workflowVersion.create({ data: { workflowId: wf.id, version: row.version, definition: definition as Prisma.InputJsonObject, settings: settings as Prisma.InputJsonObject, createdById: req.principal.userId } });
      await audit(tx, { orgId: wf.orgId, actor: req.principal, action: 'workflow.published', entityType: 'Workflow', entityId: wf.id, diff: { version: row.version }, ip: req.ip });
      return row.version;
    });
    invalidateWorkflow();
    return { version };
  });

  // ---------------- reports (legacy Rep_* tabs)
  const rangeQuery = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() });

  app.get('/workflows/:wf/reports/summary', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const range = parse(rangeQuery, req.query);
    const wf = await workflowFor(req.principal, key);
    const records = await reportRecords(wf, req.principal, { from: range.from ? new Date(range.from) : undefined, to: range.to ? new Date(range.to) : undefined });
    return { generatedAt: new Date().toISOString(), totalRecords: records.length, stages: stageSummary(records, wf.def.stages, new Date(), wf.calendar) };
  });

  app.get('/workflows/:wf/reports/pending', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const { overdueOnly, stage } = parse(z.object({ overdueOnly: z.enum(['true', 'false']).default('false'), stage: z.string().max(64).optional() }), req.query);
    const wf = await workflowFor(req.principal, key);
    const tasks = pendingTasks(await reportRecords(wf, req.principal), new Date(), wf.calendar, { overdueOnly: overdueOnly === 'true' });
    return { items: (stage ? tasks.filter((t) => t.stageKey === stage) : tasks).slice(0, 2000) };
  });

  app.get('/workflows/:wf/reports/matrix', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    const records = (await reportRecords(wf, req.principal)).filter((r) => r.stages.some((s) => s.status === 'active')).slice(0, 1000);
    return { stages: wf.def.stages.map((s) => ({ key: s.key, name: s.name, color: s.color })), rows: statusMatrix(records, wf.def.stages) };
  });

  // ---------------- saved views (legacy saved filters + Table View tab)
  const viewBody = z.object({
    name: z.string().trim().min(1).max(80),
    isShared: z.boolean().default(false),
    config: z.object({
      columns: z.array(z.string().max(64)).max(200).default([]),
      filters: z.unknown().optional(),
      sort: z.object({ by: z.string().max(64), dir: z.enum(['asc', 'desc']) }).optional(),
      status: z.string().max(20).optional(),
      stage: z.string().max(64).optional(),
    }),
  });

  app.get('/workflows/:wf/views', async (req) => {
    const { wf: key } = parse(wfParams, req.params);
    const wf = await workflowFor(req.principal, key);
    const items = await prisma.savedView.findMany({ where: { workflowId: wf.id, OR: [{ userId: req.principal.userId }, { isShared: true }] }, orderBy: { name: 'asc' } });
    return { items: items.map((v) => ({ id: v.id, name: v.name, isShared: v.isShared, isMine: v.userId === req.principal.userId, config: v.config })) };
  });

  app.post('/workflows/:wf/views', async (req, reply) => {
    const { wf: key } = parse(wfParams, req.params);
    const body = parse(viewBody, req.body);
    const wf = await workflowFor(req.principal, key);
    if (body.isShared && !isAdmin(req.principal)) throw AppError.forbidden('Only admins can share views');
    const v = await prisma.savedView.create({ data: { workflowId: wf.id, userId: req.principal.userId, name: body.name, isShared: body.isShared, config: body.config as Prisma.InputJsonObject } });
    reply.code(201);
    return { id: v.id };
  });

  app.delete('/workflows/:wf/views/:id', async (req) => {
    const { id } = parse(wfParams.extend({ id: z.string().min(1) }), req.params);
    const { count } = await prisma.savedView.deleteMany({ where: { id, userId: req.principal.userId } });
    if (!count) throw AppError.notFound('View');
    return { ok: true };
  });

  // ---------------- my tasks across workflows (legacy per-stage reminder tables)
  app.get('/me/tasks', async (req) => {
    const p = req.principal;
    const workflows = await prisma.workflow.findMany({ where: { orgId: p.orgId, isActive: true, isDraft: false, deletedAt: null }, select: { id: true } });
    const now = new Date();
    const items = [];
    for (const { id } of workflows) {
      const wf = await getWorkflow(p.orgId, id);
      const mine = wf.def.stages.filter((s) => s.responsibleGroups.some((g) => p.groups.includes(g)));
      if (!mine.length) continue;
      const rows = await prisma.$queryRaw<{ id: string; number: number; data: Record<string, unknown>; stageKey: string; plannedAt: Date | null }[]>`
        SELECT r."id", r."number", r."data", s."stageKey", s."plannedAt"
        FROM "RecordStage" s JOIN "Record" r ON r."id" = s."recordId"
        WHERE r."workflowId" = ${wf.id} AND r."archivedAt" IS NULL AND s."status" = 'active'
          AND s."stageKey" = ANY(${mine.map((s) => s.key)}::text[])
          AND ${groupSql(isAdmin(p) ? null : p.rowFilter)}
        ORDER BY s."plannedAt" ASC NULLS LAST LIMIT 500`;
      const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
      const titleFields = wf.def.fields.filter((f) => visible.has(f.key));
      for (const r of rows) {
        const stage = mine.find((s) => s.key === r.stageKey)!;
        items.push({
          workflowKey: wf.key,
          workflowName: wf.name,
          recordId: r.id,
          recordNumber: r.number,
          title: recordTitle(titleFields, r.data as never, r.number),
          stageKey: stage.key,
          stageName: stage.name,
          stageColor: stage.color,
          plannedAt: r.plannedAt?.toISOString() ?? null,
          overdue: !!r.plannedAt && r.plannedAt < now,
          delayHours: r.plannedAt ? Math.round(wf.calendar.workingHoursBetween(r.plannedAt, now) * 10) / 10 : null,
        });
      }
    }
    items.sort((a, b) => (a.plannedAt ?? '9999').localeCompare(b.plannedAt ?? '9999'));
    return { items };
  });
}

async function assertCalendar(orgId: string, calendarId: string) {
  const ok = await prisma.businessCalendar.count({ where: { id: calendarId, orgId } });
  if (!ok) throw AppError.badRequest('Unknown calendar');
}
