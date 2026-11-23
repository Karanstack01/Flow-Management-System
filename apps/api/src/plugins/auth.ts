import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { hasCapability, isSuperAdmin, orgAccessError, type Capability, type Principal } from '@fms/core';
import { prisma, principalFromUser } from '@fms/db';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface AuthUser extends Principal {
  /** Organization being acted in (a super admin may be visiting another one). */
  orgId: string;
  /** Organization the user belongs to. */
  homeOrgId: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthUser;
  }
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
    requireCapability: (cap: Capability) => preHandlerAsyncHookHandler;
    requireSuperAdmin: preHandlerAsyncHookHandler;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; org: string };
    user: { sub: string; org: string };
  }
}

const CACHE_TTL_MS = 30_000;
type Loaded = { principal: AuthUser; orgError: ReturnType<typeof orgAccessError> } | null;
const cache = new Map<string, { at: number; value: Loaded }>();

export function invalidatePrincipal(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export const ORG_CLOSED_MESSAGE = {
  SUSPENDED: 'Your organization’s access is suspended. Contact your administrator.',
  LICENSE_EXPIRED: 'Your organization’s licence has expired. Contact your administrator.',
} as const;

async function load(userId: string): Promise<Loaded> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { groups: { include: { group: true } } } });
  let value: Loaded = null;
  if (user?.isActive) {
    const principal = principalFromUser(user);
    const org = await prisma.organization.findUnique({ where: { id: principal.orgId }, select: { isActive: true, licenseExpiresAt: true } });
    value = org ? { principal, orgError: orgAccessError(org) } : null;
  }
  cache.set(userId, { at: Date.now(), value });
  return value;
}

/** Principal for an active user in a live organization (super admins pass even when the organization is closed). */
export async function loadPrincipal(userId: string): Promise<AuthUser | null> {
  const v = await load(userId);
  if (!v) return null;
  if (v.orgError && !isSuperAdmin(v.principal)) return null;
  return v.principal;
}

export default fp(async (app, opts: { config: Config }) => {
  await app.register(jwt, {
    secret: opts.config.JWT_ACCESS_SECRET,
    // Pinned algorithm: tokens signed any other way (none, RS*, …) are rejected outright.
    sign: { algorithm: 'HS256', expiresIn: opts.config.ACCESS_TOKEN_TTL },
    verify: { algorithms: ['HS256'] },
  });

  app.decorateRequest('principal', null as unknown as AuthUser);

  app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw AppError.unauthorized('Invalid or expired access token');
    }
    let v = await load(req.user.sub);
    if (v && v.principal.orgId !== req.user.org) {
      // Possibly a stale cache on this node right after a switch on another node: reload once.
      invalidatePrincipal(req.user.sub);
      v = await load(req.user.sub);
    }
    if (!v) throw AppError.unauthorized('Account disabled');
    if (v.orgError && !isSuperAdmin(v.principal)) throw new AppError(403, v.orgError, ORG_CLOSED_MESSAGE[v.orgError]);
    // The token is bound to one organization; after a super admin switches, old tokens stop working
    // and the client transparently refreshes into the new organization.
    if (v.principal.orgId !== req.user.org) throw AppError.unauthorized('Organization changed');
    req.principal = v.principal;
  });

  app.decorate('requireCapability', (cap: Capability) => async (req: FastifyRequest) => {
    if (!req.principal) throw AppError.unauthorized();
    if (!hasCapability(req.principal, cap)) throw AppError.forbidden(`Requires ${cap} permission`);
  });

  app.decorate('requireSuperAdmin', async (req: FastifyRequest) => {
    if (!req.principal) throw AppError.unauthorized();
    if (!isSuperAdmin(req.principal)) throw AppError.forbidden('Requires super admin');
  });
});
