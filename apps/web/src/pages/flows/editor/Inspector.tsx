import type { Edge } from '@xyflow/react';
import clsx from 'clsx';
import { ArrowRight, ChevronDown, ChevronRight, CircleCheck, Eye, EyeOff, Lock, Maximize2, Minimize2, Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  conditionCases,
  isStageNode,
  ELSE_HANDLE,
  type ConditionCase,
  type ConditionGroup,
  type ConditionNodeData,
  type FieldDef,
  type JumpNodeData,
  type MessageNodeData,
  type StageDef,
  type TimerNodeData,
  type WebhookNodeData,
  type WorkflowDef,
  type WorkflowSettings,
} from '@fms/core';
import { ConditionEditor } from '../../../components/ConditionEditor';
import { Button, FormField, Input, Modal, Select, Tabs, Textarea } from '../../../components/ui';
import { FIELD_TYPE_LABEL, FieldSettings } from './FieldSettings';
import { MessagePreview, RichTextEditor, TokenInput } from './MessageComposer';
import { DocumentSettings, StageGeneral } from './StageSettings';
import type { FlowNode } from './nodes';

const EMPTY: ConditionGroup = { mode: 'all', conditions: [] };
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 64) || 'field';
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line">
      <button type="button" className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
      </button>
      {open && <div className="space-y-3 px-4 pb-4">{children}</div>}
    </section>
  );
}

export interface InspectorProps {
  node: FlowNode | null;
  def: WorkflowDef;
  settings: WorkflowSettings;
  groups: string[];
  /** Organization users, for per-field access lists. */
  users: { name: string; email: string }[];
  calendars: { id: string; name: string }[];
  calendarId: string;
  /** Stage keys present when the editor opened — they hold records, so their keys are locked. */
  savedStageKeys: ReadonlySet<string>;
  savedFieldKeys: ReadonlySet<string>;
  onNodeData: (id: string, patch: Record<string, unknown>) => void;
  onStage: (key: string, patch: Partial<StageDef>) => void;
  onFields: (fn: (fields: FieldDef[]) => FieldDef[]) => void;
  onSettings: (s: WorkflowSettings) => void;
  onCalendar: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  nodes: FlowNode[];
  edges: Edge[];
  nodeName: (id: string) => string;
  /** Connect one output of a node (Depends-on path handle, or null for a jump) to a target, or disconnect it. */
  onConnectOutput: (sourceId: string, handle: string | null, targetId: string | null) => void;
  flowKey: string;
  /** Roomy layout (the panel is wide). */
  wide: boolean;
  /** Toggle between the normal and the wide panel. */
  onToggleWide: () => void;
  onPreview: (id: string) => void;
}

export function Inspector(p: InspectorProps) {
  const { node } = p;
  const title = !node ? 'Flow settings' : node.type === 'stage' ? 'Stage' : node.type === 'condition' ? 'Depends on' : node.type === 'timer' ? 'Delay / Timer' : node.type === 'jump' ? 'Stage Jump' : node.type === 'message' ? 'Message' : node.type === 'webhook' ? 'Webhook' : node.type === 'note' ? 'Note' : 'Document';
  return (
    <aside className="flex h-full w-full flex-col border-l border-line/80 bg-surface shadow-[-12px_0_32px_-24px_rgb(0_0_0/0.35)]" aria-label="Inspector">
      <header className="flex items-center gap-1 border-b border-line px-4 py-3">
        <h2 className="flex-1 font-semibold">{title}</h2>
        {node && node.type !== 'note' && <Button size="sm" variant="ghost" aria-label="Preview this step" title="Preview" icon={<Eye className="size-4" />} onClick={() => p.onPreview(node.id)} />}
        <Button size="sm" variant="ghost" aria-label={p.wide ? 'Narrow panel' : 'Widen panel'} title={p.wide ? 'Narrow panel' : 'Widen panel (or drag its left edge)'} icon={p.wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />} onClick={p.onToggleWide} />
        {node && <Button size="sm" variant="ghost" aria-label="Delete node" title="Delete node" icon={<Trash2 className="size-4" />} onClick={() => p.onDelete(node.id)} />}
        <Button size="sm" variant="ghost" aria-label="Close panel" title="Close (Esc)" icon={<X className="size-4" />} onClick={p.onClose} />
      </header>
      <div className="@container flex-1 overflow-y-auto">
        {!node && <FlowSettings {...p} />}
        {node?.type === 'stage' && <StageInspector {...p} node={node} />}
        {node?.type === 'condition' && <ConditionInspector {...p} node={node} />}
        {node?.type === 'jump' && <JumpInspector {...p} node={node} />}
        {node?.type === 'timer' && <TimerInspector {...p} node={node} />}
        {node?.type === 'message' && <MessageInspector {...p} node={node} />}
        {node?.type === 'webhook' && <WebhookInspector {...p} node={node} />}
        {node?.type === 'note' && (
          <div className="p-4">
            <FormField label="Note">
              <Textarea className="min-h-40" value={(node.data.text as string) ?? ''} onChange={(e) => p.onNodeData(node.id, { text: e.target.value })} />
            </FormField>
          </div>
        )}
        {node?.type === 'document' && <DocumentInspector {...p} node={node} />}
      </div>
    </aside>
  );
}

const conditionFields = (def: WorkflowDef) => def.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }));

function FlowSettings({ settings: s, onSettings, calendars, calendarId, onCalendar }: InspectorProps) {
  const toggle = (label: string, checked: boolean, set: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
  return (
    <>
      <p className="px-4 pt-3 text-xs text-muted">Select a node to edit it. Drag steps from the left panel and connect them left to right.</p>
      <Section title="Working calendar">
        <Select value={calendarId} onChange={(e) => onCalendar(e.target.value)} aria-label="Business calendar">
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">Delay/Timer hours count only working hours on this calendar.</p>
      </Section>
      <Section title="Notifications">
        {toggle('Email', s.channels.includes('email'), (v) => onSettings({ ...s, channels: v ? [...new Set([...s.channels, 'email' as const])] : s.channels.filter((c) => c !== 'email') }))}
        {toggle('WhatsApp', s.channels.includes('whatsapp'), (v) => onSettings({ ...s, channels: v ? [...new Set([...s.channels, 'whatsapp' as const])] : s.channels.filter((c) => c !== 'whatsapp') }))}
        {toggle('Notify the owners when a stage starts', s.handoff.enabled, (v) => onSettings({ ...s, handoff: { enabled: v } }))}
        {toggle('Send on holidays and weekly offs', s.sendOnHolidays, (v) => onSettings({ ...s, sendOnHolidays: v }))}
        <div className="flex items-center gap-2">
          {toggle('Remind before due, hours:', s.upcoming.enabled, (v) => onSettings({ ...s, upcoming: { ...s.upcoming, enabled: v } }))}
          <Input type="number" className="w-20" min={0} value={s.upcoming.hoursBefore} onChange={(e) => onSettings({ ...s, upcoming: { ...s.upcoming, hoursBefore: Number(e.target.value) } })} />
        </div>
        <div className="flex items-center gap-2">
          {toggle('Daily overdue list at hour:', s.overdueDigest.enabled, (v) => onSettings({ ...s, overdueDigest: { ...s.overdueDigest, enabled: v } }))}
          <Input type="number" className="w-20" min={0} max={23} value={s.overdueDigest.hour} onChange={(e) => onSettings({ ...s, overdueDigest: { ...s.overdueDigest, hour: Number(e.target.value) } })} />
        </div>
      </Section>
      <Section title="Auto-archive" defaultOpen={false}>
        <div className="flex items-center gap-2">
          {toggle('Archive finished records after days:', s.archive.enabled, (v) => onSettings({ ...s, archive: { ...s.archive, enabled: v } }))}
          <Input type="number" className="w-20" min={0} value={s.archive.completedDaysAgo} onChange={(e) => onSettings({ ...s, archive: { ...s.archive, completedDaysAgo: Number(e.target.value) } })} />
        </div>
      </Section>
    </>
  );
}

function DocumentInspector({ node, def, groups, users, savedStageKeys, onStage, onFields, flowKey, wide }: InspectorProps & { node: FlowNode }) {
  const key = node.data.stageKey as string | undefined;
  const stage = key ? def.stages.find((s) => s.key === key) : undefined;
  if (!key) return <p className="p-4 text-sm text-muted">This Document node was made before document steps existed and does nothing. Delete it and drag a new Document step from the left panel.</p>;
  if (!stage?.document) return <p className="p-4 text-sm text-danger">This document step no longer exists.</p>;
  return (
    <div className="p-4">
      <DocumentSettings stage={stage} def={def} isIntake={false} groups={groups} users={users} keyLocked={savedStageKeys.has(key)} flowKey={flowKey} wide={wide} onStage={(patch) => onStage(key, patch)} onFields={onFields} />
    </div>
  );
}

function StageInspector({ node, def, groups, users, savedStageKeys, savedFieldKeys, onStage, onFields, flowKey, wide }: InspectorProps & { node: FlowNode }) {
  const key = node.data.stageKey as string;
  const stage = def.stages.find((s) => s.key === key);
  const [tab, setTab] = useState<'general' | 'fields'>('general');
  if (!stage) return <p className="p-4 text-sm text-danger">This stage no longer exists.</p>;
  const isIntake = def.stages[0]?.key === key;
  const fields = def.fields.filter((f) => f.stageKey === key);
  const patchField = (fk: string, patch: Partial<FieldDef>) => onFields((all) => all.map((f) => (f.key === fk ? { ...f, ...patch } : f)));
  const addField = () => {
    let n = def.fields.length + 1;
    while (def.fields.some((f) => f.key === `field_${n}`)) n++;
    onFields((all) => [
      ...all,
      { key: `field_${n}`, label: `New field ${n}`, type: 'text', stageKey: key, required: false, unique: false, hidden: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: isIntake ? ['ALL'] : stage.responsibleGroups.length ? stage.responsibleGroups : ['ALL'] },
    ]);
  };
  return (
    <>
      <div className="px-4 pt-3">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'general', label: 'General' }, { value: 'fields', label: `Form fields (${fields.length})` }]} />
      </div>
      {tab === 'general' ? (
        <div className="p-4">
          <StageGeneral stage={stage} def={def} isIntake={isIntake} groups={groups} users={users} keyLocked={savedStageKeys.has(key)} flowKey={flowKey} wide={wide} onStage={(patch) => onStage(key, patch)} onFields={onFields} />
        </div>
      ) : (
        <div className="p-4">
          <div className={clsx('gap-2', wide ? 'grid grid-cols-1 @3xl:grid-cols-2 @3xl:items-start' : 'space-y-2')}>
            {fields.map((f, i) => (
              <FieldCard
                // Position, not key: the key changes while a new field is being named.
                key={i}
                field={f}
                def={def}
                isIntake={isIntake}
                locked={savedFieldKeys.has(f.key)}
                users={users}
                groups={groups}
                wide={wide}
                onChange={(patch) => patchField(f.key, patch)}
                onRemove={() => onFields((all) => all.filter((x) => x.key !== f.key))}
              />
            ))}
          </div>
          <Button className="mt-3" size="sm" icon={<Plus className="size-4" />} onClick={addField}>
            Add field
          </Button>
        </div>
      )}
    </>
  );
}

/** One form field: a compact summary row that opens into the full settings (or a large editor). */
function FieldCard({ field: f, def, isIntake, locked, users, groups, wide, onChange, onRemove }: { field: FieldDef; def: WorkflowDef; isIntake: boolean; locked: boolean; users: { name: string; email: string }[]; groups: string[]; wide?: boolean; onChange: (p: Partial<FieldDef>) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  // Unsaved fields keep their key in step with the name (saved keys never change).
  const autoKey = !locked && (f.key.startsWith('field_') || f.key === slug(f.label));
  const change = (patch: Partial<FieldDef>) => {
    if (patch.label !== undefined && autoKey && patch.label.trim()) {
      const candidate = slug(patch.label);
      if (candidate && !def.fields.some((x) => x.key !== f.key && x.key === candidate)) patch = { ...patch, key: candidate };
    }
    onChange(patch);
  };
  const settings = (wide: boolean) => <FieldSettings field={f} def={def} isIntake={isIntake} locked={locked} users={users} groups={groups} onChange={change} wide={wide} />;
  return (
    <div className={clsx('rounded-2xl border bg-surface transition-shadow', open ? 'border-line shadow-[var(--shadow-soft)]' : 'border-line/80')}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={clsx('size-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-90')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {f.label || 'Untitled field'}
              {f.required && <span className="text-danger"> *</span>}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              {FIELD_TYPE_LABEL[f.type]}
              {f.fieldAccessRestricted && (
                <span className="inline-flex items-center gap-0.5" title="Only assigned users">
                  <Lock className="size-3" />
                  {(f.fieldUsers ?? []).length}
                </span>
              )}
              {f.hidden && <EyeOff className="size-3" aria-label="Hidden" />}
              {f.validationRule && <span className="font-serif italic text-success">fx</span>}
              {isIntake && f.lineItem && <span>· row</span>}
            </span>
          </span>
        </button>
        <button type="button" onClick={() => setBig(true)} aria-label={`Open ${f.label} in a large editor`} title="Large editor" className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
          <Maximize2 className="size-3.5" />
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${f.label}`} title="Remove field" className="rounded-lg p-1 text-muted hover:bg-danger-soft hover:text-danger">
          <Trash2 className="size-4" />
        </button>
      </div>
      {open && <div className="animate-pop-in border-t border-line px-3 py-4">{settings(!!wide)}</div>}
      {big && (
        <Modal open wide onClose={() => setBig(false)} title={f.label || 'Field'} footer={<Button variant="primary" onClick={() => setBig(false)}>Done</Button>}>
          {settings(true)}
        </Modal>
      )}
    </div>
  );
}

/** Where an output goes — pick a step instead of dragging a line. */
function GoesTo({ value, options, onChange }: { value: string; options: { id: string; label: string }[]; onChange: (id: string | null) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <ArrowRight className="size-3.5 shrink-0 text-muted" />
      <span className="shrink-0 text-muted">Goes to</span>
      <Select className="h-8 py-0 text-xs" value={value} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— Not connected —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

const newCaseId = () => `p-${Math.random().toString(36).slice(2, 7)}`;

function ConditionInspector({ node, def, onNodeData, nodes, edges, nodeName, onConnectOutput }: InspectorProps & { node: FlowNode }) {
  const d = node.data as ConditionNodeData;
  const { cases, otherwise } = conditionCases(d);
  const setCases = (next: ConditionCase[], other = otherwise) => onNodeData(node.id, { cases: next, otherwise: other, when: undefined });
  const targetOf = (handle: string) => edges.find((e) => e.source === node.id && e.sourceHandle === handle)?.target ?? '';
  const options = nodes.filter((n) => n.id !== node.id && (isStageNode(n) || n.type === 'condition' || n.type === 'timer')).map((n) => ({ id: n.id, label: nodeName(n.id) }));
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-1.5 rounded-xl bg-surface-2 p-3 text-xs text-muted">
        <p>
          Each <b className="text-fg">path</b> has its own condition and output. Paths are checked from the top; a record follows the <b className="text-fg">first</b> one that matches.
        </p>
        <p>Turn on <b className="text-fg">Otherwise</b> for records that match none. Connect paths to the same next step to rejoin.</p>
      </div>
      <FormField label="Name">
        <Input value={d.label ?? ''} placeholder="e.g. Route by approval" onChange={(e) => onNodeData(node.id, { label: e.target.value })} />
      </FormField>
      {cases.map((c, k) => (
        <div key={c.id} className="space-y-2.5 rounded-xl border border-line p-3">
          <div className="flex items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sky-500/15 text-[11px] font-semibold text-sky-700 dark:text-sky-300">{k + 1}</span>
            <Input className="h-8 py-0 text-[13px]" value={c.label ?? ''} placeholder={`Path ${k + 1}`} aria-label={`Path ${k + 1} name`} onChange={(e) => setCases(cases.map((x) => (x.id === c.id ? { ...x, label: e.target.value || undefined } : x)))} />
            {cases.length > 1 && (
              <button type="button" aria-label={`Remove path ${k + 1}`} onClick={() => setCases(cases.filter((x) => x.id !== c.id))} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-danger">
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
          <ConditionEditor fields={conditionFields(def)} value={c.when} onChange={(when) => setCases(cases.map((x) => (x.id === c.id ? { ...x, when } : x)))} />
          <GoesTo value={targetOf(c.id)} options={options} onChange={(t) => onConnectOutput(node.id, c.id, t)} />
        </div>
      ))}
      <Button size="sm" icon={<Plus className="size-4" />} disabled={cases.length >= 10} onClick={() => setCases([...cases, { id: newCaseId(), when: EMPTY }])}>
        Add path
      </Button>
      <div className="space-y-2.5 rounded-xl border border-dashed border-line p-3">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>
            <span className="font-medium">Otherwise</span>
            <span className="block text-xs text-muted">Records that match none of the paths</span>
          </span>
          <input type="checkbox" checked={otherwise} onChange={(e) => setCases(cases, e.target.checked)} />
        </label>
        {otherwise && <GoesTo value={targetOf(ELSE_HANDLE)} options={options} onChange={(t) => onConnectOutput(node.id, ELSE_HANDLE, t)} />}
        {!otherwise && <p className="text-xs text-muted">Without it, unmatched records skip every path and continue where the paths rejoin.</p>}
      </div>
    </div>
  );
}

function JumpInspector({ node, def, onNodeData, nodes, edges, nodeName, onConnectOutput }: InspectorProps & { node: FlowNode }) {
  const d = node.data as JumpNodeData;
  const sourceNode = nodes.find((n) => n.id === edges.find((e) => e.target === node.id)?.source);
  const sourceKey = sourceNode && isStageNode(sourceNode) ? (sourceNode.data.stageKey as string) : null;
  const targetId = edges.find((e) => e.source === node.id)?.target ?? '';
  const targetKey = (nodes.find((n) => n.id === targetId)?.data.stageKey as string | undefined) ?? null;
  const si = sourceKey ? def.stages.findIndex((s) => s.key === sourceKey) : -1;
  const ti = targetKey ? def.stages.findIndex((s) => s.key === targetKey) : -1;
  const direction = si >= 0 && ti >= 0 ? (ti > si ? 'forward' : 'back') : null;
  const between = direction === 'forward' ? def.stages.slice(si + 1, ti) : direction === 'back' ? def.stages.slice(ti, si + 1) : [];
  const clear = new Set(d.clearFields ?? []);
  // Allow jump to target ANY stage (forward skip OR backward rework) plus Depends-on / Timer nodes.
  const stageOptions = nodes
    .filter((n) => n.id !== node.id && n.id !== sourceNode?.id && (isStageNode(n) || n.type === 'condition' || n.type === 'timer'))
    .map((n) => ({ id: n.id, label: nodeName(n.id) }));
  const toggle = (k: string, on: boolean) => onNodeData(node.id, { clearFields: on ? [...clear, k] : [...clear].filter((x) => x !== k) });
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-1.5 rounded-xl bg-surface-2 p-3 text-xs text-muted">
        <p>
          Connect a stage <b className="text-fg">into</b> this node, then pick where to jump. When that stage is done and the condition matches:
        </p>
        <p>
          <b className="text-fg">Forward</b> — the stages in between are skipped. <b className="text-fg">Back</b> — the stages from the target up to here are reopened for another round (rework); their owners are notified again.
        </p>
      </div>
      <FormField label="Name">
        <Input value={d.label ?? ''} placeholder="e.g. QC failed — redo production" onChange={(e) => onNodeData(node.id, { label: e.target.value })} />
      </FormField>
      <p className="text-xs">
        <span className="text-muted">After stage:</span> <b>{sourceKey ? nodeName(sourceNode!.id) : <i className="font-normal text-warning">connect a stage into this node</i>}</b>
      </p>
      <div>
        <p className="label">Jump when</p>
        <ConditionEditor fields={conditionFields(def)} value={d.when ?? EMPTY} onChange={(when) => onNodeData(node.id, { when })} />
      </div>
      <GoesTo value={targetId} options={stageOptions} onChange={(t) => onConnectOutput(node.id, null, t)} />
      {direction && (
        <p className={direction === 'back' ? 'rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300' : 'rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300'}>
          {direction === 'forward' ? (between.length ? `Skips: ${between.map((s) => s.name).join(', ')}` : 'Goes straight to the next stage (nothing to skip).') : `Reopens: ${between.map((s) => s.name).join(' → ')}`}
        </p>
      )}
      {direction === 'back' && (
        <div>
          <p className="label">Clear these fields so they are filled in again</p>
          <p className="mb-2 text-xs text-muted">Otherwise a stage that completes automatically would be done again at once — and the jump would fire again.</p>
          <div className="space-y-2">
            {between.map((s) => {
              const fields = def.fields.filter((f) => f.stageKey === s.key && f.type !== 'computed');
              if (!fields.length) return null;
              return (
                <div key={s.key}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{s.name}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {fields.map((f) => (
                      <label key={f.key} className={clsx('inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs', clear.has(f.key) ? 'border-rose-400 bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'border-line text-muted')}>
                        <input type="checkbox" className="sr-only" checked={clear.has(f.key)} onChange={(e) => toggle(f.key, e.target.checked)} />
                        {f.label}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TimerInspector({ node, def, onNodeData }: InspectorProps & { node: FlowNode }) {
  const d = node.data as TimerNodeData;
  const base = d.base ?? { kind: 'previous_stage' as const };
  const tat = d.tat ?? { kind: 'fixed' as const, hours: 8 };
  const dateFields = def.fields.filter((f) => f.type === 'date' || f.type === 'datetime');
  const choiceFields = def.fields.filter((f) => f.type === 'select');
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted">Sets when the next stage is due. Hours are working hours on the flow’s calendar (holidays and off-shift time are skipped).</p>
      <FormField label="Counted from">
        <Select
          value={base.kind === 'field' ? `field:${base.field}` : base.kind}
          onChange={(e) => {
            const v = e.target.value;
            onNodeData(node.id, { base: v.startsWith('field:') ? { kind: 'field', field: v.slice(6) } : { kind: v } });
          }}
        >
          <option value="previous_stage">When the previous stage is done</option>
          <option value="created">When the record is created</option>
          {dateFields.map((f) => (
            <option key={f.key} value={`field:${f.key}`}>
              Date in “{f.label}”
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Turnaround time">
        <Select value={tat.kind} onChange={(e) => onNodeData(node.id, { tat: e.target.value === 'by_field' ? { kind: 'by_field', field: choiceFields[0]?.key ?? '', map: {}, defaultHours: 8 } : { kind: 'fixed', hours: 8 } })}>
          <option value="fixed">Fixed number of hours</option>
          <option value="by_field" disabled={!choiceFields.length}>
            Depends on a dropdown (e.g. Priority)
          </option>
        </Select>
      </FormField>
      {tat.kind === 'fixed' ? (
        <FormField label="Working hours" hint="Negative = before the base time (e.g. −16 = two days before)">
          <Input type="number" step="any" value={tat.hours} onChange={(e) => onNodeData(node.id, { tat: { kind: 'fixed', hours: Number(e.target.value) } })} />
        </FormField>
      ) : (
        <>
          <FormField label="Dropdown field">
            <Select value={tat.field} onChange={(e) => onNodeData(node.id, { tat: { ...tat, field: e.target.value } })}>
              {choiceFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </FormField>
          {(def.fields.find((f) => f.key === tat.field)?.options ?? []).map((opt) => (
            <FormField key={opt} label={`Hours when “${opt}”`}>
              <Input type="number" step="any" value={tat.map[opt] ?? ''} onChange={(e) => onNodeData(node.id, { tat: { ...tat, map: { ...tat.map, [opt]: Number(e.target.value) } } })} />
            </FormField>
          ))}
          <FormField label="Otherwise (hours)">
            <Input type="number" step="any" value={tat.defaultHours ?? ''} onChange={(e) => onNodeData(node.id, { tat: { ...tat, defaultHours: e.target.value === '' ? undefined : Number(e.target.value) } })} />
          </FormField>
        </>
      )}
    </div>
  );
}

const isEmailField = (f: { type: string }) => ['email', 'user-email', 'text', 'system'].includes(f.type);
const isPhoneField = (f: { type: string }) => ['phone', 'text', 'system'].includes(f.type);

/** All message settings; used in the side panel and, roomier, in the full-screen editor. */
function MessageFields({ d, set, def }: { d: MessageNodeData; set: (patch: Partial<MessageNodeData>) => void; def: WorkflowDef }) {
  const [channel, setChannel] = useState<'email' | 'whatsapp'>(d.whatsapp && !d.email ? 'whatsapp' : 'email');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
        <FormField label="Name">
          <Input value={d.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <FormField label="Send">
          <Select value={d.event ?? 'stage_activated'} onChange={(e) => set({ event: e.target.value as MessageNodeData['event'] })}>
            <option value="stage_activated">When the stage starts</option>
            <option value="stage_completed">When the stage is done</option>
            <option value="stage_overdue">When the stage is overdue</option>
          </Select>
        </FormField>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <FormField label="Repeat every (days)" hint="Empty = once">
          <Input type="number" min={1} value={d.repeatEveryDays ?? ''} onChange={(e) => set({ repeatEveryDays: e.target.value ? Number(e.target.value) : undefined })} />
        </FormField>
        <label className="mb-7 inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.isActive !== false} onChange={(e) => set({ isActive: e.target.checked })} /> Active
        </label>
      </div>
      <Tabs
        value={channel}
        onChange={setChannel}
        items={[
          { value: 'email', label: <>Email{d.email && <CircleCheck className="size-3.5 text-success" aria-label="configured" />}</> },
          { value: 'whatsapp', label: <>WhatsApp{d.whatsapp && <CircleCheck className="size-3.5 text-success" aria-label="configured" />}</> },
        ]}
      />
      {channel === 'email' ? (
        <div className="space-y-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!d.email} onChange={(e) => set({ email: e.target.checked ? { to: '', subject: '', body: '' } : undefined })} /> Send an email
          </label>
          {d.email && (
            <>
              <FormField label="To" hint="Emails or a field tag, comma separated">
                <TokenInput def={def} value={d.email.to} placeholder="{{customer_email}}, ops@company.com" filter={isEmailField} onChange={(to) => set({ email: { ...d.email!, to } })} />
              </FormField>
              <FormField label="Cc">
                <TokenInput def={def} value={d.email.cc ?? ''} filter={isEmailField} onChange={(cc) => set({ email: { ...d.email!, cc: cc || undefined } })} />
              </FormField>
              <FormField label="Subject">
                <TokenInput def={def} value={d.email.subject} placeholder="Order {{record_number}} — {{customer}}" onChange={(subject) => set({ email: { ...d.email!, subject } })} />
              </FormField>
              <div>
                <p className="label">Body</p>
                <RichTextEditor def={def} value={d.email.body} onChange={(body) => set({ email: { ...d.email!, body } })} />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!d.whatsapp} onChange={(e) => set({ whatsapp: e.target.checked ? { to: '', body: '' } : undefined })} /> Send a WhatsApp message
          </label>
          {d.whatsapp && (
            <>
              <FormField label="To" hint="Phone numbers or a phone field tag">
                <TokenInput def={def} value={d.whatsapp.to} placeholder="{{customer_phone}}" filter={isPhoneField} onChange={(to) => set({ whatsapp: { ...d.whatsapp!, to } })} />
              </FormField>
              <div className="space-y-3 rounded-xl border border-line/80 p-3">
                <p className="text-xs text-muted">
                  <b className="text-fg">Approved template</b> — required by official WhatsApp to start a conversation. Use the exact name approved in your RedLava / Meta account.
                </p>
                <div className="grid grid-cols-[1fr_6rem] gap-2">
                  <FormField label="Template name">
                    <Input
                      value={d.whatsapp.template?.name ?? ''}
                      placeholder="order_update"
                      spellCheck={false}
                      onChange={(e) => {
                        const name = e.target.value.trim().toLowerCase();
                        set({ whatsapp: { ...d.whatsapp!, template: name ? { name, language: d.whatsapp!.template?.language, params: d.whatsapp!.template?.params ?? [] } : undefined } });
                      }}
                    />
                  </FormField>
                  <FormField label="Language">
                    <Input value={d.whatsapp.template?.language ?? ''} placeholder="en" disabled={!d.whatsapp.template} onChange={(e) => d.whatsapp!.template && set({ whatsapp: { ...d.whatsapp!, template: { ...d.whatsapp!.template, language: e.target.value.trim() || undefined } } })} />
                  </FormField>
                </div>
                {d.whatsapp.template && (
                  <div className="space-y-2">
                    <p className="label">Variables</p>
                    {[...d.whatsapp.template.params, ''].slice(0, Math.max(1, d.whatsapp.template.params.length + 1)).map((p, i, all) => (
                      <div key={i} className="flex items-center gap-2">
                        <code className="w-10 shrink-0 text-xs text-muted">{`{{${i + 1}}}`}</code>
                        <TokenInput
                          className="flex-1"
                          def={def}
                          value={p}
                          placeholder={i === all.length - 1 ? 'Add a variable…' : ''}
                          onChange={(v) => {
                            const params = [...d.whatsapp!.template!.params];
                            params[i] = v;
                            while (params.length && !params[params.length - 1]!.trim()) params.pop();
                            set({ whatsapp: { ...d.whatsapp!, template: { ...d.whatsapp!.template!, params } } });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <FormField label={d.whatsapp.template ? 'Fallback text (optional)' : 'Message'} hint={d.whatsapp.template ? undefined : 'Free text is delivered only within 24 hours of the customer’s last message.'}>
                <TokenInput def={def} multiline value={d.whatsapp.body} onChange={(body) => set({ whatsapp: { ...d.whatsapp!, body } })} />
              </FormField>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MessageInspector({ node, def, onNodeData }: InspectorProps & { node: FlowNode }) {
  const d = node.data as MessageNodeData;
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [expanded, setExpanded] = useState(false);
  const set = (patch: Partial<MessageNodeData>) => onNodeData(node.id, patch);
  return (
    <div className="@container space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Tabs
          value={view}
          onChange={setView}
          items={[
            { value: 'edit', label: 'Compose' },
            { value: 'preview', label: <><Eye className="size-3.5" />Preview</> },
          ]}
        />
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Maximize2 className="size-4" />} onClick={() => setExpanded(true)}>
          Expand
        </Button>
      </div>
      <p className="text-xs text-muted">Connect this node to a stage. Use the Tags buttons to insert form fields.</p>
      {view === 'edit' ? <MessageFields d={d} set={set} def={def} /> : <MessagePreview data={d} def={def} flowName={def.name} />}
      {expanded && (
        <Modal open wide onClose={() => setExpanded(false)} title={d.name || 'Message'} footer={<Button variant="primary" onClick={() => setExpanded(false)}>Done</Button>}>
          <div className="@container grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr]">
            <MessageFields d={d} set={set} def={def} />
            <div className="lg:sticky lg:top-0 lg:self-start">
              <p className="label">Live preview</p>
              <MessagePreview data={d} def={def} flowName={def.name} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WebhookInspector({ node, def, onNodeData }: InspectorProps & { node: FlowNode }) {
  const d = node.data as WebhookNodeData;
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted">Connect after a stage: once that stage is done (and the optional conditions match), the record is POSTed as JSON, signed with the secret (header x-fms-signature). Each record is sent once.</p>
      <FormField label="URL">
        <Input type="url" placeholder="https://" value={d.url ?? ''} onChange={(e) => onNodeData(node.id, { url: e.target.value })} />
      </FormField>
      <FormField label="Signing secret" hint="16+ characters, optional">
        <Input value={d.secret ?? ''} onChange={(e) => onNodeData(node.id, { secret: e.target.value || undefined })} />
      </FormField>
      <FormField label="Fields to send" hint="Field keys, comma separated. Empty = all">
        <Input defaultValue={(d.fields ?? []).join(', ')} onBlur={(e) => onNodeData(node.id, { fields: list(e.target.value) })} />
      </FormField>
      <p className="label">Only when (optional)</p>
      <ConditionEditor fields={conditionFields(def)} value={d.when ?? EMPTY} onChange={(when) => onNodeData(node.id, { when })} />
    </div>
  );
}
