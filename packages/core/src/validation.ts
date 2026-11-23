/**
 * Record input validation & coercion — replaces legacy dataSubmit()/updatedata()
 * checks (REQUIRED, UNIQUE, email, datetime formatting, file handling), but runs on
 * the server for every write and rejects writes to fields the user cannot edit.
 */
import { DateTime } from 'luxon';
import { evaluateFormula } from './formula.js';
import { isEmptyValue } from './conditions.js';
import { checkRule, type RuleContext, type RuleValue } from './rule.js';
import type { FieldDef, FieldValue, RecordData } from './schema.js';

export interface ValidateOptions {
  mode: 'create' | 'update';
  /** Keys the caller may write. */
  editable: ReadonlySet<string>;
  /** Keys whose `required` flag is enforced (e.g. intake-stage fields on create). */
  requiredScope?: ReadonlySet<string>;
  /** Existing data merged under the input — needed for dependent selects. */
  existing?: RecordData;
  /** Resolved option lists for select-like fields (from option sets). */
  options?: ReadonlyMap<string, readonly string[]>;
  timezone: string;
  /** Record values available to validation rules (RECORD_NUMBER, CREATED_BY, …). */
  ruleContext?: RuleContext['record'];
}

export interface ValidationResult {
  data: RecordData;
  errors: Record<string, string>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s()-]{6,20}$/;
const MAX_TEXT = 10_000;
const SYSTEM_TYPES = new Set(['computed', 'user-email']);

class FieldError extends Error {}

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new FieldError('Expected text');
}

function optionsFor(field: FieldDef, opts: ValidateOptions): readonly string[] | undefined {
  return opts.options?.get(field.key) ?? field.options;
}

function coerce(field: FieldDef, raw: unknown, opts: ValidateOptions, merged: RecordData): FieldValue {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'combobox': {
      const s = asString(raw);
      if (s.length > MAX_TEXT) throw new FieldError(`Max ${MAX_TEXT} characters`);
      return s || null;
    }
    case 'phone': {
      const s = asString(raw);
      if (s && !PHONE.test(s)) throw new FieldError('Invalid phone number');
      return s || null;
    }
    case 'email': {
      const s = asString(raw).toLowerCase();
      if (s && !EMAIL.test(s)) throw new FieldError('Invalid email');
      return s || null;
    }
    case 'number': {
      if (raw === null || raw === undefined || raw === '') return null;
      const n = typeof raw === 'number' ? raw : Number(asString(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new FieldError('Expected a number');
      return n;
    }
    case 'checkbox':
      if (typeof raw === 'boolean') return raw;
      if (raw === null || raw === undefined || raw === '') return false;
      return ['true', '1', 'yes', 'on'].includes(asString(raw).toLowerCase());
    case 'date': {
      const s = asString(raw);
      if (!s) return null;
      const dt = DateTime.fromISO(s, { zone: opts.timezone });
      if (!dt.isValid) throw new FieldError('Invalid date');
      return dt.toISODate();
    }
    case 'datetime': {
      const s = asString(raw);
      if (!s) return null;
      const dt = DateTime.fromISO(s, { zone: opts.timezone });
      if (!dt.isValid || dt.year < 1971) throw new FieldError('Invalid date/time');
      return dt.toUTC().toISO();
    }
    case 'select': {
      const s = asString(raw);
      const list = optionsFor(field, opts);
      if (s && list && !list.includes(s)) throw new FieldError('Not an allowed option');
      return s || null;
    }
    case 'multiselect': {
      const arr = Array.isArray(raw) ? raw.map(asString) : asString(raw).split(',').map((x) => x.trim());
      const values = [...new Set(arr.filter(Boolean))];
      const list = optionsFor(field, opts);
      if (list) {
        const bad = values.filter((v) => !list.includes(v));
        if (bad.length) throw new FieldError(`Not allowed: ${bad.join(', ')}`);
      }
      return values;
    }
    case 'dependent-select': {
      const s = asString(raw);
      if (!s) return null;
      const parent = field.dependsOn ? merged[field.dependsOn] : undefined;
      const allowed = field.optionMap?.[asString(parent)];
      if (field.optionMap && !allowed?.includes(s)) throw new FieldError('Not allowed for the selected parent value');
      return s;
    }
    case 'file': {
      if (raw === null || raw === undefined || raw === '') return [];
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || x.length > 64)) {
        throw new FieldError('Expected a list of uploaded file ids');
      }
      const ids = [...new Set(raw as string[])];
      if (!field.allowMultiple && ids.length > 1) throw new FieldError('Only one file is allowed');
      return ids;
    }
    case 'user-email':
    case 'computed':
      return null;
  }
}

export function validateRecordInput(fields: readonly FieldDef[], input: Record<string, unknown>, opts: ValidateOptions): ValidationResult {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors: Record<string, string> = {};
  const data: RecordData = {};
  const merged: RecordData = { ...(opts.existing ?? {}), ...(input as RecordData) };

  for (const [key, raw] of Object.entries(input)) {
    const field = byKey.get(key);
    if (!field) {
      errors[key] = 'Unknown field';
      continue;
    }
    if (SYSTEM_TYPES.has(field.type)) continue; // server-managed, silently ignored
    if (!opts.editable.has(key)) {
      errors[key] = 'You are not allowed to edit this field';
      continue;
    }
    try {
      data[key] = coerce(field, raw, opts, merged);
    } catch (e) {
      errors[key] = e instanceof FieldError ? e.message : 'Invalid value';
    }
  }

  for (const key of opts.requiredScope ?? []) {
    const field = byKey.get(key);
    if (!field?.required || SYSTEM_TYPES.has(field.type) || errors[key]) continue;
    const provided = key in data;
    const value = provided ? data[key] : opts.existing?.[key];
    if ((opts.mode === 'create' || provided) && (isEmptyValue(value) || value === false)) {
      errors[key] = `${field.label} is required`;
    }
  }

  // Validation rules run on every value written in this change (blank values are left to `required`).
  const after: RecordData = { ...(opts.existing ?? {}), ...data };
  for (const [key, value] of Object.entries(data)) {
    const field = byKey.get(key);
    if (!field?.validationRule?.trim() || errors[key] || isEmptyValue(value)) continue;
    try {
      const out = checkRule(field.validationRule, { data: after, value: value as RuleValue, record: opts.ruleContext }, field.label);
      if (!out.ok) errors[key] = out.message;
    } catch {
      // A broken rule never blocks data entry; the definition validator reports it to admins.
    }
  }

  return { data, errors };
}

const NO_DEFAULT = new Set(['file', 'computed', 'user-email']);

/**
 * Default values as stored data (the server-side twin of the form's pre-fill): `TODAY` / `NOW`
 * for dates, comma lists for multi-selects. Invalid defaults (e.g. an option that was removed)
 * are dropped instead of blocking the submission. Hidden fields get their value this way.
 */
export function defaultFieldValues(fields: readonly FieldDef[], opts: { timezone: string; options?: ReadonlyMap<string, readonly string[]>; now?: Date }): RecordData {
  const now = DateTime.fromJSDate(opts.now ?? new Date()).setZone(opts.timezone);
  const raw: Record<string, unknown> = {};
  for (const f of fields) {
    const d = f.defaultValue?.trim();
    if (!d || NO_DEFAULT.has(f.type)) continue;
    const token = d.toUpperCase();
    raw[f.key] = token === 'TODAY' && (f.type === 'date' || f.type === 'datetime') ? (f.type === 'date' ? now.toISODate() : now.startOf('day').toISO()) : token === 'NOW' && (f.type === 'date' || f.type === 'datetime') ? (f.type === 'date' ? now.toISODate() : now.toISO()) : d;
  }
  const v = validateRecordInput(fields, raw, { mode: 'update', editable: new Set(Object.keys(raw)), options: opts.options, timezone: opts.timezone });
  for (const k of Object.keys(v.errors)) delete v.data[k];
  return v.data;
}

/** Fill server-managed fields: computed expressions and the submitting user's email. */
export function applySystemFields(fields: readonly FieldDef[], data: RecordData, ctx: { userEmail?: string; isCreate: boolean }): RecordData {
  const out: RecordData = { ...data };
  for (const f of fields) {
    if (f.type === 'user-email' && ctx.isCreate && ctx.userEmail) out[f.key] = ctx.userEmail;
  }
  // Computed fields may reference other computed fields: iterate to a fixed point.
  const computed = fields.filter((f) => f.type === 'computed' && f.expression);
  for (let pass = 0; pass < computed.length; pass++) {
    let changed = false;
    for (const f of computed) {
      let value: number | null;
      try {
        value = evaluateFormula(f.expression!, out);
      } catch {
        value = null;
      }
      if (out[f.key] !== value) {
        out[f.key] = value;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Fields flagged unique that carry a value — the caller checks them against the DB. */
export function uniqueValues(fields: readonly FieldDef[], data: RecordData): Array<{ key: string; label: string; value: string }> {
  return fields
    .filter((f) => f.unique && !isEmptyValue(data[f.key]))
    .map((f) => ({ key: f.key, label: f.label, value: String(data[f.key]).trim() }));
}
