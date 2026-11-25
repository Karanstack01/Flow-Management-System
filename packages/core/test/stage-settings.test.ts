import { describe, expect, it } from 'vitest';
import { canActOnStage, canvasFromDefinition, compileCanvas, computeTimeline, fieldAccess, normalizeDocumentStages, reconcileCanvas, stageAccess, visibleFieldKeys, workflowDefSchema, workflowSettingsSchema, worksOnStage, type Principal, type WorkflowDefInput } from '../src/index.js';
import { calendar, ist, orderWorkflowInput } from './fixtures.js';

const settings = workflowSettingsSchema.parse({});
const user = (email: string, admin = false): Principal => ({ userId: 'u', email, groups: ['MANAGER'], capabilities: new Set(admin ? ['ADMIN'] : []) });

/** Intake → Quote (document) → Dispatch. */
const withDocument = (requireReview: boolean): WorkflowDefInput => ({
  key: 'quotes',
  name: 'Quotes',
  stages: [
    { key: 'intake', name: 'Enquiry', completion: { kind: 'on_create' } },
    { key: 'quote', name: 'Quote', document: { fieldKey: 'quote_pdf', requireReview, body: '<p>Quote for {{customer}}</p>' } },
    { key: 'dispatch', name: 'Dispatch' },
  ],
  fields: [
    { key: 'customer', label: 'Customer', type: 'text', stageKey: 'intake' },
    { key: 'quote_pdf', label: 'Quote PDF', type: 'file', stageKey: 'quote', editGroups: [] },
  ],
});

describe('document steps', () => {
  it('become Document nodes on the canvas and compile back to a stage that waits for the file', () => {
    const def = workflowDefSchema.parse(withDocument(false));
    const canvas = canvasFromDefinition(def, settings);
    expect(canvas.nodes.find((n) => n.id === 'stage-quote')?.type).toBe('document');
    const compiled = compileCanvas(canvas, def, settings);
    expect(compiled.errors).toEqual([]);
    const quote = compiled.definition!.stages[1]!;
    expect(quote.completion).toEqual({ kind: 'conditions', when: { mode: 'all', conditions: [{ field: 'quote_pdf', op: 'not_empty' }] } });
    expect(compiled.definition!.fields.find((f) => f.key === 'quote_pdf')?.required).toBe(true);
    // Round trip: the stored canvas is kept as is.
    expect(reconcileCanvas(canvas, compiled.definition!, settings).nodes.map((n) => n.type)).toEqual(canvas.nodes.map((n) => n.type));
  });

  it('with review on, the step waits for "Mark done" even after the file exists', () => {
    const def = workflowDefSchema.parse(withDocument(true));
    const compiled = compileCanvas(canvasFromDefinition(def, settings), def, settings);
    expect(compiled.definition!.stages[1]!.completion).toEqual({ kind: 'manual' });

    const auto = compileCanvas(canvasFromDefinition(workflowDefSchema.parse(withDocument(false)), settings), workflowDefSchema.parse(withDocument(false)), settings).definition!;
    const t0 = ist('2026-01-22T10:00');
    const before = computeTimeline({ stages: auto.stages, data: {}, createdAt: t0, now: t0, calendar });
    expect(before.currentStageKey).toBe('quote');
    const after = computeTimeline({ stages: auto.stages, data: { quote_pdf: ['file1'] }, createdAt: t0, now: t0, calendar, previous: before.states });
    expect(after.currentStageKey).toBe('dispatch');
  });

  it('needs a file field of its own stage, and the intake form can not be one', () => {
    const bad = withDocument(false);
    bad.fields = bad.fields.map((f) => (f.key === 'quote_pdf' ? { ...f, stageKey: 'intake' } : f));
    expect(workflowDefSchema.safeParse(bad).success).toBe(false);
    const intakeDoc = withDocument(false);
    intakeDoc.stages = intakeDoc.stages.map((s, i) => (i === 0 ? { ...s, document: { fieldKey: 'quote_pdf' } } : s));
    expect(workflowDefSchema.safeParse(intakeDoc).success).toBe(false);
  });

  it('old placeholder Document nodes (no stage) are only a warning', () => {
    const def = workflowDefSchema.parse(withDocument(false));
    const canvas = canvasFromDefinition(def, settings);
    canvas.nodes.push({ id: 'doc-old', type: 'document', x: 0, y: 600, data: {} });
    const compiled = compileCanvas(canvas, def, settings);
    expect(compiled.errors).toEqual([]);
    expect(compiled.warnings.some((w) => w.nodeId === 'doc-old')).toBe(true);
  });
});

describe('state machine decisions', () => {
  it('a skipped stage stays skipped once the flow has moved past it (no silent regression)', () => {
    const def = workflowDefSchema.parse(orderWorkflowInput);
    const t0 = ist('2026-01-22T10:00');
    // QC (the last stage) only applies when needs_qc is ticked: approve and dispatch without it.
    let t = computeTimeline({ stages: def.stages, data: { approved: true }, createdAt: t0, now: t0, calendar });
    t = computeTimeline({ stages: def.stages, data: { approved: true }, createdAt: t0, now: t0, calendar, previous: t.states.map((s) => (s.stageKey === 'dispatch' ? { ...s, actualAt: t0 } : s)) });
    expect(t.currentStageKey).toBeNull();
    expect(t.states.find((s) => s.stageKey === 'qc')?.status).toBe('skipped');
    // Ticking needs_qc afterwards no longer re-opens the finished record.
    const later = computeTimeline({ stages: def.stages, data: { approved: true, needs_qc: true }, createdAt: t0, now: t0, calendar, previous: t.states });
    expect(later.currentStageKey).toBeNull();
    expect(later.events).toEqual([]);
  });

  it('a back-jump that reopens a document step clears its file so it is generated again', () => {
    const input = withDocument(false);
    input.stages = input.stages.map((s) => (s.key === 'dispatch' ? { ...s, jumps: [{ when: { mode: 'all', conditions: [{ field: 'customer', op: 'eq', value: 'redo' }] }, to: 'quote', clearFields: [] }] } : s));
    const def = normalizeDocumentStages(workflowDefSchema.parse(input));
    expect(def.stages.find((s) => s.key === 'dispatch')!.jumps![0]!.clearFields).toEqual(['quote_pdf']);
  });

  it('assigned Editors replace the owner groups of a restricted stage', () => {
    const stage = { responsibleGroups: ['MANAGER'], stageAccessRestricted: true, stageUsers: [{ email: 'ed@x.com', role: 'Editor' as const }, { email: 'vi@x.com', role: 'Viewer' as const }] };
    expect(worksOnStage(stage, user('ed@x.com'))).toBe(true);
    expect(worksOnStage(stage, user('vi@x.com'))).toBe(false);
    expect(worksOnStage(stage, user('manager@x.com'))).toBe(false); // in MANAGER, but not assigned
    expect(worksOnStage({ ...stage, stageAccessRestricted: false }, user('manager@x.com'))).toBe(true);
    expect(canActOnStage(stage, user('boss@x.com', true))).toBe(true);
    expect(canActOnStage({ responsibleGroups: [] }, user('anyone@x.com'))).toBe(true);
  });
});

describe('stage settings', () => {
  const def = workflowDefSchema.parse({
    ...orderWorkflowInput,
    stages: orderWorkflowInput.stages.map((s) => (s.key === 'approval' ? { ...s, stageAccessRestricted: true, stageUsers: [{ email: 'Boss@x.com', role: 'Editor' }, { email: 'viewer@x.com', role: 'Viewer' }] } : s)),
  });
  const approval = def.stages.find((s) => s.key === 'approval')!;
  const approved = def.fields.find((f) => f.key === 'approved')!;

  it('Stage Access Control limits who sees and fills in the stage', () => {
    expect(stageAccess(approval, user('boss@x.com'))).toEqual({ view: true, edit: true });
    expect(stageAccess(approval, user('viewer@x.com'))).toEqual({ view: true, edit: false });
    expect(stageAccess(approval, user('other@x.com'))).toEqual({ view: false, edit: false });
    expect(stageAccess(approval, user('other@x.com', true))).toEqual({ view: true, edit: true });
    expect(fieldAccess(approved, user('viewer@x.com'), def.stages)).toEqual({ view: true, edit: false });
    expect(visibleFieldKeys(def.fields, user('other@x.com'), def.stages).has('approved')).toBe(false);
    expect(visibleFieldKeys(def.fields, user('other@x.com'), def.stages).has('customer')).toBe(true);
  });

  it('only the intake form can be public; videos must be https', () => {
    const pub = (i: number) => ({ ...orderWorkflowInput, stages: orderWorkflowInput.stages.map((s, k) => (k === i ? { ...s, publicForm: true } : s)) });
    expect(workflowDefSchema.safeParse(pub(0)).success).toBe(true);
    expect(workflowDefSchema.safeParse(pub(1)).success).toBe(false);
    const video = (url: string) => ({ ...orderWorkflowInput, stages: orderWorkflowInput.stages.map((s, k) => (k === 1 ? { ...s, video: { url } } : s)) });
    expect(workflowDefSchema.safeParse(video('https://youtu.be/abc')).success).toBe(true);
    expect(workflowDefSchema.safeParse(video('javascript:alert(1)')).success).toBe(false);
  });
});
