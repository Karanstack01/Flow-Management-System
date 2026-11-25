import clsx from 'clsx';
import { ArrowRight, ChevronDown, CornerDownLeft, EllipsisVertical, Eye, FileText, GitBranch, Globe, Hourglass, Layers, Lock, Megaphone, PlayCircle, Settings2, StickyNote, Trash2, Users, Webhook } from 'lucide-react';
import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import { conditionCases, ELSE_HANDLE, type CanvasNodeType, type ConditionGroup, type ConditionNodeData, type FieldDef, type JumpNodeData, type MessageNodeData, type StageDef, type TimerNodeData, type WebhookNodeData, type WorkflowDef } from '@fms/core';

export type FlowNode = Node<Record<string, unknown>, CanvasNodeType>;

export interface EditorContextValue {
  def: WorkflowDef;
  issues: Map<string, 'error' | 'warning'>;
  /** `${nodeId}:${handle}` → name of the step that output leads to. */
  targets: Map<string, string>;
  onPreview: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}
export const EditorContext = createContext<EditorContextValue | null>(null);
const useEditor = () => useContext(EditorContext)!;

/** Palette entries (left panel) — colours match the node headers. */
export const PALETTE: { type: CanvasNodeType; label: string; hint: string; icon: ReactNode; tone: string; disabled?: boolean }[] = [
  { type: 'stage', label: 'Stage', hint: 'A step someone completes, with its form fields', icon: <Layers />, tone: 'amber' },
  { type: 'condition', label: 'Depends on', hint: 'Route records: one path per condition (first match wins), plus an optional Otherwise', icon: <GitBranch />, tone: 'sky' },
  { type: 'jump', label: 'Stage Jump', hint: 'After a stage: jump forward (skip stages) or back (redo stages) when a condition matches', icon: <CornerDownLeft />, tone: 'rose' },
  { type: 'webhook', label: 'Webhook', hint: 'Send record data to another system after a stage', icon: <Webhook />, tone: 'violet' },
  { type: 'message', label: 'Message', hint: 'Email / WhatsApp when a stage starts, ends or is late', icon: <Megaphone />, tone: 'orange' },
  { type: 'timer', label: 'Delay/Timer', hint: 'Due time (TAT) for the next stage, in working hours', icon: <Hourglass />, tone: 'blue' },
  { type: 'document', label: 'Document', hint: 'Generate a PDF / Word document from the record, then review it or continue', icon: <FileText />, tone: 'indigo' },
  { type: 'note', label: 'Note', hint: 'A sticky note for the team', icon: <StickyNote />, tone: 'yellow' },
];

export const TONES: Record<string, { border: string; bg: string; fg: string }> = {
  amber: { border: 'border-amber-300 dark:border-amber-500/50', bg: 'bg-amber-50 dark:bg-amber-500/10', fg: 'text-amber-600 dark:text-amber-300' },
  sky: { border: 'border-sky-300 dark:border-sky-500/50', bg: 'bg-sky-50 dark:bg-sky-500/10', fg: 'text-sky-600 dark:text-sky-300' },
  violet: { border: 'border-violet-300 dark:border-violet-500/50', bg: 'bg-violet-50 dark:bg-violet-500/10', fg: 'text-violet-600 dark:text-violet-300' },
  orange: { border: 'border-orange-300 dark:border-orange-500/50', bg: 'bg-orange-50 dark:bg-orange-500/10', fg: 'text-orange-600 dark:text-orange-300' },
  blue: { border: 'border-blue-300 dark:border-blue-500/50', bg: 'bg-blue-50 dark:bg-blue-500/10', fg: 'text-blue-600 dark:text-blue-300' },
  indigo: { border: 'border-indigo-300 dark:border-indigo-500/50', bg: 'bg-indigo-50 dark:bg-indigo-500/10', fg: 'text-indigo-600 dark:text-indigo-300' },
  yellow: { border: 'border-yellow-300 dark:border-yellow-500/50', bg: 'bg-yellow-50 dark:bg-yellow-500/10', fg: 'text-yellow-600 dark:text-yellow-300' },
  rose: { border: 'border-rose-300 dark:border-rose-500/50', bg: 'bg-rose-50 dark:bg-rose-500/10', fg: 'text-rose-600 dark:text-rose-300' },
};
const meta = (t: CanvasNodeType) => PALETTE.find((p) => p.type === t)!;

export function conditionText(g: ConditionGroup | undefined, def: WorkflowDef): string {
  if (!g?.conditions.length) return 'No conditions yet';
  const label = (k: string) => def.fields.find((f) => f.key === k)?.label ?? k;
  const ops: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is one of', empty: 'is empty', not_empty: 'is filled', is_true: 'is ticked', is_false: 'is not ticked' };
  return g.conditions
    .map((c) => `${label(c.field)} ${ops[c.op] ?? c.op}${c.value === undefined ? '' : ` ${Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}`}`)
    .join(g.mode === 'all' ? ' and ' : ' or ');
}

export function timerText(d: TimerNodeData, def: WorkflowDef): string {
  const base = !d.base || d.base.kind === 'previous_stage' ? 'after previous stage' : d.base.kind === 'created' ? 'after record created' : `from ${def.fields.find((f) => f.key === (d.base as { field: string }).field)?.label ?? 'date field'}`;
  if (!d.tat || d.tat.kind === 'fixed') {
    const h = d.tat?.hours ?? 8;
    return `${h < 0 ? `${-h} working h before` : `${h} working h`} ${h < 0 ? base.replace(/^after |^from /, '') : base}`;
  }
  return `By ${def.fields.find((f) => f.key === (d.tat as { field: string }).field)?.label ?? 'field'} (${Object.entries(d.tat.map).map(([k, v]) => `${k}: ${v}h`).join(', ') || 'no values'}) ${base}`;
}

/** Eye button: opens the step's preview (nodrag so it does not start a drag). */
function PreviewButton({ id, className }: { id: string; className?: string }) {
  const { onPreview } = useEditor();
  return (
    <button
      type="button"
      title="Preview"
      aria-label="Preview this step"
      onClick={(e) => (e.stopPropagation(), onPreview(id))}
      className={clsx('nodrag grid size-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg', className)}
    >
      <Eye className="size-4" />
    </button>
  );
}

/** Gear button: opens the step's settings (the only single-click way in; dragging never opens them). */
function SettingsButton({ id, className }: { id: string; className?: string }) {
  const { onOpen } = useEditor();
  return (
    <button
      type="button"
      title="Settings"
      aria-label="Open settings"
      onClick={(e) => (e.stopPropagation(), onOpen(id))}
      className={clsx('nodrag grid size-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg', className)}
    >
      <Settings2 className="size-4" />
    </button>
  );
}

/**
 * Floating actions above the selected step. A click on a step only selects it, so moving and
 * aligning steps stays undisturbed; these are the explicit ways to act on it.
 */
function StepActions({ id, preview = true, settingsLabel = 'Settings' }: { id: string; preview?: boolean; settingsLabel?: string }) {
  const { onPreview, onOpen, onDelete } = useEditor();
  const btn = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-[background-color,color,transform] duration-200 ease-[var(--ease-apple)] active:scale-95 [&>svg]:size-4';
  return (
    <NodeToolbar position={Position.Top} offset={10}>
      <div className="nodrag flex animate-pop-in items-center gap-0.5 rounded-xl border border-line/80 bg-surface/95 p-1 text-fg shadow-[var(--shadow-float)] backdrop-blur-xl" role="toolbar" aria-label="Step actions">
        <button type="button" className={clsx(btn, 'bg-primary text-primary-fg hover:opacity-90')} onClick={() => onOpen(id)}>
          <Settings2 /> {settingsLabel}
        </button>
        {preview && (
          <button type="button" className={clsx(btn, 'text-muted hover:bg-surface-2 hover:text-fg')} onClick={() => onPreview(id)}>
            <Eye /> Preview
          </button>
        )}
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
        <button type="button" title="Delete" aria-label="Delete step" className={clsx(btn, 'px-2 text-muted hover:bg-danger-soft hover:text-danger')} onClick={() => onDelete(id)}>
          <Trash2 />
        </button>
      </div>
    </NodeToolbar>
  );
}

/** ⋮ menu: Preview / Edit settings / Delete. */
function NodeMenu({ id }: { id: string }) {
  const { onPreview, onOpen, onDelete } = useEditor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as globalThis.Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = (label: string, icon: ReactNode, fn: () => void, danger?: boolean) => (
    <button
      type="button"
      onClick={(e) => (e.stopPropagation(), setOpen(false), fn())}
      className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2 [&>svg]:size-4', danger ? 'text-danger' : 'text-fg')}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div ref={ref} className="nodrag relative">
      <button type="button" title="More" aria-label="More actions" aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen(!open))} className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <EllipsisVertical className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-20 w-44 animate-pop-in rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-float)]">
          {item('Preview', <Eye />, () => onPreview(id))}
          {item('Edit settings', <Settings2 />, () => onOpen(id))}
          {item('Delete', <Trash2 />, () => onDelete(id), true)}
        </div>
      )}
    </div>
  );
}

/** Field chip colours by type, so a stage's form reads at a glance. */
const CHIP: Record<string, string> = {
  text: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200',
  textarea: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200',
  number: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  computed: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  email: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
  phone: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
  'user-email': 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
  date: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  datetime: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  select: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
  multiselect: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
  combobox: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
  'dependent-select': 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
  checkbox: 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-200',
  file: 'border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200',
};

/** Stage and Document steps: a card with the step's description and its fields. */
function StepCard({ id, type, selected, stage, children }: { id: string; type: 'stage' | 'document'; selected: boolean; stage: StageDef; children: ReactNode }) {
  const { issues } = useEditor();
  const m = meta(type);
  const tone = TONES[m.tone]!;
  const issue = issues.get(id);
  return (
    <div
      className={clsx(
        'w-72 animate-pop-in rounded-2xl border-[1.5px] bg-surface text-fg shadow-[var(--shadow-soft)] transition-[box-shadow,transform] duration-200 ease-[var(--ease-apple)] hover:-translate-y-px hover:shadow-[var(--shadow-float)]',
        tone.border,
        selected && '-translate-y-0.5 shadow-[var(--shadow-float)] ring-2 ring-info',
        issue === 'error' && 'ring-2 ring-danger',
        issue === 'warning' && !selected && 'ring-2 ring-warning/70',
      )}
    >
      <StepActions id={id} />
      <Handle type="target" position={Position.Left} className="!size-2.5 !border-2 !border-surface !bg-amber-400" />
      <div className="flex items-center gap-2.5 px-3.5 pb-1 pt-3">
        <span className={clsx('grid size-9 shrink-0 place-items-center rounded-xl [&>svg]:size-[18px]', tone.bg, tone.fg)} style={type === 'stage' ? { color: stage.color } : undefined}>
          {m.icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={stage.name}>
          {stage.name}
        </span>
        <PreviewButton id={id} />
        <SettingsButton id={id} />
        <NodeMenu id={id} />
      </div>
      <div className="px-3.5 pb-3 text-[12px] leading-relaxed">{children}</div>
      <Handle type="source" position={Position.Right} className="!size-2.5 !border-2 !border-surface !bg-amber-400" />
    </div>
  );
}

function FieldChips({ fields, max = 5 }: { fields: FieldDef[]; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? fields : fields.slice(0, max);
  if (!fields.length) return <p className="mt-1.5 italic text-muted">No fields</p>;
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {shown.map((f) => (
          <span key={f.key} className={clsx('max-w-full truncate rounded-lg border px-2 py-0.5 text-[11.5px] font-medium', CHIP[f.type] ?? CHIP.text)} title={f.label}>
            {f.label}
            {f.required && <span className="text-danger"> *</span>}
          </span>
        ))}
      </div>
      {fields.length > max && (
        <button type="button" className="nodrag mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-success hover:underline" onClick={(e) => (e.stopPropagation(), setAll(!all))}>
          <ChevronDown className={clsx('size-3.5 transition-transform', all && 'rotate-180')} />
          {all ? 'Show less' : `Show ${fields.length - max} More`}
        </button>
      )}
    </>
  );
}

function Shell({ id, type, selected, title, children, target = true, source = true, accent, wide }: { id: string; type: CanvasNodeType; selected: boolean; title: ReactNode; children?: ReactNode; target?: boolean; source?: boolean; accent?: string; wide?: boolean }) {
  const { issues } = useEditor();
  const m = meta(type);
  const tone = TONES[m.tone]!;
  const issue = issues.get(id);
  return (
    <div
      className={clsx(
        // Pops in when added; lifts on hover and while selected.
        wide ? 'w-64' : 'w-60',
        'animate-pop-in rounded-xl border bg-surface text-fg shadow-[var(--shadow-soft)] transition-[box-shadow,transform] duration-200 ease-[var(--ease-apple)] hover:-translate-y-px hover:shadow-[var(--shadow-float)]',
        tone.border,
        selected && '-translate-y-0.5 shadow-[var(--shadow-float)] ring-2 ring-info',
        issue === 'error' && 'ring-2 ring-danger',
        issue === 'warning' && !selected && 'ring-2 ring-warning/70',
      )}
    >
      <StepActions id={id} />
      {target && <Handle type="target" position={Position.Left} />}
      <div className={clsx('flex items-center gap-1 rounded-t-xl border-b px-2.5 py-1.5', tone.bg, tone.border)} style={accent ? { borderTop: `3px solid ${accent}` } : undefined}>
        <span className={clsx('mr-1 shrink-0 [&>svg]:size-3.5', tone.fg)}>{m.icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</span>
        <PreviewButton id={id} className="-my-1 size-6 [&>svg]:size-3.5" />
        <SettingsButton id={id} className="-my-1 size-6 [&>svg]:size-3.5" />
      </div>
      <div className="px-2.5 py-2 text-[11px] leading-relaxed">{children}</div>
      {source && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const StageNode = memo(function StageNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { def } = useEditor();
  const stage = def.stages.find((s) => s.key === data.stageKey) as StageDef | undefined;
  if (!stage) return <Shell id={id} type="stage" selected={selected} title="Missing stage" />;
  const isIntake = def.stages[0]?.key === stage.key;
  const fields = def.fields.filter((f) => f.stageKey === stage.key);
  const flags = [stage.lockAfterComplete && <Lock key="l" className="size-3" aria-label="Locked after completion" />, stage.stageAccessRestricted && <Users key="u" className="size-3" aria-label="Assigned users only" />, isIntake && stage.publicForm && <Globe key="g" className="size-3" aria-label="Public form" />, stage.video && <PlayCircle key="v" className="size-3" aria-label="Instruction video" />].filter(Boolean);
  return (
    <StepCard id={id} type="stage" selected={selected} stage={stage}>
      <p className="line-clamp-2 text-muted">{stage.description || (isIntake ? 'Intake form' : stage.completion.kind === 'manual' ? 'Owner marks it done' : 'Done when its conditions are met')}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        {stage.responsibleGroups.length > 0 && <span className="truncate">{stage.responsibleGroups.join(', ')}</span>}
        {stage.planned.mode === 'manual' && <span>· planned by owner</span>}
        {stage.bulkUpdate && <span>· bulk</span>}
        {flags}
      </p>
      <FieldChips fields={fields} />
    </StepCard>
  );
});

const DocumentNode = memo(function DocumentNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { def } = useEditor();
  const stage = def.stages.find((s) => s.key === data.stageKey) as StageDef | undefined;
  if (!stage?.document) {
    return (
      <Shell id={id} type="document" selected={selected} title="Document" source={false}>
        <p className="italic text-muted">Old placeholder — delete it and add a new Document step.</p>
      </Shell>
    );
  }
  const d = stage.document;
  const file = def.fields.find((f) => f.key === d.fieldKey);
  return (
    <StepCard id={id} type="document" selected={selected} stage={stage}>
      <p className="truncate font-medium" title={d.fileName}>
        {d.fileName || 'Document'}.{d.format}
      </p>
      <p className="mt-0.5 text-muted">
        {d.format === 'pdf' ? 'PDF' : 'Word'} · {d.orientation} · {d.source === 'all_fields' ? 'all fields' : 'custom body'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={clsx('rounded-lg border px-2 py-0.5 text-[11.5px] font-medium', CHIP.file)}>{file?.label ?? 'File field missing'}</span>
        <span className={clsx('rounded-lg px-2 py-0.5 text-[11.5px] font-medium', d.requireReview ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success')}>{d.requireReview ? 'Review, then continue' : 'Continues automatically'}</span>
      </div>
    </StepCard>
  );
});

/**
 * One output per condition (checked top to bottom, first match wins), plus Otherwise when switched
 * on. Each row shows the condition and the step it leads to.
 */
const ConditionNode = memo(function ConditionNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { def, targets } = useEditor();
  const { cases, otherwise } = conditionCases(data as ConditionNodeData);
  const rows = [
    ...cases.map((c, k) => ({ handle: c.id, title: c.label || `Path ${k + 1}`, text: conditionText(c.when, def) })),
    ...(otherwise ? [{ handle: ELSE_HANDLE, title: 'Otherwise', text: 'None of the above' }] : []),
  ];
  return (
    <Shell id={id} type="condition" selected={selected} title={(data as ConditionNodeData).label || 'Depends on'} source={false} wide>
      <div className="-mx-2.5 divide-y divide-line/70">
        {rows.length === 0 && (
          <p className="px-2.5 py-2 text-[11px] italic text-muted">No paths yet — open the inspector to add one.</p>
        )}
        {rows.map((r) => {
          const to = targets.get(`${id}:${r.handle}`);
          return (
            <div key={r.handle} className="relative px-2.5 py-1.5 pr-4">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">{r.title}</p>
              <p className="line-clamp-2 font-medium">{r.text}</p>
              <p className={clsx('mt-0.5 flex items-center gap-1 text-[10px]', to ? 'text-muted' : 'italic text-warning')}>
                <ArrowRight className="size-3" /> {to ?? 'Not connected'}
              </p>
              <Handle id={r.handle} type="source" position={Position.Right} className={clsx('!-right-[5px]', r.handle === ELSE_HANDLE ? '!bg-muted' : '!bg-sky-500')} style={{ top: '50%' }} />
            </div>
          );
        })}
      </div>
    </Shell>
  );
});

/** Hangs off a stage; its output points at the stage to jump to (forward = skip, back = redo). */
const JumpNode = memo(function JumpNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { def, targets } = useEditor();
  const d = data as JumpNodeData;
  const to = targets.get(`${id}:`);
  const cleared = (d.clearFields ?? []).map((k) => def.fields.find((f) => f.key === k)?.label ?? k);
  return (
    <Shell id={id} type="jump" selected={selected} title={d.label || 'Stage Jump'}>
      <p className="text-muted">When the stage is done and</p>
      <p className="mt-0.5 line-clamp-2 font-medium">{conditionText(d.when, def)}</p>
      <p className={clsx('mt-1 flex items-center gap-1 font-medium', to ? 'text-rose-600 dark:text-rose-300' : 'italic text-warning')}>
        <ArrowRight className="size-3" /> {to ? `Jump to ${to}` : 'Pick a stage to jump to'}
      </p>
      {cleared.length > 0 && <p className="mt-0.5 truncate text-[10px] text-muted">Clears: {cleared.join(', ')}</p>}
    </Shell>
  );
});

const TimerNode = memo(function TimerNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { def } = useEditor();
  return (
    <Shell id={id} type="timer" selected={selected} title="Delay / Timer">
      <p className="text-muted">Next stage is due</p>
      <p className="mt-0.5 font-medium">{timerText(data as TimerNodeData, def)}</p>
    </Shell>
  );
});

const EVENT_TEXT: Record<string, string> = { stage_activated: 'When the stage starts', stage_completed: 'When the stage is done', stage_overdue: 'When the stage is overdue' };

const MessageNode = memo(function MessageNode({ id, data, selected }: NodeProps<FlowNode>) {
  const d = data as MessageNodeData;
  const channels = [d.email && 'EMAIL', d.whatsapp && 'WHATSAPP'].filter(Boolean).join(' · ');
  return (
    <Shell id={id} type="message" selected={selected} title={d.name || 'Message'} source={false}>
      <p className="text-[10px] font-semibold tracking-wide text-orange-600 dark:text-orange-300">{channels || 'EMAIL'}</p>
      <p className="text-muted">{EVENT_TEXT[d.event ?? 'stage_activated']}</p>
      {d.email?.subject ? <p className="mt-0.5 truncate font-medium">{d.email.subject}</p> : !d.whatsapp && <p className="mt-0.5 italic text-muted">No template configured</p>}
      {d.isActive === false && <p className="mt-0.5 font-medium text-warning">Paused</p>}
    </Shell>
  );
});

const WebhookNode = memo(function WebhookNode({ id, data, selected }: NodeProps<FlowNode>) {
  const d = data as WebhookNodeData;
  let host = '';
  try {
    host = d.url ? new URL(d.url).host : '';
  } catch {
    host = d.url ?? '';
  }
  return (
    <Shell id={id} type="webhook" selected={selected} title="Webhook" source={false}>
      <p className="text-muted">POST after the stage is done</p>
      <p className="mt-0.5 truncate font-medium">{host || <span className="italic text-muted">No URL yet</span>}</p>
    </Shell>
  );
});

const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps<FlowNode>) {
  return (
    <div className={clsx('w-52 animate-pop-in rounded-xl border border-yellow-300 bg-yellow-100 p-3 text-xs text-yellow-950 shadow-[var(--shadow-soft)] transition-shadow duration-200 hover:shadow-[var(--shadow-float)] dark:border-yellow-500/40 dark:bg-yellow-900/40 dark:text-yellow-100', selected && 'ring-2 ring-info')}>
      <StepActions id={id} preview={false} settingsLabel="Edit note" />
      <p className="whitespace-pre-wrap">{(data.text as string) || 'Double-click to write a note'}</p>
    </div>
  );
});

export const nodeTypes = {
  stage: StageNode,
  condition: ConditionNode,
  jump: JumpNode,
  timer: TimerNode,
  message: MessageNode,
  webhook: WebhookNode,
  document: DocumentNode,
  note: NoteNode,
};
