/**
 * Report computations — replaces the legacy Rep_Stage, Rep_Pending, Rep_Activity_Funnel
 * and Rep_Ord_Status sheets with pure functions over stage states. Delay is measured
 * in *working* hours via the business calendar.
 */
import type { BusinessCalendar } from './calendar.js';
import { isEmptyValue } from './conditions.js';
import type { FieldDef, RecordData, StageDef } from './schema.js';
import type { StageState, StageStatus } from './timeline.js';

export interface ReportRecord {
  id: string;
  number: number;
  title?: string;
  stages: readonly StageState[];
}

export interface StageSummaryRow {
  stageKey: string;
  stageName: string;
  color: string;
  /** Active, planned in the future. */
  upcoming: number;
  /** Active, planned time passed. */
  overdue: number;
  /** Active without a planned time. */
  unplanned: number;
  doneOnTime: number;
  doneLate: number;
  skipped: number;
  /** Records that reached this stage (active + done). */
  total: number;
  avgOverdueHours: number;
}

export interface PendingTask {
  recordId: string;
  recordNumber: number;
  title?: string;
  stageKey: string;
  plannedAt: Date | null;
  overdue: boolean;
  /** Working hours past plan (positive) or remaining (negative). */
  delayHours: number | null;
}

export function stageSummary(records: readonly ReportRecord[], stages: readonly StageDef[], now: Date, cal: BusinessCalendar): StageSummaryRow[] {
  return stages.slice(1).map((stage) => {
    const row: StageSummaryRow = {
      stageKey: stage.key,
      stageName: stage.name,
      color: stage.color,
      upcoming: 0,
      overdue: 0,
      unplanned: 0,
      doneOnTime: 0,
      doneLate: 0,
      skipped: 0,
      total: 0,
      avgOverdueHours: 0,
    };
    let overdueHours = 0;
    for (const r of records) {
      const s = r.stages.find((x) => x.stageKey === stage.key);
      if (!s) continue;
      if (s.status === 'skipped') row.skipped++;
      if (s.status === 'active') {
        row.total++;
        if (!s.plannedAt) row.unplanned++;
        else if (s.plannedAt.getTime() < now.getTime()) {
          row.overdue++;
          overdueHours += cal.workingHoursBetween(s.plannedAt, now);
        } else row.upcoming++;
      }
      if (s.status === 'done') {
        row.total++;
        if (s.plannedAt && s.actualAt && s.actualAt.getTime() > s.plannedAt.getTime()) row.doneLate++;
        else row.doneOnTime++;
      }
    }
    row.avgOverdueHours = row.overdue ? Math.round((overdueHours / row.overdue) * 10) / 10 : 0;
    return row;
  });
}

export function pendingTasks(records: readonly ReportRecord[], now: Date, cal: BusinessCalendar, opts: { overdueOnly?: boolean } = {}): PendingTask[] {
  const tasks: PendingTask[] = [];
  for (const r of records) {
    for (const s of r.stages) {
      if (s.status !== 'active') continue;
      const overdue = !!s.plannedAt && s.plannedAt.getTime() < now.getTime();
      if (opts.overdueOnly && !overdue) continue;
      tasks.push({
        recordId: r.id,
        recordNumber: r.number,
        title: r.title,
        stageKey: s.stageKey,
        plannedAt: s.plannedAt,
        overdue,
        delayHours: s.plannedAt ? Math.round(cal.workingHoursBetween(s.plannedAt, now) * 10) / 10 : null,
      });
    }
  }
  return tasks.sort((a, b) => (b.delayHours ?? -Infinity) - (a.delayHours ?? -Infinity));
}

export interface MissingFieldsRow {
  recordId: string;
  recordNumber: number;
  title?: string;
  stageKey: string;
  /** Labels of the step's fields that are still empty; required ones first. */
  missing: { key: string; label: string; required: boolean }[];
}

/**
 * Legacy Rep_Step: for each record at a step (its active step, or only `stageKey`), which of that
 * step's fields are still empty. Hidden, calculated and automatic fields are not counted; records
 * with nothing missing are left out.
 */
export function missingFields(
  records: readonly (ReportRecord & { data: RecordData })[],
  stages: readonly StageDef[],
  fields: readonly FieldDef[],
  opts: { stageKey?: string; visible?: ReadonlySet<string> } = {},
): MissingFieldsRow[] {
  const out: MissingFieldsRow[] = [];
  const docFields = new Set(stages.flatMap((s) => (s.document ? [s.document.fieldKey] : [])));
  const countable = (f: FieldDef) => !f.hidden && !['computed', 'user-email'].includes(f.type) && !docFields.has(f.key) && (!opts.visible || opts.visible.has(f.key));
  for (const r of records) {
    for (const s of r.stages) {
      if (s.status !== 'active' || (opts.stageKey && s.stageKey !== opts.stageKey)) continue;
      const missing = fields
        .filter((f) => f.stageKey === s.stageKey && countable(f) && (isEmptyValue(r.data[f.key]) || (f.required && r.data[f.key] === false)))
        .map((f) => ({ key: f.key, label: f.label, required: f.required }))
        .sort((a, b) => Number(b.required) - Number(a.required));
      if (missing.length) out.push({ recordId: r.id, recordNumber: r.number, title: r.title, stageKey: s.stageKey, missing });
    }
  }
  return out.sort((a, b) => b.missing.filter((m) => m.required).length - a.missing.filter((m) => m.required).length || a.recordNumber - b.recordNumber);
}

/** Legacy Rep_Ord_Status: record × stage matrix. */
export function statusMatrix(records: readonly ReportRecord[], stages: readonly StageDef[]): Array<{ recordId: string; recordNumber: number; title?: string; cells: Record<string, StageStatus> }> {
  return records.map((r) => ({
    recordId: r.id,
    recordNumber: r.number,
    title: r.title,
    cells: Object.fromEntries(stages.map((st) => [st.key, r.stages.find((s) => s.stageKey === st.key)?.status ?? 'waiting'])),
  }));
}
