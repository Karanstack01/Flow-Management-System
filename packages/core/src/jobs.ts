/** Queue contract shared by the API (producer) and the worker (consumer). */
export const QUEUE_NAME = 'fms';

export const JOBS = {
  /** A record changed: dispatch hand-offs, rule notifications and webhooks for it. */
  recordChanged: 'record-changed',
  /** Periodic: recompute timelines (condition stages), catch missed hand-offs. */
  sweep: 'sweep',
  /** Periodic: upcoming-due reminders and stage_overdue rules. */
  reminders: 'reminders',
  /** Hourly tick: daily overdue digest + summary report at their configured hours. */
  digests: 'digests',
  /** Periodic: auto-archive finished records. */
  archive: 'archive',
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Jobs an admin with RUN_JOBS may trigger manually (legacy op_runfun). */
export const MANUAL_JOBS: readonly JobName[] = [JOBS.sweep, JOBS.reminders, JOBS.digests, JOBS.archive];

export interface RecordChangedPayload {
  recordId: string;
}

/**
 * Payload of a periodic job. Scheduled runs have no orgId and cover every live
 * organization. A manual run by an organization admin is pinned to that
 * organization; only a super admin may run a job platform-wide.
 */
export interface PeriodicJobPayload {
  manual?: boolean;
  requestedBy?: string;
  orgId?: string;
}
