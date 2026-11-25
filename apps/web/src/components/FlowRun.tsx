/**
 * The record page as a run of its flow: every step with its status, who works on it and what this
 * user may do there; the chosen step's timings, people and deliveries; and what comes after it.
 */
import clsx from 'clsx';
import { AlertCircle, ArrowDown, CalendarClock, Check, CheckCircle2, CircleDot, Eye, Flag, Hourglass, Lock, Mail, MessageCircle, Pencil, PlayCircle, RotateCw, SkipForward, Timer, TimerReset, Users, Webhook, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { deliveryAdvice, deliveryTitle } from '../lib/deliveries';
import { fmtDateTime, fmtRelative } from '../lib/format';
import type { DeliveryLog, HistoryEntry, RecordDto, StageDto, StageView, WorkflowView } from '../lib/types';
import { StageIntro } from './StageIntro';
import { Badge, Button } from './ui';

export type StepAccess = 'edit' | 'view' | 'none';
export const stepAccess = (s: StageView): StepAccess => (s.canView === false ? 'none' : s.canEdit === false ? 'view' : 'edit');
/** May this user complete the step when it is active (the server's rule when it sent one). */
export const canActOn = (s: StageView) => s.canAct ?? (s.isMine || s.responsibleGroups.length === 0);

/** Who works on a step: its assigned editors (restricted step), else its owner groups. */
export function ownersOf(s: StageView): { label: string; kind: 'people' | 'groups' | 'anyone' } {
  const editors = (s.assignees ?? []).filter((a) => a.role === 'Editor').map((a) => a.email.split('@')[0]!);
  if (s.assignees) return { label: editors.length ? editors.join(', ') : 'No one assigned yet', kind: 'people' };
  if (s.responsibleGroups.length) return { label: s.responsibleGroups.join(', '), kind: 'groups' };
  return { label: 'Anyone who can edit it', kind: 'anyone' };
}

/** "2 h 15 m", "3 d 4 h", "45 m" (clock time). */
export function fmtSpan(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d} d${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${mm ? ` ${mm} m` : ''}`;
  return `${mm} m`;
}

/** When each reached step (last) started: from the record history, else from the step before it. */
export function stepStarts(wf: WorkflowView, record: RecordDto, history?: HistoryEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of history ?? []) for (const e of h.events ?? []) if ((e.type === 'stage_activated' || e.type === 'stage_reopened') && !out.has(e.stageKey)) out.set(e.stageKey, h.createdAt);
  let prevEnd: string | null = record.createdAt;
  wf.stages.forEach((s, i) => {
    const st = record.stages.find((x) => x.stageKey === s.key);
    if (!st || st.status === 'waiting' || st.status === 'skipped') return;
    if (!out.has(s.key) && prevEnd) out.set(s.key, i === 0 ? record.createdAt : prevEnd);
    if (st.actualAt) prevEnd = st.actualAt;
  });
  return out;
}

function statusLine(s: StageView, st: StageDto | undefined): { text: string; tone: 'success' | 'info' | 'danger' | 'muted' | 'warning' } {
  const status = st?.status ?? 'waiting';
  if (status === 'done') {
    if (st?.plannedAt && st.actualAt) {
      const late = new Date(st.actualAt).getTime() - new Date(st.plannedAt).getTime();
      return late > 60_000 ? { text: `Done · ${fmtSpan(late)} late`, tone: 'warning' } : { text: 'Done · on time', tone: 'success' };
    }
    return { text: 'Done', tone: 'success' };
  }
  if (status === 'active') {
    if (st?.overdue && st.plannedAt) return { text: `Overdue by ${fmtSpan(Date.now() - new Date(st.plannedAt).getTime())}`, tone: 'danger' };
    return canActOn(s) ? { text: 'Your turn', tone: 'info' } : { text: `Waiting on ${ownersOf(s).label}`, tone: 'info' };
  }
  if (status === 'skipped') return { text: 'Skipped — not needed', tone: 'muted' };
  return { text: s.conditional ? 'Later · only if its conditions match' : 'Later', tone: 'muted' };
}

const TONE = { success: 'text-success', info: 'text-info', danger: 'text-danger', warning: 'text-warning', muted: 'text-muted' };

function StatusIcon({ status, overdue, color }: { status: string; overdue?: boolean; color: string }) {
  const base = 'relative grid size-8 shrink-0 place-items-center rounded-full ring-4 ring-surface transition-colors duration-300';
  if (status === 'done') return <span className={clsx(base, 'bg-success text-white')}><Check className="size-4" strokeWidth={3} /></span>;
  if (status === 'active')
    return (
      <span className={clsx(base, overdue ? 'bg-danger text-white' : 'text-white')} style={overdue ? undefined : { background: color }}>
        <span className={clsx('absolute inset-0 animate-ping rounded-full opacity-25', overdue ? 'bg-danger' : '')} style={overdue ? undefined : { background: color }} aria-hidden />
        {overdue ? <AlertCircle className="size-4" /> : <CircleDot className="size-4" />}
      </span>
    );
  if (status === 'skipped') return <span className={clsx(base, 'bg-surface-2 text-muted')}><SkipForward className="size-3.5" /></span>;
  return <span className={clsx(base, 'border-2 border-dashed border-line bg-surface text-muted')}><Hourglass className="size-3.5" /></span>;
}

const ACCESS: Record<StepAccess, { icon: ReactNode; text: string; cls: string }> = {
  edit: { icon: <Pencil className="size-3.5" />, text: 'You can fill this in', cls: 'text-success' },
  view: { icon: <Eye className="size-3.5" />, text: 'View only', cls: 'text-muted' },
  none: { icon: <Lock className="size-3.5" />, text: 'No access', cls: 'text-muted' },
};

// ------------------------------------------------------------------ left: the steps
export function StepList({ wf, record, selected, onSelect, failed }: { wf: WorkflowView; record: RecordDto; selected: string; onSelect: (key: string) => void; failed: ReadonlySet<string> }) {
  const doneCount = record.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pct = Math.round((doneCount / Math.max(1, wf.stages.length)) * 100);
  return (
    <nav aria-label="Steps" className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Steps</h2>
        <span className="text-xs tabular-nums text-muted">
          {doneCount}/{wf.stages.length} · {record.completedAt ? 'finished' : `${pct}%`}
        </span>
      </div>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div className="h-full rounded-full bg-success transition-[width] duration-700 ease-[var(--ease-apple)]" style={{ width: `${pct}%` }} />
      </div>
      <ol className="relative space-y-1">
        {wf.stages.map((s, i) => {
          const st = record.stages.find((x) => x.stageKey === s.key);
          const status = st?.status ?? 'waiting';
          const line = statusLine(s, st);
          const access = ACCESS[stepAccess(s)];
          const on = selected === s.key;
          return (
            <li key={s.key} className="relative">
              {/* connector to the next step: solid once this step is behind the record */}
              {i < wf.stages.length - 1 && <span className={clsx('absolute left-[27px] top-11 h-[calc(100%-28px)] w-0.5 rounded-full', status === 'done' || status === 'skipped' ? 'bg-success/50' : 'bg-line')} aria-hidden />}
              <button
                type="button"
                onClick={() => onSelect(s.key)}
                aria-current={on ? 'step' : undefined}
                className={clsx(
                  'group relative flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-200 ease-[var(--ease-apple)]',
                  on ? 'bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]' : 'hover:bg-surface-2/60',
                  status === 'skipped' && 'opacity-70',
                )}
              >
                <StatusIcon status={status} overdue={st?.overdue} color={s.color} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {failed.has(s.key) && <AlertCircle className="size-3.5 shrink-0 text-danger" aria-label="A message for this step failed" />}
                  </span>
                  <span className={clsx('block truncate text-xs font-medium', TONE[line.tone])}>{line.text}</span>
                  <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted">
                    <Users className="size-3 shrink-0" /> <span className="truncate">{ownersOf(s).label}</span>
                  </span>
                </span>
                <span className={clsx('mt-1 shrink-0', access.cls)} title={access.text} aria-label={access.text}>
                  {access.icon}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 border-t border-line/70 pt-3 text-[11px] text-muted">
        {(['edit', 'view', 'none'] as const).map((k) => (
          <span key={k} className={clsx('flex items-center gap-1', ACCESS[k].cls)}>
            {ACCESS[k].icon}
            <span className="text-muted">{ACCESS[k].text}</span>
          </span>
        ))}
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ right: the chosen step
export function StepDetails({ wf, record, stage, start, deliveries, isAdmin, onResend }: { wf: WorkflowView; record: RecordDto; stage: StageView; start: string | undefined; deliveries: DeliveryLog[] | undefined; isAdmin: boolean; onResend?: (d: DeliveryLog) => Promise<void> }) {
  const st = record.stages.find((x) => x.stageKey === stage.key);
  const status = st?.status ?? 'waiting';
  const index = wf.stages.findIndex((s) => s.key === stage.key);
  const prev = wf.stages.slice(0, index).reverse().find((s) => record.stages.find((x) => x.stageKey === s.key)?.status !== 'skipped');
  const owners = ownersOf(stage);
  const access = stepAccess(stage);
  const zone = wf.timezone;

  const banner: { tone: string; icon: ReactNode; title: string; text: string } =
    record.archivedAt
      ? { tone: 'bg-surface-2 text-muted', icon: <Lock className="size-4" />, title: 'Archived', text: 'Restore the record to work on it again.' }
      : status === 'active'
        ? canActOn(stage) && access === 'edit'
          ? { tone: 'bg-info-soft text-info', icon: <PlayCircle className="size-4" />, title: 'Your turn', text: stage.completion === 'conditions' ? 'Fill in the fields below — the step completes by itself when its conditions are met.' : 'Fill in the fields below, then mark the step done.' }
          : { tone: 'bg-surface-2 text-fg', icon: <Users className="size-4" />, title: `Waiting on ${owners.label}`, text: access === 'none' ? 'You do not have access to this step’s details.' : access === 'view' ? 'You can see this step, but only its assigned editors change it.' : 'They have been told it is their turn.' }
        : status === 'done'
          ? { tone: 'bg-success-soft text-success', icon: <CheckCircle2 className="size-4" />, title: 'Completed', text: `Finished ${fmtDateTime(st?.actualAt, zone)}.` }
          : status === 'skipped'
            ? { tone: 'bg-surface-2 text-muted', icon: <SkipForward className="size-4" />, title: 'Skipped', text: 'Its conditions did not apply to this record, so the flow went past it.' }
            : { tone: 'bg-surface-2 text-muted', icon: <Hourglass className="size-4" />, title: 'Not started yet', text: `${prev ? `Starts after “${prev.name}” is done` : 'Starts when the record is created'}${stage.conditional ? ', and only if its conditions match' : ''}.` };

  // Timings
  const end = st?.actualAt ?? null;
  const planned = st?.plannedAt ?? null;
  const now = Date.now();
  const delta = planned ? (end ? new Date(end).getTime() : now) - new Date(planned).getTime() : null;
  const cards = [
    { icon: <PlayCircle />, label: 'Started', value: start ? fmtDateTime(start, zone) : '—', sub: start ? fmtRelative(start) : status === 'skipped' ? 'skipped' : 'not yet', tone: 'text-info' },
    { icon: <CheckCircle2 />, label: 'Completed', value: end && status === 'done' ? fmtDateTime(end, zone) : '—', sub: end && status === 'done' ? fmtRelative(end) : status === 'active' ? 'in progress' : '', tone: 'text-success' },
    { icon: <Timer />, label: 'Duration', value: start ? fmtSpan((end && status === 'done' ? new Date(end).getTime() : now) - new Date(start).getTime()) : '—', sub: status === 'active' ? 'so far' : status === 'done' ? 'clock time' : '', tone: 'text-warning' },
    { icon: <CalendarClock />, label: 'Due', value: planned ? fmtDateTime(planned, zone) : '—', sub: planned ? '' : stage.plannedMode === 'manual' ? 'set by the owner' : stage.plannedMode === 'none' ? 'no due time' : 'set when it starts', tone: 'text-muted' },
    {
      icon: <TimerReset />,
      label: status === 'done' ? 'Late / early' : 'Time left',
      value: delta === null ? 'N/A' : status === 'done' ? (delta > 60_000 ? `${fmtSpan(delta)} late` : delta < -60_000 ? `${fmtSpan(delta)} early` : 'On time') : status === 'active' ? (delta > 0 ? `${fmtSpan(delta)} over` : `${fmtSpan(delta)} left`) : 'N/A',
      sub: '',
      tone: delta !== null && delta > 60_000 && status !== 'waiting' ? 'text-danger' : 'text-violet-600 dark:text-violet-300',
    },
  ];

  const mine = (deliveries ?? []).filter((d) => d.stageKey === stage.key);
  return (
    <section className="card overflow-hidden" aria-label="Step details">
      <div className="h-1" style={{ background: stage.color }} aria-hidden />
      <div className="space-y-4 p-5">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              <span className="size-2 rounded-full" style={{ background: stage.color }} /> Step {index + 1} of {wf.stages.length}
            </p>
            <h2 className="mt-0.5 text-xl font-semibold">{stage.name}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {stage.conditional && <Badge tone="info">Conditional</Badge>}
            {stage.lockAfterComplete && <Badge>Locks when done</Badge>}
            {stage.completion === 'conditions' && <Badge>Completes automatically</Badge>}
          </div>
        </header>

        <div className={clsx('flex items-start gap-3 rounded-2xl px-4 py-3', banner.tone)} role="status">
          <span className="mt-0.5">{banner.icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{banner.title}</p>
            <p className="text-[13px] opacity-90">{banner.text}</p>
          </div>
        </div>

        <StageIntro description={stage.description} video={stage.video} />

        {/* people and access */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-line/80 p-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Who works on it</p>
            {stage.assignees ? (
              <div className="flex flex-wrap gap-1.5">
                {stage.assignees.length === 0 && <span className="text-sm text-muted">No one assigned yet</span>}
                {stage.assignees.map((a) => (
                  <Badge key={a.email} tone={a.role === 'Editor' ? 'primary' : 'neutral'}>
                    {a.role === 'Editor' ? <Pencil className="size-3" /> : <Eye className="size-3" />} {a.email}
                  </Badge>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {stage.responsibleGroups.length ? stage.responsibleGroups.map((g) => <Badge key={g} tone="primary"><Users className="size-3" /> {g}</Badge>) : <span className="text-sm text-muted">{owners.label}</span>}
              </div>
            )}
            {stage.assignees && <p className="mt-1.5 text-[11px] text-muted">Only the people assigned to this step (it is restricted).</p>}
          </div>
          <div className="rounded-2xl border border-line/80 p-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Your access</p>
            <p className={clsx('flex items-center gap-1.5 text-sm font-medium', ACCESS[access].cls)}>
              {ACCESS[access].icon} {access === 'edit' ? (canActOn(stage) ? 'You can fill it in and complete it' : 'You can fill in some fields') : ACCESS[access].text}
            </p>
            <p className="mt-1 text-[11px] text-muted">{access === 'edit' ? (canActOn(stage) ? 'It also appears in your My Tasks while it is active.' : `Completing it is up to ${owners.label}.`) : access === 'view' ? 'You can see what was filled in.' : 'Its fields are hidden from you.'}</p>
          </div>
        </div>

        {/* timings */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {cards.map((c) => (
            <div key={c.label} className="rounded-2xl border border-line/80 bg-surface-2/40 p-3">
              <p className={clsx('flex items-center gap-1.5 text-xs font-medium [&>svg]:size-3.5', c.tone)}>
                {c.icon} {c.label}
              </p>
              <p className="mt-1.5 text-sm font-semibold tabular-nums">{c.value}</p>
              {c.sub && <p className="text-[11px] text-muted">{c.sub}</p>}
            </div>
          ))}
        </div>

        {isAdmin && <Deliveries items={mine} loading={!deliveries} onResend={onResend} />}
      </div>
    </section>
  );
}

const CHANNEL_ICON: Record<string, ReactNode> = { email: <Mail className="size-3.5" />, whatsapp: <MessageCircle className="size-3.5" />, webhook: <Webhook className="size-3.5" /> };

/** Hand-offs, message rules and webhooks can be sent again; reminders and digests follow their schedule. */
const RESENDABLE = new Set(['handoff', 'rule', 'webhook']);

function ResendButton({ d, onResend }: { d: DeliveryLog; onResend?: (d: DeliveryLog) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (!onResend || !RESENDABLE.has(d.kind) || d.status === 'pending') return null;
  return (
    <Button
      size="xs"
      variant={d.status === 'failed' ? 'primary' : 'secondary'}
      icon={<RotateCw />}
      loading={busy}
      onClick={() => {
        setBusy(true);
        void onResend(d).finally(() => setBusy(false));
      }}
    >
      Send again
    </Button>
  );
}

function Deliveries({ items, loading, onResend }: { items: DeliveryLog[]; loading: boolean; onResend?: (d: DeliveryLog) => Promise<void> }) {
  const [all, setAll] = useState(false);
  if (loading) return null;
  const problems = items.filter((d) => d.status === 'failed' || d.status === 'skipped');
  const rest = items.filter((d) => !problems.includes(d));
  if (!items.length) return <p className="text-xs text-muted">No messages were sent for this step.</p>;
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Messages for this step</p>
      {problems.map((d) => (
        <div key={d.id} className="animate-pop-in overflow-hidden rounded-2xl border border-danger/25 bg-danger-soft/60">
          <div className="flex items-start gap-3 px-4 py-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger/10 text-danger">
              <AlertCircle className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-danger">{deliveryTitle(d)}</p>
                <ResendButton d={d} onResend={onResend} />
              </div>
              <p className="text-[13px] text-danger/90">
                {d.ruleName ? `${d.ruleName} · ` : d.kind === 'handoff' ? 'Hand-off · ' : ''}to {d.recipient}
                {d.error ? ` — ${d.error}` : ''}
              </p>
              <div className="mt-2 rounded-xl border border-danger/15 bg-surface/80 px-3 py-2">
                <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-danger">
                  <Wrench className="size-3" /> How to fix
                </p>
                <ol className="list-decimal space-y-0.5 pl-4 text-[12.5px] text-fg">
                  {deliveryAdvice(d).map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <ul className="divide-y divide-line/70 rounded-2xl border border-line/80">
          {(all ? rest : rest.slice(0, 3)).map((d) => (
            <li key={d.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
              <span className="text-muted">{CHANNEL_ICON[d.channel] ?? <Mail className="size-3.5" />}</span>
              <span className="min-w-0 flex-1 truncate">
                {d.ruleName ?? (d.kind === 'handoff' ? 'Hand-off' : d.kind === 'upcoming' ? 'Reminder' : d.kind)} · {d.recipient}
              </span>
              <Badge tone={d.status === 'sent' ? 'success' : 'neutral'}>{d.status}</Badge>
              <span className="w-24 text-right text-xs text-muted">{fmtRelative(d.updatedAt)}</span>
              <ResendButton d={d} onResend={onResend} />
            </li>
          ))}
          {rest.length > 3 && (
            <li>
              <button type="button" className="w-full px-3 py-1.5 text-xs font-medium text-info hover:underline" onClick={() => setAll(!all)}>
                {all ? 'Show less' : `Show ${rest.length - 3} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ what comes next
export function NextSteps({ wf, record, stage, onSelect }: { wf: WorkflowView; record: RecordDto; stage: StageView; onSelect: (key: string) => void }) {
  const index = wf.stages.findIndex((s) => s.key === stage.key);
  const status = record.stages.find((x) => x.stageKey === stage.key)?.status ?? 'waiting';
  const after = wf.stages.slice(index + 1).filter((s) => record.stages.find((x) => x.stageKey === s.key)?.status !== 'skipped');
  const next = after[0];
  const lead = status === 'active' ? (stage.completion === 'conditions' ? 'When its conditions are met' : 'When this step is marked done') : status === 'done' ? 'After this step' : 'After this step is done';
  return (
    <section className="card p-5" aria-label="What comes next">
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
        <ArrowDown className="size-4 text-muted" /> What comes next
      </h2>
      {!next ? (
        <p className="flex items-center gap-2 rounded-2xl bg-success-soft px-4 py-3 text-sm text-success">
          <Flag className="size-4" /> {status === 'done' || record.completedAt ? 'This was the last step — the record is finished.' : 'This is the last step — finishing it completes the record.'}
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-[13px] text-muted">{lead}, the record moves to:</p>
          {after.slice(0, 3).map((s, i) => {
            const st = record.stages.find((x) => x.stageKey === s.key);
            const o = ownersOf(s);
            const yours = canActOn(s) && stepAccess(s) === 'edit';
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onSelect(s.key)}
                className={clsx('flex w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-[background-color,transform] duration-200 ease-[var(--ease-apple)] hover:-translate-y-px hover:bg-surface-2/60', i === 0 ? 'border-line' : 'border-dashed border-line/80 opacity-75')}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: s.color }}>
                  {wf.stages.indexOf(s) + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {i === 0 ? '' : 'then '}
                    {s.name}
                    {s.conditional && <span className="font-normal text-muted"> · if its conditions match</span>}
                  </span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted">
                    <Users className="size-3 shrink-0" /> {o.label}
                    {st?.status === 'done' && ' · already done'}
                  </span>
                </span>
                <span className={clsx('shrink-0 text-xs font-medium', yours ? 'text-success' : 'text-muted')}>{yours ? 'You can act' : stepAccess(s) === 'none' ? 'No access' : stepAccess(s) === 'view' ? 'View only' : 'Their turn'}</span>
              </button>
            );
          })}
          {after.length > 3 && <p className="pl-1 text-xs text-muted">+ {after.length - 3} more step{after.length - 3 === 1 ? '' : 's'}</p>}
        </div>
      )}
    </section>
  );
}
