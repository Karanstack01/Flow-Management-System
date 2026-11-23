import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_TEMPLATES,
  canvasFromDefinition,
  compileCanvas,
  computeTimeline,
  effectiveGuards,
  layoutCanvas,
  reconcileCanvas,
  workflowDefSchema,
  workflowSettingsSchema,
  type Canvas,
  type WorkflowDef,
} from '../src/index.js';
import { calendar, ist } from './fixtures.js';

const settings = workflowSettingsSchema.parse({});
const template = (key: string) => workflowDefSchema.parse(BUILT_IN_TEMPLATES.find((t) => t.key === key)!.definition);

describe('built-in templates', () => {
  it.each(BUILT_IN_TEMPLATES.map((t) => [t.key, t] as const))('%s is a valid workflow', (_k, t) => {
    const r = workflowDefSchema.safeParse(t.definition);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
    expect(t.definition.key).toBe(t.key);
  });
});

describe('canvas ⇄ definition', () => {
  // Same behaviour = same order, same effective guards (own condition or branch), same timing and completion.
  const behaviour = (d: WorkflowDef) => d.stages.map((s, i) => ({ key: s.key, guards: i === 0 ? [] : effectiveGuards(s), planned: s.planned, completion: s.completion, owners: s.responsibleGroups }));

  it('round-trips every template without changing its behaviour', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      const def = workflowDefSchema.parse(t.definition);
      const canvas = canvasFromDefinition(def, settings);
      const out = compileCanvas(canvas, def, settings);
      expect(out.errors, t.key).toEqual([]);
      expect(behaviour(out.definition!), t.key).toEqual(behaviour(def));
      // …and compiling again is stable.
      const again = compileCanvas(canvasFromDefinition(out.definition!, settings), out.definition!, settings);
      expect(again.definition!.stages, t.key).toEqual(out.definition!.stages);
    }
  });

  it('rebuilds a stage condition as a Depends-on node whose Otherwise output skips to the next stage', () => {
    const def = template('purchase_indent');
    const canvas = canvasFromDefinition(def, settings);
    const cond = canvas.nodes.find((n) => n.id === 'cond-mgmt_approval')!;
    expect((cond.data as { cases: unknown[] }).cases).toHaveLength(1);
    expect(canvas.edges).toContainEqual(expect.objectContaining({ source: 'cond-mgmt_approval', target: 'timer-mgmt_approval', sourceHandle: 'c1' }));
    expect(canvas.edges).toContainEqual(expect.objectContaining({ source: 'timer-mgmt_approval', target: 'stage-mgmt_approval' }));
    expect(canvas.edges.some((e) => e.source === 'cond-mgmt_approval' && e.sourceHandle === 'else')).toBe(true);
  });

  const switchDef = workflowDefSchema.parse({
    key: 'switchy',
    name: 'Switchy',
    stages: [
      { key: 'intake', name: 'Intake', completion: { kind: 'on_create' } },
      { key: 'approve', name: 'Approve' },
      { key: 'hold', name: 'Hold' },
      { key: 'reject', name: 'Reject notice' },
      { key: 'review', name: 'Manual review' },
      { key: 'close', name: 'Close' },
    ],
    fields: [
      { key: 'decision', label: 'Decision', type: 'select', stageKey: 'intake', options: ['Approve', 'Hold', 'Reject', 'Other'] },
      { key: 'qc', label: 'QC', type: 'select', stageKey: 'close', options: ['Pass', 'Fail'] },
    ],
  });
  const is = (v: string) => ({ mode: 'all' as const, conditions: [{ field: 'decision', op: 'eq' as const, value: v }] });

  it('compiles one output per condition plus Otherwise; first match wins and paths rejoin', () => {
    const canvas: Canvas = {
      nodes: [
        { id: 'stage-intake', type: 'stage', x: 0, y: 0, data: { stageKey: 'intake' } },
        { id: 'sw', type: 'condition', x: 300, y: 0, data: { cases: [{ id: 'p1', when: is('Approve') }, { id: 'p2', when: is('Hold') }, { id: 'p3', when: is('Reject') }], otherwise: true } },
        { id: 'stage-approve', type: 'stage', x: 600, y: 0, data: { stageKey: 'approve' } },
        { id: 'stage-hold', type: 'stage', x: 600, y: 200, data: { stageKey: 'hold' } },
        { id: 'stage-reject', type: 'stage', x: 600, y: 400, data: { stageKey: 'reject' } },
        { id: 'stage-review', type: 'stage', x: 600, y: 600, data: { stageKey: 'review' } },
        { id: 'stage-close', type: 'stage', x: 900, y: 0, data: { stageKey: 'close' } },
      ],
      edges: [
        { id: 'a', source: 'stage-intake', target: 'sw' },
        { id: 'b', source: 'sw', target: 'stage-approve', sourceHandle: 'p1' },
        { id: 'c', source: 'sw', target: 'stage-hold', sourceHandle: 'p2' },
        { id: 'd', source: 'sw', target: 'stage-reject', sourceHandle: 'p3' },
        { id: 'e', source: 'sw', target: 'stage-review', sourceHandle: 'else' },
        ...['approve', 'hold', 'reject', 'review'].map((k) => ({ id: `j-${k}`, source: `stage-${k}`, target: 'stage-close' })),
      ],
    };
    const out = compileCanvas(canvas, switchDef, settings);
    expect(out.errors).toEqual([]);
    const stages = out.definition!.stages;
    expect(stages.map((s) => effectiveGuards(s)[0]?.take ?? '-')).toEqual(['-', 0, 1, 2, 'else', '-']);

    const route = (decision: string) =>
      computeTimeline({ stages, data: { decision }, createdAt: ist('2026-11-18T10:00'), now: ist('2026-11-18T11:00'), calendar, previous: [] })
        .states.filter((s) => s.status === 'active')
        .map((s) => s.stageKey);
    expect(route('Approve')).toEqual(['approve']);
    expect(route('Hold')).toEqual(['hold']);
    expect(route('Reject')).toEqual(['reject']);
    expect(route('Other')).toEqual(['review']);

    // Round trip: one Depends-on node with three cases + Otherwise, compiling to the same guards.
    const rebuilt = canvasFromDefinition(out.definition!, settings);
    const conds = rebuilt.nodes.filter((n) => n.type === 'condition');
    expect(conds).toHaveLength(1);
    expect((conds[0]!.data as { cases: unknown[] }).cases).toHaveLength(3);
    expect(behaviour(compileCanvas(rebuilt, out.definition!, settings).definition!)).toEqual(behaviour(out.definition!));
  });

  it('a single condition with no Otherwise: unmatched records skip that path and continue where it rejoins', () => {
    const canvas: Canvas = {
      nodes: [
        { id: 'stage-intake', type: 'stage', x: 0, y: 0, data: { stageKey: 'intake' } },
        { id: 'sw', type: 'condition', x: 300, y: 0, data: { cases: [{ id: 'p1', when: is('Approve') }] } },
        ...['approve', 'hold', 'reject', 'review', 'close'].map((k, i) => ({ id: `stage-${k}`, type: 'stage' as const, x: 600 + i * 300, y: 0, data: { stageKey: k } })),
      ],
      edges: [
        { id: 'a', source: 'stage-intake', target: 'sw' },
        { id: 'b', source: 'sw', target: 'stage-approve', sourceHandle: 'p1' },
        { id: 'c', source: 'stage-approve', target: 'stage-hold' },
        { id: 'd', source: 'stage-hold', target: 'stage-reject' },
        { id: 'e', source: 'stage-reject', target: 'stage-review' },
        { id: 'f', source: 'stage-review', target: 'stage-close' },
      ],
    };
    const out = compileCanvas(canvas, switchDef, settings);
    expect(out.errors).toEqual([]);
    // The path never rejoins, so everything after the switch belongs to it.
    expect(out.definition!.stages.slice(1).every((s) => effectiveGuards(s)[0]?.take === 0)).toBe(true);
  });

  it('accepts older Yes / No nodes (single condition, yes / no handles)', () => {
    const canvas: Canvas = {
      nodes: [
        { id: 'stage-intake', type: 'stage', x: 0, y: 0, data: { stageKey: 'intake' } },
        { id: 'old', type: 'condition', x: 300, y: 0, data: { when: is('Approve') } },
        ...['approve', 'hold', 'reject', 'review', 'close'].map((k, i) => ({ id: `stage-${k}`, type: 'stage' as const, x: 600 + i * 300, y: 0, data: { stageKey: k } })),
      ],
      edges: [
        { id: 'a', source: 'stage-intake', target: 'old' },
        { id: 'b', source: 'old', target: 'stage-approve', sourceHandle: 'yes' },
        { id: 'c', source: 'old', target: 'stage-hold', sourceHandle: 'no' },
        { id: 'd', source: 'stage-approve', target: 'stage-reject' },
        { id: 'e', source: 'stage-hold', target: 'stage-reject' },
        { id: 'f', source: 'stage-reject', target: 'stage-review' },
        { id: 'g', source: 'stage-review', target: 'stage-close' },
      ],
    };
    const out = compileCanvas(canvas, switchDef, settings);
    expect(out.errors).toEqual([]);
    expect(out.definition!.stages.find((s) => s.key === 'approve')!.guards).toEqual([{ cases: [is('Approve')], take: 0 }]);
    expect(out.definition!.stages.find((s) => s.key === 'hold')!.guards).toEqual([{ cases: [is('Approve')], take: 'else' }]);
  });

  it('rejects two links from one output and a path with no condition', () => {
    const def = template('lead_to_close');
    const base = canvasFromDefinition(def, settings);
    const cond = base.nodes.find((n) => n.type === 'condition')!;
    const twice = compileCanvas({ ...base, edges: [...base.edges, { id: 'x', source: cond.id, target: 'stage-closure', sourceHandle: 'c1' }] }, def, settings);
    expect(twice.errors.some((e) => e.nodeId === cond.id && /only one step/.test(e.message))).toBe(true);
    const empty = compileCanvas({ ...base, nodes: base.nodes.map((n) => (n.id === cond.id ? { ...n, data: { cases: [{ id: 'c1', when: { mode: 'all', conditions: [] } }], otherwise: true } } : n)) }, def, settings);
    expect(empty.errors.some((e) => /has no condition yet/.test(e.message))).toBe(true);
  });

  describe('Stage Jump', () => {
    const linear: Canvas = {
      nodes: switchDef.stages.map((s, i) => ({ id: `stage-${s.key}`, type: 'stage' as const, x: i * 300, y: 0, data: { stageKey: s.key } })),
      edges: switchDef.stages.slice(1).map((s, i) => ({ id: `l${i}`, source: `stage-${switchDef.stages[i]!.key}`, target: `stage-${s.key}` })),
    };
    const withJump = (from: string, to: string, when: object, clearFields: string[] = []): Canvas => ({
      nodes: [...linear.nodes, { id: 'j1', type: 'jump', x: 0, y: 300, data: { when, clearFields } }],
      edges: [...linear.edges, { id: 'jf', source: `stage-${from}`, target: 'j1' }, { id: 'jt', source: 'j1', target: `stage-${to}` }],
    });
    const at = (iso: string) => ist(iso);

    it('compiles a jump node into the source stage', () => {
      const out = compileCanvas(withJump('approve', 'review', is('Approve')), switchDef, settings);
      expect(out.errors).toEqual([]);
      expect(out.definition!.stages.find((s) => s.key === 'approve')!.jumps).toEqual([{ when: is('Approve'), to: 'review', clearFields: [] }]);
      // …and survives a rebuild.
      const rebuilt = canvasFromDefinition(out.definition!, settings);
      expect(rebuilt.nodes.filter((n) => n.type === 'jump')).toHaveLength(1);
      expect(compileCanvas(rebuilt, out.definition!, settings).definition!.stages).toEqual(out.definition!.stages);
    });

    it('forward jump skips the stages in between', () => {
      const stages = compileCanvas(withJump('approve', 'review', is('Approve')), switchDef, settings).definition!.stages;
      const done = (k: string) => ({ stageKey: k, status: 'done' as const, plannedAt: null, actualAt: at('2026-11-18T11:00') });
      const t = computeTimeline({ stages, data: { decision: 'Approve' }, createdAt: at('2026-11-18T10:00'), now: at('2026-11-18T12:00'), calendar, previous: [done('intake'), done('approve')] });
      expect(t.states.map((s) => `${s.stageKey}:${s.status}`)).toEqual(['intake:done', 'approve:done', 'hold:skipped', 'reject:skipped', 'review:active', 'close:waiting']);
    });

    it('backward jump reopens the range for another round and clears the chosen fields', () => {
      const stages = compileCanvas(withJump('close', 'reject', { mode: 'all', conditions: [{ field: 'qc', op: 'eq', value: 'Fail' }] }, ['qc']), switchDef, settings).definition!.stages.map((s) => ({ ...s, completion: { kind: 'manual' as const } }));
      const t1 = at('2026-11-18T11:00');
      const done = (k: string) => ({ stageKey: k, status: 'done' as const, plannedAt: null, actualAt: t1 });
      // "Close" is being marked done (actualAt supplied) while QC = Fail.
      const t = computeTimeline({
        stages,
        data: { decision: 'Approve', qc: 'Fail' },
        createdAt: at('2026-11-18T10:00'),
        now: at('2026-11-18T12:00'),
        calendar,
        previous: [done('intake'), done('approve'), done('hold'), done('reject'), done('review'), { stageKey: 'close', status: 'active', plannedAt: null, actualAt: at('2026-11-18T12:00') }],
      });
      expect(t.states.map((s) => `${s.stageKey}:${s.status}:${s.round ?? 0}`)).toEqual(['intake:done:0', 'approve:done:0', 'hold:done:0', 'reject:active:1', 'review:waiting:1', 'close:waiting:1']);
      expect(t.dataPatch).toEqual({ qc: null });
      expect(t.events).toContainEqual({ type: 'stage_jumped', stageKey: 'close', to: 'reject', direction: 'back' });
      expect(t.events).toContainEqual(expect.objectContaining({ type: 'stage_activated', stageKey: 'reject' }));
    });

    it('rejects jumps without a condition or back to the intake form', () => {
      expect(compileCanvas(withJump('close', 'reject', { mode: 'all', conditions: [] }), switchDef, settings).errors.some((e) => /needs a condition/.test(e.message))).toBe(true);
      expect(compileCanvas(withJump('close', 'intake', is('Approve')), switchDef, settings).errors.some((e) => /intake form/.test(e.message))).toBe(true);
    });
  });

  it('reorders stages by following the connections', () => {
    const def = template('lead_to_close');
    const canvas: Canvas = {
      nodes: def.stages.map((s, i) => ({ id: `stage-${s.key}`, type: 'stage', x: i * 100, y: 0, data: { stageKey: s.key } })),
      edges: [
        { id: 'a', source: 'stage-enquiry', target: 'stage-quotation' },
        { id: 'b', source: 'stage-quotation', target: 'stage-first_call' },
        { id: 'c', source: 'stage-first_call', target: 'stage-demo' },
        { id: 'd', source: 'stage-demo', target: 'stage-closure' },
      ],
    };
    const out = compileCanvas(canvas, def, settings);
    expect(out.errors).toEqual([]);
    expect(out.definition!.stages.map((s) => s.key)).toEqual(['enquiry', 'quotation', 'first_call', 'demo', 'closure']);
    // No timer / depends-on nodes in front any more → no TAT, no condition (manual planning is kept).
    expect(out.definition!.stages.find((s) => s.key === 'quotation')!.planned).toEqual({ mode: 'none' });
    expect(out.definition!.stages.find((s) => s.key === 'demo')!.planned).toEqual({ mode: 'manual' });
    expect(out.definition!.stages.find((s) => s.key === 'quotation')!.applicableWhen).toBeUndefined();
  });

  it('rejects branches, loops and loose stages with node-level messages', () => {
    const def = template('lead_to_close');
    const base = canvasFromDefinition(def, settings);
    const branched = compileCanvas({ ...base, edges: [...base.edges, { id: 'x', source: 'stage-enquiry', target: 'stage-closure' }] }, def, settings);
    expect(branched.definition).toBeNull();
    expect(branched.errors.some((e) => e.nodeId === 'stage-enquiry' && /more than one next step/.test(e.message))).toBe(true);

    const loose = compileCanvas({ ...base, edges: base.edges.filter((e) => e.target !== 'stage-closure' && e.source !== 'stage-closure' && !e.target.endsWith('-closure')) }, def, settings);
    expect(loose.errors.some((e) => /not connected/.test(e.message))).toBe(true);
  });

  it('turns message and webhook nodes into rules and webhooks after their stage', () => {
    const def = template('complaint_resolution');
    const base = canvasFromDefinition(def, settings);
    const canvas: Canvas = {
      nodes: [
        ...base.nodes,
        { id: 'msg-a', type: 'message', x: 0, y: 0, data: { name: 'Tell support', event: 'stage_activated', email: { to: '{{contact_phone}}@sms.example', subject: 'New', body: 'Hi' } } },
        { id: 'msg-b', type: 'message', x: 0, y: 0, data: { name: 'Unconfigured' } },
        { id: 'hook-a', type: 'webhook', x: 0, y: 0, data: { url: 'https://erp.example/hook' } },
        { id: 'note-1', type: 'note', x: 0, y: 0, data: { text: 'hello' } },
      ],
      edges: [...base.edges, { id: 'm1', source: 'stage-triage', target: 'msg-a' }, { id: 'm2', source: 'stage-triage', target: 'msg-b' }, { id: 'h1', source: 'stage-resolution', target: 'hook-a' }],
    };
    const out = compileCanvas(canvas, def, settings);
    expect(out.errors).toEqual([]);
    expect(out.rules).toEqual([{ nodeId: 'msg-a', definition: expect.objectContaining({ trigger: { type: 'stage_activated', stageKey: 'triage' } }) }]);
    expect(out.warnings.some((w) => w.nodeId === 'msg-b')).toBe(true);
    expect(out.settings!.webhooks).toEqual([expect.objectContaining({ key: 'hook_a', url: 'https://erp.example/hook', afterStage: 'resolution' })]);
  });

  it('forces the first stage to be the intake form', () => {
    const def = template('lead_to_close');
    const canvas = canvasFromDefinition(def, settings);
    const timerFirst: Canvas = {
      nodes: [...canvas.nodes, { id: 't0', type: 'timer', x: -300, y: 0, data: { tat: { kind: 'fixed', hours: 1 } } }],
      edges: [...canvas.edges, { id: 't0e', source: 't0', target: 'stage-enquiry' }],
    };
    const out = compileCanvas(timerFirst, def, settings);
    expect(out.errors.some((e) => /start with a Stage/.test(e.message))).toBe(true);
  });

  it('keeps a stored canvas that still matches, and regenerates one edited elsewhere', () => {
    const def = template('order_to_delivery');
    const stored = canvasFromDefinition(def, settings);
    stored.nodes[0]!.x = 1234;
    const withNote: Canvas = { ...stored, nodes: [...stored.nodes, { id: 'n1', type: 'note', x: 5, y: 5, data: { text: 'keep me' } }] };
    expect(reconcileCanvas(withNote, def, settings)).toEqual(withNote);

    const edited: WorkflowDef = { ...def, stages: [def.stages[0]!, def.stages[2]!, def.stages[1]!, ...def.stages.slice(3)] };
    const r = reconcileCanvas(withNote, workflowDefSchema.parse(edited), settings);
    expect(compileCanvas(r, workflowDefSchema.parse(edited), settings).definition!.stages.map((s) => s.key)).toEqual(edited.stages.map((s) => s.key));
    expect(r.nodes.find((n) => n.id === 'n1')).toBeDefined();
    expect(r.nodes.find((n) => n.id === 'stage-intake')!.x).toBe(1234);
  });

  it('lays the main path out left to right', () => {
    const def = template('employee_onboarding');
    const c = layoutCanvas(canvasFromDefinition(def, settings));
    const stages = c.nodes.filter((n) => n.type === 'stage');
    for (let i = 1; i < stages.length; i++) expect(stages[i]!.x).toBeGreaterThan(stages[i - 1]!.x);
  });
});
