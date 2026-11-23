import { describe, expect, it } from 'vitest';
import {
  applySystemFields,
  CAPABILITIES,
  canSeeRecord,
  computeTimeline,
  editableFieldKeys,
  effectiveCapabilities,
  hasCapability,
  isAdmin,
  isResponsibleFor,
  isSuperAdmin,
  orgAccessError,
  evaluateFormula,
  evaluateGroup,
  fieldAccess,
  formulaReferences,
  pendingTasks,
  projectData,
  renderTemplate,
  stageSummary,
  uniqueValues,
  validateRecordInput,
  visibleFieldKeys,
  workflowDefSchema,
  type Principal,
} from '../src/index.js';
import { calendar, ist, orderWorkflow, orderWorkflowInput, TZ } from './fixtures.js';

const principal = (groups: string[], caps: string[] = [], rowFilter?: Principal['rowFilter']): Principal => ({
  userId: 'u1',
  email: 'u1@example.com',
  groups,
  capabilities: new Set(caps as never[]),
  rowFilter,
});

describe('conditions', () => {
  const data = { status: 'Done', city: 'Delhi', tags: ['a', 'b'], qty: '5', note: '  ', ok: 'TRUE' };
  it.each([
    [{ field: 'status', op: 'eq', value: 'done' }, true],
    [{ field: 'status', op: 'neq', value: 'Done' }, false],
    [{ field: 'note', op: 'empty' }, true],
    [{ field: 'missing', op: 'empty' }, true],
    [{ field: 'city', op: 'not_empty' }, true],
    [{ field: 'ok', op: 'is_true' }, true],
    [{ field: 'tags', op: 'eq', value: 'b' }, true],
    [{ field: 'city', op: 'in', value: ['Mumbai', 'delhi'] }, true],
    [{ field: 'qty', op: 'gt', value: 4 }, true],
    [{ field: 'qty', op: 'lte', value: 4 }, false],
  ] as const)('%o → %s', (c, expected) => {
    expect(evaluateGroup({ mode: 'all', conditions: [c as never] }, data)).toBe(expected);
  });

  it('supports any/all and empty groups', () => {
    const conditions = [
      { field: 'city', op: 'eq', value: 'Pune' },
      { field: 'status', op: 'eq', value: 'Done' },
    ] as const;
    expect(evaluateGroup({ mode: 'all', conditions: [...conditions] }, data)).toBe(false);
    expect(evaluateGroup({ mode: 'any', conditions: [...conditions] }, data)).toBe(true);
    expect(evaluateGroup({ mode: 'all', conditions: [] }, data)).toBe(true);
  });
});

describe('formula', () => {
  it('evaluates arithmetic with precedence, functions and field refs', () => {
    expect(evaluateFormula('qty * rate + 10 % 4', { qty: 3, rate: '2.5' })).toBe(9.5);
    expect(evaluateFormula('round((a + b) / 3, 2)', { a: 1, b: 1 })).toBe(0.67);
    expect(evaluateFormula('-max(a, 7, 2)', { a: 3 })).toBe(-7);
  });
  it('returns null when an input is missing', () => {
    expect(evaluateFormula('qty * rate', { qty: 3 })).toBeNull();
  });
  it('rejects code', () => {
    expect(() => evaluateFormula('constructor.constructor("x")()', {})).toThrow();
    expect(() => evaluateFormula('a; b', {})).toThrow();
  });
  it('lists references', () => {
    expect(formulaReferences('round(qty * rate, 2)')).toEqual(['qty', 'rate']);
  });
});

describe('workflow schema', () => {
  it('accepts the sample workflow', () => {
    expect(orderWorkflow.stages).toHaveLength(4);
    expect(orderWorkflow.fields.find((f) => f.key === 'remarks')?.editGroups).toEqual(['MANAGER']);
  });
  it('reports broken references', () => {
    const bad = structuredClone(orderWorkflowInput);
    bad.fields.push({ key: 'total', label: 'Total', type: 'computed', stageKey: 'intake', expression: 'qty * nope' });
    bad.fields.push({ key: 'customer', label: 'Dup', type: 'text', stageKey: 'ghost' });
    const r = workflowDefSchema.safeParse(bad);
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining(['Unknown field "nope"', 'Duplicate field key "customer"', 'Unknown stage "ghost"']));
  });
});

describe('permissions', () => {
  const fields = orderWorkflow.fields;
  it('field access by group, edit implies view', () => {
    const remarks = fields.find((f) => f.key === 'remarks')!;
    expect(fieldAccess(remarks, principal(['STORE']))).toEqual({ view: true, edit: false });
    expect(fieldAccess(remarks, principal(['MANAGER']))).toEqual({ view: true, edit: true });
    expect(fieldAccess(remarks, principal(['SALES']))).toEqual({ view: false, edit: false });
    expect(fieldAccess(remarks, principal([], ['ADMIN']))).toEqual({ view: true, edit: true });
  });
  it('never lets anyone edit computed fields', () => {
    const amount = fields.find((f) => f.key === 'amount')!;
    expect(fieldAccess(amount, principal([], ['ADMIN'])).edit).toBe(false);
    expect(editableFieldKeys(fields, principal(['SALES'])).has('amount')).toBe(false);
  });
  it('projects data to visible fields', () => {
    const visible = visibleFieldKeys(fields, principal(['SALES']));
    expect(projectData({ customer: 'Acme', remarks: 'secret' }, visible)).toEqual({ customer: 'Acme' });
  });
  it('applies row filters', () => {
    const p = principal(['SALES'], [], { mode: 'all', conditions: [{ field: 'city', op: 'eq', value: 'Delhi' }] });
    expect(canSeeRecord(p, { city: 'Delhi' })).toBe(true);
    expect(canSeeRecord(p, { city: 'Pune' })).toBe(false);
  });
});

describe('super admin', () => {
  const fields = orderWorkflow.fields;
  const superAdmin: Principal = { ...principal([]), isSuperAdmin: true, rowFilter: { mode: 'all', conditions: [{ field: 'city', op: 'eq', value: 'Delhi' }] } };

  it('holds every capability without belonging to any group', () => {
    expect(isAdmin(superAdmin)).toBe(true);
    for (const cap of CAPABILITIES) expect(hasCapability(superAdmin, cap)).toBe(true);
    expect(effectiveCapabilities(superAdmin)).toEqual([...CAPABILITIES]);
    expect(effectiveCapabilities(principal([], ['EXPORT']))).toEqual(['EXPORT']);
  });

  it('sees and edits every field and record, but still never edits computed fields', () => {
    const remarks = fields.find((f) => f.key === 'remarks')!;
    const amount = fields.find((f) => f.key === 'amount')!;
    expect(fieldAccess(remarks, superAdmin)).toEqual({ view: true, edit: true });
    expect(fieldAccess(amount, superAdmin).edit).toBe(false);
    expect(canSeeRecord(superAdmin, { city: 'Pune' })).toBe(true);
    expect(isResponsibleFor(['STORE'], superAdmin)).toBe(true);
  });

  it('is not granted by a group capability', () => {
    expect(isSuperAdmin(principal(['ADMINS'], ['ADMIN']))).toBe(false);
  });

  it('closes suspended and licence-expired organizations', () => {
    const now = new Date('2026-11-18T10:00:00Z');
    expect(orgAccessError({ isActive: true }, now)).toBeNull();
    expect(orgAccessError({ isActive: true, licenseExpiresAt: new Date('2026-11-19T00:00:00Z') }, now)).toBeNull();
    expect(orgAccessError({ isActive: true, licenseExpiresAt: new Date('2026-11-18T09:59:59Z') }, now)).toBe('LICENSE_EXPIRED');
    expect(orgAccessError({ isActive: false, licenseExpiresAt: new Date('2026-11-18T09:00:00Z') }, now)).toBe('SUSPENDED');
  });
});

describe('validation', () => {
  const fields = orderWorkflow.fields;
  const all = new Set(fields.map((f) => f.key));
  const intake = new Set(fields.filter((f) => f.stageKey === 'intake').map((f) => f.key));

  it('coerces and validates input', () => {
    const r = validateRecordInput(fields, { customer: ' Acme ', email: 'A@B.COM', priority: 'Urgent', needs_qc: 'yes', qty: '1,200' }, { mode: 'create', editable: all, requiredScope: intake, timezone: TZ });
    expect(r.errors).toEqual({});
    expect(r.data).toEqual({ customer: 'Acme', email: 'a@b.com', priority: 'Urgent', needs_qc: true, qty: 1200 });
  });

  it('flags required, invalid, unknown and forbidden fields', () => {
    const editable = new Set(['customer', 'email', 'priority']);
    const r = validateRecordInput(fields, { email: 'nope', priority: 'Whenever', hacker: 1, approved: true }, { mode: 'create', editable, requiredScope: intake, timezone: TZ });
    expect(r.errors).toEqual({
      email: 'Invalid email',
      priority: 'Not an allowed option',
      hacker: 'Unknown field',
      approved: 'You are not allowed to edit this field',
      customer: 'Customer Name is required',
    });
  });

  it('on update only checks required fields that are being changed', () => {
    const r = validateRecordInput(fields, { priority: 'Low' }, { mode: 'update', editable: all, requiredScope: intake, existing: { customer: 'Acme' }, timezone: TZ });
    expect(r.errors).toEqual({});
    const r2 = validateRecordInput(fields, { customer: '' }, { mode: 'update', editable: all, requiredScope: intake, timezone: TZ });
    expect(r2.errors.customer).toBe('Customer Name is required');
  });

  it('computes system fields and finds unique values', () => {
    const data = applySystemFields(fields, { qty: 3, rate: 19.999 }, { isCreate: true });
    expect(data.amount).toBe(60);
    expect(uniqueValues(fields, { email: 'a@b.com' })).toEqual([{ key: 'email', label: 'Email', value: 'a@b.com' }]);
  });
});

describe('templates', () => {
  it('renders {{key}} and legacy <<Label>> tags, escaping HTML when asked', () => {
    const out = renderTemplate('Hi {{customer}} / <<Customer Name>> #{{record_number}}', { fields: orderWorkflow.fields, data: { customer: '<b>Acme</b>' }, extra: { record_number: 42 } }, { html: true });
    expect(out).toBe('Hi &lt;b&gt;Acme&lt;/b&gt; / &lt;b&gt;Acme&lt;/b&gt; #42');
  });
});

describe('reports', () => {
  it('summarises stages and lists pending tasks with working-hour delays', () => {
    const created = ist('2026-01-22T10:00');
    const a = computeTimeline({ stages: orderWorkflow.stages, data: {}, createdAt: created, now: created, calendar });
    const b = computeTimeline({ stages: orderWorkflow.stages, data: { approved: true, priority: 'Urgent' }, createdAt: created, now: created, calendar });
    const records = [
      { id: 'a', number: 1, stages: a.states },
      { id: 'b', number: 2, stages: b.states },
    ];
    const now = ist('2026-01-23T10:00'); // approval for "a" planned Thu 14:00 → 5h late
    const summary = stageSummary(records, orderWorkflow.stages, now, calendar);
    expect(summary.find((s) => s.stageKey === 'approval')).toMatchObject({ overdue: 1, doneOnTime: 1, total: 2, avgOverdueHours: 5 });
    const tasks = pendingTasks(records, now, calendar, { overdueOnly: true });
    // Most delayed first. Record 2's dispatch (Urgent, planned Thu 12:00) is 6h Thu + 1h Fri late.
    expect(tasks.map((t) => [t.recordNumber, t.stageKey, t.delayHours])).toEqual([
      [2, 'dispatch', 7],
      [1, 'approval', 5],
    ]);
  });
});
