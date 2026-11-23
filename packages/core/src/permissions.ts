/**
 * Group-based access control — server-side replacement for the legacy client-side
 * editwright(): view/edit groups per field (Settings N/O), capability groups
 * (CREATE / DELETE / RUNSCRIPT) and per-user row filters (Settings X).
 *
 * Role ladder (legacy → new):
 *   CEOITBOX licence holder / owner of every FMS sheet  → SUPER ADMIN (platform, cross-organization)
 *   Sheet editor using the "CEOITBOX › Admin" menu       → ADMIN capability (one organization)
 *   Web-app user listed in Settings X:AC                  → group capabilities + field/row access
 *
 * Super admin is a per-user flag, never a group capability, so an organization
 * admin can not grant it by editing groups.
 */
import { evaluateGroup } from './conditions.js';
import type { ConditionGroup, FieldDef, RecordData, StageDef } from './schema.js';

export const CAPABILITIES = ['ADMIN', 'CREATE', 'DELETE', 'RUN_JOBS', 'EXPORT', 'MANAGE_RULES'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Principal {
  userId: string;
  email: string;
  /** Upper-cased group names. */
  groups: readonly string[];
  capabilities: ReadonlySet<Capability>;
  /** Restricts which records the user sees (legacy "col:value" in Settings X). */
  rowFilter?: ConditionGroup | null;
  /** Platform operator: every capability in every organization, bypasses field and row restrictions. */
  isSuperAdmin?: boolean;
}

export interface FieldAccess {
  view: boolean;
  edit: boolean;
}

const ALL = 'ALL';

export function isSuperAdmin(p: Principal): boolean {
  return p.isSuperAdmin === true;
}

export function isAdmin(p: Principal): boolean {
  return isSuperAdmin(p) || p.capabilities.has('ADMIN');
}

/** Capabilities as the client should see them (super admins hold all of them). */
export function effectiveCapabilities(p: Principal): Capability[] {
  return isSuperAdmin(p) ? [...CAPABILITIES] : [...p.capabilities];
}

/** Organization lifecycle: suspended or licence-expired organizations are closed to everyone but super admins. */
export interface OrgStatus {
  isActive: boolean;
  licenseExpiresAt?: Date | null;
}

export function orgAccessError(org: OrgStatus, now = new Date()): 'SUSPENDED' | 'LICENSE_EXPIRED' | null {
  if (!org.isActive) return 'SUSPENDED';
  if (org.licenseExpiresAt && org.licenseExpiresAt.getTime() < now.getTime()) return 'LICENSE_EXPIRED';
  return null;
}

export function hasCapability(p: Principal, cap: Capability): boolean {
  return isAdmin(p) || p.capabilities.has(cap);
}

function intersects(allowed: readonly string[], groups: readonly string[]): boolean {
  return allowed.includes(ALL) || allowed.some((g) => groups.includes(g));
}

/**
 * Stage Access Control: when a stage is restricted, only its listed users (and admins) see its
 * fields; Editors may also fill them in and complete the stage. Unrestricted stages allow everyone
 * (field and group rules still apply on top).
 */
export function stageAccess(stage: Pick<StageDef, 'stageAccessRestricted' | 'stageUsers'> | undefined, p: Principal): FieldAccess {
  if (!stage?.stageAccessRestricted || isAdmin(p)) return { view: true, edit: true };
  const me = p.email.toLowerCase();
  const entry = (stage.stageUsers ?? []).find((u) => u.email.toLowerCase() === me);
  return entry ? { view: true, edit: entry.role === 'Editor' } : { view: false, edit: false };
}

/** Field access; pass the workflow's stages so Stage Access Control applies too. */
export function fieldAccess(field: FieldDef, p: Principal, stages?: readonly StageDef[]): FieldAccess {
  const own = ownFieldAccess(field, p);
  if (!stages) return own;
  const s = stageAccess(stages.find((x) => x.key === field.stageKey), p);
  return { view: own.view && s.view, edit: own.edit && s.edit };
}

function ownFieldAccess(field: FieldDef, p: Principal): FieldAccess {
  if (isAdmin(p)) return { view: true, edit: field.type !== 'computed' };
  // "Allow only assigned users": the per-field user list replaces the group rules.
  if (field.fieldAccessRestricted) {
    const me = p.email.toLowerCase();
    const entry = (field.fieldUsers ?? []).find((u) => u.email.toLowerCase() === me);
    if (!entry) return { view: false, edit: false };
    return { view: true, edit: entry.role === 'Editor' && field.type !== 'computed' };
  }
  const edit = field.type !== 'computed' && intersects(field.editGroups, p.groups);
  const view = edit || intersects(field.viewGroups, p.groups);
  return { view, edit };
}

export function visibleFieldKeys(fields: readonly FieldDef[], p: Principal, stages?: readonly StageDef[]): Set<string> {
  return new Set(fields.filter((f) => !f.hidden && fieldAccess(f, p, stages).view).map((f) => f.key));
}

export function editableFieldKeys(fields: readonly FieldDef[], p: Principal, stages?: readonly StageDef[]): Set<string> {
  return new Set(fields.filter((f) => !f.hidden && fieldAccess(f, p, stages).edit).map((f) => f.key));
}

/** Strip every field the principal may not see. Never send unprojected data to a client. */
export function projectData(data: RecordData, visible: ReadonlySet<string>): RecordData {
  const out: RecordData = {};
  for (const [k, v] of Object.entries(data)) if (visible.has(k)) out[k] = v;
  return out;
}

export function canSeeRecord(p: Principal, data: RecordData): boolean {
  if (isAdmin(p) || !p.rowFilter) return true;
  return evaluateGroup(p.rowFilter, data);
}

/** A user is responsible for a stage when they belong to one of its groups. */
export function isResponsibleFor(stageGroups: readonly string[], p: Principal): boolean {
  return isAdmin(p) || intersects(stageGroups, p.groups);
}
