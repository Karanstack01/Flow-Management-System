import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { z } from 'zod';
import { CAPABILITIES, MANUAL_JOBS, calendarSchema, conditionGroupSchema, hasCapability, isAdmin, isSuperAdmin, notificationRuleSchema, visibleFieldKeys, type JobName, type NotificationRuleDef } from '@fms/core';
import { prisma, Prisma, type LoadedWorkflow } from '@fms/db';
import type { AuthUser } from '../plugins/auth.js';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';
import { assertSeatAvailable } from '../lib/license.js';
import { enqueueManualJob, publishRecordChanged } from '../lib/queue.js';
import { getWorkflow, invalidateWorkflow } from '../lib/workflows.js';
import { invalidatePrincipal } from '../plugins/auth.js';
import { passwordSchema } from './auth.js';

const idParam = z.object({ id: z.string().min(1).max(40) });
const groupNames = z.array(z.string().trim().min(1).max(64).transform((s) => s.toUpperCase())).max(50);

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const admin = { preHandler: app.requireCapability('ADMIN') };

  // ------------------------------------------------------------ users
  app.get('/admin/users', admin, async (req) => {
    const users = await prisma.user.findMany({ where: { orgId: req.principal.orgId }, include: { groups: { include: { group: true } } }, orderBy: { name: 'asc' } });
    return {
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        phone: u.phone,
        isActive: u.isActive,
        groups: u.groups.map((g) => g.group.name),
        rowFilter: u.rowFilter,
        lastLoginAt: u.lastLoginAt,
        locked: !!u.lockedUntil && u.lockedUntil > new Date(),
        isSuperAdmin: u.isSuperAdmin,
      })),
    };
  });

  const userBody = z.object({
    email: z.string().email().transform((s) => s.toLowerCase()),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(30).optional().nullable(),
    groups: groupNames.default([]),
    isActive: z.boolean().default(true),
    rowFilter: conditionGroupSchema.nullable().optional(),
    password: passwordSchema.optional(),
  });

  async function groupIds(orgId: string, names: string[]) {
    const found = await prisma.group.findMany({ where: { orgId, name: { in: names } } });
    const missing = names.filter((n) => !found.some((g) => g.name === n));
    if (missing.length) throw AppError.badRequest(`Unknown groups: ${missing.join(', ')}`);
    return found.map((g) => g.id);
  }

  app.post('/admin/users', admin, async (req, reply) => {
    const body = parse(userBody, req.body);
    if (!body.password) throw AppError.validation({ password: 'Password is required' });
    if (body.isActive) await assertSeatAvailable(prisma, req.principal.orgId);
    const ids = await groupIds(req.principal.orgId, body.groups);
    const user = await prisma.user.create({
      data: {
        orgId: req.principal.orgId,
        email: body.email,
        name: body.name,
        phone: body.phone ?? null,
        isActive: body.isActive,
        rowFilter: body.rowFilter ?? Prisma.JsonNull,
        passwordHash: await hash(body.password),
        groups: { create: ids.map((groupId) => ({ groupId })) },
      },
    });
    await audit(prisma, { orgId: user.orgId, actor: req.principal, action: 'user.created', entityType: 'User', entityId: user.id, ip: req.ip });
    reply.code(201);
    return { id: user.id };
  });

  app.put('/admin/users/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(userBody, req.body);
    const existing = await prisma.user.findFirst({ where: { id, orgId: req.principal.orgId } });
    if (!existing) throw AppError.notFound('User');
    // Organization admins can not touch platform accounts (password resets would be a takeover path).
    if (existing.isSuperAdmin && !isSuperAdmin(req.principal)) throw AppError.forbidden('Super admin accounts can only be changed by a super admin');
    if (id === req.principal.userId && !body.isActive) throw AppError.badRequest('You cannot deactivate yourself');
    if (body.isActive && !existing.isActive && !existing.isSuperAdmin) await assertSeatAvailable(prisma, existing.orgId, { excludeUserId: id });
    const ids = await groupIds(req.principal.orgId, body.groups);
    // An admin dropping their own admin group would lock the organization out of its settings.
    if (id === req.principal.userId && !isSuperAdmin(req.principal) && !(await prisma.group.count({ where: { id: { in: ids }, capabilities: { has: 'ADMIN' } } }))) {
      throw AppError.badRequest('You cannot remove your own admin access. Ask another admin to do it.');
    }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          email: body.email,
          name: body.name,
          phone: body.phone ?? null,
          isActive: body.isActive,
          rowFilter: body.rowFilter ?? Prisma.JsonNull,
          ...(body.password ? { passwordHash: await hash(body.password), failedLogins: 0, lockedUntil: null } : {}),
        },
      });
      await tx.userGroup.deleteMany({ where: { userId: id } });
      await tx.userGroup.createMany({ data: ids.map((groupId) => ({ userId: id, groupId })) });
      if (!body.isActive || body.password) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, { orgId: existing.orgId, actor: req.principal, action: 'user.updated', entityType: 'User', entityId: id, diff: { groups: body.groups, isActive: body.isActive }, ip: req.ip });
    });
    invalidatePrincipal(id);
    return { ok: true };
  });

  // ------------------------------------------------------------ groups
  app.get('/admin/groups', admin, async (req) => {
    const items = await prisma.group.findMany({ where: { orgId: req.principal.orgId }, include: { _count: { select: { members: true } } }, orderBy: { name: 'asc' } });
    return { items: items.map((g) => ({ id: g.id, name: g.name, description: g.description, capabilities: g.capabilities, members: g._count.members })) };
  });

  const groupBody = z.object({
    name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_ -]+$/).transform((s) => s.toUpperCase()),
    description: z.string().max(300).optional().nullable(),
    capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  });

  app.post('/admin/groups', admin, async (req, reply) => {
    const body = parse(groupBody, req.body);
    const g = await prisma.group.create({ data: { orgId: req.principal.orgId, name: body.name, description: body.description ?? null, capabilities: body.capabilities } });
    await audit(prisma, { orgId: g.orgId, actor: req.principal, action: 'group.created', entityType: 'Group', entityId: g.id, diff: body, ip: req.ip });
    reply.code(201);
    return { id: g.id };
  });

  app.put('/admin/groups/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(groupBody, req.body);
    const { count } = await prisma.group.updateMany({ where: { id, orgId: req.principal.orgId }, data: { name: body.name, description: body.description ?? null, capabilities: body.capabilities } });
    if (!count) throw AppError.notFound('Group');
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: 'group.updated', entityType: 'Group', entityId: id, diff: body, ip: req.ip });
    invalidatePrincipal();
    return { ok: true };
  });

  // ------------------------------------------------------------ calendars & holidays
  app.get('/admin/calendars', admin, async (req) => {
    const items = await prisma.businessCalendar.findMany({ where: { orgId: req.principal.orgId }, include: { holidays: { orderBy: { date: 'asc' } } }, orderBy: { name: 'asc' } });
    return { items };
  });

  const calendarBody = z.object({ name: z.string().trim().min(1).max(80), config: z.unknown(), holidays: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(80) })).max(1000) });

  async function saveCalendar(orgId: string, id: string | null, raw: unknown) {
    const body = parse(calendarBody, raw);
    const cfg = parse(calendarSchema, { ...(body.config as object), holidays: body.holidays.map((h) => h.date) });
    return prisma.$transaction(async (tx) => {
      const data = { name: body.name, timezone: cfg.timezone, shiftStart: cfg.shiftStart, shiftEnd: cfg.shiftEnd, weeklyOff: cfg.weeklyOff };
      const cal = id ? await tx.businessCalendar.update({ where: { id }, data }) : await tx.businessCalendar.create({ data: { orgId, ...data } });
      await tx.holiday.deleteMany({ where: { calendarId: cal.id } });
      await tx.holiday.createMany({ data: body.holidays.map((h) => ({ calendarId: cal.id, date: h.date, name: h.name })), skipDuplicates: true });
      return cal;
    });
  }

  app.post('/admin/calendars', admin, async (req, reply) => {
    const cal = await saveCalendar(req.principal.orgId, null, req.body);
    reply.code(201);
    return { id: cal.id };
  });

  app.put('/admin/calendars/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    if (!(await prisma.businessCalendar.count({ where: { id, orgId: req.principal.orgId } }))) throw AppError.notFound('Calendar');
    await saveCalendar(req.principal.orgId, id, req.body);
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: 'calendar.updated', entityType: 'BusinessCalendar', entityId: id, ip: req.ip });
    invalidateWorkflow();
    return { ok: true };
  });

  // ------------------------------------------------------------ option sets
  app.get('/admin/option-sets', admin, async (req) => ({ items: await prisma.optionSet.findMany({ where: { orgId: req.principal.orgId }, orderBy: { name: 'asc' } }) }));

  const optionSetBody = z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
    name: z.string().trim().min(1).max(80),
    options: z.array(z.string().trim().min(1).max(200)).max(5000).transform((a) => [...new Set(a)]),
  });

  app.put('/admin/option-sets', admin, async (req) => {
    const body = parse(optionSetBody, req.body);
    const set = await prisma.optionSet.upsert({
      where: { orgId_key: { orgId: req.principal.orgId, key: body.key } },
      update: { name: body.name, options: body.options },
      create: { orgId: req.principal.orgId, ...body },
    });
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: 'option_set.saved', entityType: 'OptionSet', entityId: set.id, ip: req.ip });
    invalidateWorkflow();
    return { id: set.id };
  });

  // ------------------------------------------------------------ notification rules (legacy Messages tab)
  const rulesGuard = async (req: { principal: Parameters<typeof hasCapability>[0] }) => {
    if (!hasCapability(req.principal, 'MANAGE_RULES')) throw AppError.forbidden('Requires MANAGE_RULES permission');
  };
  const wfParam = z.object({ wf: z.string().min(1).max(64) });

  /**
   * A non-admin rule author may only put fields they can see into a message. Otherwise
   * `{{salary}}` in an email to themselves would leak a field restricted to other people.
   */
  function assertRuleFieldsVisible(p: AuthUser, wf: LoadedWorkflow, def: NotificationRuleDef) {
    if (isAdmin(p)) return;
    const texts = [def.email?.to, def.email?.cc, def.email?.subject, def.email?.body, def.whatsapp?.to, def.whatsapp?.body, ...(def.whatsapp?.template?.params ?? [])].filter((s): s is string => !!s);
    const names = texts.flatMap((t) => [...t.matchAll(/\{\{\s*([^}]+?)\s*\}\}|<<([^<>]+)>>/g)].map((m) => (m[1] ?? m[2] ?? '').trim().toLowerCase()));
    const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
    const hidden = wf.def.fields.filter((f) => !visible.has(f.key) && names.some((n) => n === f.key.toLowerCase() || n === f.label.trim().toLowerCase()));
    if (hidden.length) throw AppError.forbidden(`You can not use fields you are not allowed to see: ${hidden.map((f) => f.label).join(', ')}`);
  }

  app.get('/workflows/:wf/rules', { preHandler: rulesGuard }, async (req) => {
    const { wf: key } = parse(wfParam, req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    const rules = await prisma.notificationRule.findMany({ where: { workflowId: wf.id }, orderBy: { createdAt: 'asc' } });
    return { items: rules.map((r) => ({ id: r.id, isActive: r.isActive, definition: r.definition, updatedAt: r.updatedAt })) };
  });

  app.post('/workflows/:wf/rules', { preHandler: rulesGuard }, async (req, reply) => {
    const { wf: key } = parse(wfParam, req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    const def = parse(notificationRuleSchema, req.body);
    assertRuleFieldsVisible(req.principal, wf, def);
    const rule = await prisma.notificationRule.create({ data: { workflowId: wf.id, isActive: def.isActive, definition: def as Prisma.InputJsonObject } });
    await audit(prisma, { orgId: wf.orgId, actor: req.principal, action: 'rule.created', entityType: 'NotificationRule', entityId: rule.id, ip: req.ip });
    reply.code(201);
    return { id: rule.id };
  });

  app.put('/workflows/:wf/rules/:id', { preHandler: rulesGuard }, async (req) => {
    const { wf: key, id } = parse(wfParam.extend({ id: z.string().min(1) }), req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    const def = parse(notificationRuleSchema, req.body);
    assertRuleFieldsVisible(req.principal, wf, def);
    const { count } = await prisma.notificationRule.updateMany({ where: { id, workflowId: wf.id }, data: { isActive: def.isActive, definition: def as Prisma.InputJsonObject } });
    if (!count) throw AppError.notFound('Rule');
    await audit(prisma, { orgId: wf.orgId, actor: req.principal, action: 'rule.updated', entityType: 'NotificationRule', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/workflows/:wf/rules/:id', { preHandler: rulesGuard }, async (req) => {
    const { wf: key, id } = parse(wfParam.extend({ id: z.string().min(1) }), req.params);
    const wf = await getWorkflow(req.principal.orgId, key);
    const { count } = await prisma.notificationRule.deleteMany({ where: { id, workflowId: wf.id } });
    if (!count) throw AppError.notFound('Rule');
    await audit(prisma, { orgId: wf.orgId, actor: req.principal, action: 'rule.deleted', entityType: 'NotificationRule', entityId: id, ip: req.ip });
    return { ok: true };
  });

  /** Resend: forget delivery history so the rule fires again for these records (legacy send_individual_rem). */
  app.post('/workflows/:wf/rules/:id/resend', { preHandler: rulesGuard }, async (req) => {
    const { wf: key, id } = parse(wfParam.extend({ id: z.string().min(1) }), req.params);
    const { recordIds } = parse(z.object({ recordIds: z.array(z.string().min(1)).min(1).max(500) }), req.body);
    const wf = await getWorkflow(req.principal.orgId, key);
    if (!(await prisma.notificationRule.count({ where: { id, workflowId: wf.id } }))) throw AppError.notFound('Rule');
    // Only records of this flow; then re-run them so the rule fires again where its trigger still holds.
    const records = await prisma.record.findMany({ where: { id: { in: recordIds }, workflowId: wf.id }, select: { id: true } });
    const ids = records.map((r) => r.id);
    const { count } = await prisma.notificationLog.deleteMany({ where: { ruleId: id, recordId: { in: ids } } });
    await publishRecordChanged(ids);
    await audit(prisma, { orgId: wf.orgId, actor: req.principal, action: 'rule.resent', entityType: 'NotificationRule', entityId: id, diff: { records: ids.length }, ip: req.ip });
    return { cleared: count, records: ids.length };
  });

  // ------------------------------------------------------------ audit & jobs
  app.get('/admin/audit', admin, async (req) => {
    const q = parse(z.object({ entityType: z.string().optional(), entityId: z.string().optional(), cursor: z.string().optional(), take: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const items = await prisma.auditLog.findMany({
      where: { orgId: req.principal.orgId, entityType: q.entityType, entityId: q.entityId },
      orderBy: { createdAt: 'desc' },
      take: q.take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return { items: items.slice(0, q.take), nextCursor: items.length > q.take ? items[q.take - 1]!.id : null };
  });

  /**
   * Scheduled runs cover every organization, so their counters and errors are
   * platform data: organization admins see only that they ran and whether they succeeded.
   */
  app.get('/admin/jobs', { preHandler: app.requireCapability('RUN_JOBS') }, async (req) => {
    const superAdmin = isSuperAdmin(req.principal);
    const rows = await prisma.jobRun.findMany({ where: { OR: [{ orgId: null }, { orgId: req.principal.orgId }] }, orderBy: { startedAt: 'desc' }, take: 100 });
    return {
      items: rows.map((r) => ({
        ...r,
        scope: r.orgId ? 'organization' : 'platform',
        ...(r.orgId || superAdmin ? {} : { stats: null, error: r.error ? 'Failed (details visible to the platform operator)' : null }),
      })),
    };
  });

  /** Legacy op_runfun / "Send Reminder" menu: runs the job for this organization only. */
  app.post('/admin/jobs/:name/run', { preHandler: app.requireCapability('RUN_JOBS') }, async (req) => {
    const { name } = parse(z.object({ name: z.string() }), req.params);
    if (!MANUAL_JOBS.includes(name as JobName)) throw AppError.badRequest(`Unknown job. Allowed: ${MANUAL_JOBS.join(', ')}`);
    await enqueueManualJob(name as JobName, req.principal.email, req.principal.orgId);
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: 'job.triggered', entityType: 'Job', entityId: name, ip: req.ip });
    return { queued: true };
  });
}
