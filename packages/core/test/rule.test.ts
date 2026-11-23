import { describe, expect, it } from 'vitest';
import { checkRule, defaultFieldValues, evaluateRule, fieldAccess, ruleReferences, RuleError, validateRecordInput, workflowDefSchema, type FieldDef, type Principal } from '../src/index.js';
import { orderWorkflowInput } from './fixtures.js';

const ctx = (data: Record<string, unknown>, value?: unknown) => ({ data: data as never, value: value as never, now: new Date('2026-11-21T10:00:00Z') });

describe('validation rule language', () => {
  it('evaluates spreadsheet-style formulas', () => {
    expect(evaluateRule('=IF(name="Raghbir", "Done", "Not Done")', ctx({ name: 'raghbir' }))).toBe('Done'); // case-insensitive
    expect(evaluateRule('=IF(name<>"Raghbir", "x")', ctx({ name: 'Raghbir' }))).toBeNull();
    expect(evaluateRule('qty * rate + 1', ctx({ qty: 2, rate: '2.5' }))).toBe(6);
    expect(evaluateRule('"Order " & RECORD_NUMBER', { data: {}, record: { RECORD_NUMBER: 42 } })).toBe('Order 42');
    expect(evaluateRule('AND(value >= 1, value <= 10) && !ISBLANK(value)', ctx({}, 5))).toBe(true);
    expect(evaluateRule('LEN(value) = 15', ctx({}, '27AAAAA0000A1Z5'))).toBe(true);
    expect(evaluateRule('COUNT(value)', ctx({}, ['a', 'b']))).toBe(2);
    expect(evaluateRule('DAYS(value, TODAY())', ctx({}, '2026-11-25'))).toBe(4);
    expect(evaluateRule('IN(status, "Open", "Hold")', ctx({ status: 'hold' }))).toBe(true);
    expect(evaluateRule('2 ^ 3 - -1', ctx({}))).toBe(9);
    expect(evaluateRule('missing = null', ctx({}))).toBe(true);
  });

  it('only evaluates the IF branch it takes', () => {
    expect(evaluateRule('IF(TRUE, 1, DAYS("bad", "date"))', ctx({}))).toBe(1);
    expect(() => evaluateRule('IF(FALSE, 1, DAYS("bad", "date"))', ctx({}))).toThrow(RuleError);
  });

  it('turns results into valid / invalid with messages', () => {
    expect(checkRule('=value > 0', ctx({}, 3)).ok).toBe(true);
    expect(checkRule('=value > 0', ctx({}, 0), 'Qty')).toEqual({ ok: false, result: false, message: 'Qty is not valid' });
    expect(checkRule('=IF(value > 100, "At most 100")', ctx({}, 120))).toMatchObject({ ok: false, message: 'At most 100' });
    expect(checkRule('=IF(value > 100, "At most 100")', ctx({}, 50)).ok).toBe(true);
  });

  it('reports syntax errors with a position and lists references', () => {
    expect(() => evaluateRule('=IF(a > 1, "x"', ctx({}))).toThrow(/Expected "\)"/);
    expect(() => evaluateRule('=FOO(1)', ctx({}))).toThrow(/Unknown function FOO/);
    expect(() => evaluateRule('=IF(1)', ctx({}))).toThrow(/takes 2–3 arguments/);
    expect(() => evaluateRule('="open', ctx({}))).toThrow(/closing quote/);
    expect(ruleReferences('=IF(AND(qty > 1, value <> rate), RECORD_NUMBER, TODAY())')).toEqual(['qty', 'value', 'rate', 'RECORD_NUMBER']);
  });
});

describe('field settings', () => {
  const base = workflowDefSchema.parse(orderWorkflowInput);
  const field = (patch: Partial<FieldDef>): FieldDef => ({ ...base.fields[0]!, ...patch });
  const user = (email: string): Principal => ({ userId: 'u', email, groups: ['SALES'], capabilities: new Set() });

  it('restricts a field to its assigned users', () => {
    const f = field({ fieldAccessRestricted: true, fieldUsers: [{ email: 'viewer@x.com', role: 'Viewer' }, { email: 'editor@x.com', role: 'Editor' }] });
    expect(fieldAccess(f, user('someone@x.com'))).toEqual({ view: false, edit: false });
    expect(fieldAccess(f, user('Viewer@X.com'))).toEqual({ view: true, edit: false });
    expect(fieldAccess(f, user('editor@x.com'))).toEqual({ view: true, edit: true });
    expect(fieldAccess(f, { ...user('admin@x.com'), capabilities: new Set(['ADMIN']) })).toEqual({ view: true, edit: true });
  });

  it('runs validation rules and the single-file limit on write', () => {
    const qty: FieldDef = field({ key: 'qty', label: 'Qty', type: 'number', validationRule: '=IF(value > 100, "At most 100 units")' });
    const doc: FieldDef = field({ key: 'doc', label: 'Drawing', type: 'file' });
    const opts = { mode: 'update' as const, editable: new Set(['qty', 'doc']), timezone: 'Asia/Kolkata' };
    expect(validateRecordInput([qty, doc], { qty: 120 }, opts).errors).toEqual({ qty: 'At most 100 units' });
    expect(validateRecordInput([qty, doc], { qty: 80 }, opts).errors).toEqual({});
    expect(validateRecordInput([qty, doc], { doc: ['f1', 'f2'] }, opts).errors).toEqual({ doc: 'Only one file is allowed' });
    expect(validateRecordInput([qty, { ...doc, allowMultiple: true }], { doc: ['f1', 'f2'] }, opts).errors).toEqual({});
  });

  it('resolves default values on the server (TODAY, numbers, bad options dropped, files skipped)', () => {
    const d = defaultFieldValues(
      [
        field({ key: 'due', type: 'date', defaultValue: 'TODAY' }),
        field({ key: 'qty', type: 'number', defaultValue: '5' }),
        field({ key: 'prio', type: 'select', options: ['Low', 'High'], defaultValue: 'Urgent' }),
        field({ key: 'tags', type: 'multiselect', options: ['A', 'B'], defaultValue: 'A, B' }),
        field({ key: 'doc', type: 'file', defaultValue: 'x' }),
        field({ key: 'note', type: 'text' }),
      ],
      { timezone: 'Asia/Kolkata', now: new Date('2026-11-21T20:00:00Z') },
    );
    expect(d).toEqual({ due: '2026-11-22', qty: 5, tags: ['A', 'B'] }); // 20:00 UTC is already the 22nd in India
  });

  it('rejects broken rules and unknown references when the flow is saved', () => {
    const withRule = (rule: string) => ({ ...orderWorkflowInput, fields: orderWorkflowInput.fields.map((f, i) => (i === 0 ? { ...f, validationRule: rule } : f)) });
    expect(workflowDefSchema.safeParse(withRule('=LEN(value) > 2')).success).toBe(true);
    const bad = workflowDefSchema.safeParse(withRule('=IF(value >'));
    expect(bad.success).toBe(false);
    const unknown = workflowDefSchema.safeParse(withRule('=value <> nope'));
    expect(unknown.success).toBe(false);
  });
});
