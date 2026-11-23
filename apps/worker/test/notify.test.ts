import { describe, expect, it } from 'vitest';
import { evaluateNotificationTransition, isRetryable, layout, MAX_ATTEMPTS, splitList, table } from '../src/notify.js';
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

  describe('evaluateNotificationTransition (Notification Delivery Machine)', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    it('allows pending -> sent on settle_success', () => {
      const res = evaluateNotificationTransition({ status: 'pending', attempts: 1, updatedAt: now }, 'settle_success', now);
      expect(res.allowed).toBe(true);
      expect(res.nextStatus).toBe('sent');
    });

    it('rejects settle_success when not pending', () => {
      const res = evaluateNotificationTransition({ status: 'sent', attempts: 1, updatedAt: now }, 'settle_success', now);
      expect(res.allowed).toBe(false);
    });

    it('transitions to failed with backoff when attempts < MAX_ATTEMPTS, or dead when max reached', () => {
      const fail1 = evaluateNotificationTransition({ status: 'pending', attempts: 1, updatedAt: now }, 'settle_fail', now);
      expect(fail1.allowed).toBe(true);
      expect(fail1.nextStatus).toBe('failed');
      expect(fail1.delayMs).toBe(5 * 60_000);

      const failMax = evaluateNotificationTransition({ status: 'pending', attempts: MAX_ATTEMPTS, updatedAt: now }, 'settle_fail', now);
      expect(failMax.allowed).toBe(true);
      expect(failMax.nextStatus).toBe('dead');
    });

    it('validates retry eligibility on reclaim', () => {
      const ago5 = new Date(now.getTime() - 5 * 60_000);
      const ago20 = new Date(now.getTime() - 20 * 60_000);
      expect(evaluateNotificationTransition({ status: 'failed', attempts: 1, updatedAt: ago5 }, 'reclaim', now).allowed).toBe(false);
      expect(evaluateNotificationTransition({ status: 'failed', attempts: 1, updatedAt: ago20 }, 'reclaim', now).allowed).toBe(true);
    });
  });
});
