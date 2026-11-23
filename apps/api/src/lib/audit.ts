import type { Prisma, Tx } from '@fms/db';

export interface AuditEntry {
  orgId: string;
  actor?: { userId: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  diff?: Prisma.InputJsonValue;
  ip?: string;
}

/** Append-only audit trail. Pass the transaction client to make it atomic with the change. */
export async function audit(db: Tx, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      orgId: e.orgId,
      actorId: e.actor?.userId,
      actorEmail: e.actor?.email,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      diff: e.diff,
      ip: e.ip,
    },
  });
}

/** Field-level before/after diff for record updates. */
export function diffData(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) out[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return out;
}
