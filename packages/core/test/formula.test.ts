import { describe, expect, it } from 'vitest';
import { evaluateFormula, formulaError, formulaReferences } from '../src/index.js';

const now = new Date('2026-11-24T06:30:00Z'); // 12:00 in Asia/Kolkata
const run = (e: string, data: Record<string, unknown> = {}) => evaluateFormula(e, data as never, { timezone: 'Asia/Kolkata', now });

describe('formulas', () => {
  it('keeps arithmetic and blanks as before', () => {
    expect(run('round(qty * rate, 2)', { qty: 3, rate: 19.999 })).toBe(60);
    expect(run('qty * rate', { qty: 3 })).toBeNull();
    expect(run('a / b', { a: 1, b: 0 })).toBeNull();
  });

  it('IF / AND / OR / comparisons, evaluating only the branch taken', () => {
    expect(run('IF(amount > 50000, "Needs approval", "Auto")', { amount: 60000 })).toBe('Needs approval');
    expect(run('IF(amount > 50000, "Needs approval", "Auto")', { amount: 100 })).toBe('Auto');
    // The blank `missing` is never touched, so the result is not blank.
    expect(run('IF(paid, "Done", missing * 2)', { paid: true })).toBe('Done');
    expect(run('AND(paid, qty >= 10)', { paid: true, qty: 12 })).toBe(true);
    expect(run('OR(status = "closed", status = "CANCELLED")', { status: 'cancelled' })).toBe(true);
    expect(run('NOT(ISBLANK(remarks))', { remarks: '' })).toBe(false);
    expect(run('city <> ""', { city: 'Pune' })).toBe(true);
  });

  it('text functions', () => {
    expect(run('first & " " & last', { first: 'Asha', last: 'Rao' })).toBe('Asha Rao');
    expect(run('TEXTJOIN(", ", city, state, country)', { city: 'Pune', country: 'India' })).toBe('Pune, India');
    expect(run('UPPER(LEFT(code, 3))', { code: 'abcdef' })).toBe('ABC');
    expect(run('CONTAINS(remarks, "urgent")', { remarks: 'Very URGENT order' })).toBe(true);
    expect(run('TEXT(amount, 2)', { amount: 12.5 })).toBe('12.50');
    expect(run('COALESCE(phone, mobile, "—")', { mobile: '98765' })).toBe('98765');
  });

  it('dates in the business timezone', () => {
    expect(run('TODAY()')).toBe('2026-11-24');
    expect(run('DAYS(TODAY(), order_date)', { order_date: '2026-11-20' })).toBe(4);
    expect(run('ADDDAYS(order_date, 7)', { order_date: '2026-11-20' })).toBe('2026-11-27');
    expect(run('HOURS(done, started)', { started: '2026-11-24T04:00:00Z', done: '2026-11-24T06:30:00Z' })).toBe(2.5);
    expect(run('MONTH(order_date)', { order_date: '2026-11-20' })).toBe(11);
    expect(run('DAYS(TODAY(), order_date)', {})).toBeNull();
  });

  it('references and errors', () => {
    expect(formulaReferences('IF(paid, TEXTJOIN(" ", a, b), "x")')).toEqual(['paid', 'a', 'b']);
    expect(formulaReferences('TRUE & total')).toEqual(['total']);
    expect(formulaError('IF(a, "b"')).toMatch(/Expected/);
    expect(formulaError('NOPE(a)')).toMatch(/Unknown function/);
    expect(formulaError('"open')).toMatch(/closing quote/);
  });
});
