import { Plus, Trash2 } from 'lucide-react';
import { CONDITION_OPS, type Condition, type ConditionGroup, type ConditionOp } from '@fms/core';
import { Button, Input, Select } from './ui';

export interface ConditionField {
  key: string;
  label: string;
  options?: string[];
}

const OP_LABELS: Record<ConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  in: 'is one of',
  empty: 'is empty',
  not_empty: 'is not empty',
  is_true: 'is checked / true',
  is_false: 'is not checked',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};
const NO_VALUE: ConditionOp[] = ['empty', 'not_empty', 'is_true', 'is_false'];

/** Visual editor for the condition DSL (record filters, stage rules, row filters, notification triggers). */
export function ConditionEditor({ fields, value: raw, onChange }: { fields: ConditionField[]; value: ConditionGroup | undefined; onChange: (g: ConditionGroup) => void }) {
  // Tolerate a missing or partial group (older data) instead of crashing the page.
  const value: ConditionGroup = { mode: raw?.mode ?? 'all', conditions: Array.isArray(raw?.conditions) ? raw.conditions : [] };
  const update = (i: number, patch: Partial<Condition>) => onChange({ ...value, conditions: value.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    // Container query: lays out by the space it is given (side panel vs full page), not the screen.
    <div className="@container space-y-2">
      {value.conditions.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          Match
          <Select className="w-auto" value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as 'all' | 'any' })}>
            <option value="all">all conditions (AND)</option>
            <option value="any">any condition (OR)</option>
          </Select>
        </div>
      )}
      {value.conditions.map((c, i) => {
        const field = fields.find((f) => f.key === c.field);
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-xl border border-line/70 p-2 @xl:grid-cols-[1fr_10rem_1fr_auto] @xl:border-0 @xl:p-0">
            <Select aria-label="Field" className="col-span-3 @xl:col-span-1" value={c.field} onChange={(e) => update(i, { field: e.target.value })}>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Operator" value={c.op} onChange={(e) => update(i, { op: e.target.value as ConditionOp, value: NO_VALUE.includes(e.target.value as ConditionOp) ? undefined : c.value })}>
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </Select>
            {NO_VALUE.includes(c.op) ? (
              <span />
            ) : field?.options?.length && (c.op === 'eq' || c.op === 'neq') ? (
              <Select aria-label="Value" value={String(c.value ?? '')} onChange={(e) => update(i, { value: e.target.value })}>
                <option value="">—</option>
                {field.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : (
              <Input
                aria-label="Value"
                placeholder={c.op === 'in' ? 'a, b, c' : 'value'}
                value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}
                onChange={(e) => update(i, { value: c.op === 'in' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value })}
              />
            )}
            <Button variant="ghost" size="sm" aria-label="Remove condition" onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, j) => j !== i) })} icon={<Trash2 className="size-4" />} />
          </div>
        );
      })}
      <Button
        size="sm"
        icon={<Plus className="size-4" />}
        disabled={!fields.length}
        onClick={() => onChange({ ...value, conditions: [...value.conditions, { field: fields[0]!.key, op: 'eq', value: '' }] })}
      >
        Add condition
      </Button>
    </div>
  );
}
