import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/index.js';
import { calendar, fmt, ist } from './fixtures.js';

describe('BusinessCalendar.addWorkingHours', () => {
  it('adds within the same shift', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T10:00'), 2))).toBe('2026-01-22 12:00');
  });

  it('a full working day from shift start ends exactly at shift end', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T09:00'), 9))).toBe('2026-01-22 18:00');
  });

  it('rolls overflow into the next working day', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T16:00'), 4))).toBe('2026-01-23 11:00');
  });

  it('clamps a base before shift start', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T07:00'), 2))).toBe('2026-01-22 11:00');
  });

  it('moves a base after shift end to the next morning', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T20:00'), 2))).toBe('2026-01-23 11:00');
  });

  it('skips weekly offs and holidays', () => {
    // Sat 17:00 → 1h Sat, Sun off, Mon holiday, 8h Tue
    expect(fmt(calendar.addWorkingHours(ist('2026-01-24T17:00'), 9))).toBe('2026-01-27 17:00');
  });

  it('zero hours snaps to the next working start', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-25T12:00'), 0))).toBe('2026-01-27 09:00');
  });

  it('spans multiple days for long TATs', () => {
    // 27h from Thu 09:00 = Thu 9h + Fri 9h + Sat 9h → Sat 18:00
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T09:00'), 27))).toBe('2026-01-24 18:00');
  });

  it('supports fractional hours', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T10:00'), 1.5))).toBe('2026-01-22 11:30');
  });

  it('negative hours subtract', () => {
    expect(fmt(calendar.addWorkingHours(ist('2026-01-22T12:00'), -2))).toBe('2026-01-22 10:00');
  });
});

describe('BusinessCalendar.subtractWorkingHours', () => {
  it('walks back across holiday and weekly off', () => {
    // Tue 11:00 − 4h → 2h Tue, Mon holiday, Sun off, Sat 18:00 − 2h
    expect(fmt(calendar.subtractWorkingHours(ist('2026-01-27T11:00'), 4))).toBe('2026-01-24 16:00');
  });

  it('clamps a base after shift end', () => {
    expect(fmt(calendar.subtractWorkingHours(ist('2026-01-22T21:00'), 1))).toBe('2026-01-22 17:00');
  });
});

describe('BusinessCalendar.workingHoursBetween', () => {
  it('counts only working time', () => {
    // Fri 17:00 → Tue 10:00 = Fri 1h + Sat 9h + Tue 1h
    expect(calendar.workingHoursBetween(ist('2026-01-23T17:00'), ist('2026-01-27T10:00'))).toBe(11);
  });

  it('is antisymmetric', () => {
    expect(calendar.workingHoursBetween(ist('2026-01-27T10:00'), ist('2026-01-23T17:00'))).toBe(-11);
  });

  it('is the inverse of addWorkingHours', () => {
    const start = ist('2026-01-22T14:20');
    const end = calendar.addWorkingHours(start, 23.25);
    expect(calendar.workingHoursBetween(start, end)).toBeCloseTo(23.25, 6);
  });
});

describe('BusinessCalendar config', () => {
  it('rejects invalid timezones', () => {
    expect(() => new BusinessCalendar({ timezone: 'Mars/Base', shiftStart: '09:00', shiftEnd: '18:00', weeklyOff: [], holidays: [] })).toThrow();
  });

  it('handles DST zones by wall clock', () => {
    const ny = new BusinessCalendar({ timezone: 'America/New_York', shiftStart: '09:00', shiftEnd: '17:00', weeklyOff: [6, 7], holidays: [] });
    // Fri 2026-03-06 16:00 + 2h → Mon 2026-03-09 10:00 local (DST starts Sun 03-08)
    const from = new Date('2026-03-06T21:00:00Z'); // 16:00 EST
    expect(ny.addWorkingHours(from, 2).toISOString()).toBe('2026-03-09T14:00:00.000Z'); // 10:00 EDT
  });
});
