import type { Tx } from '@fms/db';
import { AppError } from './errors.js';

/**
 * Licence limits set by a super admin on the organization (null = unlimited).
 * Super admin accounts are platform staff and never consume a customer seat.
 */
export async function assertSeatAvailable(db: Tx, orgId: string, opts: { excludeUserId?: string } = {}) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { maxUsers: true } });
  if (org.maxUsers == null) return;
  const used = await db.user.count({ where: { orgId, isActive: true, isSuperAdmin: false, ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}) } });
  if (used >= org.maxUsers) throw new AppError(402, 'LICENSE_LIMIT', `Your licence allows ${org.maxUsers} active users. Deactivate someone or ask your provider for more seats.`);
}

export async function assertWorkflowSlot(db: Tx, orgId: string) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { maxWorkflows: true } });
  if (org.maxWorkflows == null) return;
  const used = await db.workflow.count({ where: { orgId } });
  if (used >= org.maxWorkflows) throw new AppError(402, 'LICENSE_LIMIT', `Your licence allows ${org.maxWorkflows} workflows.`);
}
