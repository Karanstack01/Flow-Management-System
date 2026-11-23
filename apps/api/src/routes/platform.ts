/**
 * Platform administration — super admins only.
 *
 * Legacy equivalent: the CEOITBOX operator who owns every client's FMS
 * spreadsheet, issues licences (checklicence / "License Status"), runs "Setup
 * Sheet" for a new client, and can open any sheet's Admin menu. Here that becomes:
 * organizations (tenants) with licence limits and suspension, cross-tenant user
 * lookup, super admin management, platform-wide jobs and a health overview.
 */
import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { z } from 'zod';
import { MANUAL_JOBS, orgAccessError, type JobName } from '@fms/core';
import { prisma } from '@fms/db';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';
import { enqueueManualJob } from '../lib/queue.js';
import { invalidateWorkflow } from '../lib/workflows.js';
import { invalidatePrincipal } from '../plugins/auth.js';
import { passwordSchema } from './auth.js';

const idParam = z.object({ id: z.string().min(1).max(40) });
const limit = z.number().int().min(1).max(100_000).nullable();
const timezone = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA timezone');

const createOrgBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'Lower-case letters, digits and dashes'),
  timezone: timezone.default('Asia/Kolkata'),
  maxUsers: limit.optional(),
  maxWorkflows: limit.optional(),
  licenseExpiresAt: z.coerce.date().nullable().optional(),
  admin: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email().transform((s) => s.toLowerCase()),
    password: passwordSchema,
  }),
});

const updateOrgBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    isActive: z.boolean(),
    suspendedReason: z.string().trim().max(300).nullable(),
    maxUsers: limit,
    maxWorkflows: limit,
    licenseExpiresAt: z.coerce.date().nullable(),
  })
  .partial();

export default async function platformRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireSuperAdmin);

  // ------------------------------------------------------------ overview
  app.get('/platform/overview', async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const [orgs, users, superAdmins, workflows, openRecords, overdueStages, failedNotifications, sentNotifications, lastJobs] = await Promise.all([
      prisma.organization.findMany({ select: { isActive: true, licenseExpiresAt: true } }),
      prisma.user.groupBy({ by: ['isActive'], where: { isSuperAdmin: false }, _count: true }),
      prisma.user.count({ where: { isSuperAdmin: true, isActive: true } }),
      prisma.workflow.count({ where: { isActive: true } }),
      prisma.record.count({ where: { archivedAt: null, completedAt: null } }),
      prisma.recordStage.count({ where: { status: 'active', plannedAt: { lt: now }, record: { archivedAt: null } } }),
      prisma.notificationLog.count({ where: { status: 'failed', createdAt: { gte: dayAgo } } }),
      prisma.notificationLog.count({ where: { status: 'sent', createdAt: { gte: dayAgo } } }),
      prisma.jobRun.findMany({ where: { orgId: null }, orderBy: { startedAt: 'desc' }, distinct: ['name'] }),
    ]);
    const closed = orgs.filter((o) => orgAccessError(o, now)).length;
    return {
      organizations: { total: orgs.length, live: orgs.length - closed, closed },
      users: {
        active: users.find((u) => u.isActive)?._count ?? 0,
        inactive: users.find((u) => !u.isActive)?._count ?? 0,
        superAdmins,
      },
      workflows,
      openRecords,
      overdueStages,
      notifications24h: { sent: sentNotifications, failed: failedNotifications },
      jobs: lastJobs.map((j) => ({ name: j.name, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error?.split('\n')[0] ?? null })),
    };
  });

  // ------------------------------------------------------------ organizations
  app.get('/platform/orgs', async () => {
    const [orgs, activeUsers, records] = await Promise.all([
      prisma.organization.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { workflows: true } } } }),
      prisma.user.groupBy({ by: ['orgId'], where: { isActive: true, isSuperAdmin: false }, _count: true }),
      prisma.record.groupBy({ by: ['orgId'], where: { archivedAt: null }, _count: true }),
    ]);
    const now = new Date();
    return {
      items: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        isActive: o.isActive,
        status: orgAccessError(o, now) ?? 'ACTIVE',
        suspendedReason: o.suspendedReason,
        maxUsers: o.maxUsers,
        maxWorkflows: o.maxWorkflows,
        licenseExpiresAt: o.licenseExpiresAt,
        createdAt: o.createdAt,
        activeUsers: activeUsers.find((u) => u.orgId === o.id)?._count ?? 0,
        workflows: o._count.workflows,
        records: records.find((r) => r.orgId === o.id)?._count ?? 0,
      })),
    };
  });

  /** Onboard a client (legacy "Setup Sheet"): organization + admin group + first admin + business calendar. */
  app.post('/platform/orgs', async (req, reply) => {
    const body = parse(createOrgBody, req.body);
    if (await prisma.organization.findUnique({ where: { slug: body.slug }, select: { id: true } })) throw AppError.conflict('That slug is already used', { slug: 'Already used' });
    if (await prisma.user.findUnique({ where: { email: body.admin.email }, select: { id: true } })) throw AppError.conflict('A user with this email already exists', { 'admin.email': 'Already registered' });
    const passwordHash = await hash(body.admin.password);

    const org = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: body.name, slug: body.slug, maxUsers: body.maxUsers ?? null, maxWorkflows: body.maxWorkflows ?? null, licenseExpiresAt: body.licenseExpiresAt ?? null },
      });
      const admins = await tx.group.create({ data: { orgId: org.id, name: 'ADMINS', description: 'Full administrative access', capabilities: ['ADMIN'] } });
      await tx.businessCalendar.create({ data: { orgId: org.id, name: 'Head Office', timezone: body.timezone, shiftStart: '09:30', shiftEnd: '18:30', weeklyOff: [7] } });
      const user = await tx.user.create({
        data: { orgId: org.id, email: body.admin.email, name: body.admin.name, passwordHash, groups: { create: { groupId: admins.id } } },
      });
      await audit(tx, { orgId: org.id, actor: req.principal, action: 'platform.org_created', entityType: 'Organization', entityId: org.id, diff: { name: body.name, slug: body.slug, adminUserId: user.id }, ip: req.ip });
      return org;
    });
    reply.code(201);
    return { id: org.id };
  });

  app.patch('/platform/orgs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(updateOrgBody, req.body);
    const existing = await prisma.organization.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound('Organization');
    if (body.isActive === false && id === req.principal.homeOrgId) throw AppError.badRequest('You can not suspend your own organization');
    const closing = (body.isActive === false && existing.isActive) || (body.licenseExpiresAt != null && body.licenseExpiresAt < new Date());

    await prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id },
        data: { ...body, ...(body.isActive === true ? { suspendedReason: null } : {}) },
      });
      // Close open sessions right away instead of waiting for access tokens to expire.
      if (closing) await tx.refreshToken.updateMany({ where: { revokedAt: null, user: { orgId: id, isSuperAdmin: false } }, data: { revokedAt: new Date() } });
      await audit(tx, { orgId: id, actor: req.principal, action: body.isActive === false ? 'platform.org_suspended' : body.isActive === true && !existing.isActive ? 'platform.org_reactivated' : 'platform.org_updated', entityType: 'Organization', entityId: id, diff: JSON.parse(JSON.stringify(body)), ip: req.ip });
    });
    invalidatePrincipal();
    invalidateWorkflow();
    return { ok: true };
  });

  // ------------------------------------------------------------ users across organizations
  app.get('/platform/users', async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(120).optional(), superAdmins: z.enum(['true', 'false']).optional() }), req.query);
    const users = await prisma.user.findMany({
      where: {
        ...(q.superAdmins === 'true' ? { isSuperAdmin: true } : {}),
        ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] } : {}),
      },
      include: { org: { select: { id: true, name: true } } },
      orderBy: [{ isSuperAdmin: 'desc' }, { name: 'asc' }],
      take: 100,
    });
    return {
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        isActive: u.isActive,
        isSuperAdmin: u.isSuperAdmin,
        org: u.org,
        lastLoginAt: u.lastLoginAt,
        locked: !!u.lockedUntil && u.lockedUntil > new Date(),
      })),
    };
  });

  app.put('/platform/users/:id/super-admin', async (req) => {
    const { id } = parse(idParam, req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw AppError.notFound('User');
    if (target.isSuperAdmin === enabled) return { ok: true };
    if (!enabled) {
      // Another super admin must do it, so nobody locks the platform out by accident.
      if (id === req.principal.userId) throw AppError.badRequest('You cannot remove your own super admin access');
      const others = await prisma.user.count({ where: { isSuperAdmin: true, isActive: true, id: { not: id } } });
      if (!others) throw AppError.badRequest('At least one active super admin is required');
    }
    if (enabled && !target.isActive) throw AppError.badRequest('Activate the user first');
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { isSuperAdmin: enabled, activeOrgId: null } });
      await audit(tx, { orgId: target.orgId, actor: req.principal, action: enabled ? 'platform.super_admin_granted' : 'platform.super_admin_revoked', entityType: 'User', entityId: id, ip: req.ip });
    });
    invalidatePrincipal(id);
    return { ok: true };
  });

  /** Sign a user out everywhere and clear a lockout (e.g. suspected compromise). */
  app.post('/platform/users/:id/revoke-sessions', async (req) => {
    const { id } = parse(idParam, req.params);
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, orgId: true } });
    if (!target) throw AppError.notFound('User');
    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
      await audit(tx, { orgId: target.orgId, actor: req.principal, action: 'platform.sessions_revoked', entityType: 'User', entityId: id, ip: req.ip });
    });
    invalidatePrincipal(id);
    return { ok: true };
  });

  // ------------------------------------------------------------ jobs & platform audit
  app.get('/platform/jobs', async () => {
    const rows = await prisma.jobRun.findMany({ orderBy: { startedAt: 'desc' }, take: 200 });
    const orgIds = [...new Set(rows.map((r) => r.orgId).filter((x): x is string => !!x))];
    const orgs = orgIds.length ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [];
    return { items: rows.map((r) => ({ ...r, orgName: r.orgId ? (orgs.find((o) => o.id === r.orgId)?.name ?? null) : null })) };
  });

  app.post('/platform/jobs/:name/run', async (req) => {
    const { name } = parse(z.object({ name: z.string() }), req.params);
    const { orgId } = parse(z.object({ orgId: z.string().min(1).max(40).nullable().default(null) }), req.body ?? {});
    if (!MANUAL_JOBS.includes(name as JobName)) throw AppError.badRequest(`Unknown job. Allowed: ${MANUAL_JOBS.join(', ')}`);
    if (orgId && !(await prisma.organization.count({ where: { id: orgId } }))) throw AppError.notFound('Organization');
    await enqueueManualJob(name as JobName, req.principal.email, orgId ?? undefined);
    await audit(prisma, { orgId: orgId ?? req.principal.homeOrgId, actor: req.principal, action: orgId ? 'job.triggered' : 'platform.job_triggered', entityType: 'Job', entityId: name, ip: req.ip });
    return { queued: true };
  });

  app.get('/platform/audit', async (req) => {
    const q = parse(z.object({ cursor: z.string().optional(), take: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const items = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'platform.' } },
      include: { org: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return {
      items: items.slice(0, q.take).map(({ org, ...a }) => ({ ...a, orgName: org.name })),
      nextCursor: items.length > q.take ? items[q.take - 1]!.id : null,
    };
  });
}
