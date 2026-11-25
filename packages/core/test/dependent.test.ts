import { describe, expect, it } from 'vitest';
import { dependentOptions, dependentsOf, parentChoices, staleDependents, validateRecordInput, workflowDefSchema, type FieldDef } from '../src/index.js';

const base = { required: false, unique: false, hidden: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] };
const country: FieldDef = { ...base, key: 'country', label: 'Country', type: 'select', stageKey: 'intake', options: ['India', 'UAE'] };
const state: FieldDef = { ...base, key: 'state', label: 'State', type: 'dependent-select', stageKey: 'intake', dependsOn: 'country', optionMap: { India: ['Maharashtra', 'Delhi'], UAE: ['Dubai'] } };
const city: FieldDef = { ...base, key: 'city', label: 'City', type: 'dependent-select', stageKey: 'intake', dependsOn: 'state', optionMap: { Maharashtra: ['Mumbai', 'Pune'], Delhi: ['New Delhi'], Dubai: ['Deira'] } };
const fields = [country, state, city];

describe('dependent dropdowns', () => {
  it('offer the choices of the parent value, nothing before it is chosen', () => {
    expect(dependentOptions(state, 'India')).toEqual(['Maharashtra', 'Delhi']);
    expect(dependentOptions(state, '')).toEqual([]);
    expect(dependentOptions(state, 'Nepal')).toEqual([]);
  });

  it('clear values the new parent no longer offers, all the way down the chain', () => {
    expect(staleDependents(fields, { country: 'UAE', state: 'Maharashtra', city: 'Mumbai' })).toEqual({ state: null, city: null });
    expect(staleDependents(fields, { country: 'India', state: 'Maharashtra', city: 'Mumbai' })).toEqual({});
    // Only below the field that changed: an old city value is left alone when an unrelated field is edited.
    expect(staleDependents(fields, { country: 'India', state: 'Delhi', city: 'Mumbai' }, ['remarks'])).toEqual({});
    expect(staleDependents(fields, { country: 'India', state: 'Delhi', city: 'Mumbai' }, ['state'])).toEqual({ city: null });
    expect(dependentsOf(fields, 'country')).toEqual(['state', 'city']);
  });

  it('give the editor the parent choices, also for a dependent parent', () => {
    expect(parentChoices(fields, 'country')).toEqual(['India', 'UAE']);
    expect(parentChoices(fields, 'state')).toEqual(['Maharashtra', 'Delhi', 'Dubai']);
  });

  it('are validated against the parent on save', () => {
    const opts = { mode: 'update' as const, editable: new Set(['country', 'state', 'city']), timezone: 'Asia/Kolkata' };
    expect(validateRecordInput(fields, { country: 'India', state: 'Delhi' }, opts).errors).toEqual({});
    expect(validateRecordInput(fields, { country: 'UAE', state: 'Delhi' }, opts).errors.state).toBeDefined();
  });

  it('must depend on an earlier dropdown, without loops', () => {
    const def = (fs: FieldDef[], stages = [{ key: 'intake', name: 'Intake', completion: { kind: 'on_create' } }, { key: 'review', name: 'Review' }]) => workflowDefSchema.safeParse({ key: 'wf', name: 'Wf', stages, fields: fs });
    expect(def(fields).success).toBe(true);
    // The parent is filled in a later stage.
    expect(def([{ ...country, stageKey: 'review' }, state, city]).success).toBe(false);
    // A loop: state depends on city.
    expect(def([country, { ...state, dependsOn: 'city' }, city]).success).toBe(false);
    // Only dropdown-like parents.
    expect(def([{ ...country, type: 'text', options: undefined }, state, city]).success).toBe(false);
  });
});
