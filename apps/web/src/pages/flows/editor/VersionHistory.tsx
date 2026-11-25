import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArchiveRestore, CircleMinus, CirclePlus, History, Loader2, PenLine, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { diffFlows, summarizeChanges, type ChangeArea, type FlowChange, type FlowSnapshot } from '@fms/core';
import { Badge, Button, ErrorNote, Tabs } from '../../../components/ui';
import { api } from '../../../lib/api';
import { fmtDateTime, fmtRelative } from '../../../lib/format';
import type { FlowVersion, FlowVersionSummary } from '../../../lib/types';

const AREA: Record<ChangeArea, string> = { flow: 'Flow', stage: 'Stage', field: 'Field', settings: 'Settings', message: 'Message', layout: 'Layout' };

function noteText(note: string | null): { text: string; tone: 'neutral' | 'success' | 'info' | 'warning' } {
  if (!note) return { text: 'Saved', tone: 'neutral' };
  if (note.startsWith('restored:')) return { text: `Restored from v${note.slice(9)}`, tone: 'warning' };
  return (
    {
      created: { text: 'Created', tone: 'info' as const },
      published: { text: 'Published', tone: 'success' as const },
      form_editor: { text: 'Form editor', tone: 'neutral' as const },
      saved: { text: 'Saved', tone: 'neutral' as const },
    }[note] ?? { text: note, tone: 'neutral' as const }
  );
}

/**
 * Version history of a flow: every save is a version. Pick one to see what changed in it (against the
 * version before), or what restoring it would change in the editor; Restore loads it into the editor,
 * where it is checked and saved like any edit (so it becomes the next version, and Undo still works).
 */
export function VersionHistory({ flowKey, editor, dirty, isDraft, onRestore, onClose }: { flowKey: string; editor: FlowSnapshot; dirty: boolean; isDraft: boolean; onRestore: (v: FlowVersion) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const list = useQuery({ queryKey: ['flow-versions', flowKey], queryFn: () => api<{ current: number; items: FlowVersionSummary[] }>(`/flows/${flowKey}/versions`), staleTime: 0 });
  const items = list.data?.items ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked ?? items[0]?.version ?? null;
  const index = items.findIndex((v) => v.version === selected);
  const previous = index >= 0 ? (items[index + 1]?.version ?? null) : null;
  const [mode, setMode] = useState<'version' | 'editor'>('version');

  const load = (v: number | null) => ({
    queryKey: ['flow-version', flowKey, v],
    queryFn: () => api<FlowVersion>(`/flows/${flowKey}/versions/${v}`),
    enabled: v !== null,
    staleTime: Infinity, // a saved version never changes
  });
  const sel = useQuery(load(selected));
  const prev = useQuery(load(previous));

  const changes = useMemo<FlowChange[] | null>(() => {
    if (!sel.data) return null;
    if (mode === 'editor') return diffFlows(editor, sel.data);
    if (previous === null) return [];
    return prev.data ? diffFlows(prev.data, sel.data) : null;
  }, [mode, sel.data, prev.data, previous, editor]);

  const current = list.data?.current;
  const isCurrent = selected === current;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [selected]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Version history"
      className="m-auto h-[min(760px,calc(100%-2rem))] w-[min(1040px,calc(100%-2rem))] max-w-none overflow-hidden rounded-[22px] border border-line/70 bg-surface p-0 text-fg shadow-[var(--shadow-float)]"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-line/70 px-5 py-3.5">
          <span className="grid size-9 place-items-center rounded-xl bg-surface-2">
            <History className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold">Version history</h2>
            <p className="text-xs text-muted">Every save is a version. See what changed, or bring an older version back.</p>
          </div>
          <button type="button" onClick={() => ref.current?.close()} className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted transition-colors hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]">
          {/* ---- versions */}
          <nav aria-label="Versions" className="min-h-0 overflow-y-auto border-b border-line/70 p-2 md:border-b-0 md:border-r">
            <ErrorNote error={list.error} />
            {list.isLoading && (
              <p className="flex items-center gap-2 p-4 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </p>
            )}
            <ol className="relative space-y-0.5">
              {items.map((v) => {
                const n = noteText(v.note);
                const on = v.version === selected;
                return (
                  <li key={v.version}>
                    <button
                      type="button"
                      onClick={() => setPicked(v.version)}
                      aria-current={on}
                      className={clsx(
                        'group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-200 ease-[var(--ease-apple)]',
                        on ? 'bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]' : 'hover:bg-surface-2/60',
                      )}
                    >
                      <span className={clsx('mt-0.5 grid h-6 min-w-9 place-items-center rounded-lg px-1.5 text-[11px] font-semibold tabular-nums transition-colors', on ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted group-hover:bg-line/60')}>v{v.version}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-medium">{fmtRelative(v.createdAt)}</span>
                          {v.version === current && <Badge tone="success">Current</Badge>}
                          {v.note && v.note !== 'saved' && <Badge tone={n.tone}>{n.text}</Badge>}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted">{v.author?.name ?? 'System'}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* ---- details */}
          <section className="flex min-h-0 flex-col">
            {selected === null ? (
              !list.isLoading && <p className="p-8 text-center text-sm text-muted">No versions yet — save the flow to create one.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 border-b border-line/70 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold">
                      Version {selected}
                      {isCurrent && <span className="ml-2 text-xs font-medium text-success">current</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {items[index] && `${fmtDateTime(items[index].createdAt)} · ${items[index].author?.name ?? 'System'}${items[index].author?.email ? ` (${items[index].author!.email})` : ''}`}
                    </p>
                  </div>
                  <Tabs
                    value={mode}
                    onChange={setMode}
                    items={[
                      { value: 'version', label: previous === null ? 'Contents' : `Changes since v${previous}` },
                      { value: 'editor', label: 'If restored' },
                    ]}
                  />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  <ErrorNote error={sel.error ?? prev.error} />
                  {sel.data && !sel.data.valid && (
                    <p className="mb-3 rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning">This version was saved under older rules. If you restore it, the editor shows what needs fixing before it can be saved.</p>
                  )}
                  {changes === null ? (
                    <p className="flex items-center gap-2 text-sm text-muted">
                      <Loader2 className="size-4 animate-spin" /> Comparing…
                    </p>
                  ) : mode === 'version' && previous === null ? (
                    <FirstVersion v={sel.data!} />
                  ) : changes.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
                      {mode === 'editor' ? (dirty ? 'The editor already matches this version (apart from unsaved layout).' : 'The editor already matches this version.') : 'Saved without changes to the flow.'}
                    </p>
                  ) : (
                    <>
                      <p className="mb-3 text-[13px] text-muted">
                        {mode === 'editor' ? 'Restoring this version would change the editor like this: ' : ''}
                        <span className="font-medium text-fg">{summarizeChanges(changes)}</span>
                      </p>
                      <ChangeList changes={changes} />
                    </>
                  )}
                </div>

                <footer className="flex flex-wrap items-center gap-2 border-t border-line/70 bg-surface-2/40 px-5 py-3">
                  <p className="min-w-0 flex-1 text-xs text-muted">
                    {confirming
                      ? `The editor will show version ${selected}${dirty ? ' and your unsaved changes are replaced (Undo brings them back)' : ''}. Nothing changes for users until you save${isDraft ? '' : ' — saving makes it live'}.`
                      : isCurrent && !dirty
                        ? 'This is the version in use.'
                        : 'Restoring loads this version into the editor; save to keep it.'}
                  </p>
                  {confirming ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<ArchiveRestore className="size-4" />}
                        onClick={() => {
                          onRestore(sel.data!);
                          ref.current?.close();
                        }}
                      >
                        Restore v{selected}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="primary" icon={<ArchiveRestore className="size-4" />} disabled={!sel.data || (isCurrent && !dirty)} onClick={() => setConfirming(true)}>
                      {isCurrent ? 'Discard edits, back to this version' : 'Restore this version'}
                    </Button>
                  )}
                </footer>
              </>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}

function FirstVersion({ v }: { v: FlowVersion }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">The first version of the flow.</p>
      <ol className="space-y-1.5">
        {v.definition.stages.map((s, i) => (
          <li key={s.key} className="flex items-center gap-3 rounded-xl border border-line/80 px-3 py-2">
            <span className="grid size-6 place-items-center rounded-lg text-[11px] font-semibold text-white" style={{ background: s.color }}>
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
            <span className="text-xs text-muted">{v.definition.fields.filter((f) => f.stageKey === s.key).length} fields</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChangeList({ changes }: { changes: FlowChange[] }) {
  const icon = { added: <CirclePlus className="size-4 text-success" />, removed: <CircleMinus className="size-4 text-danger" />, changed: <PenLine className="size-4 text-warning" /> };
  const word = { added: 'Added', removed: 'Removed', changed: 'Changed' };
  return (
    <ul className="space-y-2">
      {changes.map((c, i) => (
        <li key={i} className="animate-pop-in rounded-xl border border-line/80 bg-surface px-3.5 py-2.5" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {icon[c.kind]}
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              {word[c.kind]} · {AREA[c.area]}
            </span>
            <span className="font-medium">{c.name}</span>
          </p>
          {c.details.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 pl-6 text-[13px] text-muted">
              {c.details.map((d, k) => (
                <li key={k} className="break-words">
                  {d}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
