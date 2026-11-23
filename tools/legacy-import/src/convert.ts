/**
 * Legacy Settings tab → WorkflowDef.
 *
 * Decodes the column-index based conventions documented in docs/LEGACY_ANALYSIS.md §3:
 * field rows (A..P), stage list (S:T), TS_* timeline columns, "col:COND" dependency
 * strings and JSON TAT maps. Everything that cannot be translated mechanically is
 * reported as a warning instead of being silently dropped.
 */
import { DateTime } from 'luxon';
import {
  workflowDefSchema,
  type Condition,
  type FieldDef,
  type FieldType,
  type FieldValue,
  type RecordData,
  type StageDef,
  type TatRule,
  type TimeBase,
  type WorkflowDef,
} from '@fms/core';

export type ColumnTarget =
  | { kind: 'field'; key: string; type: FieldType; linksKey?: string }
  | { kind: 'planned' | 'actual'; stageKey: string };

export interface ConvertResult {
  definition: WorkflowDef;
  /** Legacy Data column index → where its values go. */
  columns: Map<number, ColumnTarget>;
  warnings: string[];
}

interface LegacyRow {
  col: number;
  label: string;
  flags: string;
  type: string;
  source: string;
  stageNo: number;
  deps: string;
  hours: string;
  bg: string;
  qtype: string;
  notify: string;
  view: string;
  edit: string;
  width: string;
}

const TYPE_MAP: Record<string, FieldType> = {
  text: 'text',
  number: 'number',
  email: 'email',
  date: 'date',
  'datetime-local': 'datetime',
  textarea: 'textarea',
  checkbox: 'checkbox',
  file: 'file',
  tel: 'phone',
  dropdown_Itm: 'select',
  dropdown_Rng: 'select',
  'dropdown-search': 'select',
  'dropdown-multiple-search': 'multiselect',
  'dropdown-input': 'combobox',
  'dropdown-dependent': 'dependent-select',
  useremail: 'user-email',
};
const FORMULA = new Set(['formula', 'Formula-Nowrap', 'formula_long', 'htmlformula']);
const PLANNED = new Set(['TS_TAT', 'TS_MANUAL', 'TS_Formula']);

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 60) || 'field';

const groups = (s: string) => s.split(',').map((g) => g.trim().toUpperCase()).filter(Boolean);
const isRange = (s: string) => s.includes('!') || /^\$?[A-Z]{1,3}\$?\d*:\$?[A-Z]{1,3}\$?\d*$/i.test(s.trim());

function tokens(deps: string): { col: number; cond: string }[] {
  return deps
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const i = t.indexOf(':');
      return { col: Number(t.slice(0, i)), cond: t.slice(i + 1).trim() };
    })
    .filter((t) => Number.isFinite(t.col));
}

export function convertSettings(rows: string[][], opts: { key: string; name: string }): ConvertResult {
  const warnings: string[] = [];
  const cell = (r: string[], i: number) => (r[i] ?? '').trim();
  const fieldRows: LegacyRow[] = rows
    .slice(1)
    .filter((r) => cell(r, 1) && cell(r, 0) !== '' && Number.isFinite(Number(cell(r, 0))))
    .map((r) => ({
      col: Number(cell(r, 0)),
      label: cell(r, 1),
      flags: cell(r, 2).toUpperCase(),
      type: cell(r, 3),
      source: cell(r, 4),
      stageNo: Number(cell(r, 6)) || 1,
      deps: cell(r, 7),
      hours: cell(r, 8),
      bg: cell(r, 9),
      qtype: cell(r, 10),
      notify: cell(r, 12),
      view: cell(r, 13),
      edit: cell(r, 14),
      width: cell(r, 15),
    }));

  // ---- stages (S:T), falling back to stage numbers used by fields
  let stageList = rows
    .slice(1)
    .filter((r) => cell(r, 18) && Number.isFinite(Number(cell(r, 19))))
    .map((r) => ({ no: Number(cell(r, 19)), name: cell(r, 18) }));
  if (!stageList.length) stageList = [...new Set(fieldRows.map((f) => f.stageNo))].map((no) => ({ no, name: `Stage ${no}` }));
  stageList.sort((a, b) => a.no - b.no);
  if (stageList[0]?.no !== 1) stageList.unshift({ no: 1, name: 'Intake' });

  const usedStageKeys = new Set<string>();
  const stageKeyByNo = new Map<number, string>();
  for (const s of stageList) {
    let k = slug(s.name);
    while (usedStageKeys.has(k)) k = `${k}_${s.no}`;
    usedStageKeys.add(k);
    stageKeyByNo.set(s.no, k);
  }
  const intakeKey = stageKeyByNo.get(1)!;
  const stageKeyFor = (no: number, label: string) => {
    const k = stageKeyByNo.get(no);
    if (!k) warnings.push(`"${label}" references unknown stage ${no}; moved to intake`);
    return k ?? intakeKey;
  };

  // ---- columns & fields
  const columns = new Map<number, ColumnTarget>();
  const fields: FieldDef[] = [];
  const usedKeys = new Set<string>();
  const uniqueKey = (label: string) => {
    let k = slug(label);
    for (let n = 2; usedKeys.has(k); n++) k = `${slug(label)}_${n}`;
    usedKeys.add(k);
    return k;
  };

  for (const r of fieldRows) {
    if (r.type === 'TS_Data') {
      columns.set(r.col, { kind: 'actual', stageKey: stageKeyFor(r.stageNo, r.label) });
      continue;
    }
    if (PLANNED.has(r.type)) {
      columns.set(r.col, { kind: 'planned', stageKey: stageKeyFor(r.stageNo, r.label) });
      continue;
    }
    if (r.type === 'send_status') {
      warnings.push(`"${r.label}" (send_status) dropped — delivery is tracked in the notification log`);
      continue;
    }
    let type: FieldType = TYPE_MAP[r.type] ?? 'text';
    if (!TYPE_MAP[r.type] && !FORMULA.has(r.type)) warnings.push(`"${r.label}": unknown type "${r.type}" imported as text`);
    const formula = FORMULA.has(r.type);
    if (formula) {
      type = 'text';
      warnings.push(`"${r.label}" was a sheet formula; imported read-only. Convert it to a computed field with an expression if needed`);
    }
    const stageKey = stageKeyFor(r.stageNo, r.label);
    const key = uniqueKey(r.label);
    const f: FieldDef = {
      key,
      label: r.label.slice(0, 120),
      type,
      stageKey,
      required: r.flags.includes('REQUIRED') && !formula,
      unique: /UNIQUE(?!LABEL)/.test(r.flags),
      hidden: r.flags.includes('HIDDEN'),
      searchKey: r.flags.includes('SEARCHKEY'),
      frozen: r.flags.includes('FREEZE'),
      lineItem: r.qtype === 'Dynamic' && stageKey === intakeKey,
      // The legacy intake form showed every stage-1 field to creators regardless of groups.
      viewGroups: r.view ? groups(r.view) : stageKey === intakeKey ? ['ALL'] : [],
      editGroups: formula ? [] : r.edit ? groups(r.edit) : stageKey === intakeKey ? ['ALL'] : [],
      width: Number(r.width) >= 40 && Number(r.width) <= 800 ? Math.round(Number(r.width)) : undefined,
    };
    if (['select', 'multiselect', 'combobox'].includes(type) && r.source) {
      if (isRange(r.source)) {
        f.optionSetKey = slug(r.source.split('!')[0]!.replace(/'/g, '')).slice(0, 64);
        warnings.push(`"${r.label}": options came from range ${r.source}; create option set "${f.optionSetKey}" (Calendars & lists)`);
      } else {
        f.options = r.source.replace(/'/g, '').split(',').map((o) => o.trim()).filter(Boolean);
      }
    }
    if (type === 'dependent-select') {
      warnings.push(`"${r.label}": dependent options came from range ${r.source || '(none)'}; fill optionMap in the designer`);
    }
    fields.push(f);
    const target: ColumnTarget = { kind: 'field', key, type };
    if (type === 'file') {
      // Drive links cannot become uploaded files automatically; keep them visible.
      const linksKey = uniqueKey(`${r.label} legacy links`);
      fields.push({ ...f, key: linksKey, label: `${f.label} (legacy links)`.slice(0, 120), type: 'textarea', required: false, unique: false, lineItem: f.lineItem, editGroups: [] });
      target.linksKey = linksKey;
    }
    columns.set(r.col, target);
  }

  const fieldAt = (col: number) => {
    const t = columns.get(col);
    return t?.kind === 'field' ? fields.find((f) => f.key === t.key) : undefined;
  };
  const toCondition = (fieldKey: string, cond: string): Condition => {
    const c = cond.toUpperCase();
    if (c === 'NULL') return { field: fieldKey, op: 'empty' };
    if (c === 'NOT NULL') return { field: fieldKey, op: 'not_empty' };
    if (c === 'TRUE') return { field: fieldKey, op: 'is_true' };
    if (c === 'FALSE') return { field: fieldKey, op: 'is_false' };
    return { field: fieldKey, op: 'eq', value: cond };
  };

  // dependent selects: "parentCol:DEPEND"
  for (const r of fieldRows) {
    if (TYPE_MAP[r.type] !== 'dependent-select') continue;
    const parent = tokens(r.deps).find((t) => t.cond.toUpperCase() === 'DEPEND');
    const f = fieldAt(r.col);
    const pf = parent ? fieldAt(parent.col) : undefined;
    if (f && pf) f.dependsOn = pf.key;
    else if (f) {
      f.type = 'select';
      warnings.push(`"${r.label}": no parent found for dependent dropdown; imported as select`);
    }
  }

  // ---- stage rules
  const stages: StageDef[] = stageList.map((s, index) => {
    const key = stageKeyByNo.get(s.no)!;
    const own = fieldRows.filter((r) => r.stageNo === s.no);
    const color = own.map((r) => r.bg).find((c) => /^#[0-9a-f]{6}$/i.test(c)) ?? '#64748b';
    const responsibleGroups = [...new Set(own.flatMap((r) => groups(r.notify)))];
    if (index === 0) return { key, name: s.name, color, responsibleGroups, planned: { mode: 'none' }, completion: { kind: 'on_create' } };

    const plannedRow = own.find((r) => PLANNED.has(r.type));
    const actualRow = own.find((r) => r.type === 'TS_Data');
    if (!plannedRow) warnings.push(`Stage "${s.name}" has no planned-time column; it will have no deadline`);
    if (!actualRow) warnings.push(`Stage "${s.name}" has no actual-time column; it completes manually`);

    const applicable: Condition[] = [];
    let planned: StageDef['planned'] = { mode: 'none' };
    if (plannedRow?.type === 'TS_MANUAL') planned = { mode: 'manual' };
    else if (plannedRow?.type === 'TS_Formula') {
      planned = { mode: 'manual' };
      warnings.push(`Stage "${s.name}": planned time was a sheet formula; converted to manual planning`);
    } else if (plannedRow) {
      let base: TimeBase = { kind: 'previous_stage' };
      let keyField: string | undefined;
      for (const t of tokens(plannedRow.deps)) {
        const target = columns.get(t.col);
        const cond = t.cond.toUpperCase();
        if (cond === 'TIME') {
          if (target?.kind === 'actual') {
            const prevKey = stageKeyByNo.get(stageList[index - 1]!.no);
            if (target.stageKey === prevKey) base = { kind: 'previous_stage' };
            else if (target.stageKey === intakeKey) base = { kind: 'created' };
            else warnings.push(`Stage "${s.name}": TAT counted from a non-adjacent stage; using previous stage`);
          } else if (target?.kind === 'field' && (target.type === 'date' || target.type === 'datetime')) base = { kind: 'field', field: target.key };
          else warnings.push(`Stage "${s.name}": TIME column ${t.col} is not a date; using previous stage`);
        } else if (cond === 'CONDITION') {
          keyField = target?.kind === 'field' ? target.key : undefined;
        } else if (target?.kind === 'field') {
          applicable.push(toCondition(target.key, t.cond));
        } // conditions on timeline columns are implied by sequential stages
      }
      let tat: TatRule = { kind: 'fixed', hours: 8 };
      const n = Number(plannedRow.hours);
      if (plannedRow.hours !== '' && Number.isFinite(n)) tat = { kind: 'fixed', hours: n };
      else {
        try {
          const map = JSON.parse(plannedRow.hours) as Record<string, number>;
          if (keyField) tat = { kind: 'by_field', field: keyField, map };
          else warnings.push(`Stage "${s.name}": TAT map without a CONDITION column; using 8h`);
        } catch {
          warnings.push(`Stage "${s.name}": TAT "${plannedRow.hours}" not understood; using 8h`);
        }
      }
      planned = { mode: 'tat', base, tat };
    }

    const doneWhen: Condition[] = [];
    for (const t of tokens(actualRow?.deps ?? '')) {
      const target = columns.get(t.col);
      if (target?.kind === 'field') doneWhen.push(toCondition(target.key, t.cond));
    }
    return {
      key,
      name: s.name,
      color,
      responsibleGroups,
      applicableWhen: applicable.length ? { mode: 'all', conditions: applicable } : undefined,
      planned,
      completion: doneWhen.length ? { kind: 'conditions', when: { mode: 'all', conditions: doneWhen } } : { kind: 'manual' },
    };
  });

  const parsed = workflowDefSchema.safeParse({ key: opts.key, name: opts.name, stages, fields });
  if (!parsed.success) throw new Error(`Converted definition is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return { definition: parsed.data, columns, warnings };
}

// ------------------------------------------------------------------ data rows

export interface ImportedRecord {
  number: number;
  data: RecordData;
  createdAt: Date;
  stages: Map<string, { plannedAt: Date | null; actualAt: Date | null }>;
}

const FORMATS = {
  dmy: ['dd/MMM/yyyy HH:mm', 'd/M/yyyy H:mm:ss', 'd/M/yyyy H:mm', 'd/M/yyyy', 'dd-MMM-yyyy HH:mm', 'dd-MMM-yyyy', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd'],
  mdy: ['dd/MMM/yyyy HH:mm', 'M/d/yyyy H:mm:ss', 'M/d/yyyy H:mm', 'M/d/yyyy', 'dd-MMM-yyyy HH:mm', 'dd-MMM-yyyy', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd'],
};

export function parseLegacyDate(v: string, zone: string, order: 'dmy' | 'mdy'): DateTime | null {
  const s = v.trim();
  if (!s) return null;
  const iso = DateTime.fromISO(s, { zone });
  if (iso.isValid) return iso;
  for (const f of FORMATS[order]) {
    const dt = DateTime.fromFormat(s, f, { zone });
    if (dt.isValid) return dt;
  }
  return null;
}

function coerce(type: FieldType, v: string, zone: string, order: 'dmy' | 'mdy'): FieldValue {
  const s = v.trim();
  if (!s) return type === 'checkbox' ? false : type === 'multiselect' ? [] : null;
  switch (type) {
    case 'number': {
      const n = Number(s.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      return ['true', 'yes', '1'].includes(s.toLowerCase());
    case 'date':
      return parseLegacyDate(s, zone, order)?.toISODate() ?? null;
    case 'datetime':
      return parseLegacyDate(s, zone, order)?.toUTC().toISO() ?? null;
    case 'multiselect':
      return s.split(',').map((x) => x.trim()).filter(Boolean);
    case 'email':
      return s.toLowerCase();
    default:
      return s;
  }
}

export function convertDataRows(rows: string[][], conv: ConvertResult, opts: { timezone: string; dateOrder: 'dmy' | 'mdy'; now?: Date }): { records: ImportedRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const intake = conv.definition.stages[0]!.key;
  const records: ImportedRecord[] = [];
  let badDates = 0;
  for (const r of rows.slice(1)) {
    const number = Number((r[0] ?? '').trim());
    if (!Number.isInteger(number) || number <= 0) continue;
    const data: RecordData = {};
    const stages = new Map<string, { plannedAt: Date | null; actualAt: Date | null }>();
    for (const [col, t] of conv.columns) {
      const raw = r[col] ?? '';
      if (t.kind === 'field') {
        if (t.type === 'file') {
          data[t.key] = [];
          if (t.linksKey && raw.trim()) data[t.linksKey] = raw.trim();
        } else data[t.key] = coerce(t.type, raw, opts.timezone, opts.dateOrder);
      } else {
        const dt = parseLegacyDate(raw, opts.timezone, opts.dateOrder);
        if (raw.trim() && !dt) badDates++;
        const s = stages.get(t.stageKey) ?? { plannedAt: null, actualAt: null };
        if (t.kind === 'planned') s.plannedAt = dt?.toJSDate() ?? null;
        else s.actualAt = dt?.toJSDate() ?? null;
        stages.set(t.stageKey, s);
      }
    }
    const createdAt = stages.get(intake)?.actualAt ?? opts.now ?? new Date();
    records.push({ number, data, createdAt, stages });
  }
  if (badDates) warnings.push(`${badDates} timeline cell(s) had unparseable dates (try --date-order mdy)`);
  return { records, warnings };
}
