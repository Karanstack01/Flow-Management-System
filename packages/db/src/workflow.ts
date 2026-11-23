import {
  BusinessCalendar,
  CAPABILITIES,
  conditionGroupSchema,
  orgAccessError,
  workflowDefSchema,
  workflowSettingsSchema,
  type Capability,
  type Principal,
  type StageState,
  type StageStatus,
  type WorkflowDef,
  type WorkflowSettings,
} from '@fms/core';
import type { Group, PrismaClient, RecordStage, User, UserGroup } from '@prisma/client';

export interface LoadedWorkflow {
  id: string;
  orgId: string;
  key: string;
  name: string;
  version: number;
  isActive: boolean;
  def: WorkflowDef;
  settings: WorkflowSettings;
  calendar: BusinessCalendar;
  calendarId: string;
  /** Resolved option lists for fields that reference an option set. */
  options: Map<string, string[]>;
  /** False when the owning organization is suspended or its licence expired — automation must pause. */
  orgLive: boolean;
  isDraft: boolean;
  deletedAt: Date | null;
  /** Automation (hand-offs, reminders, webhooks) runs only for live, active, published flows. */
  automationLive: boolean;
}

/** Load and validate a workflow with its calendar and option sets. */
export async function loadWorkflow(db: PrismaClient, where: { orgId?: string; id?: string; key?: string }): Promise<LoadedWorkflow | null> {
  const row = await db.workflow.findFirst({
    where: { orgId: where.orgId, id: where.id, key: where.key },
    include: { calendar: { include: { holidays: true } }, org: { select: { isActive: true, licenseExpiresAt: true } } },
  });
  if (!row) return null;

  const def = workflowDefSchema.parse(row.definition);
  const settings = workflowSettingsSchema.parse(row.settings ?? {});
  const calendar = new BusinessCalendar({
    timezone: row.calendar.timezone,
    shiftStart: row.calendar.shiftStart,
    shiftEnd: row.calendar.shiftEnd,
    weeklyOff: row.calendar.weeklyOff,
    holidays: row.calendar.holidays.map((h) => h.date),
  });

  const setKeys = [...new Set(def.fields.map((f) => f.optionSetKey).filter((k): k is string => !!k))];
  const sets = setKeys.length ? await db.optionSet.findMany({ where: { orgId: row.orgId, key: { in: setKeys } } }) : [];
  const options = new Map<string, string[]>();
  for (const f of def.fields) {
    if (f.optionSetKey) options.set(f.key, sets.find((s) => s.key === f.optionSetKey)?.options ?? []);
  }

  return {
    id: row.id,
    orgId: row.orgId,
    key: row.key,
    name: row.name,
    version: row.version,
    isActive: row.isActive,
    def,
    settings,
    calendar,
    calendarId: row.calendarId,
    options,
    orgLive: orgAccessError(row.org) === null,
    isDraft: row.isDraft,
    deletedAt: row.deletedAt,
    // Inactive (read-only) flows hold their notifications too; the sweep delivers them on reactivation.
    automationLive: orgAccessError(row.org) === null && row.isActive && !row.isDraft && !row.deletedAt,
  };
}

type UserWithGroups = User & { groups: (UserGroup & { group: Group })[] };

/**
 * The organization a user is acting in. Regular users are pinned to their own
 * organization; a super admin may be "inside" another one (activeOrgId).
 */
export function effectiveOrgId(user: Pick<User, 'orgId' | 'isSuperAdmin' | 'activeOrgId'>): string {
  return user.isSuperAdmin && user.activeOrgId ? user.activeOrgId : user.orgId;
}

/**
 * Build the authorization principal for a user row (used by API auth and worker digests).
 * `orgId` is the organization being acted in; `homeOrgId` is where the user belongs.
 * Group memberships only count in the home organization. The worker passes the
 * workflow's organization explicitly so a visiting super admin still gets the
 * notifications of their home organization.
 */
export function principalFromUser(user: UserWithGroups, actingOrgId: string = effectiveOrgId(user)): Principal & { orgId: string; homeOrgId: string; name: string } {
  const orgId = actingOrgId;
  const inHome = orgId === user.orgId;
  const caps = new Set<Capability>();
  if (inHome) for (const ug of user.groups) for (const c of ug.group.capabilities) if ((CAPABILITIES as readonly string[]).includes(c)) caps.add(c as Capability);
  const rowFilter = inHome && user.rowFilter ? conditionGroupSchema.safeParse(user.rowFilter) : null;
  return {
    userId: user.id,
    orgId,
    homeOrgId: user.orgId,
    email: user.email,
    name: user.name,
    groups: inHome ? user.groups.map((ug) => ug.group.name.toUpperCase()) : [],
    capabilities: caps,
    rowFilter: rowFilter?.success ? rowFilter.data : null,
    isSuperAdmin: user.isSuperAdmin,
  };
}

/** Write only the stage rows that changed (upsert handles stages added to the definition later). */
export async function saveStageStates(
  tx: Pick<PrismaClient, 'recordStage'>,
  recordId: string,
  before: readonly StageState[],
  after: readonly StageState[],
  completedBy?: { stageKey: string; userId: string },
) {
  const prev = new Map(before.map((s) => [s.stageKey, s]));
  for (const s of after) {
    const p = prev.get(s.stageKey);
    const same = p && p.status === s.status && p.plannedAt?.getTime() === s.plannedAt?.getTime() && p.actualAt?.getTime() === s.actualAt?.getTime() && (p.round ?? 0) === (s.round ?? 0);
    if (same) continue;
    const reopened = (s.round ?? 0) > (p?.round ?? 0);
    const row = {
      status: s.status,
      plannedAt: s.plannedAt,
      actualAt: s.actualAt,
      round: s.round ?? 0,
      ...(reopened ? { completedById: null } : {}),
      ...(completedBy?.stageKey === s.stageKey ? { completedById: completedBy.userId } : {}),
    };
    await tx.recordStage.upsert({
      where: { recordId_stageKey: { recordId, stageKey: s.stageKey } },
      update: row,
      create: { recordId, stageKey: s.stageKey, ...row },
    });
  }
}

export function toStageStates(rows: readonly (Pick<RecordStage, 'stageKey' | 'status' | 'plannedAt' | 'actualAt'> & { round?: number })[]): StageState[] {
  return rows.map((r) => ({ stageKey: r.stageKey, status: r.status as StageStatus, plannedAt: r.plannedAt, actualAt: r.actualAt, ...(r.round ? { round: r.round } : {}) }));
}

/** Notification dedupe suffix: a stage reopened by a Stage Jump is new work and notifies again. */
export const roundSuffix = (round: number | undefined) => (round ? `:r${round}` : '');
