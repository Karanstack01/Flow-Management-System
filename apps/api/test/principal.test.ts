import { describe, expect, it } from 'vitest';
import { effectiveOrgId, principalFromUser } from '@fms/db';

const base = {
  id: 'u1',
  orgId: 'home',
  email: 'ops@platform.test',
  name: 'Ops',
  phone: null,
  passwordHash: 'x',
  isActive: true,
  rowFilter: { mode: 'all', conditions: [{ field: 'city', op: 'eq', value: 'Delhi' }] },
  failedLogins: 0,
  lockedUntil: null,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  groups: [{ userId: 'u1', groupId: 'g1', group: { id: 'g1', orgId: 'home', name: 'store', description: null, capabilities: ['EXPORT', 'BOGUS'], createdAt: new Date() } }],
};

describe('principalFromUser', () => {
  it('regular users are pinned to their own organization even if activeOrgId is set', () => {
    const user = { ...base, isSuperAdmin: false, activeOrgId: 'other' };
    expect(effectiveOrgId(user)).toBe('home');
    const p = principalFromUser(user);
    expect(p.orgId).toBe('home');
    expect(p.groups).toEqual(['STORE']);
    expect([...p.capabilities]).toEqual(['EXPORT']);
    expect(p.isSuperAdmin).toBe(false);
  });

  it('a visiting super admin acts in the other organization without carrying home groups or row filter', () => {
    const user = { ...base, isSuperAdmin: true, activeOrgId: 'other' };
    const p = principalFromUser(user);
    expect(p).toMatchObject({ orgId: 'other', homeOrgId: 'home', groups: [], rowFilter: null, isSuperAdmin: true });
    expect(p.capabilities.size).toBe(0);
  });

  it('the worker can evaluate a visiting super admin in their home organization', () => {
    const user = { ...base, isSuperAdmin: true, activeOrgId: 'other' };
    const p = principalFromUser(user, 'home');
    expect(p.orgId).toBe('home');
    expect(p.groups).toEqual(['STORE']);
  });
});
