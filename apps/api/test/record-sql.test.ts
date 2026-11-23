import { describe, expect, it } from 'vitest';
import { BusinessCalendar, workflowDefSchema, type Principal } from '@fms/core';
import type { LoadedWorkflow } from '@fms/db';
import { conditionSql, groupSql, listSql } from '../src/lib/record-sql.js';
import { buildListQuery } from '../src/routes/records.js';
import type { AuthUser } from '../src/plugins/auth.js';

const def = workflowDefSchema.parse({
  key: 'orders',
  name: 'Orders',
  stages: [
    { key: 'intake', name: 'Intake', completion: { kind: 'on_create' } },
    { key: 'approval', name: 'Approval', responsibleGroups: ['MANAGER'], planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 4 } } },
  ],
  fields: [
    { key: 'customer', label: 'Customer', type: 'text', stageKey: 'intake', searchKey: true },
    { key: 'qty', label: 'Qty', type: 'number', stageKey: 'intake' },
    { key: 'secret', label: 'Margin', type: 'number', stageKey: 'approval', viewGroups: ['MANAGER'], editGroups: ['MANAGER'] },
  ],
});

const wf: LoadedWorkflow = {
  id: 'wf1',
  orgId: 'org1',
  key: 'orders',
  name: 'Orders',
  version: 1,
  isActive: true,
  def,
  settings: {} as LoadedWorkflow['settings'],
  calendar: new BusinessCalendar({ timezone: 'UTC', shiftStart: '09:00', shiftEnd: '17:00', weeklyOff: [6, 7], holidays: [] }),
  calendarId: 'cal1',
  options: new Map(),
};

const user = (groups: string[], extra: Partial<Principal> = {}): AuthUser => ({ userId: 'u', orgId: 'org1', homeOrgId: 'org1', email: 'u@x.com', name: 'U', groups, capabilities: new Set(), ...extra });

describe('record SQL builder', () => {
  it('binds field keys and values as parameters (no string interpolation)', () => {
    const evil = "x'); DROP TABLE \"Record\"; --";
    const sql = conditionSql({ field: 'customer', op: 'eq', value: evil });
    expect(sql.sql).not.toContain('DROP TABLE');
    expect(sql.values).toContain('customer');
    expect(sql.values).toContain(evil.toLowerCase());
  });

  it('joins groups with AND / OR and treats empty groups as TRUE', () => {
    expect(groupSql({ mode: 'all', conditions: [] }).sql).toBe('TRUE');
    const any = groupSql({ mode: 'any', conditions: [{ field: 'qty', op: 'gt', value: 5 }, { field: 'customer', op: 'empty' }] });
    expect(any.sql).toContain(' OR ');
    expect(any.values).toContain(5);
  });

  it('applies the row filter and escapes LIKE wildcards in search', () => {
    const q = buildListQuery(wf, user(['SALES'], { rowFilter: { mode: 'all', conditions: [{ field: 'customer', op: 'eq', value: 'Acme' }] } }), { search: '50%_off' });
    const sql = listSql(q);
    expect(sql.values).toContain('acme');
    expect(sql.values).toContain('%50\\%\\_off%');
    // search only spans visible fields
    expect(q.searchKeys).toEqual(['customer', 'qty']);
  });

  it('rejects filtering or sorting on fields the user cannot see', () => {
    const filters = JSON.stringify({ mode: 'all', conditions: [{ field: 'secret', op: 'gt', value: 10 }] });
    expect(() => buildListQuery(wf, user(['SALES']), { filters })).toThrow(/Cannot filter on secret/);
    expect(() => buildListQuery(wf, user(['SALES']), { sort: 'secret' })).toThrow(/Invalid sort/);
    expect(() => buildListQuery(wf, user(['MANAGER']), { filters, sort: 'secret' })).not.toThrow();
  });

  it('limits "my tasks" to stages the user owns', () => {
    expect(buildListQuery(wf, user(['MANAGER']), { mine: 'true' }).activeStageKeys).toEqual(['approval']);
    expect(listSql(buildListQuery(wf, user(['SALES']), { mine: 'true' })).sql).toContain('FALSE');
  });
});
