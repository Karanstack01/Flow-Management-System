import { describe, expect, it } from 'vitest';
import {
  computeTimeline,
  canTransitionStage,
  assertStageTransition,
  computeRecordLifecycle,
  type StageState,
} from '../src/index.js';
import { calendar, fmt, ist, orderWorkflow } from './fixtures.js';

const stages = orderWorkflow.stages;
const byKey = (states: StageState[], key: string) => states.find((s) => s.stageKey === key)!;

function create(data: Record<string, unknown>, at = ist('2026-01-22T10:00')) {
  return computeTimeline({ stages, data: data as never, createdAt: at, now: at, calendar });
}

describe('computeTimeline', () => {
  it('on create: intake done, approval active with TAT plan, rest waiting', () => {
    const r = create({ customer: 'Acme', priority: 'Urgent' });
    expect(byKey(r.states, 'intake')).toMatchObject({ status: 'done' });
    expect(fmt(byKey(r.states, 'intake').actualAt)).toBe('2026-01-22 10:00');
    expect(byKey(r.states, 'approval').status).toBe('active');
    expect(fmt(byKey(r.states, 'approval').plannedAt)).toBe('2026-01-22 14:00');
    expect(byKey(r.states, 'dispatch')).toMatchObject({ status: 'waiting', plannedAt: null });
    expect(r.currentStageKey).toBe('approval');
    expect(r.events).toEqual([{ type: 'stage_activated', stageKey: 'approval', plannedAt: byKey(r.states, 'approval').plannedAt }]);
  });

  it('auto-completes a condition stage and plans the next one from the actual time', () => {
    const first = create({ customer: 'Acme', priority: 'Urgent' });
    const now = ist('2026-01-22T15:00');
    const r = computeTimeline({
      stages,
      data: { customer: 'Acme', priority: 'Urgent', approved: true },
      createdAt: ist('2026-01-22T10:00'),
      now,
      calendar,
      previous: first.states,
    });
    expect(byKey(r.states, 'approval')).toMatchObject({ status: 'done', actualAt: now });
    // Urgent = 2h from 15:00
    expect(fmt(byKey(r.states, 'dispatch').plannedAt)).toBe('2026-01-22 17:00');
    expect(r.events).toContainEqual({ type: 'stage_completed', stageKey: 'approval', actualAt: now, onTime: false });
    expect(r.events.some((e) => e.type === 'stage_activated' && e.stageKey === 'dispatch')).toBe(true);
  });

  it('uses the default TAT when the keyed value is not mapped', () => {
    const first = create({ priority: 'Low' });
    const r = computeTimeline({
      stages,
      data: { priority: 'Low', approved: true },
      createdAt: ist('2026-01-22T10:00'),
      now: ist('2026-01-22T11:00'),
      calendar,
      previous: first.states,
    });
    // default 8h from Thu 11:00 → 7h Thu + 1h Fri
    expect(fmt(byKey(r.states, 'dispatch').plannedAt)).toBe('2026-01-23 10:00');
  });

  it('keeps planned times stable unless replan is requested', () => {
    const first = create({ priority: 'Urgent', approved: true });
    expect(fmt(byKey(first.states, 'dispatch').plannedAt)).toBe('2026-01-22 12:00');
    const later = { stages, data: { priority: 'Normal', approved: true }, createdAt: ist('2026-01-22T10:00'), now: ist('2026-01-22T11:00'), calendar, previous: first.states } as const;
    expect(fmt(byKey(computeTimeline(later).states, 'dispatch').plannedAt)).toBe('2026-01-22 12:00');
    // Normal = 16h from approval at 10:00 → 8h Thu + 8h Fri → Fri 17:00
    expect(fmt(byKey(computeTimeline({ ...later, replan: true }).states, 'dispatch').plannedAt)).toBe('2026-01-23 17:00');
  });

  it('skips non-applicable stages and finishes the flow', () => {
    const data = { priority: 'Urgent', approved: true, needs_qc: false };
    const first = create(data);
    const dispatchedAt = ist('2026-01-22T11:30');
    const previous = first.states.map((s) => (s.stageKey === 'dispatch' ? { ...s, actualAt: dispatchedAt } : s));
    const r = computeTimeline({ stages, data, createdAt: ist('2026-01-22T10:00'), now: ist('2026-01-22T12:00'), calendar, previous });
    expect(byKey(r.states, 'dispatch')).toMatchObject({ status: 'done', actualAt: dispatchedAt });
    expect(byKey(r.states, 'qc')).toMatchObject({ status: 'skipped', plannedAt: null });
    expect(r.currentStageKey).toBeNull();
    expect(r.events).toContainEqual({ type: 'stage_completed', stageKey: 'dispatch', actualAt: dispatchedAt, onTime: true });
  });

  it('activates a conditional stage when applicable', () => {
    const data = { priority: 'Urgent', approved: true, needs_qc: true };
    const first = create(data);
    const previous = first.states.map((s) => (s.stageKey === 'dispatch' ? { ...s, actualAt: ist('2026-01-22T11:00') } : s));
    const r = computeTimeline({ stages, data, createdAt: ist('2026-01-22T10:00'), now: ist('2026-01-22T11:00'), calendar, previous });
    expect(byKey(r.states, 'qc').status).toBe('active');
    expect(fmt(byKey(r.states, 'qc').plannedAt)).toBe('2026-01-22 13:00');
  });

  it('is idempotent: recomputing with no change emits no events', () => {
    const first = create({ priority: 'Urgent' });
    const again = computeTimeline({ stages, data: { priority: 'Urgent' }, createdAt: ist('2026-01-22T10:00'), now: ist('2026-01-22T13:00'), calendar, previous: first.states });
    expect(again.events).toEqual([]);
    expect(again.states).toEqual(first.states);
  });

  describe('canTransitionStage & assertStageTransition (Stage Lifecycle Machine)', () => {
    it('allows valid transitions', () => {
      expect(canTransitionStage('waiting', 'active', 'reach').allowed).toBe(true);
      expect(canTransitionStage('waiting', 'skipped', 'skip').allowed).toBe(true);
      expect(canTransitionStage('active', 'done', 'complete').allowed).toBe(true);
      expect(canTransitionStage('done', 'waiting', 'reopen').allowed).toBe(true);
      expect(canTransitionStage('skipped', 'active', 'reactivate').allowed).toBe(true);
      expect(canTransitionStage('active', 'waiting', 'revert').allowed).toBe(true);
    });

    it('rejects invalid or illegal transitions', () => {
      expect(canTransitionStage('waiting', 'done').allowed).toBe(false);
      expect(canTransitionStage('done', 'skipped').allowed).toBe(false);
      expect(canTransitionStage('skipped', 'done').allowed).toBe(false);
      expect(() => assertStageTransition('waiting', 'done')).toThrow();
    });
  });

  describe('computeRecordLifecycle (Record Overall Lifecycle Machine)', () => {
    it('returns active when record has current stage and not completed/archived', () => {
      expect(computeRecordLifecycle({ currentStageKey: 'approval', completedAt: null, archivedAt: null })).toBe('active');
    });

    it('returns completed when completedAt is set or no current stage key', () => {
      expect(computeRecordLifecycle({ currentStageKey: null, completedAt: '2026-01-22T15:00:00Z', archivedAt: null })).toBe('completed');
      expect(computeRecordLifecycle({ currentStageKey: null, completedAt: null, archivedAt: null })).toBe('completed');
    });

    it('returns archived when archivedAt is set, regardless of stage/completed status', () => {
      expect(computeRecordLifecycle({ currentStageKey: 'approval', completedAt: null, archivedAt: '2026-01-22T16:00:00Z' })).toBe('archived');
      expect(computeRecordLifecycle({ currentStageKey: null, completedAt: '2026-01-22T15:00:00Z', archivedAt: '2026-01-22T16:00:00Z' })).toBe('archived');
    });
  });
});
