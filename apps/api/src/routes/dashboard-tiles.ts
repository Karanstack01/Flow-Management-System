/**
 * Dashboard link tiles (legacy Dashboard tab / dashboard.html): links to reports, sheets and sites
 * the team opens often. Everyone sees the tiles for their groups; admins manage them.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAdmin } from '@fms/core';
import { prisma } from '@fms/db';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';

export const TILE_ICONS = ['link', 'chart', 'sheet', 'doc', 'folder', 'video', 'form', 'calendar'] as const;

const tileBody = z.object({
  name: z.string().trim().min(1).max(80),
  // Only web links: no javascript:, data: or other schemes that would run in the app.
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), 'Links must start with https:// or http://'),
  description: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  icon: z.enum(TILE_ICONS).default('link'),
  groups: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});

export default async function dashboardTileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  const admin = { preHandler: app.requireCapability('ADMIN') };

  app.get('/dashboard/tiles', async (req) => {
    const p = req.principal;
    const rows = await prisma.dashboardTile.findMany({ where: { orgId: p.orgId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    const mine = (groups: string[]) => !groups.length || groups.includes('ALL') || groups.some((g) => p.groups.includes(g));
    return { items: (isAdmin(p) ? rows : rows.filter((t) => mine(t.groups))).map(({ orgId: _o, ...t }) => t), canManage: isAdmin(p) };
  });

  app.post('/admin/dashboard-tiles', admin, async (req, reply) => {
    const body = parse(tileBody, req.body);
    const p = req.principal;
    if ((await prisma.dashboardTile.count({ where: { orgId: p.orgId } })) >= 60) throw AppError.badRequest('At most 60 tiles');
    const last = await prisma.dashboardTile.findFirst({ where: { orgId: p.orgId }, orderBy: { position: 'desc' }, select: { position: true } });
    const tile = await prisma.dashboardTile.create({ data: { ...body, orgId: p.orgId, position: (last?.position ?? -1) + 1 } });
    await audit(prisma, { orgId: p.orgId, actor: p, action: 'dashboard_tile.created', entityType: 'DashboardTile', entityId: tile.id, ip: req.ip });
    reply.code(201);
    return { id: tile.id };
  });

  app.put('/admin/dashboard-tiles/:id', admin, async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(40) }), req.params);
    const body = parse(tileBody, req.body);
    const { count } = await prisma.dashboardTile.updateMany({ where: { id, orgId: req.principal.orgId }, data: body });
    if (!count) throw AppError.notFound('Tile');
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: 'dashboard_tile.updated', entityType: 'DashboardTile', entityId: id, ip: req.ip });
    return { ok: true };
  });

  /** New order: the ids in the order they should appear. */
  app.put('/admin/dashboard-tiles', admin, async (req) => {
    const { order } = parse(z.object({ order: z.array(z.string().min(1).max(40)).max(60) }), req.body);
    await prisma.$transaction(order.map((id, position) => prisma.dashboardTile.updateMany({ where: { id, orgId: req.principal.orgId }, data: { position } })));
    return { ok: true };
  });

  app.delete('/admin/dashboard-tiles/:id', admin, async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(40) }), req.params);
    const { count } = await prisma.dashboardTile.deleteMany({ where: { id, orgId: req.principal.orgId } });
    if (!count) throw AppError.notFound('Tile');
    await audit(prisma, { orgId: req.principal.orgId, actor: req.principal, action: 'dashboard_tile.deleted', entityType: 'DashboardTile', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
