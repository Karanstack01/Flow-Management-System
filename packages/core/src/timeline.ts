/**
 * Stage timeline engine — replaces legacy planningtime() + timestamp() + the
 * "planned set & actual empty" current-stage logic used by every report.
 *
 * Pure function: given the workflow stages, record data and the previous stage
 * states, returns the new states plus the events that happened (used by the API
 * to enqueue hand-off notifications). Run it inside the same DB transaction as
 * every record write, and periodically from the worker.
 *
 * Rules
 *  - Stages are sequential. Stage 1 (intake) is done at creation.
 *  - A stage is *reached* when every earlier non-skipped stage is done.
 *  - On reach: if its own condition or a branch guard does not hold, or a done
 *    stage before it jumped past it, the stage is skipped; otherwise it is active
 *    and its planned time is computed (TAT) once and then kept stable unless
 *    `replan` is set.
 *  - Completion: on_create | manual (actualAt supplied by the caller) |
 *    conditions (auto-stamped with `now` when the condition group holds).
 *  - Recorded actual times are never erased — except by a backward Stage Jump,
 *    which reopens a range of stages for another round (rework).
 */
import { DateTime } from 'luxon';
import type { BusinessCalendar } from './calendar.js';
import { evaluateGroup } from './conditions.js';
import { normalizeGuard, type RecordData, type StageDef, type SwitchGuard, type TatRule, type TimeBase } from './schema.js';

export type StageStatus = 'waiting' | 'active' | 'done' | 'skipped';

export type StageTransitionAction =
  | 'reach'
  | 'complete'
  | 'skip'
  | 'reopen'
  | 'reactivate'
  | 'revert'
  | 'noop';

export interface StageTransitionCheck {
  allowed: boolean;
  reason?: string;
}

/** Explicit transition map for stage lifecycle */
export const ALLOWED_STAGE_TRANSITIONS: Record<StageStatus, readonly StageStatus[]> = {
  waiting: ['waiting', 'active', 'skipped'],
  active: ['active', 'done', 'skipped', 'waiting'],
  done: ['done', 'waiting'], // 'waiting' happens during backward jump / rework
  skipped: ['skipped', 'active', 'waiting'],
};

/**
 * Formal transition guard function for RecordStage lifecycle state machine.
 * Prevents illegal / impossible transitions across the workflow lifecycle.
 */
export function canTransitionStage(
  from: StageStatus,
  to: StageStatus,
  action: StageTransitionAction = 'noop',
): StageTransitionCheck {
  if (from === to) return { allowed: true };

  const allowedTargets = ALLOWED_STAGE_TRANSITIONS[from];
  if (!allowedTargets.includes(to)) {
    return {
      allowed: false,
      reason: `Illegal stage transition from '${from}' to '${to}' (action: ${action})`,
    };
  }

  // Guard specific actions
  switch (action) {
    case 'complete':
      if (to !== 'done') {
        return { allowed: false, reason: `Action 'complete' can only transition to 'done', not '${to}'` };
      }
      break;
    case 'reopen':
      if (from !== 'done' && from !== 'active' && from !== 'skipped') {
        return { allowed: false, reason: `Action 'reopen' cannot be applied to stage in '${from}' status` };
      }
      if (to !== 'waiting') {
        return { allowed: false, reason: `Action 'reopen' can only transition to 'waiting', not '${to}'` };
      }
      break;
    case 'revert':
      if (from !== 'active' && from !== 'skipped') {
        return { allowed: false, reason: `Action 'revert' can only revert 'active' or 'skipped' stages to 'waiting'` };
      }
      if (to !== 'waiting') {
        return { allowed: false, reason: `Action 'revert' can only transition to 'waiting', not '${to}'` };
      }
      break;
    case 'skip':
      if (to !== 'skipped') {
        return { allowed: false, reason: `Action 'skip' can only transition to 'skipped', not '${to}'` };
      }
      break;
    case 'reactivate':
      if (from !== 'skipped') {
        return { allowed: false, reason: `Action 'reactivate' can only reactivate 'skipped' stages` };
      }
      if (to !== 'active') {
        return { allowed: false, reason: `Action 'reactivate' can only transition to 'active', not '${to}'` };
      }
      break;
    default:
      break;
  }

  return { allowed: true };
}

export function assertStageTransition(
  from: StageStatus,
  to: StageStatus,
  action: StageTransitionAction = 'noop',
): void {
  const check = canTransitionStage(from, to, action);
  if (!check.allowed) {
    throw new Error(check.reason);
  }
}

/** Record overall lifecycle state */
export type RecordLifecycleStatus = 'active' | 'completed' | 'archived';

export interface RecordLifecycleInput {
  currentStageKey?: string | null;
  completedAt?: Date | string | null;
  archivedAt?: Date | string | null;
}

/**
 * Deterministically computes overall record lifecycle state from timestamps and current stage.
 */
export function computeRecordLifecycle(input: RecordLifecycleInput): RecordLifecycleStatus {
  if (input.archivedAt) return 'archived';
  if (input.completedAt || !input.currentStageKey) return 'completed';
  return 'active';
}

/** A switch guard holds when the first matching case is the one this stage belongs to. */
export function guardHolds(g: SwitchGuard, data: RecordData): boolean {
  const hit = g.cases.findIndex((c) => evaluateGroup(c, data));
  return g.take === 'else' ? hit === -1 : hit === g.take;
}

/** A stage applies when its own condition and every Depends-on branch guard on its path hold. */
export function stageApplies(stage: Pick<StageDef, 'applicableWhen' | 'guards'>, data: RecordData): boolean {
  if (stage.applicableWhen && !evaluateGroup(stage.applicableWhen, data)) return false;
  return (stage.guards ?? []).every((g) => guardHolds(normalizeGuard(g), data));
}

/** A backward jump stops reopening after this many rounds (protects against endless rework loops). */
export const MAX_ROUNDS = 20;

export interface StageState {
  stageKey: string;
  status: StageStatus;
  plannedAt: Date | null;
  actualAt: Date | null;
  /** Rework round: 0 the first time, +1 each time a backward jump reopens the stage. */
  round?: number;
}

export type TimelineEvent =
  | { type: 'stage_activated'; stageKey: string; plannedAt: Date | null }
  | { type: 'stage_completed'; stageKey: string; actualAt: Date; onTime: boolean | null }
  | { type: 'stage_skipped'; stageKey: string }
  | { type: 'stage_jumped'; stageKey: string; to: string; direction: 'forward' | 'back' }
  | { type: 'stage_reopened'; stageKey: string; round: number };

export interface TimelineInput {
  stages: readonly StageDef[];
  data: RecordData;
  createdAt: Date;
  now: Date;
  calendar: BusinessCalendar;
  previous?: readonly StageState[];
  /** Recompute planned times even if already set (admin "re-plan"). */
  replan?: boolean;
}

export interface TimelineResult {
  states: StageState[];
  events: TimelineEvent[];
  /** Key of the first stage that is active, or null when all done/skipped. */
  currentStageKey: string | null;
  /** Fields a backward jump cleared — the caller must save them into the record data. */
  dataPatch?: Record<string, null>;
}

export function resolveTatHours(rule: TatRule, data: RecordData): number | null {
  if (rule.kind === 'fixed') return rule.hours;
  const raw = data[rule.field];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key !== undefined && key !== null) {
    const wanted = String(key).trim().toLowerCase();
    for (const [k, hours] of Object.entries(rule.map)) {
      if (k.trim().toLowerCase() === wanted) return hours;
    }
  }
  return rule.defaultHours ?? null;
}

export function parseFieldDate(value: unknown, timezone: string): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const dt = DateTime.fromISO(value.trim(), { zone: timezone });
  return dt.isValid ? dt.toJSDate() : null;
}

function resolveBase(base: TimeBase, input: TimelineInput, previousDoneAt: Date): Date | null {
  switch (base.kind) {
    case 'previous_stage':
      return previousDoneAt;
    case 'created':
      return input.createdAt;
    case 'field':
      return parseFieldDate(input.data[base.field], input.calendar.config.timezone);
  }
}

function pass(input: TimelineInput): TimelineResult {
  const prevByKey = new Map((input.previous ?? []).map((s) => [s.stageKey, s]));
  const indexOf = new Map(input.stages.map((s, i) => [s.key, i]));
  const states: StageState[] = [];
  const events: TimelineEvent[] = [];
  let previousDoneAt: Date = input.createdAt;
  let blocked = false;

  // A done stage with a forward jump whose condition holds skips everything up to its target.
  const jumpedOver = (index: number) =>
    states.some((st, i) => {
      if (st.status !== 'done') return false;
      return (input.stages[i]!.jumps ?? []).some((j) => {
        const t = indexOf.get(j.to);
        return t !== undefined && t > index && i < index && evaluateGroup(j.when, input.data);
      });
    });

  // A skip is final once the flow has moved past it: a later stage was reached, or the record is
  // finished. Otherwise editing a field could re-activate an earlier stage, push the current stage
  // back to "waiting" and wipe its plan — silently, with no event (the old "stage regression").
  // Legacy FMS behaved the same way: conditional stages were decided once, when reached.
  const prevStatuses = input.stages.map((s) => prevByKey.get(s.key)?.status);
  const finished = (input.previous?.length ?? 0) > 0 && prevStatuses.every((st) => st === 'done' || st === 'skipped');
  const movedPast = (index: number) => finished || prevStatuses.slice(index + 1).some((st) => st === 'active' || st === 'done');

  input.stages.forEach((stage, index) => {
    const prev = prevByKey.get(stage.key);
    const prevStatus = prev?.status;
    let plannedAt = prev?.plannedAt ?? null;
    let actualAt = prev?.actualAt ?? null;
    const round = prev?.round ?? 0;
    let status: StageStatus;

    if (index === 0) {
      actualAt ??= input.createdAt;
      status = 'done';
    } else if (blocked) {
      // Not reached yet. Keep historic actuals, drop speculative plans.
      status = actualAt ? 'done' : 'waiting';
      if (!actualAt) plannedAt = null;
    } else if (!actualAt && (!stageApplies(stage, input.data) || jumpedOver(index) || (prevStatus === 'skipped' && movedPast(index)))) {
      status = 'skipped';
      plannedAt = null;
    } else {
      if (stage.planned.mode === 'tat' && (plannedAt === null || input.replan) && !actualAt) {
        const base = resolveBase(stage.planned.base, input, previousDoneAt);
        const hours = resolveTatHours(stage.planned.tat, input.data);
        plannedAt = base && hours !== null ? input.calendar.addWorkingHours(base, hours) : null;
      } else if (stage.planned.mode === 'none') {
        plannedAt = null;
      }
      if (!actualAt && stage.completion.kind === 'conditions' && evaluateGroup(stage.completion.when, input.data)) {
        actualAt = input.now;
      }
      status = actualAt ? 'done' : 'active';
    }

    if (status === 'done') previousDoneAt = actualAt!;
    else if (status !== 'skipped') blocked = true;

    if (status !== prevStatus) {
      if (prevStatus) {
        assertStageTransition(prevStatus, status);
      }
      if (status === 'active') events.push({ type: 'stage_activated', stageKey: stage.key, plannedAt });
      if (status === 'skipped') events.push({ type: 'stage_skipped', stageKey: stage.key });
      if (status === 'done' && index > 0) {
        events.push({
          type: 'stage_completed',
          stageKey: stage.key,
          actualAt: actualAt!,
          onTime: plannedAt ? actualAt!.getTime() <= plannedAt.getTime() : null,
        });
        for (const j of stage.jumps ?? []) {
          const t = indexOf.get(j.to);
          if (t !== undefined && t > index && evaluateGroup(j.when, input.data)) events.push({ type: 'stage_jumped', stageKey: stage.key, to: j.to, direction: 'forward' });
        }
      }
    }
    states.push({ stageKey: stage.key, status, plannedAt, actualAt, ...(round ? { round } : {}) });
  });

  return { states, events, currentStageKey: states.find((s) => s.status === 'active')?.stageKey ?? null };
}

export function computeTimeline(input: TimelineInput): TimelineResult {
  const first = pass(input);
  const prevByKey = new Map((input.previous ?? []).map((s) => [s.stageKey, s]));

  // Backward jump (rework): fires once, when its stage becomes done in this computation.
  for (let i = 1; i < input.stages.length; i++) {
    const stage = input.stages[i]!;
    const now = first.states[i]!;
    if (now.status !== 'done' || prevByKey.get(stage.key)?.status === 'done') continue;
    const jump = (stage.jumps ?? []).find((j) => {
      const t = input.stages.findIndex((s) => s.key === j.to);
      return t > 0 && t < i && evaluateGroup(j.when, input.data);
    });
    if (!jump) continue;
    const target = input.stages.findIndex((s) => s.key === jump.to);
    const round = Math.max(...first.states.slice(target, i + 1).map((s) => s.round ?? 0)) + 1;
    if (round > MAX_ROUNDS) continue; // give up silently rather than loop forever

    // Reopen target … this stage; stages after it go back to their state before this change.
    const reopened: StageState[] = first.states.map((s, k) => {
      if (k < target) return s;
      if (k <= i) return { stageKey: s.stageKey, status: 'waiting', plannedAt: null, actualAt: null, round };
      return prevByKey.get(s.stageKey) ?? { stageKey: s.stageKey, status: 'waiting', plannedAt: null, actualAt: null };
    });
    const dataPatch = Object.fromEntries(jump.clearFields.map((f) => [f, null])) as Record<string, null>;
    // Re-run without back-jumps so a still-true condition can not loop within one computation.
    const second = pass({ ...input, stages: input.stages.map((s) => ({ ...s, jumps: s.jumps?.filter((j) => input.stages.findIndex((x) => x.key === j.to) > input.stages.indexOf(s)) })), data: { ...input.data, ...dataPatch }, previous: reopened });

    const events: TimelineEvent[] = [
      ...first.events.filter((e) => {
        const k = input.stages.findIndex((s) => s.key === e.stageKey);
        return k < target || (k === i && e.type === 'stage_completed');
      }),
      { type: 'stage_jumped', stageKey: stage.key, to: jump.to, direction: 'back' },
      ...input.stages.slice(target, i + 1).map((s) => ({ type: 'stage_reopened' as const, stageKey: s.key, round })),
      ...second.events,
    ];
    return { states: second.states, events, currentStageKey: second.currentStageKey, ...(Object.keys(dataPatch).length ? { dataPatch } : {}) };
  }
  return first;
}
