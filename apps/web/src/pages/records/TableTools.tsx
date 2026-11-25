/**
 * Records table tools (legacy View Table): a quick filter on each column, editing a cell in place,
 * and the column totals chooser.
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Filter, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type { Condition, ConditionGroup, FieldValue } from '@fms/core';
import { FieldInput } from '../../components/FieldInput';
import { Button, Input } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { fmtNumber } from '../../lib/format';
import type { ColumnTotals, FieldView, RecordDto, WorkflowView } from '../../lib/types';

// ------------------------------------------------------------------ popover shell
/**
 * Floats above the page (a portal), placed under its anchor — inside the table it would be clipped
 * by the scroll area and painted under later rows. Flips above the anchor near the bottom edge.
 */
function Popover({ anchor, onClose, children, className, width = 288 }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode; className?: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const h = ref.current?.offsetHeight ?? 320;
      const below = window.innerHeight - a.bottom - 12;
      const top = below >= Math.min(h, 320) || below >= a.top ? a.bottom + 4 : Math.max(8, a.top - 4 - h);
      setPos({ top, left: Math.max(8, Math.min(a.left, window.innerWidth - width - 8)), maxHeight: Math.max(160, top > a.top ? window.innerHeight - top - 8 : a.top - 12) });
    };
    place();
    // Again once the anchor and the popover are laid out (both may mount in the same commit).
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => (cancelAnimationFrame(raf), window.removeEventListener('resize', place), window.removeEventListener('scroll', place, true));
  }, [anchor, width]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [onClose, anchor]);
  return createPortal(
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: pos?.maxHeight }}
      className={clsx('z-50 animate-pop-in overflow-y-auto rounded-2xl border border-line bg-surface p-3 text-left text-sm font-normal normal-case tracking-normal text-fg shadow-[var(--shadow-float)]', className)}
    >
      {children}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ column filter
type FilterKind = 'values' | 'boolean' | 'number' | 'date' | 'file';
export function filterKind(f: FieldView): FilterKind {
  if (f.type === 'checkbox') return 'boolean';
  if (f.type === 'number' || f.type === 'computed') return 'number';
  if (f.type === 'date' || f.type === 'datetime') return 'date';
  if (f.type === 'file') return 'file';
  return 'values';
}

/** The conditions of a filter group that belong to one column. */
export const columnConditions = (g: ConditionGroup, key: string) => g.conditions.filter((c) => c.field === key);

export function ColumnFilter({ wf, field, filters, archived, onApply }: { wf: WorkflowView; field: FieldView; filters: ConditionGroup; archived: boolean; onApply: (conds: Condition[]) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const active = columnConditions(filters, field.key).length > 0;
  return (
    <span className="relative inline-flex">
      <button
        ref={btn}
        type="button"
        aria-label={`Filter ${field.label}`}
        title={active ? 'Filtered — change or clear' : 'Filter this column'}
        onClick={(e) => (e.stopPropagation(), setOpen(!open))}
        className={clsx('grid size-6 place-items-center rounded-md transition-colors', active ? 'bg-info text-white' : 'text-muted opacity-60 hover:bg-surface hover:opacity-100 group-hover:opacity-100')}
      >
        <Filter className="size-3.5" />
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)}>
          <FilterBody wf={wf} field={field} current={columnConditions(filters, field.key)} archived={archived} onApply={(c) => (onApply(c), setOpen(false))} />
        </Popover>
      )}
    </span>
  );
}

function FilterBody({ wf, field, current, archived, onApply }: { wf: WorkflowView; field: FieldView; current: Condition[]; archived: boolean; onApply: (c: Condition[]) => void }) {
  const kind = filterKind(field);
  const emptyMode = current.find((c) => c.op === 'empty' || c.op === 'not_empty')?.op ?? null;
  const footer = (apply: () => void, disabled = false) => (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-line/70 pt-2.5">
      <Button size="xs" variant="ghost" icon={<X />} onClick={() => onApply([])} disabled={!current.length}>
        Clear
      </Button>
      <Button size="xs" variant="primary" icon={<Check />} onClick={apply} disabled={disabled}>
        Apply
      </Button>
    </div>
  );
  const blanks = (
    <div className="mb-2 flex gap-1">
      {(['empty', 'not_empty'] as const).map((op) => (
        <button key={op} type="button" onClick={() => onApply(emptyMode === op ? [] : [{ field: field.key, op }])} className={clsx('rounded-lg px-2 py-1 text-xs transition-colors', emptyMode === op ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted hover:text-fg')}>
          {op === 'empty' ? 'Is empty' : 'Has a value'}
        </button>
      ))}
    </div>
  );

  if (kind === 'boolean' || kind === 'file') {
    const on = current[0]?.op;
    const opts: [Condition['op'], string][] = kind === 'boolean' ? [['is_true', 'Yes'], ['is_false', 'No']] : [['not_empty', 'Has a file'], ['empty', 'No file']];
    return (
      <div>
        <p className="mb-2 text-xs font-semibold text-muted">{field.label}</p>
        <div className="flex gap-1">
          {opts.map(([op, label]) => (
            <button key={op} type="button" onClick={() => onApply(on === op ? [] : [{ field: field.key, op }])} className={clsx('flex-1 rounded-lg px-2 py-1.5 text-sm transition-colors', on === op ? 'bg-primary text-primary-fg' : 'bg-surface-2 hover:bg-line/60')}>
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (kind === 'number' || kind === 'date') return <RangeFilter field={field} kind={kind} current={current} blanks={blanks} footer={footer} onApply={onApply} />;
  return <ValuesFilter wf={wf} field={field} current={current} archived={archived} blanks={blanks} footer={footer} onApply={onApply} />;
}

function RangeFilter({ field, kind, current, blanks, footer, onApply }: { field: FieldView; kind: 'number' | 'date'; current: Condition[]; blanks: ReactNode; footer: (apply: () => void, disabled?: boolean) => ReactNode; onApply: (c: Condition[]) => void }) {
  const pick = (op: 'gte' | 'lte') => {
    const v = current.find((c) => c.op === op)?.value;
    return v === undefined || v === null ? '' : String(v).slice(0, 10);
  };
  const [from, setFrom] = useState(pick('gte'));
  const [to, setTo] = useState(pick('lte'));
  const type = kind === 'number' ? 'number' : 'date';
  const conds = (): Condition[] => [
    ...(from !== '' ? [{ field: field.key, op: 'gte' as const, value: kind === 'number' ? Number(from) : from }] : []),
    // A whole "to" day for date-time fields.
    ...(to !== '' ? [{ field: field.key, op: 'lte' as const, value: kind === 'number' ? Number(to) : field.type === 'datetime' ? `${to}T23:59:59.999Z` : to }] : []),
  ];
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-muted">{field.label}</p>
      {blanks}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">
          {kind === 'number' ? 'At least' : 'From'}
          <Input type={type} className="mt-1 h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          {kind === 'number' ? 'At most' : 'To'}
          <Input type={type} className="mt-1 h-9" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {footer(() => onApply(conds()), from === '' && to === '')}
    </div>
  );
}

function ValuesFilter({ wf, field, current, archived, blanks, footer, onApply }: { wf: WorkflowView; field: FieldView; current: Condition[]; archived: boolean; blanks: ReactNode; footer: (apply: () => void, disabled?: boolean) => ReactNode; onApply: (c: Condition[]) => void }) {
  const fixed = field.type === 'select' || field.type === 'multiselect' ? (field.options ?? []) : null;
  const used = useQuery({
    queryKey: ['column-values', wf.key, field.key, archived],
    queryFn: () => api<{ items: { value: string; count: number }[] }>(`/workflows/${wf.key}/records/values`, { query: { field: field.key, archived: String(archived) } }).then((r) => r.items),
    enabled: !fixed,
    staleTime: 30_000,
  });
  const values = fixed ?? used.data?.map((v) => v.value) ?? [];
  const counts = new Map(used.data?.map((v) => [v.value, v.count]));
  const initial = current.find((c) => c.op === 'in' || c.op === 'eq');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial ? (Array.isArray(initial.value) ? initial.value : [String(initial.value ?? '')]) : []));
  const [q, setQ] = useState('');
  const shown = useMemo(() => values.filter((v) => v.toLowerCase().includes(q.trim().toLowerCase())), [values, q]);
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-muted">{field.label}</p>
      {blanks}
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted" />
        <Input className="h-8 pl-8 text-[13px]" placeholder="Search values" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {used.isLoading && !fixed && <p className="px-1 py-2 text-xs text-muted">Loading values…</p>}
        {!used.isLoading && shown.length === 0 && <p className="px-1 py-2 text-xs text-muted">No values</p>}
        {shown.map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-2">
            <input type="checkbox" checked={picked.has(v)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(v); else n.delete(v); return n; })} />
            <span className="min-w-0 flex-1 truncate">{v}</span>
            {counts.has(v) && <span className="text-[11px] tabular-nums text-muted">{counts.get(v)}</span>}
          </label>
        ))}
      </div>
      {footer(() => onApply(picked.size ? [{ field: field.key, op: 'in', value: [...picked] }] : []), !picked.size && !current.length)}
    </div>
  );
}

// ------------------------------------------------------------------ inline edit
/** Can this user change this cell right here (the server checks again on save)? */
export function canEditCell(wf: WorkflowView, f: FieldView, r: RecordDto, isAdmin: boolean): boolean {
  if (!f.canEdit || !wf.isActive || r.archivedAt) return false;
  if (['computed', 'user-email', 'file'].includes(f.type)) return false;
  if (wf.stages.some((s) => s.document?.fieldKey === f.key)) return false;
  const stage = wf.stages.find((s) => s.key === f.stageKey);
  const st = r.stages.find((s) => s.stageKey === f.stageKey);
  if (!stage || !st || !['active', 'done'].includes(st.status)) return false;
  if (stage.lockAfterComplete && st.status === 'done') return false;
  if (stage.canEdit === false) return false;
  if (stage.singleUpdate === false && !isAdmin) return false;
  return true;
}

export function InlineEditor({ wf, field, record, anchor, onClose, onSaved }: { wf: WorkflowView; field: FieldView; record: RecordDto; anchor: RefObject<HTMLElement | null>; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState<FieldValue | undefined>(record.data[field.key]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/workflows/${wf.key}/records/${record.id}`, { method: 'PATCH', body: { data: { [field.key]: value ?? null }, version: record.version } });
      toast.success(`#${record.number}: ${field.label} saved`);
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof ApiError && e.details?.[field.key] ? e.details[field.key]! : (e as Error).message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={320}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="mb-2 text-xs font-semibold text-muted">
          #{record.number} · {field.label}
        </p>
        <FieldInput field={field} value={value} onChange={setValue} zone={wf.timezone} data={{ ...record.data, [field.key]: value }} invalid={!!error} />
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button size="xs" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" variant="primary" type="submit" loading={busy} icon={<Check />}>
            Save
          </Button>
        </div>
      </form>
    </Popover>
  );
}

// ------------------------------------------------------------------ totals
export type TotalKind = 'none' | 'sum' | 'avg' | 'min' | 'max' | 'filled' | 'unique';
const TOTAL_LABEL: Record<TotalKind, string> = { none: '—', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', filled: 'Count', unique: 'Unique' };

export function TotalCell({ field, totals, kind, onKind }: { field: FieldView; totals: ColumnTotals | undefined; kind: TotalKind; onKind: (k: TotalKind) => void }) {
  const numeric = field.type === 'number' || field.type === 'computed';
  const kinds: TotalKind[] = numeric ? ['sum', 'avg', 'min', 'max', 'filled', 'unique', 'none'] : ['filled', 'unique', 'none'];
  const value = kind === 'none' || !totals ? null : totals[kind];
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <select
        aria-label={`Total for ${field.label}`}
        value={kind}
        onChange={(e) => onKind(e.target.value as TotalKind)}
        onClick={(e) => e.stopPropagation()}
        className="cursor-pointer rounded-md bg-transparent py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted outline-none hover:text-fg"
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {TOTAL_LABEL[k]}
          </option>
        ))}
      </select>
      {value !== null && value !== undefined && <span className="font-semibold tabular-nums text-fg">{fmtNumber(kind === 'avg' ? Math.round(value * 100) / 100 : value)}</span>}
    </span>
  );
}
