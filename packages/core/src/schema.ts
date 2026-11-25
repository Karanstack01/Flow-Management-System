/**
 * Workflow definition schema.
 *
 * Replaces the legacy "Settings" tab. Every reference is by stable `key`, never by
 * column index, so adding/removing fields no longer requires renumbering rules
 * (legacy addFields/deleteFields).
 */
import { z } from 'zod';
import { formulaReferences } from './formula.js';
import { RULE_RECORD_VALUES, ruleReferences } from './rule.js';

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'email',
  'phone',
  'date',
  'datetime',
  'checkbox',
  'select', // legacy dropdown_Itm / dropdown_Rng / dropdown-search
  'multiselect', // legacy dropdown-multiple-search
  'combobox', // legacy dropdown-input (suggestions, free text allowed)
  'dependent-select', // legacy dropdown-dependent
  'file',
  'user-email', // auto-filled with the submitting user's email
  'computed', // legacy formula / Formula-Nowrap / formula_long
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** What a Dependent Dropdown can hang off: one chosen value (Country → State → City chains allowed). */
export const DEPENDENT_PARENT_TYPES: readonly FieldType[] = ['select', 'combobox', 'dependent-select'];

export const CONDITION_OPS = ['empty', 'not_empty', 'is_true', 'is_false', 'eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lower_snake_case starting with a letter');

const groupName = z.string().trim().min(1).max(64).transform((s) => s.toUpperCase());

export const conditionSchema = z.object({
  field: keySchema,
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export const conditionGroupSchema = z.object({
  mode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).default([]),
});
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;

/** Turn-around time. Negative hours mean "before the base time" (legacy negative TAT). */
export const tatRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), hours: z.number().finite() }),
  z.object({
    kind: z.literal('by_field'),
    field: keySchema,
    map: z.record(z.string(), z.number().finite()),
    defaultHours: z.number().finite().optional(),
  }),
]);
export type TatRule = z.infer<typeof tatRuleSchema>;

export const timeBaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('previous_stage') }),
  z.object({ kind: z.literal('created') }),
  z.object({ kind: z.literal('field'), field: keySchema }),
]);
export type TimeBase = z.infer<typeof timeBaseSchema>;

export const plannedRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  /** Planned time is typed in by a user (legacy TS_MANUAL). */
  z.object({ mode: z.literal('manual') }),
  /** Planned time = base + TAT in working hours (legacy TS_TAT). */
  z.object({ mode: z.literal('tat'), base: timeBaseSchema, tat: tatRuleSchema }),
]);
export type PlannedRule = z.infer<typeof plannedRuleSchema>;

export const completionRuleSchema = z.discriminatedUnion('kind', [
  /** Done as soon as the record is created (intake stage). */
  z.object({ kind: z.literal('on_create') }),
  /** A user clicks "Mark done". */
  z.object({ kind: z.literal('manual') }),
  /** Auto-stamped when conditions hold (legacy TS_Data + column H). */
  z.object({ kind: z.literal('conditions'), when: conditionGroupSchema }),
]);
export type CompletionRule = z.infer<typeof completionRuleSchema>;

export const fieldDefSchema = z.object({
  key: keySchema,
  label: z.string().trim().min(1).max(120),
  type: z.enum(FIELD_TYPES),
  stageKey: keySchema,
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  /** Stored but never rendered in forms/tables (legacy HIDDEN). */
  hidden: z.boolean().default(false),
  /** Used as the record's display title / search key (legacy SEARCHKEY). */
  searchKey: z.boolean().default(false),
  /** Pinned to the left in the grid (legacy FREEZE). */
  frozen: z.boolean().default(false),
  /** Part of the repeating line-item group on the intake form (legacy question type "Dynamic"). */
  lineItem: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  /** Admin-managed option list (legacy dropdown_Rng sheet range). Resolved into `options` at runtime. */
  optionSetKey: keySchema.optional(),
  /** dependent-select: parent field + parent value -> allowed children. */
  dependsOn: keySchema.optional(),
  optionMap: z.record(z.string(), z.array(z.string())).optional(),
  /** computed: arithmetic expression over other numeric fields, e.g. `qty * rate`. */
  expression: z.string().max(500).optional(),
  viewGroups: z.array(groupName).default(['ALL']),
  editGroups: z.array(groupName).default(['ALL']),
  width: z.number().int().min(40).max(800).optional(),
  helpText: z.string().max(300).optional(),
  /** Input placeholder text shown in the form. */
  placeholder: z.string().max(200).optional(),
  /** Default value pre-filled in the form. */
  defaultValue: z.string().max(500).optional(),
  /** For file fields: allow uploading multiple files. */
  allowMultiple: z.boolean().optional(),
  /** Validation rule (see rule.ts): TRUE / blank = valid, FALSE = invalid, other text = the error message. */
  validationRule: z.string().max(1000).optional(),
  /** Whether field is restricted to assigned users only. */
  fieldAccessRestricted: z.boolean().optional(),
  /** Users assigned to this field (email strings). */
  fieldUsers: z.array(z.object({ email: z.string().trim().toLowerCase().max(254), role: z.enum(['Viewer', 'Editor']) })).max(500).optional(),
  /** Include in repeating rows table (alias for lineItem, used for non-intake stages). */
  inRepeatingTable: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

export const stageGuardSchema = z.union([
  z.object({
    cases: z.array(conditionGroupSchema).min(1).max(10),
    take: z.union([z.number().int().min(0).max(9), z.literal('else')]),
  }),
  z.object({ when: conditionGroupSchema, negate: z.boolean().default(false) }),
]);
export type StageGuardInput = z.infer<typeof stageGuardSchema>;
/** Normalised guard: the switch form. */
export interface SwitchGuard {
  cases: ConditionGroup[];
  take: number | 'else';
}
export const normalizeGuard = (g: StageGuardInput): SwitchGuard => ('cases' in g ? g : { cases: [g.when], take: g.negate ? 'else' : 0 });

const httpsLink = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https:\/\//i.test(u), 'Use an https:// link');

export const DOCUMENT_FORMATS = ['pdf', 'doc'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/**
 * Document step (legacy "autocrat"): when the stage starts, the body is filled with the record's
 * values and saved as a PDF / Word file in a file field of the stage. With `requireReview` the stage
 * waits for someone to check the document and mark it done; otherwise it completes by itself.
 */
export const documentConfigSchema = z.object({
  /** File field (in this stage) that receives the generated document — its label is the column header. */
  fieldKey: keySchema,
  /** File name template, e.g. `Quote {{record_number}} {{customer}}`; the extension is added. */
  fileName: z.string().trim().max(200).default('Document {{record_number}}'),
  requireReview: z.boolean().default(true),
  /** custom = the body below; all_fields = a table of every field and its value. */
  source: z.enum(['custom', 'all_fields']).default('custom'),
  format: z.enum(DOCUMENT_FORMATS).default('pdf'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  /** Rich-text / HTML body with {{field}} tags. */
  body: z.string().max(200_000).default(''),
});
export type DocumentConfig = z.infer<typeof documentConfigSchema>;

export const stageDefSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#64748b'),
  /** Groups that own this stage: notified on hand-off, reminders and digests (legacy column M). */
  responsibleGroups: z.array(groupName).default([]),
  /** Stage is skipped when this evaluates false once it is reached (legacy conditional TS_TAT). */
  applicableWhen: conditionGroupSchema.optional(),
  /**
   * Branch path from Depends-on nodes on the canvas, outermost first. The stage applies only when
   * every guard holds. A guard is a switch: the cases are checked in order, the first match wins,
   * and `take` says which case this stage belongs to (`else` = none matched).
   * The older `{ when, negate }` form (one condition, Yes / No) is still accepted.
   */
  guards: z.array(stageGuardSchema).max(20).optional(),
  /**
   * Stage Jump: when this stage is done and `when` holds, go to stage `to`. Forward jumps skip the
   * stages in between; backward jumps reopen `to` … this stage for another round (rework) and clear
   * `clearFields` so the redone stages are filled in again.
   */
  jumps: z
    .array(
      z.object({
        when: conditionGroupSchema,
        to: keySchema,
        clearFields: z.array(keySchema).max(100).default([]),
        label: z.string().trim().max(80).optional(),
      }),
    )
    .max(10)
    .optional(),
  planned: plannedRuleSchema.default({ mode: 'none' }),
  completion: completionRuleSchema.default({ kind: 'manual' }),
  // Settings below are optional so older definitions stay valid; unset means the default noted.
  // ── Stage update options ──────────────────────────────────────────────
  /** Allow editing one record at a time via the entry form (default true). */
  singleUpdate: z.boolean().optional(),
  /** Allow updating multiple records for this stage from the table or bulk tool. */
  bulkUpdate: z.boolean().optional(),
  // ── Basic settings ────────────────────────────────────────────────────
  /** Header colour for this stage's column in the All Entries table. */
  headerColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Make stage data read-only once the stage is completed. */
  lockAfterComplete: z.boolean().optional(),
  // ── Planned time (fixed hours + minutes) ──────────────────────────────
  plannedHours: z.number().int().min(0).optional(),
  plannedMinutes: z.number().int().min(0).max(59).optional(),
  /** Key of the stage node used as TAT start. */
  tatFromStageKey: keySchema.optional(),
  /** Key of a date field within that stage to use as start timestamp. */
  tatFromField: keySchema.optional(),
  /** Add extra time offset to the planned baseline. */
  addExtraTime: z.boolean().optional(),
  /** Use a date field's value directly as the planned deadline. */
  useFieldAsPlanned: z.boolean().optional(),
  // ── Public form ───────────────────────────────────────────────────────
  /** Expose this stage's form publicly (no login required). */
  publicForm: z.boolean().optional(),
  // ── Thank-you message ─────────────────────────────────────────────────
  showThankYou: z.boolean().optional(),
  thankYouText: z.string().max(2000).optional(),
  // ── Stage access control ──────────────────────────────────────────────
  /** Only the listed users (and admins) may see this stage's fields; Editors may also fill them in and complete it. */
  stageAccessRestricted: z.boolean().optional(),
  stageUsers: z.array(z.object({ email: z.string().trim().toLowerCase().max(254), role: z.enum(['Viewer', 'Editor']) })).max(500).optional(),
  // ── Shown above the stage's form ──────────────────────────────────────
  description: z.string().max(2000).optional(),
  /** Instruction video (YouTube, Google Drive or any https embed link). */
  video: z.object({ title: z.string().trim().max(120).optional(), url: httpsLink }).optional(),
  /** Public link id of the intake form (set when public access is first switched on). */
  publicFormId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  /** Document step: generates a file into `document.fieldKey` when the stage starts. */
  document: documentConfigSchema.optional(),
});
export type StageDef = z.infer<typeof stageDefSchema>;

export const workflowDefSchema = z
  .object({
    key: keySchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    stages: z.array(stageDefSchema).min(1).max(50),
    fields: z.array(fieldDefSchema).max(500),
  })
  .superRefine((wf, ctx) => {
    const stageKeys = new Set<string>();
    wf.stages.forEach((s, i) => {
      if (stageKeys.has(s.key)) ctx.addIssue({ code: 'custom', path: ['stages', i, 'key'], message: `Duplicate stage key "${s.key}"` });
      stageKeys.add(s.key);
    });

    const fieldKeys = new Map<string, FieldDef>();
    wf.fields.forEach((f, i) => {
      if (fieldKeys.has(f.key)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `Duplicate field key "${f.key}"` });
      fieldKeys.set(f.key, f);
      if (!stageKeys.has(f.stageKey)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'stageKey'], message: `Unknown stage "${f.stageKey}"` });
    });

    const first = wf.stages[0];
    if (first && first.completion.kind !== 'on_create') {
      ctx.addIssue({ code: 'custom', path: ['stages', 0, 'completion'], message: 'The first (intake) stage must complete on_create' });
    }
    if (first && first.planned.mode !== 'none') {
      ctx.addIssue({ code: 'custom', path: ['stages', 0, 'planned'], message: 'The intake stage has no planned time' });
    }

    const refField = (key: string, path: (string | number)[]) => {
      if (!fieldKeys.has(key)) ctx.addIssue({ code: 'custom', path, message: `Unknown field "${key}"` });
    };
    const refGroup = (g: ConditionGroup | undefined, path: (string | number)[]) =>
      g?.conditions.forEach((c, ci) => refField(c.field, [...path, 'conditions', ci, 'field']));

    wf.stages.forEach((s, i) => {
      refGroup(s.applicableWhen, ['stages', i, 'applicableWhen']);
      s.guards?.forEach((g, gi) => normalizeGuard(g).cases.forEach((c, ci) => refGroup(c, ['stages', i, 'guards', gi, 'cases', ci])));
      if (i === 0 && s.guards?.length) ctx.addIssue({ code: 'custom', path: ['stages', 0, 'guards'], message: 'The intake stage can not be inside a branch' });
      s.jumps?.forEach((j, ji) => {
        refGroup(j.when, ['stages', i, 'jumps', ji, 'when']);
        j.clearFields.forEach((f, fi) => refField(f, ['stages', i, 'jumps', ji, 'clearFields', fi]));
        const target = wf.stages.findIndex((x) => x.key === j.to);
        if (target < 0) ctx.addIssue({ code: 'custom', path: ['stages', i, 'jumps', ji, 'to'], message: `Unknown stage "${j.to}"` });
        else if (target === i) ctx.addIssue({ code: 'custom', path: ['stages', i, 'jumps', ji, 'to'], message: 'A stage can not jump to itself' });
        else if (target === 0) ctx.addIssue({ code: 'custom', path: ['stages', i, 'jumps', ji, 'to'], message: 'Jumps can not go back to the intake form' });
        if (!j.when.conditions.length) ctx.addIssue({ code: 'custom', path: ['stages', i, 'jumps', ji, 'when'], message: 'A jump needs at least one condition' });
      });
      if (s.completion.kind === 'conditions') refGroup(s.completion.when, ['stages', i, 'completion', 'when']);
      if (s.publicForm && i !== 0) ctx.addIssue({ code: 'custom', path: ['stages', i, 'publicForm'], message: `${s.name}: only the intake form can be public` });
      if (s.stageAccessRestricted && (s.stageUsers ?? []).some((u) => !/^[^\s@]+@[^\s@]+$/.test(u.email))) {
        ctx.addIssue({ code: 'custom', path: ['stages', i, 'stageUsers'], message: `${s.name}: stage access lists an invalid email` });
      }
      if (s.document) {
        if (i === 0) ctx.addIssue({ code: 'custom', path: ['stages', 0, 'document'], message: 'The intake form can not be a document step' });
        const f = fieldKeys.get(s.document.fieldKey);
        if (!f || f.type !== 'file' || f.stageKey !== s.key) ctx.addIssue({ code: 'custom', path: ['stages', i, 'document', 'fieldKey'], message: `${s.name}: the document needs a file field in its own stage` });
      }
      if (s.planned.mode === 'tat') {
        if (s.planned.base.kind === 'field') refField(s.planned.base.field, ['stages', i, 'planned', 'base', 'field']);
        if (s.planned.tat.kind === 'by_field') refField(s.planned.tat.field, ['stages', i, 'planned', 'tat', 'field']);
      }
    });

    wf.fields.forEach((f, i) => {
      if (f.type === 'dependent-select') {
        const path = ['fields', i, 'dependsOn'];
        if (!f.dependsOn) ctx.addIssue({ code: 'custom', path, message: `${f.label}: a dependent dropdown needs the field it depends on` });
        else if (f.dependsOn === f.key) ctx.addIssue({ code: 'custom', path, message: `${f.label}: a dropdown can not depend on itself` });
        else {
          refField(f.dependsOn, path);
          const parent = fieldKeys.get(f.dependsOn);
          const stageIndex = (k: string) => wf.stages.findIndex((s) => s.key === k);
          if (parent && !DEPENDENT_PARENT_TYPES.includes(parent.type)) {
            ctx.addIssue({ code: 'custom', path, message: `${f.label}: it can only depend on a Dropdown, Dropdown + free text or another Dependent Dropdown` });
          } else if (parent && stageIndex(parent.stageKey) > stageIndex(f.stageKey)) {
            ctx.addIssue({ code: 'custom', path, message: `${f.label}: “${parent.label}” is filled in a later stage, so it can not be chosen first` });
          } else if (parent?.lineItem && !f.lineItem) {
            ctx.addIssue({ code: 'custom', path, message: `${f.label}: “${parent.label}” is a repeating-row field, so this field must be one too` });
          }
          // Country → State → City is fine; City → … → City is a loop.
          const seen = new Set([f.key]);
          for (let p = parent; p?.type === 'dependent-select' && p.dependsOn; p = fieldKeys.get(p.dependsOn)) {
            if (seen.has(p.dependsOn)) {
              ctx.addIssue({ code: 'custom', path, message: `${f.label}: dependent dropdowns depend on each other in a loop` });
              break;
            }
            seen.add(p.dependsOn);
          }
        }
      }
      if (f.type === 'computed') {
        if (!f.expression) {
          ctx.addIssue({ code: 'custom', path: ['fields', i, 'expression'], message: 'computed fields need an expression' });
        } else {
          try {
            formulaReferences(f.expression).forEach((k) => refField(k, ['fields', i, 'expression']));
          } catch (e) {
            ctx.addIssue({ code: 'custom', path: ['fields', i, 'expression'], message: `Invalid expression: ${(e as Error).message}` });
          }
        }
      }
      if (f.validationRule?.trim()) {
        try {
          ruleReferences(f.validationRule)
            .filter((k) => k !== 'value' && !RULE_RECORD_VALUES.some((r) => r.name === k))
            .forEach((k) => refField(k, ['fields', i, 'validationRule']));
        } catch (e) {
          ctx.addIssue({ code: 'custom', path: ['fields', i, 'validationRule'], message: `${f.label}: invalid validation rule — ${(e as Error).message}` });
        }
      }
      if (f.fieldAccessRestricted && (f.fieldUsers ?? []).some((u) => !/^[^\s@]+@[^\s@]+$/.test(u.email))) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'fieldUsers'], message: `${f.label}: field access lists an invalid email` });
      }
      if (f.lineItem && f.stageKey !== first?.key) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'lineItem'], message: 'Line-item fields must belong to the intake stage' });
      }
    });
  });
export type WorkflowDef = z.infer<typeof workflowDefSchema>;
export type WorkflowDefInput = z.input<typeof workflowDefSchema>;

export const calendarSchema = z
  .object({
    /** IANA zone, e.g. "Asia/Kolkata" (legacy used offsets such as "GMT+05:30"). */
    timezone: z.string().min(1),
    shiftStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    shiftEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** ISO weekday numbers that are off: 1 = Monday … 7 = Sunday. */
    weeklyOff: z.array(z.number().int().min(1).max(7)).default([7]),
    /** Holiday dates as yyyy-MM-dd in the calendar's timezone. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  })
  .refine((c) => c.shiftStart < c.shiftEnd, { message: 'shiftStart must be before shiftEnd', path: ['shiftEnd'] })
  .refine((c) => c.weeklyOff.length < 7, { message: 'At least one working weekday is required', path: ['weeklyOff'] });
export type CalendarConfig = z.infer<typeof calendarSchema>;

/**
 * Workflow automation settings — replaces the scattered Settings!AE:AQ cells
 * (reminder tiers, hand-off, pending digest, report hours/recipients, archive
 * trigger, FMS post connections).
 */
export const CHANNELS = ['email', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Reports that can be emailed on a schedule (legacy Rep_Stage, Rep_Pending, Rep_Activity_Funnel, Rep_Ord_Status, Rep_Step). */
export const REPORT_KINDS = ['summary', 'pending', 'funnel', 'matrix', 'missing'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
const hourOfDay = z.number().int().min(0).max(23);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const phoneNumber = z.string().trim().regex(/^\+?[\d\s()-]{6,20}$/, 'Phone numbers need digits only, with the country code');

export const workflowSettingsSchema = z.object({
  channels: z.array(z.enum(CHANNELS)).default(['email']),
  /** Legacy AE18: send reminders/digests on holidays too. */
  sendOnHolidays: z.boolean().default(false),
  /**
   * Notify a stage's responsible groups when the stage becomes active (legacy onformsubmit).
   * `batch`: like the legacy sheet, one message per person every few minutes listing all their new
   * tasks, instead of one message per record.
   */
  handoff: z.object({ enabled: z.boolean().default(true), batch: z.boolean().default(false) }).default({}),
  /**
   * Remind before the planned time (legacy reminder tiers, Settings rows 3–6). `hoursBefore` is the
   * first level; `tiers` add more, each either fixed working hours or a share of the stage's TAT.
   */
  upcoming: z
    .object({
      enabled: z.boolean().default(false),
      hoursBefore: z.number().min(0).max(240).default(2),
      tiers: z
        .array(z.object({ kind: z.enum(['hours', 'percent']), value: z.number().min(0).max(1000) }))
        .max(4)
        .default([]),
    })
    .default({}),
  /** Daily overdue digest per responsible group (legacy sendpending, AK7). */
  overdueDigest: z.object({ enabled: z.boolean().default(true), hour: hourOfDay.default(9) }).default({}),
  /**
   * Scheduled reports (legacy Rep_* PDFs at up to four times a day, AK12:AK19): which reports, when,
   * and to whom by email (as a PDF attachment) and WhatsApp.
   */
  summaryReport: z
    .object({
      enabled: z.boolean().default(false),
      hour: hourOfDay.default(18),
      /** Up to four send times; empty = `hour` only. */
      hours: z.array(hourOfDay).max(4).default([]),
      reports: z.array(z.enum(REPORT_KINDS)).min(1).default(['summary', 'pending']),
      recipients: z.array(z.string().email()).default([]),
      cc: z.array(z.string().email()).default([]),
      whatsapp: z.array(phoneNumber).max(20).default([]),
      /** Attach the report as a PDF (email). */
      pdf: z.boolean().default(true),
      /** "Fields still empty" report: the stage it checks (default: every active stage). */
      missingStage: keySchema.optional(),
    })
    .default({}),
  /** Records table: default sort and row colours (legacy Settings AF58/AF60 and AF64:AF66). */
  table: z
    .object({
      defaultSort: z.object({ by: z.string().min(1).max(64), dir: z.enum(['asc', 'desc']) }).optional(),
      rowColors: z
        .array(z.object({ when: conditionGroupSchema, color: hexColor, label: z.string().trim().max(60).optional() }))
        .max(20)
        .default([]),
    })
    .default({}),
  /**
   * AI reports (legacy AI tab): every N hours, the matching records' chosen fields go to the
   * organization's AI connection with the prompt, and the answer is emailed / sent on WhatsApp.
   */
  aiReports: z
    .array(
      z.object({
        key: keySchema,
        name: z.string().trim().min(1).max(120),
        enabled: z.boolean().default(true),
        prompt: z.string().trim().min(1).max(4000),
        when: conditionGroupSchema.default({ mode: 'all', conditions: [] }),
        fields: z.array(keySchema).max(60).default([]),
        everyHours: z.number().int().min(1).max(168).default(24),
        recipients: z.array(z.string().email()).default([]),
        whatsapp: z.array(phoneNumber).max(20).default([]),
      }),
    )
    .max(10)
    .default([]),
  /** Auto-archive (legacy Archive!D1/H1 + archive trigger). */
  archive: z
    .object({
      enabled: z.boolean().default(false),
      when: conditionGroupSchema.default({ mode: 'all', conditions: [] }),
      /** Only archive records whose flow finished at least N days ago. */
      completedDaysAgo: z.number().int().min(0).default(7),
    })
    .default({}),
  /** Outbound webhooks (legacy post_data to other sheets). */
  webhooks: z
    .array(
      z.object({
        key: keySchema,
        url: z.string().url(),
        secret: z.string().min(16).optional(),
        when: conditionGroupSchema,
        fields: z.array(keySchema).default([]),
        /** Only fire once this stage is done (set by connecting a Webhook node to a stage on the canvas). */
        afterStage: keySchema.optional(),
      }),
    )
    .default([]),
});
export type WebhookDef = WorkflowSettings['webhooks'][number];
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

/**
 * Custom notification rule — replaces one row of the legacy Messages tab.
 * Recipients/subject/body are templates ({{field}} or <<Label>>). Delivery is
 * de-duplicated per (rule, record, period) in NotificationLog instead of
 * "<Rule> Reminder Status" columns that users could edit.
 */
export const notificationRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().default(true),
    trigger: z.discriminatedUnion('type', [
      z.object({ type: z.literal('condition'), when: conditionGroupSchema }),
      z.object({ type: z.literal('stage_activated'), stageKey: keySchema }),
      z.object({ type: z.literal('stage_completed'), stageKey: keySchema }),
      z.object({ type: z.literal('stage_overdue'), stageKey: keySchema }),
    ]),
    /** Re-send every N days while the trigger still holds (legacy repatreminder). */
    repeatEveryDays: z.number().int().min(1).max(365).optional(),
    email: z
      .object({
        to: z.string().min(1).max(1000),
        cc: z.string().max(1000).optional(),
        subject: z.string().min(1).max(300),
        body: z.string().min(1).max(20000),
        /** Sender name shown to recipients (legacy Messages "From" / AK21 alias); the address stays the connection's. */
        fromName: z.string().trim().max(80).optional(),
        /** File fields whose files are attached — uploads and generated documents (legacy attachments / autocrat). */
        attachments: z.array(keySchema).max(10).default([]),
      })
      .optional(),
    whatsapp: z
      .object({
        to: z.string().min(1).max(500),
        /** Free text. Official WhatsApp only delivers this inside the 24-hour customer-service window. */
        body: z.string().max(4000).default(''),
        /** Pre-approved template (required to start a conversation on official WhatsApp). */
        template: z
          .object({
            name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Template names are lower_snake_case'),
            language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).optional(),
            /** Body variables {{1}}, {{2}}… — each may use {{field}} / <<Label>> placeholders. */
            params: z.array(z.string().max(1000)).max(20).default([]),
          })
          .optional(),
      })
      .refine((w) => w.body.trim() || w.template, { message: 'Enter a message or an approved template', path: ['body'] })
      .optional(),
  })
  .refine((r) => r.email || r.whatsapp, { message: 'Configure at least one channel', path: ['email'] });
export type NotificationRuleDef = z.infer<typeof notificationRuleSchema>;

export type FieldValue = string | number | boolean | string[] | null;
export type RecordData = Record<string, FieldValue | undefined>;
