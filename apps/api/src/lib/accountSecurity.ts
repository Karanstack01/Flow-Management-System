/**
 * Account Security & Brute-Force Lockout State Machine.
 * Formalizes user login security states:
 * - 'unlocked': 0 failed attempts
 * - 'counting': 1..4 failed attempts
 * - 'locked': >= 5 failed attempts within lockout window
 */

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

export type AccountSecurityState =
  | { status: 'unlocked' }
  | { status: 'counting'; failedAttempts: number; remainingAttempts: number }
  | { status: 'locked'; lockedUntil: Date; remainingMs: number };

export interface AccountSecurityRecord {
  failedLogins: number;
  lockedUntil: Date | null;
}

export function accountSecurityStatus(record: AccountSecurityRecord, now = new Date()): AccountSecurityState {
  if (record.lockedUntil && record.lockedUntil > now) {
    return {
      status: 'locked',
      lockedUntil: record.lockedUntil,
      remainingMs: record.lockedUntil.getTime() - now.getTime(),
    };
  }

  // If previous lock has expired, failed count resets
  const count = record.lockedUntil && record.lockedUntil <= now ? 0 : record.failedLogins;
  if (count <= 0) {
    return { status: 'unlocked' };
  }

  return {
    status: 'counting',
    failedAttempts: count,
    remainingAttempts: Math.max(0, MAX_FAILED - count),
  };
}

export function onLoginFailure(record: AccountSecurityRecord, now = new Date()): {
  failedLogins: number;
  lockedUntil: Date | null;
  newStatus: 'counting' | 'locked';
} {
  // A lock that has run out starts a fresh count
  const baseFailed = record.lockedUntil && record.lockedUntil <= now ? 0 : record.failedLogins;
  const failed = baseFailed + 1;
  const isLocked = failed >= MAX_FAILED;
  const lockedUntil = isLocked ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;

  return {
    failedLogins: failed,
    lockedUntil,
    newStatus: isLocked ? 'locked' : 'counting',
  };
}

export function onLoginSuccess(): {
  failedLogins: number;
  lockedUntil: null;
} {
  return {
    failedLogins: 0,
    lockedUntil: null,
  };
}
