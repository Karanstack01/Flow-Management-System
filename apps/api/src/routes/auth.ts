import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { effectiveCapabilities, isSuperAdmin, orgAccessError } from '@fms/core';
import { effectiveOrgId, prisma } from '@fms/db';
import type { Config } from '../config.js';
import { AppError, parse } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { accountSecurityStatus, onLoginFailure, onLoginSuccess } from '../lib/accountSecurity.js';
import { invalidatePrincipal, ORG_CLOSED_MESSAGE } from '../plugins/auth.js';

const COOKIE = 'fms_rt';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const ROTATION_GRACE_MS = 15_000;
// Verified against when the email is unknown so response time does not reveal accounts.
const DUMMY_HASH_PROMISE = hash('dummy-password-for-timing');

export const passwordSchema = z
  .string()
  .min(10, 'At least 10 characters')
  .max(200)
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), 'Use letters and numbers');

export default async function authRoutes(app: FastifyInstance, opts: { config: Config }) {
  const { config } = opts;
  const hmac = (token: string) => createHmac('sha256', config.JWT_REFRESH_SECRET).update(token).digest('hex');
  const cookieOpts = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/api/v1/auth',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400,
  };

  /** Organizations that are suspended or past their licence admit only super admins. */
  async function assertOrgOpen(user: { orgId: string; isSuperAdmin: boolean; activeOrgId: string | null }) {
    if (user.isSuperAdmin) return;
    const org = await prisma.organization.findUnique({ where: { id: user.orgId }, select: { isActive: true, licenseExpiresAt: true } });
    const err = org ? orgAccessError(org) : 'SUSPENDED';
    if (err) throw new AppError(403, err, ORG_CLOSED_MESSAGE[err]);
  }

  async function issueTokens(reply: FastifyReply, user: { id: string; orgId: string; isSuperAdmin: boolean; activeOrgId: string | null }, family: string, meta: { ip: string; ua?: string }) {
    const refresh = randomBytes(48).toString('base64url');
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        family,
        tokenHash: hmac(refresh),
        expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ip: meta.ip,
        userAgent: meta.ua?.slice(0, 300),
      },
    });
    reply.setCookie(COOKIE, refresh, cookieOpts);
    return app.jwt.sign({ sub: user.id, org: effectiveOrgId(user) });
  }

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const email = body.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.isActive) {
      await verify(await DUMMY_HASH_PROMISE, body.password).catch(() => false);
      throw AppError.unauthorized('Invalid email or password');
    }
    const security = accountSecurityStatus(user);
    if (security.status === 'locked') {
      throw new AppError(423, 'LOCKED', 'Too many failed attempts. Try again later.');
    }
    const ok = await verify(user.passwordHash, body.password).catch(() => false);
    if (!ok) {
      const transition = onLoginFailure(user);
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: transition.failedLogins, lockedUntil: transition.lockedUntil },
      });
      throw AppError.unauthorized('Invalid email or password');
    }
    // Checked only after the password, so a suspended organization does not reveal which emails exist.
    await assertOrgOpen(user);

    const success = onLoginSuccess();
    await prisma.user.update({ where: { id: user.id }, data: { ...success, lastLoginAt: new Date() } });
    const accessToken = await issueTokens(reply, user, randomBytes(12).toString('hex'), { ip: req.ip, ua: req.headers['user-agent'] });
    await audit(prisma, { orgId: user.orgId, actor: { userId: user.id, email: user.email }, action: 'auth.login', entityType: 'User', entityId: user.id, ip: req.ip });
    return { accessToken };
  });

  app.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (!token) throw AppError.unauthorized('No session');
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hmac(token) }, include: { user: true } });
    if (!row) throw AppError.unauthorized('Invalid session');
    const reused = async (revokedAt: Date) => {
      // Rotated moments ago by another tab of the same browser (they share the cookie): not theft.
      // The client retries once and picks up the new cookie.
      if (Date.now() - revokedAt.getTime() < ROTATION_GRACE_MS) throw new AppError(409, 'REFRESH_RACE', 'Session was just refreshed by another tab');
      // Reuse of a rotated token ⇒ likely theft: kill the whole family.
      await prisma.refreshToken.updateMany({ where: { family: row.family, revokedAt: null }, data: { revokedAt: new Date() } });
      reply.clearCookie(COOKIE, cookieOpts);
      throw AppError.unauthorized('Session revoked');
    };
    if (row.revokedAt) return reused(row.revokedAt);
    if (row.expiresAt < new Date() || !row.user.isActive) throw AppError.unauthorized('Session expired');
    await assertOrgOpen(row.user);
    // Atomic rotation: only one concurrent request can consume this token.
    const { count } = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (count !== 1) return reused(new Date());
    const accessToken = await issueTokens(reply, row.user, row.family, { ip: req.ip, ua: req.headers['user-agent'] });
    return { accessToken };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await prisma.refreshToken.updateMany({ where: { tokenHash: hmac(token), revokedAt: null }, data: { revokedAt: new Date() } });
    reply.clearCookie(COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const p = req.principal;
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: p.orgId }, select: { id: true, name: true, slug: true, isActive: true, licenseExpiresAt: true } });
    return {
      id: p.userId,
      orgId: p.orgId,
      homeOrgId: p.homeOrgId,
      org: { id: org.id, name: org.name, slug: org.slug, status: orgAccessError(org) ?? 'ACTIVE' },
      email: p.email,
      name: p.name,
      groups: p.groups,
      capabilities: effectiveCapabilities(p),
      isSuperAdmin: isSuperAdmin(p),
    };
  });

  /**
   * Super admin only: work inside another organization (legacy: opening another
   * client's FMS spreadsheet). The new access token is bound to that organization;
   * pass the home organization id (or null) to go back.
   */
  app.post('/switch-org', { preHandler: [app.authenticate, app.requireSuperAdmin] }, async (req) => {
    const { orgId } = parse(z.object({ orgId: z.string().min(1).max(40).nullable() }), req.body);
    const p = req.principal;
    const target = orgId ?? p.homeOrgId;
    const org = await prisma.organization.findUnique({ where: { id: target }, select: { id: true } });
    if (!org) throw AppError.notFound('Organization');
    const user = await prisma.user.update({ where: { id: p.userId }, data: { activeOrgId: target === p.homeOrgId ? null : target } });
    invalidatePrincipal(p.userId);
    await audit(prisma, { orgId: target, actor: p, action: target === p.homeOrgId ? 'platform.org_returned' : 'platform.org_entered', entityType: 'Organization', entityId: target, ip: req.ip });
    return { accessToken: app.jwt.sign({ sub: user.id, org: effectiveOrgId(user) }) };
  });

  app.post('/change-password', { preHandler: app.authenticate, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.principal.userId } });
    if (!(await verify(user.passwordHash, body.currentPassword).catch(() => false))) throw AppError.badRequest('Current password is incorrect');
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hash(body.newPassword) } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    invalidatePrincipal(user.id);
    await audit(prisma, { orgId: user.orgId, actor: { userId: user.id, email: user.email }, action: 'auth.password_changed', entityType: 'User', entityId: user.id, ip: req.ip });
    // Every other session is signed out; this one gets a fresh refresh token so it keeps working.
    const accessToken = await issueTokens(reply, user, randomBytes(12).toString('hex'), { ip: req.ip, ua: req.headers['user-agent'] });
    return { ok: true, accessToken };
  });
}
