/**
 * Flow canvas — the node editor's model, and its translation to and from the
 * executable workflow definition.
 *
 * The engine runs stages one after another (the legacy FMS process: step 1 → step 2 → …,
 * with conditional skips). The canvas authors that sequence plus the automation around it:
 *
 *   stage      → a WorkflowDef stage (content edited in the inspector)
 *   condition  → "Depends on": a switch with one output per condition (checked in order, first
 *                match wins) and an optional "Otherwise" output. Each output starts a path; the
 *                paths rejoin at the first step they all reach (or run to the end). Stages on a
 *                path get a guard, so each record walks only its path.
 *   timer      → "Delay/Timer": the next stage's planned time = base + TAT working hours
 *   jump       → "Stage Jump": hangs off a stage and points at another stage; when that stage is
 *                done and the condition holds, the flow jumps forward (skipping stages) or back
 *                (reopening stages for rework).
 *   message    → a notification rule triggered by the stage it hangs off
 *   webhook    → settings.webhooks entry, fired after the stage it hangs off
 *   document   → a stage with a `document` config: generates a PDF / Word file into a file field
 *                when the stage starts, then waits for a review or continues by itself
 *   note       → sticky note, canvas only
 */
import { z } from 'zod';
import {
  conditionGroupSchema,
  normalizeGuard,
  notificationRuleSchema,
  timeBaseSchema,
  tatRuleSchema,
  workflowDefSchema,
  workflowSettingsSchema,
  type ConditionGroup,
  type NotificationRuleDef,
  type StageDef,
  type SwitchGuard,
  type WebhookDef,
  type WorkflowDef,
  type WorkflowSettings,
} from './schema.js';

export const CANVAS_NODE_TYPES = ['stage', 'condition', 'timer', 'jump', 'message', 'webhook', 'document', 'note'] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];
const MAIN: ReadonlySet<CanvasNodeType> = new Set(['stage', 'condition', 'timer', 'document']);
/** A Document node is a step only once it owns a stage; older placeholder nodes (no stage) are canvas-only. */
export const isLegacyDocument = (n: { type?: string; data: Record<string, unknown> }) => n.type === 'document' && typeof n.data.stageKey !== 'string';
const isMainNode = (n: CanvasNode | undefined) => !!n && MAIN.has(n.type) && !isLegacyDocument(n);
/** Stage and Document nodes both stand for a WorkflowDef stage. */
export const isStageNode = (n: { type?: string; data: Record<string, unknown> }) => n.type === 'stage' || (n.type === 'document' && !isLegacyDocument(n));

const nodeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const canvasNodeSchema = z.object({
  id: nodeId,
  type: z.enum(CANVAS_NODE_TYPES),
  x: z.number().finite(),
  y: z.number().finite(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type CanvasNode = z.infer<typeof canvasNodeSchema>;

/** Output of a Depends-on node: the id of one of its cases, or `else` for Otherwise. */
export const ELSE_HANDLE = 'else';

export const canvasEdgeSchema = z.object({
  id: z.string().min(1).max(160),
  source: nodeId,
  target: nodeId,
  sourceHandle: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullish(),
});
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;

export const canvasSchema = z.object({
  nodes: z.array(canvasNodeSchema).max(500),
  edges: z.array(canvasEdgeSchema).max(1000),
});
export type Canvas = z.infer<typeof canvasSchema>;

// ------------------------------------------------------------------ node payloads
export const MESSAGE_EVENTS = ['stage_activated', 'stage_completed', 'stage_overdue'] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

export interface StageNodeData {
  stageKey: string;
}
export interface ConditionCase {
  /** Output handle id. */
  id: string;
  label?: string;
  when: ConditionGroup;
}
export interface ConditionNodeData {
  label?: string;
  cases?: ConditionCase[];
  /** Adds an Otherwise output for records that match none of the cases. */
  otherwise?: boolean;
  /** Legacy single condition with Yes / No outputs. */
  when?: ConditionGroup;
}
export interface TimerNodeData {
  base?: z.infer<typeof timeBaseSchema>;
  tat?: z.infer<typeof tatRuleSchema>;
}
export interface JumpNodeData {
  label?: string;
  when?: ConditionGroup;
  clearFields?: string[];
}
export interface MessageNodeData {
  name?: string;
  event?: MessageEvent;
  repeatEveryDays?: number;
  email?: { to: string; cc?: string; subject: string; body: string; fromName?: string; attachments?: string[] };
  whatsapp?: { to: string; body: string; template?: { name: string; language?: string; params: string[] } };
  isActive?: boolean;
}
export interface WebhookNodeData {
  key?: string;
  url?: string;
  secret?: string;
  fields?: string[];
  when?: ConditionGroup;
}
export interface NoteNodeData {
  text?: string;
}

export interface CanvasIssue {
  nodeId?: string;
  message: string;
}

export interface CanvasRule {
  nodeId: string;
  definition: NotificationRuleDef;
}

export interface CompiledCanvas {
  definition: WorkflowDef | null;
  settings: WorkflowSettings | null;
  rules: CanvasRule[];
  errors: CanvasIssue[];
  warnings: CanvasIssue[];
}

export type StageGuard = SwitchGuard;

const EMPTY_GROUP: ConditionGroup = { mode: 'all', conditions: [] };

/** Cases and Otherwise of a Depends-on node (older Yes/No nodes become one case + Otherwise). */
export function conditionCases(d: ConditionNodeData): { cases: ConditionCase[]; otherwise: boolean } {
  // New-style node: `cases` array is present (even if empty) — honour it as-is.
  if (Array.isArray(d.cases)) return { cases: d.cases, otherwise: !!d.otherwise };
  // Legacy yes/no node: no `cases` property at all — synthesise one case + Otherwise.
  return { cases: [{ id: 'yes', label: 'Yes', when: d.when ?? EMPTY_GROUP }], otherwise: true };
}

/** Legacy handles: `no` was the Otherwise output; a missing handle means the first case. */
function normalizeHandle(handle: string | null | undefined, d: ConditionNodeData): string {
  const { cases } = conditionCases(d);
  if (!handle) return cases[0]!.id;
  if (handle === 'no' && !cases.some((c) => c.id === 'no')) return ELSE_HANDLE;
  return handle;
}

const keyFromId = (id: string) => {
  const k = id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(k) ? k.slice(0, 64) : `hook_${k}`.slice(0, 64);
};

// ------------------------------------------------------------------ graph helpers
interface MainGraph {
  out(id: string): { target: string; handle: string | null }[];
  inc(id: string): string[];
  /** Successor of a stage/timer, or of one output of a Depends-on node. */
  next(id: string, handle?: string): string | null;
  /** First step every given path start reaches (null when they never all rejoin). */
  merge(starts: readonly string[]): string | null;
}

function mainGraph(nodes: ReadonlyMap<string, CanvasNode>, edges: readonly CanvasEdge[]): MainGraph {
  const isMain = (id: string) => isMainNode(nodes.get(id));
  const outs = new Map<string, { target: string; handle: string | null }[]>();
  const incs = new Map<string, string[]>();
  for (const e of edges) {
    if (!isMain(e.source) || !isMain(e.target)) continue;
    const src = nodes.get(e.source)!;
    const handle = src.type === 'condition' ? normalizeHandle(e.sourceHandle, src.data as ConditionNodeData) : null;
    outs.set(e.source, [...(outs.get(e.source) ?? []), { target: e.target, handle }]);
    incs.set(e.target, [...(incs.get(e.target) ?? []), e.source]);
  }
  const out = (id: string) => outs.get(id) ?? [];
  const reach = (from: string) => {
    const order: string[] = [];
    const seen = new Set<string>([from]);
    for (let i = 0, q = [from]; i < q.length; i++) {
      order.push(q[i]!);
      for (const o of out(q[i]!)) if (!seen.has(o.target)) (seen.add(o.target), q.push(o.target));
    }
    return order;
  };
  return {
    out,
    inc: (id) => incs.get(id) ?? [],
    next: (id, handle) => out(id).find((o) => (handle ? o.handle === handle : true))?.target ?? null,
    merge: (starts) => {
      if (starts.length < 2) return null;
      const sets = starts.slice(1).map((s) => new Set(reach(s)));
      return reach(starts[0]!).find((n) => sets.every((set) => set.has(n))) ?? null;
    },
  };
}

/** Stage-own condition and branch guards as one normalised list, outermost first. */
export function effectiveGuards(stage: Pick<StageDef, 'applicableWhen' | 'guards'>): StageGuard[] {
  return [...(stage.guards ?? []).map(normalizeGuard), ...(stage.applicableWhen?.conditions.length ? [{ cases: [stage.applicableWhen], take: 0 as const }] : [])];
}

// ------------------------------------------------------------------ canvas → definition
/**
 * Compile a canvas plus stage/field content into an executable definition,
 * settings and canvas-owned notification rules. Never throws: problems come
 * back as errors (block saving) and warnings (saved, but worth knowing).
 */
export function compileCanvas(canvas: Canvas, content: WorkflowDef, settings: WorkflowSettings): CompiledCanvas {
  const errors: CanvasIssue[] = [];
  const warnings: CanvasIssue[] = [];
  const nodes = new Map(canvas.nodes.map((n) => [n.id, n]));
  const label = (n: CanvasNode) => {
    if (isStageNode(n)) return `${n.type === 'document' ? 'Document' : 'Stage'} “${content.stages.find((s) => s.key === (n.data as unknown as StageNodeData).stageKey)?.name ?? n.id}”`;
    if (n.type === 'condition') return `Depends-on “${(n.data as ConditionNodeData).label ?? n.id}”`;
    if (n.type === 'timer') return 'Delay/Timer';
    if (n.type === 'jump') return `Stage Jump “${(n.data as JumpNodeData).label ?? n.id}”`;
    if (n.type === 'message') return `Message “${(n.data as MessageNodeData).name ?? n.id}”`;
    return `${n.type} node`;
  };

  const edges = canvas.edges.filter((e) => {
    if (!nodes.has(e.source) || !nodes.has(e.target)) return false;
    if (e.source === e.target) {
      errors.push({ nodeId: e.source, message: `${label(nodes.get(e.source)!)} is connected to itself` });
      return false;
    }
    return true;
  });

  // ---- stage nodes ⇄ stage content
  const stageByNode = new Map<string, StageDef>();
  const seenStage = new Set<string>();
  for (const n of canvas.nodes) {
    if (isLegacyDocument(n)) {
      warnings.push({ nodeId: n.id, message: 'This Document node was made before document steps existed and does nothing — delete it and drag in a new Document step' });
      continue;
    }
    if (!isStageNode(n)) continue;
    const key = (n.data as unknown as StageNodeData).stageKey;
    const stage = content.stages.find((s) => s.key === key);
    if (!stage) {
      errors.push({ nodeId: n.id, message: `Stage node refers to unknown stage “${String(key)}”` });
      continue;
    }
    if (n.type === 'document' && !stage.document) {
      errors.push({ nodeId: n.id, message: `Document “${stage.name}” is not set up yet — open it and choose its file field` });
      continue;
    }
    if (seenStage.has(key)) {
      errors.push({ nodeId: n.id, message: `Stage “${stage.name}” appears twice on the canvas` });
      continue;
    }
    seenStage.add(key);
    stageByNode.set(n.id, stage);
  }
  for (const s of content.stages) if (!seenStage.has(s.key)) errors.push({ message: `Stage “${s.name}” has no node on the canvas` });

  // ---- main path (stages, timers, Depends-on switches)
  const g = mainGraph(nodes, edges);
  const main = canvas.nodes.filter((n) => isMainNode(n) && (!isStageNode(n) || stageByNode.has(n.id)));
  let shapeOk = true;
  for (const n of main) {
    const outs = g.out(n.id);
    if (n.type === 'condition') {
      const { cases, otherwise } = conditionCases(n.data as ConditionNodeData);
      const valid = new Set([...cases.map((c) => c.id), ...(otherwise ? [ELSE_HANDLE] : [])]);
      for (const h of valid) {
        if (outs.filter((o) => o.handle === h).length > 1) {
          errors.push({ nodeId: n.id, message: `${label(n)}: each output can lead to only one step` });
          shapeOk = false;
        }
      }
      if (outs.some((o) => !valid.has(o.handle!))) warnings.push({ nodeId: n.id, message: `${label(n)} has a connection from an output that no longer exists — it is ignored` });
      if (!outs.some((o) => valid.has(o.handle!))) warnings.push({ nodeId: n.id, message: `${label(n)} has no outgoing path yet` });
    } else if (outs.length > 1) {
      errors.push({ nodeId: n.id, message: `${label(n)} leads to more than one next step. To split the flow, connect it to a Depends-on node and give each path a condition.` });
      shapeOk = false;
    }
  }

  interface Emitted {
    stage: StageDef;
    guards: StageGuard[];
    timer: CanvasNode | null;
    nodeId: string;
  }
  const emitted: Emitted[] = [];
  const visited = new Set<string>();

  const walk = (start: string | null, stop: string | null, guards: StageGuard[], timerIn: CanvasNode | null) => {
    let cur = start;
    let timer = timerIn;
    while (cur && cur !== stop) {
      if (visited.has(cur)) {
        errors.push({ nodeId: cur, message: `${label(nodes.get(cur)!)} is reached from paths that never join first — connect the paths to the same next step, or remove the loop (use a Stage Jump to go back)` });
        return;
      }
      visited.add(cur);
      const n = nodes.get(cur)!;
      if (n.type === 'condition') {
        const { cases, otherwise } = conditionCases(n.data as ConditionNodeData);
        const parsed = cases.map((c) => conditionGroupSchema.safeParse(c.when));
        if (parsed.some((p) => !p.success)) {
          errors.push({ nodeId: n.id, message: `${label(n)}: invalid conditions` });
          return;
        }
        const whens = parsed.map((p) => p.data!);
        whens.forEach((w, k) => {
          if (!w.conditions.length) errors.push({ nodeId: n.id, message: `${label(n)}: path ${k + 1} has no condition yet` });
        });
        const outputs: { start: string | null; take: number | 'else' }[] = [
          ...cases.map((c, k) => ({ start: g.next(cur!, c.id), take: k })),
          ...(otherwise ? [{ start: g.next(cur!, ELSE_HANDLE), take: 'else' as const }] : []),
        ];
        const join = g.merge(outputs.map((o) => o.start).filter((s): s is string => !!s));
        for (const o of outputs) walk(o.start, join, [...guards, { cases: whens, take: o.take }], timer);
        timer = null;
        cur = join;
        continue;
      }
      if (n.type === 'timer') {
        if (timer) errors.push({ nodeId: n.id, message: 'Only one Delay/Timer can come before a stage' });
        timer = n;
        cur = g.next(cur);
        if (!cur || cur === stop) warnings.push({ nodeId: n.id, message: 'Delay/Timer has no stage after it and is ignored' });
        continue;
      }
      emitted.push({ stage: stageByNode.get(cur)!, guards, timer, nodeId: cur });
      timer = null;
      cur = g.next(cur);
    }
  };

  if (shapeOk && main.length) {
    const starts = main.filter((n) => !g.inc(n.id).length);
    if (!starts.length) {
      errors.push({ message: 'The flow loops back on itself. Remove the connection that goes back to an earlier step — use a Stage Jump to send records back.' });
    } else {
      // The real start is the stage that leads somewhere (or the only stage); the rest are unconnected.
      const sorted = [...starts].sort((a, b) => Number(b.type === 'stage' && g.out(b.id).length > 0) - Number(a.type === 'stage' && g.out(a.id).length > 0) || a.x - b.x);
      const start = sorted[0]!;
      for (const n of sorted.slice(1)) errors.push({ nodeId: n.id, message: `${label(n)} is not connected to the flow` });
      if (start.type !== 'stage') errors.push({ nodeId: start.id, message: 'The flow must start with a Stage (the intake form)' });
      walk(start.id, null, [], null);
      for (const n of main) if (!visited.has(n.id) && !sorted.slice(1).some((s) => s.id === n.id)) errors.push({ nodeId: n.id, message: `${label(n)} is not connected to the flow` });
    }
  }

  // ---- Stage Jumps (stage → jump → stage)
  const jumpsByStage = new Map<string, NonNullable<StageDef['jumps']>>();
  for (const n of canvas.nodes) {
    if (n.type !== 'jump') continue;
    const d = n.data as JumpNodeData;
    const from = edges.filter((e) => e.target === n.id && stageByNode.has(e.source)).map((e) => stageByNode.get(e.source)!);
    const to = edges.filter((e) => e.source === n.id && stageByNode.has(e.target)).map((e) => stageByNode.get(e.target)!);
    if (from.length !== 1) {
      (from.length ? errors : warnings).push({ nodeId: n.id, message: from.length ? `${label(n)} can hang off only one stage` : `${label(n)} is not connected to a stage, so it never fires` });
      continue;
    }
    if (to.length !== 1) {
      (to.length ? errors : warnings).push({ nodeId: n.id, message: to.length ? `${label(n)} can point at only one stage` : `${label(n)} has no target stage yet` });
      continue;
    }
    const when = conditionGroupSchema.safeParse(d.when ?? EMPTY_GROUP);
    if (!when.success || !when.data.conditions.length) {
      errors.push({ nodeId: n.id, message: `${label(n)} needs a condition (otherwise it would always jump)` });
      continue;
    }
    if (to[0]!.key === from[0]!.key) {
      errors.push({ nodeId: n.id, message: `${label(n)} points back at its own stage` });
      continue;
    }
    jumpsByStage.set(from[0]!.key, [...(jumpsByStage.get(from[0]!.key) ?? []), { when: when.data, to: to[0]!.key, clearFields: (d.clearFields ?? []).filter((f) => content.fields.some((x) => x.key === f)), label: d.label || undefined }]);
  }

  const orderedStages: StageDef[] = emitted.map((e, i) => {
    const jumps = jumpsByStage.get(e.stage.key);
    const next: StageDef = { ...e.stage, applicableWhen: undefined, guards: e.guards.length ? e.guards : undefined, jumps: jumps?.length ? jumps : undefined };
    if (i === 0) {
      if (e.guards.length || e.timer) errors.push({ nodeId: e.nodeId, message: 'Nothing can come before the first stage' });
      return { ...next, guards: undefined, planned: { mode: 'none' }, completion: { kind: 'on_create' } };
    }
    if (e.timer) {
      const d = e.timer.data as TimerNodeData;
      const base = timeBaseSchema.safeParse(d.base ?? { kind: 'previous_stage' });
      const tat = tatRuleSchema.safeParse(d.tat ?? { kind: 'fixed', hours: 8 });
      if (!base.success || !tat.success) errors.push({ nodeId: e.timer.id, message: 'Delay/Timer: invalid settings' });
      else next.planned = { mode: 'tat', base: base.data, tat: tat.data };
    } else {
      next.planned = e.stage.planned.mode === 'manual' ? { mode: 'manual' } : { mode: 'none' };
    }
    if (next.completion.kind === 'on_create') next.completion = { kind: 'manual' };
    return next;
  });
  // Jumps back to the intake form are not allowed (it is never reopened).
  for (const [key, jumps] of jumpsByStage) {
    if (jumps.some((j) => j.to === orderedStages[0]?.key)) {
      const n = canvas.nodes.find((x) => x.type === 'jump' && edges.some((e) => e.source === x.id && stageByNode.get(e.target)?.key === orderedStages[0]?.key) && edges.some((e) => e.target === x.id && stageByNode.get(e.source)?.key === key));
      errors.push({ nodeId: n?.id, message: 'A Stage Jump can not go back to the intake form' });
    }
  }

  // ---- side nodes
  const stageSources = (n: CanvasNode) => edges.filter((e) => e.target === n.id && stageByNode.has(e.source)).map((e) => stageByNode.get(e.source)!);
  const rules: CanvasRule[] = [];
  const webhooks: WebhookDef[] = [];
  const hookKeys = new Set<string>();
  for (const n of canvas.nodes) {
    if (n.type === 'message') {
      const d = n.data as MessageNodeData;
      const from = stageSources(n);
      if (from.length > 1) {
        errors.push({ nodeId: n.id, message: `${label(n)} is connected to more than one stage` });
        continue;
      }
      if (!from.length) {
        warnings.push({ nodeId: n.id, message: `${label(n)} is not connected to a stage, so it is not sent` });
        continue;
      }
      if (!d.email && !d.whatsapp) {
        warnings.push({ nodeId: n.id, message: `${label(n)} has no template configured, so it is not sent` });
        continue;
      }
      const parsed = notificationRuleSchema.safeParse({
        name: d.name || 'Message',
        isActive: d.isActive ?? true,
        trigger: { type: d.event ?? 'stage_activated', stageKey: from[0]!.key },
        repeatEveryDays: d.repeatEveryDays,
        email: d.email,
        // Template variable lines come from a textarea: drop blank lines at the end (WhatsApp rejects empty variables).
        whatsapp: d.whatsapp && {
          ...d.whatsapp,
          template: d.whatsapp.template && { ...d.whatsapp.template, params: d.whatsapp.template.params.slice(0, d.whatsapp.template.params.findLastIndex((p) => p.trim() !== '') + 1) },
        },
      });
      if (!parsed.success) errors.push({ nodeId: n.id, message: `${label(n)}: ${parsed.error.issues[0]?.message ?? 'invalid'}` });
      else {
        // Attachments must be file fields of this flow (uploads or generated documents).
        const bad = (parsed.data.email?.attachments ?? []).filter((k) => content.fields.find((f) => f.key === k)?.type !== 'file');
        if (bad.length) errors.push({ nodeId: n.id, message: `${label(n)}: attachments must be file fields (${bad.join(', ')})` });
        else rules.push({ nodeId: n.id, definition: parsed.data });
      }
    } else if (n.type === 'webhook') {
      const d = n.data as WebhookNodeData;
      const from = stageSources(n);
      if (from.length > 1) {
        errors.push({ nodeId: n.id, message: 'A webhook can follow only one stage' });
        continue;
      }
      if (!d.url) {
        warnings.push({ nodeId: n.id, message: 'Webhook has no URL yet, so it is not sent' });
        continue;
      }
      const key = d.key || keyFromId(n.id);
      if (hookKeys.has(key)) errors.push({ nodeId: n.id, message: `Two webhooks use the key “${key}”` });
      hookKeys.add(key);
      webhooks.push({ key, url: d.url, secret: d.secret || undefined, when: d.when ?? EMPTY_GROUP, fields: d.fields ?? [], afterStage: from[0]?.key });
    }
  }

  if (errors.length) return { definition: null, settings: null, rules, errors, warnings };

  const def = workflowDefSchema.safeParse({ ...content, stages: orderedStages });
  const set = workflowSettingsSchema.safeParse({ ...settings, webhooks });
  const nodeOfStage = (i: unknown) => (typeof i === 'number' ? emitted[i]?.nodeId : undefined);
  if (!def.success) for (const i of def.error.issues) errors.push({ nodeId: i.path[0] === 'stages' ? nodeOfStage(i.path[1]) : undefined, message: `${i.path.join('.')}: ${i.message}` });
  if (!set.success) for (const i of set.error.issues) errors.push({ message: `settings.${i.path.join('.')}: ${i.message}` });
  return { definition: def.success ? normalizeDocumentStages(def.data) : null, settings: set.success ? set.data : null, rules, errors, warnings };
}

/**
 * Rules that follow from a stage being a document step, applied by every path that saves a
 * definition (flow editor, form editor, API), so they can not drift apart:
 *  - completion: wait for a review ("Approve & continue"), or complete as soon as the file exists;
 *  - the document's file field is required (the step can not be done without its document);
 *  - a backward Stage Jump that reopens a document step clears its file, so the document is
 *    generated again from the corrected data instead of the step completing at once with the old one.
 */
export function normalizeDocumentStages(def: WorkflowDef): WorkflowDef {
  const docFields = new Set(def.stages.flatMap((s) => (s.document ? [s.document.fieldKey] : [])));
  if (!docFields.size) return def;
  const index = new Map(def.stages.map((s, i) => [s.key, i]));
  const stages = def.stages.map((s, i): StageDef => {
    let next = s;
    if (s.document) {
      next = { ...next, completion: s.document.requireReview ? { kind: 'manual' } : { kind: 'conditions', when: { mode: 'all', conditions: [{ field: s.document.fieldKey, op: 'not_empty' }] } } };
    }
    if (s.jumps?.length) {
      next = {
        ...next,
        jumps: s.jumps.map((j) => {
          const t = index.get(j.to);
          if (t === undefined || t >= i) return j;
          const reopenedDocs = def.stages.slice(t, i + 1).flatMap((x) => (x.document ? [x.document.fieldKey] : []));
          return reopenedDocs.length ? { ...j, clearFields: [...new Set([...j.clearFields, ...reopenedDocs])] } : j;
        }),
      };
    }
    return next;
  });
  return { ...def, stages, fields: def.fields.map((f) => (docFields.has(f.key) && !f.required ? { ...f, required: true } : f)) };
}

// ------------------------------------------------------------------ definition → canvas
export interface ExistingRule {
  id: string;
  canvasNodeId?: string | null;
  definition: NotificationRuleDef;
}

const COL = 300;
const ROW = 190;
const TOP = 80;

/**
 * Left-to-right layout. Each path of a Depends-on node gets its own lane below the previous one;
 * paths rejoin on the original lane. Messages, webhooks and jumps hang under their stage.
 */
export function layoutCanvas(canvas: Canvas): Canvas {
  const byId = new Map(canvas.nodes.map((n) => [n.id, { ...n }]));
  const g = mainGraph(byId, canvas.edges);
  const placed = new Set<string>();
  let lowest = 0;
  const lay = (start: string | null, stop: string | null, col: number, row: number): { col: number; maxRow: number } => {
    let cur = start;
    let maxRow = row;
    while (cur && cur !== stop && !placed.has(cur)) {
      const n = byId.get(cur)!;
      n.x = col * COL;
      n.y = TOP + row * ROW;
      placed.add(cur);
      col++;
      if (n.type === 'condition') {
        const { cases, otherwise } = conditionCases(n.data as ConditionNodeData);
        const starts = [...cases.map((c) => g.next(cur!, c.id)), ...(otherwise ? [g.next(cur!, ELSE_HANDLE)] : [])];
        const join = g.merge(starts.filter((s): s is string => !!s));
        let lane = row;
        let endCol = col;
        for (const s of starts) {
          if (!s || s === join) continue;
          const r = lay(s, join, col, lane);
          endCol = Math.max(endCol, r.col);
          maxRow = Math.max(maxRow, r.maxRow);
          lane = r.maxRow + 1;
        }
        col = endCol;
        cur = join;
      } else {
        cur = g.next(cur);
      }
    }
    lowest = Math.max(lowest, maxRow);
    return { col, maxRow };
  };
  const starts = canvas.nodes.filter((n) => isMainNode(n) && !g.inc(n.id).length).sort((a, b) => a.x - b.x);
  let lane = 0;
  for (const s of starts) lane = lay(s.id, null, 0, lane).maxRow + 1;
  const sideTop = TOP + (lowest + 1) * ROW + 30;
  const below = new Map<string, number>();
  let loose = 0;
  for (const n of byId.values()) {
    if (isMainNode(n)) continue;
    const parent = canvas.edges.find((e) => e.target === n.id && placed.has(e.source))?.source;
    if (parent) {
      const p = byId.get(parent)!;
      const k = below.get(parent) ?? 0;
      below.set(parent, k + 1);
      n.x = p.x;
      n.y = sideTop + k * 130;
    } else if (n.type !== 'note') {
      n.x = loose++ * COL;
      n.y = sideTop + 2 * 130 + 40;
    }
  }
  return { nodes: canvas.nodes.map((n) => byId.get(n.id)!), edges: canvas.edges };
}

/**
 * Build a canvas for a definition (no stored canvas yet, or it was edited elsewhere).
 * Consecutive stages that share a switch become one Depends-on node with one output per case
 * (+ Otherwise), rejoining at the next stage. Stage jumps become Jump nodes.
 */
export function canvasFromDefinition(def: WorkflowDef, settings: WorkflowSettings, rules: readonly ExistingRule[] = []): Canvas {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const link = (source: string, target: string, handle?: string) => edges.push({ id: `e-${source}-${handle ? `${handle}-` : ''}${target}`, source, target, sourceHandle: handle ?? null });
  interface Exit {
    id: string;
    handle?: string;
  }
  interface Frag {
    entry: string;
    exits: Exit[];
  }
  const items = def.stages.map((stage, index) => ({ stage, index, guards: index === 0 ? [] : effectiveGuards(stage) }));
  const gkey = (g: StageGuard) => JSON.stringify(g.cases);
  const usedIds = new Set<string>();

  const stageFrag = (s: StageDef, index: number): Frag => {
    nodes.push({ id: `stage-${s.key}`, type: s.document ? 'document' : 'stage', x: 0, y: 0, data: { stageKey: s.key } });
    if (index > 0 && s.planned.mode === 'tat') {
      nodes.push({ id: `timer-${s.key}`, type: 'timer', x: 0, y: 0, data: { base: s.planned.base, tat: s.planned.tat } });
      link(`timer-${s.key}`, `stage-${s.key}`);
      return { entry: `timer-${s.key}`, exits: [{ id: `stage-${s.key}` }] };
    }
    return { entry: `stage-${s.key}`, exits: [{ id: `stage-${s.key}` }] };
  };

  const build = (list: typeof items, depth: number): Frag | null => {
    const pieces: Frag[] = [];
    let i = 0;
    while (i < list.length) {
      const it = list[i]!;
      if (it.guards.length === depth) {
        pieces.push(stageFrag(it.stage, it.index));
        i++;
        continue;
      }
      // One switch: consecutive items with the same cases; a path that already ended can not restart.
      const key = gkey(it.guards[depth]!);
      const byTake = new Map<number | 'else', typeof items>();
      let current: number | 'else' | null = null;
      while (i < list.length && list[i]!.guards.length > depth && gkey(list[i]!.guards[depth]!) === key) {
        const take = list[i]!.guards[depth]!.take;
        if (take !== current && byTake.has(take)) break;
        current = take;
        byTake.set(take, [...(byTake.get(take) ?? []), list[i++]!]);
      }
      const cases = it.guards[depth]!.cases;
      let condId = `cond-${it.stage.key}${depth ? `-${depth}` : ''}`;
      while (usedIds.has(condId)) condId += '_';
      usedIds.add(condId);
      nodes.push({ id: condId, type: 'condition', x: 0, y: 0, data: { label: 'Depends on', cases: cases.map((when, k) => ({ id: `c${k + 1}`, when })), otherwise: true } });
      const exits: Exit[] = [];
      for (const take of [...cases.map((_, k) => k), 'else' as const]) {
        const handle = take === 'else' ? ELSE_HANDLE : `c${take + 1}`;
        const frag = build(byTake.get(take) ?? [], depth + 1);
        if (frag) (link(condId, frag.entry, handle), exits.push(...frag.exits));
        else exits.push({ id: condId, handle });
      }
      pieces.push({ entry: condId, exits });
    }
    for (let k = 0; k + 1 < pieces.length; k++) for (const e of pieces[k]!.exits) link(e.id, pieces[k + 1]!.entry, e.handle);
    return pieces.length ? { entry: pieces[0]!.entry, exits: pieces[pieces.length - 1]!.exits } : null;
  };
  build(items, 0);

  def.stages.forEach((s) =>
    (s.jumps ?? []).forEach((j, k) => {
      const id = `jump-${s.key}-${k + 1}`.slice(0, 64);
      nodes.push({ id, type: 'jump', x: 0, y: 0, data: { label: j.label, when: j.when, clearFields: j.clearFields } });
      link(`stage-${s.key}`, id);
      link(id, `stage-${j.to}`);
    }),
  );
  rules.forEach((r, i) => {
    const t = r.definition.trigger;
    if (t.type === 'condition') return; // condition rules stay on the Rules page
    const id = r.canvasNodeId ?? `msg-${i + 1}`;
    nodes.push({
      id,
      type: 'message',
      x: 0,
      y: 0,
      data: { ruleId: r.id, name: r.definition.name, event: t.type, repeatEveryDays: r.definition.repeatEveryDays, email: r.definition.email, whatsapp: r.definition.whatsapp, isActive: r.definition.isActive },
    });
    if (def.stages.some((s) => s.key === t.stageKey)) link(`stage-${t.stageKey}`, id);
  });
  for (const h of settings.webhooks) {
    const id = `hook-${h.key}`.slice(0, 64);
    nodes.push({ id, type: 'webhook', x: 0, y: 0, data: { key: h.key, url: h.url, secret: h.secret, fields: h.fields, when: h.when } });
    if (h.afterStage && def.stages.some((s) => s.key === h.afterStage)) link(`stage-${h.afterStage}`, id);
  }
  return layoutCanvas({ nodes, edges });
}

/** Structural fingerprint of what the canvas controls, to detect edits made outside the editor. */
function fingerprint(def: WorkflowDef, settings: WorkflowSettings) {
  return JSON.stringify({
    stages: def.stages.map((s, i) => [s.key, i === 0 ? [] : effectiveGuards(s), s.planned.mode === 'tat' ? s.planned : s.planned.mode, s.jumps ?? []]),
    hooks: settings.webhooks.map((h) => [h.key, h.url, h.afterStage ?? null]),
  });
}

/**
 * Return a canvas that matches the current definition. A stored canvas is kept
 * (positions, notes) when it still compiles to the same structure; otherwise a
 * fresh one is generated, re-using stored positions for nodes with the same id.
 */
export function reconcileCanvas(stored: Canvas | null | undefined, def: WorkflowDef, settings: WorkflowSettings, rules: readonly ExistingRule[] = []): Canvas {
  const parsed = stored ? canvasSchema.safeParse(stored) : null;
  const fresh = () => canvasFromDefinition(def, settings, rules);
  if (!parsed?.success) return fresh();
  const canvas = hydrateMessages(parsed.data, rules);
  const compiled = compileCanvas(canvas, def, settings);
  if (compiled.definition && compiled.settings && fingerprint(compiled.definition, compiled.settings) === fingerprint(def, settings)) return canvas;
  const regenerated = fresh();
  const old = new Map(parsed.data.nodes.map((n) => [n.id, n]));
  return {
    nodes: [
      ...regenerated.nodes.map((n) => (old.has(n.id) ? { ...n, x: old.get(n.id)!.x, y: old.get(n.id)!.y } : n)),
      ...parsed.data.nodes.filter((n) => n.type === 'note' || isLegacyDocument(n)),
    ],
    edges: regenerated.edges,
  };
}

/** Message nodes show the live rule (it may have been edited on the Rules page). */
function hydrateMessages(canvas: Canvas, rules: readonly ExistingRule[]): Canvas {
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => {
      if (n.type !== 'message') return n;
      const r = rules.find((x) => x.canvasNodeId === n.id);
      if (!r || r.definition.trigger.type === 'condition') return n;
      const d = r.definition;
      return { ...n, data: { ...n.data, ruleId: r.id, name: d.name, event: d.trigger.type, repeatEveryDays: d.repeatEveryDays, email: d.email, whatsapp: d.whatsapp, isActive: d.isActive } };
    }),
  };
}
