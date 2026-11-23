import { prisma, loadWorkflow, type LoadedWorkflow } from '@fms/db';
import { fieldAccess, hasCapability, isAdmin, isResponsibleFor, stageAccess, type Principal } from '@fms/core';
import { AppError } from './errors.js';

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; wf: LoadedWorkflow }>();

/**
 * Load a workflow of the caller's organization by id or key (short-lived cache).
 * Trashed flows are not found unless `includeTrashed` (flow management only).
 */
export async function getWorkflow(orgId: string, idOrKey: string, opts: { includeTrashed?: boolean } = {}): Promise<LoadedWorkflow> {
  const cacheKey = `${orgId}:${idOrKey}`;
  const hit = cache.get(cacheKey);
  let wf = hit && Date.now() - hit.at < TTL_MS ? hit.wf : null;
  if (!wf) {
    wf = (await loadWorkflow(prisma, { orgId, id: idOrKey })) ?? (await loadWorkflow(prisma, { orgId, key: idOrKey }));
    if (!wf) throw AppError.notFound('Workflow');
    cache.set(cacheKey, { at: Date.now(), wf });
  }
  if (wf.deletedAt && !opts.includeTrashed) throw AppError.notFound('Workflow');
  return wf;
}

/**
 * A workflow as a regular user may use it: drafts exist only for the people building them
 * (admins), so for everyone else a draft is "not found" — no records, reports or views.
 */
export async function workflowFor(p: Principal & { orgId: string }, idOrKey: string): Promise<LoadedWorkflow> {
  const wf = await getWorkflow(p.orgId, idOrKey);
  if (wf.isDraft && !isAdmin(p)) throw AppError.notFound('Workflow');
  return wf;
}

export function invalidateWorkflow() {
  cache.clear();
}

/** Definition as seen by one user: hidden/invisible fields removed, access flags attached. */
export function describeWorkflow(wf: LoadedWorkflow, p: Principal) {
  return {
    id: wf.id,
    key: wf.key,
    name: wf.name,
    version: wf.version,
    isActive: wf.isActive,
    isDraft: wf.isDraft,
    description: wf.def.description,
    timezone: wf.calendar.config.timezone,
    canCreate: hasCapability(p, 'CREATE'),
    canArchive: hasCapability(p, 'DELETE'),
    canExport: hasCapability(p, 'EXPORT'),
    stages: wf.def.stages.map((s, i) => {
      const access = stageAccess(s, p);
      return {
        key: s.key,
        name: s.name,
        color: s.color,
        responsibleGroups: s.responsibleGroups,
        plannedMode: s.planned.mode,
        completion: s.completion.kind,
        isMine: isResponsibleFor(s.responsibleGroups, p),
        /** Stage Access Control: may this user fill in / complete the stage? */
        canEdit: access.edit,
        description: s.description,
        video: s.video,
        headerColor: s.headerColor,
        lockAfterComplete: !!s.lockAfterComplete,
        singleUpdate: s.singleUpdate !== false,
        bulkUpdate: !!s.bulkUpdate,
        document: s.document ? { fieldKey: s.document.fieldKey, format: s.document.format, requireReview: s.document.requireReview } : null,
        ...(i === 0 ? { thankYou: s.showThankYou ? s.thankYouText || null : null, publicFormId: s.publicForm && isAdmin(p) ? (s.publicFormId ?? null) : null } : {}),
      };
    }),
    fields: wf.def.fields
      .filter((f) => !f.hidden)
      .map((f) => ({ field: f, access: fieldAccess(f, p, wf.def.stages) }))
      .filter((x) => x.access.view)
      .map(({ field: f, access }) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        stageKey: f.stageKey,
        required: f.required,
        unique: f.unique,
        searchKey: f.searchKey,
        frozen: f.frozen,
        lineItem: f.lineItem,
        options: wf.options.get(f.key) ?? f.options,
        dependsOn: f.dependsOn,
        optionMap: f.optionMap,
        width: f.width,
        helpText: f.helpText,
        placeholder: f.placeholder,
        defaultValue: f.defaultValue,
        allowMultiple: f.allowMultiple,
        canEdit: access.edit,
      })),
  };
}
export type WorkflowView = ReturnType<typeof describeWorkflow>;
