import { describe, expect, it } from 'vitest';
import {
  accountSecurityStatus,
  MAX_FAILED,
  onLoginFailure,
  onLoginSuccess,
} from '../src/lib/accountSecurity.js';

describe('accountSecurity state machine', () => {
  const now = new Date('2026-11-23T12:00:00Z');

  it('reports unlocked when 0 failed logins and no lock', () => {
    const s = accountSecurityStatus({ failedLogins: 0, lockedUntil: null }, now);
    expect(s.status).toBe('unlocked');
  });

  it('reports counting when failedLogins > 0 but < MAX_FAILED', () => {
    const s = accountSecurityStatus({ failedLogins: 2, lockedUntil: null }, now);
    expect(s.status).toBe('counting');
    if (s.status === 'counting') {
      expect(s.failedAttempts).toBe(2);
      expect(s.remainingAttempts).toBe(3);
    }
  });

  it('reports locked when lockedUntil is in the future', () => {
    const future = new Date(now.getTime() + 10 * 60_000);
    const s = accountSecurityStatus({ failedLogins: 5, lockedUntil: future }, now);
    expect(s.status).toBe('locked');
    if (s.status === 'locked') {
      expect(s.remainingMs).toBe(10 * 60_000);
    }
  });

  it('resets to unlocked when lock has expired', () => {
    const past = new Date(now.getTime() - 1 * 60_000);
    const s = accountSecurityStatus({ failedLogins: 5, lockedUntil: past }, now);
    expect(s.status).toBe('unlocked');
  });

  it('increments failed count and locks on 5th failure', () => {
    let rec = { failedLogins: 0, lockedUntil: null };
    for (let i = 1; i <= 4; i++) {
      const step = onLoginFailure(rec, now);
      expect(step.failedLogins).toBe(i);
      expect(step.newStatus).toBe('counting');
      expect(step.lockedUntil).toBeNull();
      rec = { failedLogins: step.failedLogins, lockedUntil: step.lockedUntil };
    }

    const lockStep = onLoginFailure(rec, now);
    expect(lockStep.failedLogins).toBe(MAX_FAILED);
    expect(lockStep.newStatus).toBe('locked');
    expect(lockStep.lockedUntil).not.toBeNull();
    expect(lockStep.lockedUntil?.getTime()).toBe(now.getTime() + 15 * 60_000);
  });

  it('resets to 0 on login success', () => {
    const res = onLoginSuccess();
    expect(res.failedLogins).toBe(0);
    expect(res.lockedUntil).toBeNull();
  });
});
