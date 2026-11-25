import { DateTime } from 'luxon';
import { canSeeRecord, worksOnStage, type RecordData, type StageDef } from '@fms/core';
import { loadWorkflow, prisma, principalFromUser, type LoadedWorkflow } from '@fms/db';
import type { Channels } from './channels.js';
import type { WorkerConfig } from './config.js';
import { stageWorkers, type Recipient } from './notify.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface JobContext {
  cfg: WorkerConfig;
  /** The organization's own email / WhatsApp connections, or the server defaults. */
  channelsFor(orgId: string): Promise<Channels>;
  log: Logger;
  /** Set for a manual run pinned to one organization; unset = every live organization. */
  orgId?: string;
}

const cache = new Map<string, { at: number; wf: LoadedWorkflow }>();

export async function workflowById(id: string): Promise<LoadedWorkflow | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.wf;
  const wf = await loadWorkflow(prisma, { id });
  if (wf) cache.set(id, { at: Date.now(), wf });
  return wf;
}

/** Active workflows of live organizations (suspended / licence-expired organizations are skipped). */
export async function activeWorkflows(orgId?: string): Promise<LoadedWorkflow[]> {
  const rows = await prisma.workflow.findMany({ where: { isActive: true, isDraft: false, deletedAt: null, ...(orgId ? { orgId } : {}) }, select: { id: true } });
  const out: LoadedWorkflow[] = [];
  for (const r of rows) {
    const wf = await workflowById(r.id);
    if (wf?.automationLive) out.push(wf);
  }
  return out;
}

/**
 * The people who work on this stage (its owner groups, or its assigned Editors when Stage Access
 * Control is on) and are allowed to see this record (row filters respected).
 */
export async function stageRecipients(wf: LoadedWorkflow, stage: StageDef, data: RecordData): Promise<Recipient[]> {
  const users = await stageWorkers(wf.orgId, [stage]);
  return users
    .map((u) => ({ u, p: principalFromUser(u, wf.orgId) }))
    .filter(({ p }) => worksOnStage(stage, p) && canSeeRecord(p, data))
    .map(({ u }) => ({ userId: u.id, email: u.email, phone: u.phone }));
}

export const recordUrl = (cfg: WorkerConfig, wf: LoadedWorkflow, recordId: string) => `${cfg.APP_URL.replace(/\/$/, '')}/w/${wf.key}/records/${recordId}`;

export const fmtTime = (wf: LoadedWorkflow, d: Date | null) => (d ? DateTime.fromJSDate(d).setZone(wf.calendar.config.timezone).toFormat('dd LLL yyyy, HH:mm') : '—');

/** Should time-based notifications go out right now for this workflow? */
export function isQuietDay(wf: LoadedWorkflow, now = new Date()) {
  return !wf.settings.sendOnHolidays && !wf.calendar.isWorkingDay(now);
}
