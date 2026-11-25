/**
 * Version history: what changed between two saved versions of a flow, in words an admin reads
 * ("Stage “Approval”: owners MANAGER → MANAGER, HOD"), not a JSON diff.
 */
import type { Canvas } from './canvas.js';
import type { WorkflowDef, WorkflowSettings } from './schema.js';

export interface FlowSnapshot {
  definition: WorkflowDef;
  settings?: WorkflowSettings | null;
  canvas?: Canvas | null;
}

export type ChangeArea = 'flow' | 'stage' | 'field' | 'settings' | 'message' | 'layout';

export interface FlowChange {
  kind: 'added' | 'removed' | 'changed';
  area: ChangeArea;
  /** What changed, e.g. the stage or field name. */
  name: string;
  /** One line per property, e.g. "Owners: MANAGER → MANAGER, HOD". */
  details: string[];
}

const STAGE_LABELS: Record<string, string> = {
  name: 'Name',
  color: 'Colour',
  responsibleGroups: 'Owners',
  applicableWhen: 'Applies when (Depends on)',
  guards: 'Guards',
  jumps: 'Stage Jumps',
  planned: 'Due time (TAT)',
  completion: 'Completion rule',
  singleUpdate: 'Single item update',
  bulkUpdate: 'Bulk update',
  headerColor: 'Header colour',
  lockAfterComplete: 'Lock after completion',
  publicForm: 'Public form',
  publicFormId: 'Public link',
  showThankYou: 'Thank-you message',
  thankYouText: 'Thank-you text',
  stageAccessRestricted: 'Stage access control',
  stageUsers: 'Assigned users',
  description: 'Description',
  video: 'Instruction video',
  document: 'Document settings',
};

const FIELD_LABELS: Record<string, string> = {
  label: 'Label',
  type: 'Type',
  stageKey: 'Stage',
  required: 'Required',
  unique: 'Unique',
  hidden: 'Hidden',
  searchKey: 'Search key',
  frozen: 'Frozen column',
  lineItem: 'Line item',
  options: 'Options',
  optionSetKey: 'Option set',
  dependsOn: 'Depends on field',
  optionMap: 'Dependent options',
  expression: 'Formula',
  viewGroups: 'Who can view',
  editGroups: 'Who can edit',
  width: 'Column width',
  helpText: 'Help text',
  placeholder: 'Placeholder',
  defaultValue: 'Default value',
  allowMultiple: 'Multiple files',
  validationRule: 'Validation',
  fieldAccessRestricted: 'Field access control',
  fieldUsers: 'Field users',
  inRepeatingTable: 'In repeating table',
};

const SETTINGS_LABELS: Record<string, string> = {
  channels: 'Channels',
  sendOnHolidays: 'Send on holidays',
  handoff: 'Hand-off emails',
  upcoming: 'Upcoming reminders',
  overdueDigest: 'Overdue digest',
  summaryReport: 'Summary report',
  archive: 'Auto-archive',
  webhooks: 'Webhooks',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A readable value, or null when it is too structured to show inline. */
function show(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return short(v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) || '—';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? short(v.join(', '), 60) : '—';
  return null;
}

function propLines(before: Record<string, unknown>, after: Record<string, unknown>, labels: Record<string, string>, skip: string[] = [], rename: (k: string, v: unknown) => unknown = (_k, v) => v): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !skip.includes(k));
  const lines: string[] = [];
  for (const k of keys) {
    if (same(before[k], after[k])) continue;
    const label = labels[k] ?? k;
    const a = show(rename(k, before[k]));
    const b = show(rename(k, after[k]));
    lines.push(a !== null && b !== null ? `${label}: ${a} → ${b}` : `${label} updated`);
  }
  return lines;
}

/** Changes from `before` to `after` (older → newer). */
export function diffFlows(before: FlowSnapshot, after: FlowSnapshot): FlowChange[] {
  const out: FlowChange[] = [];
  const a = before.definition;
  const b = after.definition;

  const flowLines = propLines({ name: a.name, description: a.description }, { name: b.name, description: b.description }, { name: 'Name', description: 'Description' });
  if (flowLines.length) out.push({ kind: 'changed', area: 'flow', name: b.name, details: flowLines });

  // ---- stages (by key; order changes reported as moves)
  const stageName = (def: WorkflowDef, key: string) => def.stages.find((s) => s.key === key)?.name ?? key;
  const aStages = new Map(a.stages.map((s, i) => [s.key, { s, i }]));
  const bStages = new Map(b.stages.map((s, i) => [s.key, { s, i }]));
  for (const [key, { s, i }] of bStages) {
    const old = aStages.get(key);
    if (!old) {
      out.push({ kind: 'added', area: 'stage', name: s.name, details: [`Position ${i + 1}${s.document ? ' · document step' : ''}`] });
      continue;
    }
    const lines = propLines(old.s as unknown as Record<string, unknown>, s as unknown as Record<string, unknown>, STAGE_LABELS, ['key']);
    // Position among the stages that exist in both versions, so one insertion does not "move" everything after it.
    const common = (def: WorkflowDef, other: Map<string, unknown>) => def.stages.filter((x) => other.has(x.key)).map((x) => x.key);
    const posA = common(a, bStages).indexOf(key);
    const posB = common(b, aStages).indexOf(key);
    if (posA !== posB) lines.unshift(`Moved from position ${old.i + 1} to ${i + 1}`);
    if (lines.length) out.push({ kind: 'changed', area: 'stage', name: s.name === old.s.name ? s.name : `${old.s.name} → ${s.name}`, details: lines });
  }
  for (const [key, { s }] of aStages) if (!bStages.has(key)) out.push({ kind: 'removed', area: 'stage', name: s.name, details: [] });

  // ---- fields (by key)
  const aFields = new Map(a.fields.map((f) => [f.key, f]));
  const bFields = new Map(b.fields.map((f) => [f.key, f]));
  const stageOf = (def: WorkflowDef) => (k: string, v: unknown) => (k === 'stageKey' && typeof v === 'string' ? stageName(def, v) : v);
  for (const [key, f] of bFields) {
    const old = aFields.get(key);
    if (!old) {
      out.push({ kind: 'added', area: 'field', name: f.label, details: [`${f.type} · stage “${stageName(b, f.stageKey)}”${f.required ? ' · required' : ''}`] });
      continue;
    }
    // A field moved only when its stage key changed (a renamed stage is reported on the stage).
    const lines = propLines(old as unknown as Record<string, unknown>, f as unknown as Record<string, unknown>, FIELD_LABELS, ['key', 'stageKey']);
    if (old.stageKey !== f.stageKey) lines.unshift(`Stage: ${stageOf(a)('stageKey', old.stageKey) as string} → ${stageOf(b)('stageKey', f.stageKey) as string}`);
    if (lines.length) out.push({ kind: 'changed', area: 'field', name: f.label === old.label ? f.label : `${old.label} → ${f.label}`, details: lines });
  }
  for (const [key, f] of aFields) if (!bFields.has(key)) out.push({ kind: 'removed', area: 'field', name: f.label, details: [`was in stage “${stageName(a, f.stageKey)}”`] });

  // ---- settings
  if (before.settings && after.settings) {
    const lines = propLines(before.settings as unknown as Record<string, unknown>, after.settings as unknown as Record<string, unknown>, SETTINGS_LABELS);
    if (lines.length) out.push({ kind: 'changed', area: 'settings', name: 'Flow settings', details: lines });
  }

  // ---- canvas: messages (they become notification rules) and layout
  if (before.canvas && after.canvas) {
    const msgs = (c: Canvas) => new Map(c.nodes.filter((n) => n.type === 'message').map((n) => [n.id, n.data as Record<string, unknown>]));
    const am = msgs(before.canvas);
    const bm = msgs(after.canvas);
    const label = (d: Record<string, unknown>) => (typeof d.name === 'string' && d.name) || 'Message';
    for (const [id, d] of bm) {
      const old = am.get(id);
      if (!old) out.push({ kind: 'added', area: 'message', name: label(d), details: [] });
      else if (!same({ ...old, ruleId: undefined }, { ...d, ruleId: undefined })) out.push({ kind: 'changed', area: 'message', name: label(d), details: propLines(old, d, { name: 'Name', event: 'When', email: 'Email', whatsapp: 'WhatsApp', isActive: 'Active', stageKey: 'Stage' }, ['ruleId']) });
    }
    for (const [id, d] of am) if (!bm.has(id)) out.push({ kind: 'removed', area: 'message', name: label(d), details: [] });

    const pos = (c: Canvas) => new Map(c.nodes.map((n) => [n.id, `${n.x},${n.y}`]));
    const ap = pos(before.canvas);
    const moved = [...pos(after.canvas)].filter(([id, p]) => ap.has(id) && ap.get(id) !== p).length;
    const links = (c: Canvas) => new Set(c.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
    const al = links(before.canvas);
    const bl = links(after.canvas);
    const relinked = [...bl].filter((x) => !al.has(x)).length + [...al].filter((x) => !bl.has(x)).length;
    const lines = [relinked && `${relinked} connection${relinked === 1 ? '' : 's'} changed`, moved && `${moved} step${moved === 1 ? '' : 's'} moved`].filter(Boolean) as string[];
    if (lines.length) out.push({ kind: 'changed', area: 'layout', name: 'Canvas', details: lines });
  }
  return out;
}

/** One-line summary, e.g. "2 stages, 3 fields changed". */
export function summarizeChanges(changes: FlowChange[]): string {
  if (!changes.length) return 'No changes';
  const count = (area: ChangeArea) => changes.filter((c) => c.area === area).length;
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => n && parts.push(`${n} ${n === 1 ? one : many}`);
  add(count('stage'), 'stage', 'stages');
  add(count('field'), 'field', 'fields');
  add(count('message'), 'message', 'messages');
  if (count('settings')) parts.push('settings');
  if (count('flow')) parts.push('name / description');
  if (count('layout') && !parts.length) parts.push('layout');
  return `${parts.join(', ')} changed`;
}
