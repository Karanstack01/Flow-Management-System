import { describe, expect, it } from 'vitest';
import { canvasFromDefinition, diffFlows, summarizeChanges, workflowDefSchema, workflowSettingsSchema } from '../src/index.js';
import { orderWorkflowInput } from './fixtures.js';

const settings = workflowSettingsSchema.parse({});
const base = workflowDefSchema.parse(orderWorkflowInput);

describe('version diff', () => {
  it('reports nothing for identical versions', () => {
    expect(diffFlows({ definition: base, settings }, { definition: base, settings })).toEqual([]);
    expect(summarizeChanges([])).toBe('No changes');
  });

  it('describes stage and field changes in words', () => {
    const next = workflowDefSchema.parse({
      ...orderWorkflowInput,
      name: 'Orders v2',
      stages: [...orderWorkflowInput.stages.map((s) => (s.key === 'approval' ? { ...s, name: 'Manager approval', responsibleGroups: ['MANAGER', 'HOD'] } : s)), { key: 'invoice', name: 'Invoice' }],
      fields: orderWorkflowInput.fields.filter((f) => f.key !== 'remarks').map((f) => (f.key === 'customer' ? { ...f, required: !f.required } : f)),
    });
    const changes = diffFlows({ definition: base, settings }, { definition: next, settings: { ...settings, sendOnHolidays: true } });
    const approval = changes.find((c) => c.area === 'stage' && c.kind === 'changed')!;
    expect(approval.name).toBe(`${base.stages.find((s) => s.key === 'approval')!.name} → Manager approval`);
    expect(approval.details.some((d) => d.startsWith('Owners:') && d.endsWith('MANAGER, HOD'))).toBe(true);
    expect(changes.some((c) => c.kind === 'added' && c.area === 'stage' && c.name === 'Invoice')).toBe(true);
    expect(changes.some((c) => c.kind === 'removed' && c.area === 'field')).toBe(true);
    expect(changes.some((c) => c.kind === 'changed' && c.area === 'field' && c.details.some((d) => d.startsWith('Required:')))).toBe(true);
    expect(changes.find((c) => c.area === 'settings')!.details).toEqual(['Send on holidays: off → on']);
    expect(changes.find((c) => c.area === 'flow')!.details[0]).toContain('→ Orders v2');
    // Renaming a stage is reported once, on the stage — not again on each of its fields.
    expect(changes.some((c) => c.area === 'field' && c.details.some((d) => d.startsWith('Stage:')))).toBe(false);
    // Adding a stage at the end does not "move" the others.
    expect(changes.some((c) => c.details.some((d) => d.startsWith('Moved')))).toBe(false);
    expect(summarizeChanges(changes)).toMatch(/stages?, \d+ fields?, settings, name/);
  });

  it('reports canvas moves and reconnections only when both versions have a canvas', () => {
    const canvas = canvasFromDefinition(base, settings);
    const moved = { ...canvas, nodes: canvas.nodes.map((n, i) => (i === 0 ? { ...n, x: n.x + 100 } : n)) };
    const changes = diffFlows({ definition: base, settings, canvas }, { definition: base, settings, canvas: moved });
    expect(changes).toEqual([{ kind: 'changed', area: 'layout', name: 'Canvas', details: ['1 step moved'] }]);
    expect(diffFlows({ definition: base, canvas: null }, { definition: base, canvas: moved })).toEqual([]);
  });
});
