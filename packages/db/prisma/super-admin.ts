/**
 * Break-glass CLI: grant or revoke super admin from the server shell.
 *
 *   npm run super-admin -w @fms/db -- grant  someone@company.com
 *   npm run super-admin -w @fms/db -- revoke someone@company.com
 *
 * Needs only DATABASE_URL, so it works even when every super admin is locked out.
 * Revoking the last active super admin is refused.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [action, rawEmail] = process.argv.slice(2);
  if ((action !== 'grant' && action !== 'revoke') || !rawEmail) {
    console.error('Usage: super-admin <grant|revoke> <email>');
    process.exitCode = 2;
    return;
  }
  const email = rawEmail.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user with email ${email}`);

  if (action === 'revoke') {
    const others = await prisma.user.count({ where: { isSuperAdmin: true, isActive: true, id: { not: user.id } } });
    if (!others) throw new Error('Refusing to revoke the last active super admin');
  }

  const enabled = action === 'grant';
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: enabled, activeOrgId: null, ...(enabled ? { isActive: true, failedLogins: 0, lockedUntil: null } : {}) } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.auditLog.create({
      data: { orgId: user.orgId, actorEmail: 'cli', action: enabled ? 'platform.super_admin_granted' : 'platform.super_admin_revoked', entityType: 'User', entityId: user.id },
    }),
  ]);
  console.log(`${email}: super admin ${enabled ? 'granted' : 'revoked'}. Existing sessions were signed out.`);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
