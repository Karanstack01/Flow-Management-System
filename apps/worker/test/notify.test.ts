import { describe, expect, it } from 'vitest';
import { isRetryable, layout, MAX_ATTEMPTS, splitList, table } from '../src/notify.js';
import { periodKey } from '../src/jobs/record-changed.js';

describe('notify helpers', () => {
  it('splits recipient lists on commas, semicolons and whitespace', () => {
    expect(splitList(' a@x.com, b@y.com;c@z.com  d@w.com ')).toEqual(['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com']);
    expect(splitList(undefined)).toEqual([]);
  });

  it('escapes titles and headers in HTML output', () => {
    expect(layout('<script>', 'body')).toContain('&lt;script&gt;');
    expect(table(['<b>'], [['ok']])).toContain('&lt;b&gt;');
  });

  it('retries failed deliveries with back-off and recovers stale claims, but never sent ones', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    expect(isRetryable({ status: 'failed', attempts: 1, updatedAt: ago(4) }, now)).toBe(false); // waits 5 min
    expect(isRetryable({ status: 'failed', attempts: 1, updatedAt: ago(6) }, now)).toBe(true);
    expect(isRetryable({ status: 'failed', attempts: 3, updatedAt: ago(15) }, now)).toBe(false); // waits 20 min
    expect(isRetryable({ status: 'failed', attempts: 3, updatedAt: ago(21) }, now)).toBe(true);
    expect(isRetryable({ status: 'failed', attempts: MAX_ATTEMPTS, updatedAt: ago(999) }, now)).toBe(false); // gives up
    expect(isRetryable({ status: 'pending', attempts: 1, updatedAt: ago(5) }, now)).toBe(false); // still in flight
    expect(isRetryable({ status: 'pending', attempts: 1, updatedAt: ago(11) }, now)).toBe(true); // crashed
    expect(isRetryable({ status: 'sent', attempts: 1, updatedAt: ago(999) }, now)).toBe(false);
    expect(isRetryable({ status: 'skipped', attempts: 1, updatedAt: ago(999) }, now)).toBe(false);
  });

  it('derives stable repeat periods', () => {
    const t = new Date('2026-01-22T10:00:00Z');
    expect(periodKey(undefined, t)).toBe('once');
    expect(periodKey(1, t)).toBe(periodKey(1, new Date('2026-01-22T23:59:59Z')));
    expect(periodKey(1, t)).not.toBe(periodKey(1, new Date('2026-01-23T00:00:01Z')));
  });
});
