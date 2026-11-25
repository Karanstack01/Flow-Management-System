/**
 * Flow management (All Flows page), the node editor, the template library and
 * the flows dashboard.
 *
 * Legacy mapping: one FMS spreadsheet per process → one flow; "make a copy of the
 * sheet" → duplicate / use template; the Settings tab → the node editor.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  canvasSchema,
  compileCanvas,
  documentConfigSchema,
  fieldDefSchema,
  recordTitle,
  sampleRecord,
  isAdmin,
  isSuperAdmin,
  notificationRuleSchema,
  reconcileCanvas,
  stageDefSchema,
  workflowDefSchema,
  workflowSettingsSchema,
  type Canvas,
  type ExistingRule,
  type WorkflowDef,
  type WorkflowSettings,
} from '@fms/core';
import { prisma, Prisma, type Tx } from '@fms/db';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';
import { renderDocument } from '../lib/docgen.js';
import { assertWorkflowSlot } from '../lib/license.js';
import { groupSql } from '../lib/record-sql.js';
import { ensurePublicFormId, getWorkflow, invalidateWorkflow, workflowFor } from '../lib/workflows.js';
import type { AuthUser } from '../plugins/auth.js';

const flowParams = z.object({ wf: z.string().min(1).max(64) });
const idParam = z.object({ id: z.string().min(1).max(40) });
const json = (v: unknown) => v as Prisma.InputJsonObject;

const slugKey = (s: string) => {
  const k = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  return /^[a-z]/.test(k) ? k : `flow_${k}`.replace(/_+$/, '') || 'flow';
};

/** A key that is free in this organization (trashed flows still hold theirs). */
async function freeKey(db: Tx, orgId: string, wanted: string) {
  const base = slugKey(wanted);
  const taken = new Set((await db.workflow.findMany({ where: { orgId, key: { startsWith: base } }, select: { key: true } })).map((w) => w.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Message nodes reference rules by id; copies must not. */
function stripRuleIds(canvas: Canvas | null): Canvas | null {
  if (!canvas) return null;
  return { ...canvas, nodes: canvas.nodes.map((n) => (n.type === 'message' ? { ...n, data: Object.fromEntries(Object.entries(n.data).filter(([k]) => k !== 'ruleId')) } : n)) };
}

const BLANK_DEF = (key: string, name: string, description?: string): WorkflowDef =>
  workflowDefSchema.parse({
    key,
    name,
    description,
    stages: [
      { key: 'intake', name: 'Form Submitted', color: '#16a34a', completion: { kind: 'on_create' } },
      { key: 'review', name: 'Review', color: '#2563eb', planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 8 } }, completion: { kind: 'manual' } },
    ],
    fields: [{ key: 'title', label: 'Title', type: 'text', stageKey: 'intake', required: true, searchKey: true, frozen: true }],
  });

interface NewFlow {
  name: string;
  key?: string;
  description?: string | null;
  label?: string | null;
  definition?: WorkflowDef;
  settings?: WorkflowSettings;
  canvas?: Canvas | null;
  rules?: { definition: unknown; isActive: boolean; canvasNodeId: string | null }[];
}

/** Create a draft flow (blank, from a template, or as a duplicate). */
async function createDraft(p: AuthUser, input: NewFlow, ip: string) {
  const calendar = await prisma.businessCalendar.findFirst({ where: { orgId: p.orgId }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (!calendar) throw AppError.badRequest('Create a business calendar first (Settings › Calendars)');
  return prisma.$transaction(async (tx) => {
    await assertWorkflowSlot(tx, p.orgId);
    const key = await freeKey(tx, p.orgId, input.key || input.name);
    const description = input.description ?? input.definition?.description ?? undefined;
    const definition = input.definition ? workflowDefSchema.parse({ ...input.definition, key, name: input.name, description }) : BLANK_DEF(key, input.name, description ?? undefined);
    const settings = input.settings ?? workflowSettingsSchema.parse({});
    // A copy never shares the original's public form link; it starts private.
    if (definition.stages[0]) definition.stages[0] = { ...definition.stages[0], publicForm: undefined, publicFormId: undefined };
    const wf = await tx.workflow.create({
      data: {
        orgId: p.orgId,
        key,
        name: input.name,
        description: definition.description,
        label: input.label || null,
        isDraft: true,
        isActive: true,
        createdById: p.userId,
        definition: json(definition),
        settings: json(settings),
        canvas: input.canvas ? json(input.canvas) : Prisma.JsonNull,
        calendarId: calendar.id,
        versions: { create: { version: 1, definition: json(definition), settings: json(settings), canvas: input.canvas ? json(input.canvas) : Prisma.JsonNull, note: 'created', createdById: p.userId } },
      },
    });
    for (const r of input.rules ?? []) await tx.notificationRule.create({ data: { workflowId: wf.id, definition: json(r.definition), isActive: r.isActive, canvasNodeId: r.canvasNodeId } });
    await audit(tx, { orgId: p.orgId, actor: p, action: 'workflow.created', entityType: 'Workflow', entityId: wf.id, diff: { key, draft: true }, ip });
    return wf;
  });
}

/** Per-flow record counts, honouring the caller's row filter so counts never leak hidden records. */
async function flowStats(p: AuthUser, workflowIds: string[]) {
  if (!workflowIds.length) return { records: new Map<string, { open: number; created: number; completed: number }>(), stages: new Map<string, Map<string, { active: number; overdue: number }>>() };
  const filter = groupSql(isAdmin(p) ? null : p.rowFilter);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [recordRows, stageRows] = await Promise.all([
    prisma.$queryRaw<{ workflowId: string; open: number; created: number; completed: number }[]>`
      SELECT r."workflowId", count(*) FILTER (WHERE r."completedAt" IS NULL)::int AS open,
             count(*) FILTER (WHERE r."createdAt" >= ${since})::int AS created,
             count(*) FILTER (WHERE r."completedAt" >= ${since})::int AS completed
      FROM "Record" r
      WHERE r."orgId" = ${p.orgId} AND r."archivedAt" IS NULL AND r."workflowId" = ANY(${workflowIds}::text[]) AND ${filter}
      GROUP BY 1`,
    prisma.$queryRaw<{ workflowId: string; stageKey: string; active: number; overdue: number }[]>`
      SELECT r."workflowId", s."stageKey", count(*)::int AS active, count(*) FILTER (WHERE s."plannedAt" < now())::int AS overdue
      FROM "RecordStage" s JOIN "Record" r ON r."id" = s."recordId"
      WHERE s."status" = 'active' AND r."orgId" = ${p.orgId} AND r."archivedAt" IS NULL AND r."workflowId" = ANY(${workflowIds}::text[]) AND ${filter}
      GROUP BY 1, 2`,
  ]);
  const records = new Map(recordRows.map((r) => [r.workflowId, { open: r.open, created: r.created, completed: r.completed }]));
  const stages = new Map<string, Map<string, { active: number; overdue: number }>>();
  for (const s of stageRows) {
    if (!stages.has(s.workflowId)) stages.set(s.workflowId, new Map());
    stages.get(s.workflowId)!.set(s.stageKey, { active: s.active, overdue: s.overdue });
  }
  return { records, stages };
}

const stageList = (definition: unknown) => {
  const d = definition as { stages?: { key: string; name: string; color: string }[]; fields?: unknown[] };
  return { stages: (d.stages ?? []).map((s) => ({ key: s.key, name: s.name, color: s.color })), fieldCount: d.fields?.length ?? 0 };
};

export default async function flowRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const admin = { preHandler: app.requireCapability('ADMIN') };

  // ------------------------------------------------------------ All Flows
  app.get('/flows', async (req) => {
    const p = req.principal;
    const q = parse(
      z.object({
        tab: z.enum(['primary', 'drafts', 'trash']).default('primary'),
        q: z.string().trim().max(120).optional(),
        label: z.string().trim().max(60).optional(),
        status: z.enum(['all', 'active', 'inactive']).default('all'),
        since: z.enum(['any', '7d', '30d', '90d']).default('any'),
      }),
      req.query,
    );
    const manager = isAdmin(p);
    const tab = manager ? q.tab : 'primary';
    const scope: Prisma.WorkflowWhereInput =
      tab === 'trash' ? { deletedAt: { not: null } } : tab === 'drafts' ? { deletedAt: null, isDraft: true } : { deletedAt: null, isDraft: false, ...(manager ? {} : { isActive: true }) };
    const days = q.since === 'any' ? null : Number(q.since.slice(0, -1));
    const where: Prisma.WorkflowWhereInput = {
      orgId: p.orgId,
      ...scope,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { key: { contains: q.q.toLowerCase() } }] } : {}),
      ...(q.label ? { label: q.label } : {}),
      ...(q.status === 'all' ? {} : { isActive: q.status === 'active' }),
      ...(days ? { updatedAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    };
    const [rows, favorites, counts, labels] = await Promise.all([
      prisma.workflow.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 500 }),
      prisma.workflowFavorite.findMany({ where: { userId: p.userId }, select: { workflowId: true } }),
      manager
        ? Promise.all([
            prisma.workflow.count({ where: { orgId: p.orgId, deletedAt: null, isDraft: false } }),
            prisma.workflow.count({ where: { orgId: p.orgId, deletedAt: null, isDraft: true } }),
            prisma.workflow.count({ where: { orgId: p.orgId, deletedAt: { not: null } } }),
          ])
        : prisma.workflow.count({ where: { orgId: p.orgId, deletedAt: null, isDraft: false, isActive: true } }).then((n) => [n, 0, 0]),
      prisma.workflow.findMany({ where: { orgId: p.orgId, deletedAt: null, label: { not: null } }, distinct: ['label'], select: { label: true }, orderBy: { label: 'asc' } }),
    ]);
    const creatorIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
    const creators = creatorIds.length ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true, email: true } }) : [];
    const stats = await flowStats(p, rows.map((r) => r.id));
    const fav = new Set(favorites.map((f) => f.workflowId));
    const items = rows
      .map((r) => {
        const st = stats.stages.get(r.id);
        const { stages } = stageList(r.definition);
        return {
          id: r.id,
          key: r.key,
          name: r.name,
          description: r.description,
          label: r.label,
          status: r.deletedAt ? 'trashed' : r.isDraft ? 'draft' : r.isActive ? 'active' : 'inactive',
          isFavorite: fav.has(r.id),
          version: r.version,
          stageCount: stages.length,
          openRecords: stats.records.get(r.id)?.open ?? 0,
          overdue: st ? [...st.values()].reduce((s, x) => s + x.overdue, 0) : 0,
          createdBy: creators.find((c) => c.id === r.createdById) ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          deletedAt: r.deletedAt,
        };
      })
      .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite));
    return { items, counts: { primary: counts[0], drafts: counts[1], trash: counts[2] }, labels: labels.map((l) => l.label!), canManage: manager };
  });

  /** Create a flow: blank or from a template. Always starts as a draft. */
  app.post('/flows', admin, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        key: z.string().trim().max(64).optional(),
        description: z.string().trim().max(2000).optional(),
        label: z.string().trim().max(60).optional(),
        templateId: z.string().min(1).max(40).optional(),
      }),
      req.body,
    );
    let from: Pick<NewFlow, 'definition' | 'settings' | 'canvas'> = {};
    if (body.templateId) {
      const t = await prisma.workflowTemplate.findFirst({ where: { id: body.templateId, OR: [{ orgId: null }, { orgId: req.principal.orgId }] } });
      if (!t) throw AppError.notFound('Template');
      from = { definition: workflowDefSchema.parse(t.definition), settings: workflowSettingsSchema.parse(t.settings), canvas: t.canvas ? canvasSchema.parse(t.canvas) : null };
    }
    const wf = await createDraft(req.principal, { ...from, name: body.name, key: body.key, description: body.description, label: body.label }, req.ip);
    reply.code(201);
    return { id: wf.id, key: wf.key };
  });

  app.patch('/flows/:wf', admin, async (req) => {
    const { wf: key } = parse(flowParams, req.params);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).nullable(), label: z.string().trim().max(60).nullable(), isActive: z.boolean() }).partial(),
      req.body,
    );
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    // Draft / live / inactive is one lifecycle: a draft becomes live by publishing, not by this switch.
    if (body.isActive !== undefined && wf.isDraft) throw AppError.badRequest('Publish the draft in the flow editor first');
    const def = { ...wf.def, ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description || undefined } : {}) };
    await prisma.$transaction(async (tx) => {
      await tx.workflow.update({
        where: { id: wf.id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          ...(body.label !== undefined ? { label: body.label || null } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          definition: json(def),
        },
      });
      await audit(tx, { orgId: wf.orgId, actor: req.principal, action: 'workflow.updated', entityType: 'Workflow', entityId: wf.id, diff: json(body), ip: req.ip });
    });
    invalidateWorkflow();
    return { ok: true };
  });

  app.put('/flows/:wf/favorite', async (req) => {
    const { wf: key } = parse(flowParams, req.params);
    const { starred } = parse(z.object({ starred: z.boolean() }), req.body);
    const wf = await workflowFor(req.principal, key);
    const where = { userId_workflowId: { userId: req.principal.userId, workflowId: wf.id } };
    if (starred) await prisma.workflowFavorite.upsert({ where, update: {}, create: { userId: req.principal.userId, workflowId: wf.id } });
    else await prisma.workflowFavorite.deleteMany({ where: { userId: req.principal.userId, workflowId: wf.id } });
    return { ok: true };
  });

  /** Trash / restore one or many flows (legacy: no undo — deleting the sheet lost everything). */
  app.post('/flows/bulk', admin, async (req) => {
    const body = parse(z.object({ action: z.enum(['trash', 'restore']), keys: z.array(z.string().min(1).max(64)).min(1).max(200) }), req.body);
    const p = req.principal;
    const rows = await prisma.workflow.findMany({ where: { orgId: p.orgId, key: { in: body.keys } }, select: { id: true } });
    await prisma.$transaction(async (tx) => {
      await tx.workflow.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deletedAt: body.action === 'trash' ? new Date() : null } });
      for (const r of rows) await audit(tx, { orgId: p.orgId, actor: p, action: body.action === 'trash' ? 'workflow.trashed' : 'workflow.restored', entityType: 'Workflow', entityId: r.id, ip: req.ip });
    });
    invalidateWorkflow();
    return { updated: rows.length };
  });

  /** Permanent delete — only from the trash, and the caller must type the flow key. Records go with it. */
  app.delete('/flows/:wf', admin, async (req) => {
    const { wf: key } = parse(flowParams, req.params);
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body ?? {});
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    if (!wf.deletedAt) throw AppError.badRequest('Move the flow to the trash first');
    if (confirm !== wf.key) throw AppError.badRequest(`Type the flow key “${wf.key}” to confirm`);
    const records = await prisma.record.count({ where: { workflowId: wf.id } });
    await prisma.$transaction(async (tx) => {
      await tx.workflow.delete({ where: { id: wf.id } });
      await audit(tx, { orgId: wf.orgId, actor: req.principal, action: 'workflow.deleted', entityType: 'Workflow', entityId: wf.id, diff: { key: wf.key, name: wf.name, records }, ip: req.ip });
    });
    invalidateWorkflow();
    return { ok: true, recordsDeleted: records };
  });

  app.post('/flows/:wf/duplicate', admin, async (req, reply) => {
    const { wf: key } = parse(flowParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional() }), req.body ?? {});
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    const row = await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id }, include: { rules: true } });
    const copy = await createDraft(
      req.principal,
      {
        name: body.name ?? `${wf.name} (copy)`,
        key: `${wf.key}_copy`,
        label: row.label,
        definition: wf.def,
        settings: wf.settings,
        canvas: stripRuleIds(row.canvas ? canvasSchema.safeParse(row.canvas).data ?? null : null),
        rules: row.rules.map((r) => ({ definition: r.definition, isActive: r.isActive, canvasNodeId: r.canvasNodeId })),
      },
      req.ip,
    );
    reply.code(201);
    return { id: copy.id, key: copy.key };
  });

  // ------------------------------------------------------------ node editor
  async function rulesOf(workflowId: string): Promise<(ExistingRule & { isCanvas: boolean })[]> {
    const rows = await prisma.notificationRule.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });
    return rows.flatMap((r) => {
      const def = notificationRuleSchema.safeParse(r.definition);
      return def.success ? [{ id: r.id, canvasNodeId: r.canvasNodeId, definition: { ...def.data, isActive: r.isActive }, isCanvas: !!r.canvasNodeId }] : [];
    });
  }

  app.get('/flows/:wf/editor', admin, async (req) => {
    const { wf: key } = parse(flowParams, req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    const row = await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id }, select: { canvas: true, label: true } });
    const rules = await rulesOf(wf.id);
    // Rules already on the canvas plus stage-triggered rules made on the Rules page (adopted on save).
    const canvasRules = row.canvas ? rules.filter((r) => r.isCanvas) : rules;
    const canvas = reconcileCanvas(row.canvas as Canvas | null, wf.def, wf.settings, canvasRules);
    const onCanvas = new Set(canvas.nodes.filter((n) => n.type === 'message').map((n) => n.id));
    const [groups, calendars, users] = await Promise.all([
      prisma.group.findMany({ where: { orgId: wf.orgId }, select: { name: true }, orderBy: { name: 'asc' } }),
      prisma.businessCalendar.findMany({ where: { orgId: wf.orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.user.findMany({ where: { orgId: wf.orgId, isActive: true }, select: { name: true, email: true }, orderBy: { name: 'asc' }, take: 2000 }),
    ]);
    return {
      flow: { id: wf.id, key: wf.key, name: wf.name, description: wf.def.description ?? null, label: row.label, isActive: wf.isActive, isDraft: wf.isDraft, version: wf.version, calendarId: wf.calendarId },
      definition: wf.def,
      settings: wf.settings,
      canvas,
      // Rules managed on the Rules page instead of the canvas (condition rules always are).
      otherRules: rules.filter((r) => r.definition.trigger.type === 'condition' || (r.canvasNodeId ? !onCanvas.has(r.canvasNodeId) : !!row.canvas)).length,
      groups: groups.map((g) => g.name),
      calendars,
      users,
    };
  });

  const editorBody = z.object({
    canvas: canvasSchema,
    definition: z.object({
      key: z.string(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).optional(),
      stages: z.array(stageDefSchema).min(1).max(50),
      fields: z.array(fieldDefSchema).max(500),
    }),
    settings: workflowSettingsSchema,
    calendarId: z.string().min(1).max(40).optional(),
    publish: z.boolean().default(false),
    /** Set when this save brings back an older version (Version history › Restore). */
    restoredFrom: z.number().int().positive().optional(),
  });

  /** Save the canvas: compile → definition + settings + message rules, all in one transaction. */
  app.put('/flows/:wf/editor', admin, async (req) => {
    const { wf: key } = parse(flowParams, req.params);
    const body = parse(editorBody, req.body);
    const p = req.principal;
    const wf = await getWorkflow(p.orgId, key);
    if (body.definition.key !== wf.key) throw AppError.badRequest('The flow key cannot be changed');
    if (body.calendarId && !(await prisma.businessCalendar.count({ where: { id: body.calendarId, orgId: p.orgId } }))) throw AppError.badRequest('Unknown calendar');

    const compiled = compileCanvas(body.canvas, body.definition as WorkflowDef, body.settings);
    if (!compiled.definition || !compiled.settings) {
      throw new AppError(422, 'FLOW_INVALID', compiled.errors[0]?.message ?? 'The flow has problems', { errors: compiled.errors, warnings: compiled.warnings });
    }
    const definition = await ensurePublicFormId(wf.id, compiled.definition);
    const settings = compiled.settings;
    const existing = await prisma.notificationRule.findMany({ where: { workflowId: wf.id } });
    const nodeRuleId = new Map(body.canvas.nodes.filter((n) => n.type === 'message' && typeof n.data.ruleId === 'string').map((n) => [n.id, n.data.ruleId as string]));

    if (body.restoredFrom && !(await prisma.workflowVersion.count({ where: { workflowId: wf.id, version: body.restoredFrom } }))) throw AppError.badRequest(`Version ${body.restoredFrom} does not exist`);
    const canvas = json(stripRuleIds(body.canvas));
    const note = body.restoredFrom ? `restored:${body.restoredFrom}` : body.publish && wf.isDraft ? 'published' : 'saved';
    const version = await prisma.$transaction(async (tx) => {
      const row = await tx.workflow.update({
        where: { id: wf.id },
        data: {
          name: definition.name,
          description: definition.description ?? null,
          definition: json(definition),
          settings: json(settings),
          canvas,
          calendarId: body.calendarId ?? undefined,
          ...(body.publish ? { isDraft: false, isActive: true } : {}),
          version: { increment: 1 },
        },
      });
      await tx.workflowVersion.create({ data: { workflowId: wf.id, version: row.version, definition: json(definition), settings: json(settings), canvas, note, createdById: p.userId } });

      const kept = new Set<string>();
      for (const r of compiled.rules) {
        const match = existing.find((e) => e.canvasNodeId === r.nodeId) ?? existing.find((e) => e.id === nodeRuleId.get(r.nodeId) && !e.canvasNodeId);
        const data = { definition: json(r.definition), isActive: r.definition.isActive, canvasNodeId: r.nodeId };
        if (match) {
          await tx.notificationRule.update({ where: { id: match.id }, data });
          kept.add(match.id);
        } else {
          kept.add((await tx.notificationRule.create({ data: { workflowId: wf.id, ...data } })).id);
        }
      }
      // Canvas-owned rules whose Message node was removed (or is no longer configured).
      await tx.notificationRule.deleteMany({ where: { workflowId: wf.id, canvasNodeId: { not: null }, id: { notIn: [...kept] } } });
      await audit(tx, {
        orgId: wf.orgId,
        actor: p,
        action: body.restoredFrom ? 'workflow.restored' : body.publish && wf.isDraft ? 'workflow.published' : 'workflow.saved',
        entityType: 'Workflow',
        entityId: wf.id,
        diff: { version: row.version, rules: compiled.rules.length, ...(body.restoredFrom ? { restoredFrom: body.restoredFrom } : {}) },
        ip: req.ip,
      });
      return row.version;
    });
    invalidateWorkflow();
    // The public link id the server kept (it replaces one that clashes with another flow).
    return { version, warnings: compiled.warnings, isDraft: body.publish ? false : wf.isDraft, publicFormId: definition.stages[0]?.publicForm ? (definition.stages[0].publicFormId ?? null) : null };
  });

  // ------------------------------------------------------------ version history
  async function authors(ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    const users = wanted.length ? await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]));
  }

  /** Every saved version, newest first (who, when, how). */
  app.get('/flows/:wf/versions', admin, async (req) => {
    const { wf: key } = parse(flowParams, req.params);
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    const rows = await prisma.workflowVersion.findMany({
      where: { workflowId: wf.id },
      orderBy: { version: 'desc' },
      take: 200,
      select: { version: true, createdAt: true, createdById: true, note: true },
    });
    const who = await authors(rows.map((r) => r.createdById));
    return {
      current: wf.version,
      items: rows.map((r) => ({ version: r.version, createdAt: r.createdAt.toISOString(), note: r.note, author: r.createdById ? (who.get(r.createdById) ?? null) : null })),
    };
  });

  /** One version's content, for comparing and restoring in the editor. */
  app.get('/flows/:wf/versions/:version', admin, async (req) => {
    const { wf: key, version } = parse(flowParams.extend({ version: z.coerce.number().int().positive() }), req.params);
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    const row = await prisma.workflowVersion.findUnique({ where: { workflowId_version: { workflowId: wf.id, version } } });
    if (!row) throw AppError.notFound('Version');
    // Old versions may predate today's rules; they are still shown, and the editor re-checks them on save.
    const def = workflowDefSchema.safeParse(row.definition);
    const settings = workflowSettingsSchema.safeParse(row.settings);
    const canvas = canvasSchema.safeParse(row.canvas);
    const who = await authors([row.createdById]);
    return {
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      note: row.note,
      author: row.createdById ? (who.get(row.createdById) ?? null) : null,
      definition: def.success ? def.data : row.definition,
      settings: settings.success ? settings.data : wf.settings,
      canvas: row.canvas && canvas.success ? canvas.data : null,
      valid: def.success,
    };
  });

  /** Document step "Download sample": the document as it would be generated, filled with sample values. */
  app.post('/flows/:wf/document-preview', { ...admin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { wf: key } = parse(flowParams, req.params);
    const body = parse(z.object({ document: documentConfigSchema, fields: z.array(fieldDefSchema).max(500), stageName: z.string().max(80).optional() }), req.body);
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    const data = sampleRecord(body.fields);
    const doc = await renderDocument(body.document, {
      fields: body.fields,
      data,
      extra: { record_number: 1024, record_title: recordTitle(body.fields, data, 1024), workflow_name: wf.name, current_stage: body.stageName ?? 'Document', link: 'https://app.example.com/r/1024' },
    });
    reply
      .header('content-type', doc.mimeType)
      .header('content-disposition', `attachment; filename="${encodeURIComponent(`Sample - ${doc.fileName}`)}"`)
      .header('x-content-type-options', 'nosniff');
    return reply.send(doc.buffer);
  });

  // ------------------------------------------------------------ templates
  app.get('/templates', async (req) => {
    const rows = await prisma.workflowTemplate.findMany({ where: { OR: [{ orgId: null }, { orgId: req.principal.orgId }] }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    return {
      items: rows.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        scope: t.orgId ? 'organization' : 'global',
        builtIn: !!t.builtInKey,
        ...stageList(t.definition),
        updatedAt: t.updatedAt,
      })),
      canPublishGlobal: isSuperAdmin(req.principal),
    };
  });

  app.get('/templates/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const t = await prisma.workflowTemplate.findFirst({ where: { id, OR: [{ orgId: null }, { orgId: req.principal.orgId }] } });
    if (!t) throw AppError.notFound('Template');
    return { id: t.id, name: t.name, description: t.description, category: t.category, definition: t.definition, settings: t.settings };
  });

  app.post('/flows/:wf/save-as-template', admin, async (req, reply) => {
    const { wf: key } = parse(flowParams, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).optional(),
        category: z.string().trim().min(1).max(40).default('General'),
        scope: z.enum(['organization', 'global']).default('organization'),
      }),
      req.body,
    );
    if (body.scope === 'global' && !isSuperAdmin(req.principal)) throw AppError.forbidden('Only a super admin can publish templates for every organization');
    const wf = await getWorkflow(req.principal.orgId, key, { includeTrashed: true });
    const row = await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id }, select: { canvas: true } });
    const canvas = stripRuleIds(reconcileCanvas(row.canvas as Canvas | null, wf.def, wf.settings, (await rulesOf(wf.id)).filter((r) => r.isCanvas)));
    // Webhook secrets and URLs are organization-specific; templates carry the shape only.
    const settings = { ...wf.settings, webhooks: [] };
    const t = await prisma.workflowTemplate.create({
      data: {
        orgId: body.scope === 'global' ? null : req.principal.orgId,
        name: body.name,
        description: body.description ?? wf.def.description ?? null,
        category: body.category,
        definition: json(wf.def),
        settings: json(settings),
        canvas: canvas ? json({ ...canvas, nodes: canvas.nodes.filter((n) => n.type !== 'webhook'), edges: canvas.edges.filter((e) => canvas.nodes.some((n) => n.id === e.target && n.type !== 'webhook')) }) : Prisma.JsonNull,
        createdById: req.principal.userId,
      },
    });
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: body.scope === 'global' ? 'platform.template_published' : 'template.created', entityType: 'WorkflowTemplate', entityId: t.id, ip: req.ip });
    reply.code(201);
    return { id: t.id };
  });

  app.delete('/templates/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const t = await prisma.workflowTemplate.findFirst({ where: { id, OR: [{ orgId: null }, { orgId: req.principal.orgId }] } });
    if (!t) throw AppError.notFound('Template');
    if (t.builtInKey) throw AppError.badRequest('Built-in templates can not be deleted');
    if (!t.orgId && !isSuperAdmin(req.principal)) throw AppError.forbidden('Only a super admin can delete global templates');
    await prisma.workflowTemplate.delete({ where: { id } });
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: t.orgId ? 'template.deleted' : 'platform.template_deleted', entityType: 'WorkflowTemplate', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ------------------------------------------------------------ dashboard
  app.get('/dashboard', async (req) => {
    const p = req.principal;
    const manager = isAdmin(p);
    const rows = await prisma.workflow.findMany({
      where: { orgId: p.orgId, deletedAt: null, ...(manager ? {} : { isDraft: false, isActive: true }) },
      orderBy: { name: 'asc' },
      select: { id: true, key: true, name: true, label: true, isActive: true, isDraft: true, definition: true, updatedAt: true },
    });
    const stats = await flowStats(p, rows.map((r) => r.id));
    const flows = rows.map((r) => {
      const rec = stats.records.get(r.id) ?? { open: 0, created: 0, completed: 0 };
      const st = stats.stages.get(r.id);
      const stages = stageList(r.definition).stages.map((s) => ({ ...s, active: st?.get(s.key)?.active ?? 0, overdue: st?.get(s.key)?.overdue ?? 0 }));
      return {
        key: r.key,
        name: r.name,
        label: r.label,
        status: r.isDraft ? 'draft' : r.isActive ? 'active' : 'inactive',
        open: rec.open,
        created7d: rec.created,
        completed7d: rec.completed,
        overdue: stages.reduce((s, x) => s + x.overdue, 0),
        stages,
        updatedAt: r.updatedAt,
      };
    });
    const live = flows.filter((f) => f.status === 'active');
    const ids = rows.map((r) => r.id);
    const filter = groupSql(manager ? null : p.rowFilter);
    const tz = (await prisma.businessCalendar.findFirst({ where: { orgId: p.orgId }, orderBy: { createdAt: 'asc' }, select: { timezone: true } }))?.timezone ?? 'UTC';

    // Daily created / completed for the last 14 days, in the organization's timezone.
    const trend = ids.length
      ? await prisma.$queryRaw<{ date: string; created: number; completed: number }[]>`
          WITH days AS (
            SELECT generate_series((now() AT TIME ZONE ${tz})::date - 13, (now() AT TIME ZONE ${tz})::date, interval '1 day')::date AS d
          )
          SELECT to_char(d, 'YYYY-MM-DD') AS date,
            (SELECT count(*)::int FROM "Record" r WHERE r."orgId" = ${p.orgId} AND r."workflowId" = ANY(${ids}::text[]) AND ${filter}
               AND ((r."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date = d) AS created,
            (SELECT count(*)::int FROM "Record" r WHERE r."orgId" = ${p.orgId} AND r."workflowId" = ANY(${ids}::text[]) AND ${filter}
               AND r."completedAt" IS NOT NULL AND ((r."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date = d) AS completed
          FROM days ORDER BY d`
      : [];

    // Stage completions in the last 30 days that had a planned time: on time vs late.
    const [onTime] = ids.length
      ? await prisma.$queryRaw<{ onTime: number; late: number; avgLateHours: number | null }[]>`
          SELECT count(*) FILTER (WHERE s."actualAt" <= s."plannedAt")::int AS "onTime",
                 count(*) FILTER (WHERE s."actualAt" > s."plannedAt")::int AS "late",
                 (avg(EXTRACT(EPOCH FROM (s."actualAt" - s."plannedAt")) / 3600) FILTER (WHERE s."actualAt" > s."plannedAt"))::float AS "avgLateHours"
          FROM "RecordStage" s JOIN "Record" r ON r."id" = s."recordId"
          WHERE s."status" = 'done' AND s."plannedAt" IS NOT NULL AND s."actualAt" >= now() - interval '30 days'
            AND r."orgId" = ${p.orgId} AND r."workflowId" = ANY(${ids}::text[]) AND ${filter}`
      : [{ onTime: 0, late: 0, avgLateHours: null }];

    // Open work per owning team (a stage owned by two groups counts for both).
    const teamMap = new Map<string, { active: number; overdue: number }>();
    for (const r of rows) {
      const owners = new Map(((r.definition as { stages?: { key: string; responsibleGroups?: string[] }[] }).stages ?? []).map((s) => [s.key, s.responsibleGroups?.length ? s.responsibleGroups : ['Unassigned']]));
      for (const [stageKey, c] of stats.stages.get(r.id) ?? []) {
        for (const grp of owners.get(stageKey) ?? ['Unassigned']) {
          const t = teamMap.get(grp) ?? { active: 0, overdue: 0 };
          t.active += c.active;
          t.overdue += c.overdue;
          teamMap.set(grp, t);
        }
      }
    }
    const teams = [...teamMap].map(([group, t]) => ({ group, ...t })).sort((a, b) => b.active - a.active).slice(0, 8);

    // Recent record activity — admins only (others could see records hidden by their row filter).
    const activityRows = manager ? await prisma.auditLog.findMany({ where: { orgId: p.orgId, entityType: 'Record' }, orderBy: { createdAt: 'desc' }, take: 8 }) : [];
    const recs = activityRows.length ? await prisma.record.findMany({ where: { id: { in: activityRows.map((a) => a.entityId) } }, select: { id: true, number: true, workflowId: true } }) : [];
    const activity = activityRows.map((a) => {
      const rec = recs.find((x) => x.id === a.entityId);
      const wf = rec ? rows.find((r) => r.id === rec.workflowId) : undefined;
      return { id: a.id, action: a.action, actorEmail: a.actorEmail, createdAt: a.createdAt, recordId: a.entityId, recordNumber: rec?.number ?? null, flowKey: wf?.key ?? null, flowName: wf?.name ?? null };
    });

    return {
      timezone: tz,
      trend,
      onTime: { onTime: onTime?.onTime ?? 0, late: onTime?.late ?? 0, avgLateHours: onTime?.avgLateHours ?? null },
      teams,
      activity,
      totals: {
        flows: live.length,
        drafts: flows.filter((f) => f.status === 'draft').length,
        openRecords: flows.reduce((s, f) => s + f.open, 0),
        overdue: flows.reduce((s, f) => s + f.overdue, 0),
        created7d: flows.reduce((s, f) => s + f.created7d, 0),
        completed7d: flows.reduce((s, f) => s + f.completed7d, 0),
      },
      flows,
    };
  });
}
