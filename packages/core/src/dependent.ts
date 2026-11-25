/**
 * Dependent dropdowns (legacy "dropdown-dependent"): a field whose choices depend on another
 * field's value — Country → State → City. One set of rules for the form, the editor and the server:
 *
 * - the child offers `optionMap[parent value]` (nothing until the parent is chosen);
 * - when a parent changes, a child value that is no longer offered is cleared — and so on down the
 *   chain — instead of being saved invalid (or rejected on save);
 * - the editor lists the parent's choices so the map is written against real values.
 */
import type { FieldDef, RecordData } from './schema.js';

type DependentField = Pick<FieldDef, 'key' | 'type' | 'dependsOn' | 'optionMap'>;
type OptionField = DependentField & Pick<FieldDef, 'options'>;

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** The choices a dependent dropdown offers for its parent's current value ([] until the parent is set). */
export function dependentOptions(field: Pick<FieldDef, 'optionMap'>, parentValue: unknown): string[] {
  const p = text(parentValue);
  return p ? (field.optionMap?.[p] ?? []) : [];
}

/**
 * Dependent values that are not allowed any more for their parent's value, cascading down chains.
 * Returns the keys to clear (as `null`) — empty when everything still fits.
 *
 * `changed`: only look below these fields (the ones just edited), so older values left over from an
 * earlier option list are not wiped by an unrelated edit.
 */
export function staleDependents(fields: readonly DependentField[], data: RecordData, changed?: Iterable<string>): Record<string, null> {
  const out: Record<string, null> = {};
  const now: RecordData = { ...data };
  const below = changed ? new Set([...changed].flatMap((k) => dependentsOf(fields, k))) : null;
  // A chain is at most as long as the number of dependent fields.
  const deps = fields.filter((f) => f.type === 'dependent-select' && f.dependsOn && f.optionMap && (!below || below.has(f.key)));
  for (let pass = 0; pass <= deps.length; pass++) {
    let changed = false;
    for (const f of deps) {
      const v = text(now[f.key]);
      if (!v) continue;
      if (!dependentOptions(f, now[f.dependsOn!]).includes(v)) {
        now[f.key] = null;
        out[f.key] = null;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Fields that depend on `key`, directly or further down the chain. */
export function dependentsOf(fields: readonly DependentField[], key: string): string[] {
  const out: string[] = [];
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    for (const f of fields) if (f.type === 'dependent-select' && f.dependsOn === k && !out.includes(f.key) && f.key !== key) (out.push(f.key), queue.push(f.key));
  }
  return out;
}

/** The values a parent field can have: its options, or all choices of a dependent parent. */
export function parentChoices(fields: readonly OptionField[], parentKey: string | undefined, resolved?: ReadonlyMap<string, readonly string[]>): string[] {
  const parent = fields.find((f) => f.key === parentKey);
  if (!parent) return [];
  if (parent.type === 'dependent-select') return [...new Set(Object.values(parent.optionMap ?? {}).flat())];
  return [...(resolved?.get(parent.key) ?? parent.options ?? [])];
}
