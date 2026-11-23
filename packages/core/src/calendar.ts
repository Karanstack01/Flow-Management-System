/**
 * Working-hours calendar.
 *
 * Replaces the ~10 copies of shift/holiday arithmetic in legacy planningtime(),
 * Rep_Stage(), Rep_Pending() … with one implementation:
 *  - time only accrues inside [shiftStart, shiftEnd) on working days,
 *  - weekly offs and holiday dates are skipped,
 *  - all wall-clock maths happens in the calendar's IANA timezone (DST-safe).
 */
import { DateTime } from 'luxon';
import type { CalendarConfig } from './schema.js';

const MS_PER_HOUR = 3_600_000;
/** Safety valve: never scan further than ~10 years. */
const MAX_DAYS = 3660;

export class BusinessCalendar {
  private readonly holidays: Set<string>;
  private readonly weeklyOff: Set<number>;
  private readonly start: { hour: number; minute: number };
  private readonly end: { hour: number; minute: number };

  constructor(readonly config: CalendarConfig) {
    if (!DateTime.local().setZone(config.timezone).isValid) {
      throw new Error(`Invalid timezone "${config.timezone}"`);
    }
    this.holidays = new Set(config.holidays);
    this.weeklyOff = new Set(config.weeklyOff);
    this.start = parseHm(config.shiftStart);
    this.end = parseHm(config.shiftEnd);
    if (this.weeklyOff.size >= 7) throw new Error('Calendar has no working weekdays');
  }

  /** Length of one working day in hours. */
  get hoursPerDay(): number {
    return (this.end.hour * 60 + this.end.minute - (this.start.hour * 60 + this.start.minute)) / 60;
  }

  isWorkingDay(date: Date | DateTime): boolean {
    const dt = this.toZone(date);
    return !this.weeklyOff.has(dt.weekday) && !this.holidays.has(dt.toISODate()!);
  }

  isHoliday(date: Date | DateTime): boolean {
    return this.holidays.has(this.toZone(date).toISODate()!);
  }

  /** `from` + `hours` of working time. Negative hours delegate to subtract. */
  addWorkingHours(from: Date, hours: number): Date {
    if (!Number.isFinite(hours)) throw new Error('hours must be finite');
    if (hours < 0) return this.subtractWorkingHours(from, -hours);
    let remaining = Math.round(hours * MS_PER_HOUR);
    let cursor = this.toZone(from);

    for (let i = 0; i < MAX_DAYS; i++) {
      if (!this.isWorkingDay(cursor)) {
        cursor = this.dayStart(cursor.plus({ days: 1 }));
        continue;
      }
      const dayStart = this.dayStart(cursor);
      const dayEnd = this.dayEnd(cursor);
      if (cursor < dayStart) cursor = dayStart;
      if (cursor >= dayEnd) {
        cursor = this.dayStart(cursor.plus({ days: 1 }));
        continue;
      }
      const available = dayEnd.toMillis() - cursor.toMillis();
      if (remaining <= available) return cursor.plus({ milliseconds: remaining }).toJSDate();
      remaining -= available;
      cursor = this.dayStart(cursor.plus({ days: 1 }));
    }
    throw new Error('Working-hours calculation exceeded the calendar range');
  }

  /** `from` − `hours` of working time (legacy negative TAT, e.g. "remind 4h before due"). */
  subtractWorkingHours(from: Date, hours: number): Date {
    if (!Number.isFinite(hours)) throw new Error('hours must be finite');
    if (hours < 0) return this.addWorkingHours(from, -hours);
    let remaining = Math.round(hours * MS_PER_HOUR);
    let cursor = this.toZone(from);

    for (let i = 0; i < MAX_DAYS; i++) {
      if (!this.isWorkingDay(cursor)) {
        cursor = this.dayEnd(cursor.minus({ days: 1 }));
        continue;
      }
      const dayStart = this.dayStart(cursor);
      const dayEnd = this.dayEnd(cursor);
      if (cursor > dayEnd) cursor = dayEnd;
      if (cursor <= dayStart) {
        cursor = this.dayEnd(cursor.minus({ days: 1 }));
        continue;
      }
      const available = cursor.toMillis() - dayStart.toMillis();
      if (remaining <= available) return cursor.minus({ milliseconds: remaining }).toJSDate();
      remaining -= available;
      cursor = this.dayEnd(cursor.minus({ days: 1 }));
    }
    throw new Error('Working-hours calculation exceeded the calendar range');
  }

  /** Working hours elapsed between a and b (negative if b < a). Used for delay reporting. */
  workingHoursBetween(a: Date, b: Date): number {
    if (b.getTime() < a.getTime()) return -this.workingHoursBetween(b, a);
    const from = this.toZone(a);
    const to = this.toZone(b);
    let total = 0;
    let day = from.startOf('day');
    for (let i = 0; i < MAX_DAYS && day <= to; i++) {
      if (this.isWorkingDay(day)) {
        const s = DateTime.max(this.dayStart(day), from);
        const e = DateTime.min(this.dayEnd(day), to);
        if (e > s) total += e.toMillis() - s.toMillis();
      }
      day = day.plus({ days: 1 });
    }
    return total / MS_PER_HOUR;
  }

  /** Next working-day shift start at or after `date` (used to schedule reminders). */
  nextWorkingStart(date: Date): Date {
    return this.addWorkingHours(date, 0);
  }

  private toZone(d: Date | DateTime): DateTime {
    return (d instanceof Date ? DateTime.fromJSDate(d) : d).setZone(this.config.timezone);
  }

  private dayStart(d: DateTime): DateTime {
    return d.set({ hour: this.start.hour, minute: this.start.minute, second: 0, millisecond: 0 });
  }

  private dayEnd(d: DateTime): DateTime {
    return d.set({ hour: this.end.hour, minute: this.end.minute, second: 0, millisecond: 0 });
  }
}

function parseHm(value: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}", expected HH:mm`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${value}"`);
  return { hour, minute };
}
