/**
 * Condition evaluation — typed replacement for the legacy "col:NULL,col:NOT NULL,col:value"
 * strings (Settings column H, Messages B/D, Archive D1/H1, user row filters X).
 */
import type { Condition, ConditionGroup, FieldValue, RecordData } from './schema.js';

export function isEmptyValue(v: FieldValue | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function isTruthyValue(v: FieldValue | undefined): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', 'yes', '1', 'y'].includes(v.trim().toLowerCase());
  return false;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

function toComparable(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function evaluateCondition(c: Condition, data: RecordData): boolean {
  const v = data[c.field];
  switch (c.op) {
    case 'empty':
      return isEmptyValue(v);
    case 'not_empty':
      return !isEmptyValue(v);
    case 'is_true':
      return isTruthyValue(v);
    case 'is_false':
      return !isTruthyValue(v);
    case 'eq':
    case 'neq': {
      const target = norm(c.value);
      const hit = Array.isArray(v) ? v.some((x) => norm(x) === target) : norm(v) === target;
      return c.op === 'eq' ? hit : !hit;
    }
    case 'in': {
      const list = (Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',')).map(norm);
      return Array.isArray(v) ? v.some((x) => list.includes(norm(x))) : list.includes(norm(v));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(v);
      const b = toComparable(c.value);
      if (a === null || b === null) return false;
      if (c.op === 'gt') return a > b;
      if (c.op === 'gte') return a >= b;
      if (c.op === 'lt') return a < b;
      return a <= b;
    }
  }
}

/** Empty groups are vacuously true. */
export function evaluateGroup(group: ConditionGroup | undefined, data: RecordData): boolean {
  if (!group || group.conditions.length === 0) return true;
  return group.mode === 'any'
    ? group.conditions.some((c) => evaluateCondition(c, data))
    : group.conditions.every((c) => evaluateCondition(c, data));
}
