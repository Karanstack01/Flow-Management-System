/**
 * Searchable dropdown (legacy `dropdown-search`): type to narrow a long option list, arrows + Enter
 * to pick, Esc to close. Single value, or several (`multiple`) shown as chips.
 */
import clsx from 'clsx';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  options: string[];
  value: string | string[] | null;
  onChange: (v: string | string[] | null) => void;
  multiple?: boolean;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Shown as the first entry of a single select, and when nothing is chosen. */
  emptyLabel?: string;
  'aria-label'?: string;
}

export function SearchSelect({ options, value, onChange, multiple, placeholder, disabled, invalid, emptyLabel = '— Select —', ...aria }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const chosen = multiple ? (Array.isArray(value) ? value : []) : [];
  const single = !multiple && typeof value === 'string' ? value : '';
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const pool = multiple ? options.filter((o) => !chosen.includes(o)) : options;
    return s ? pool.filter((o) => o.toLowerCase().includes(s)) : pool;
  }, [q, options, multiple, chosen]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    input.current?.focus();
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => setActive(0), [q, open]);

  const pick = (o: string) => {
    if (multiple) {
      onChange([...chosen, o]);
      setQ('');
      input.current?.focus();
    } else {
      onChange(o);
      setOpen(false);
      setQ('');
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(filtered.length - 1, a + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[active] !== undefined) pick(filtered[active]!);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Backspace' && multiple && !q && chosen.length) onChange(chosen.slice(0, -1));
  };

  return (
    <div ref={root} className="relative">
      <div
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        aria-label={aria['aria-label']}
        onClick={() => !disabled && setOpen(true)}
        onKeyDown={(e) => !open && !disabled && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && (e.preventDefault(), setOpen(true))}
        className={clsx('input flex min-h-10 cursor-pointer flex-wrap items-center gap-1 py-1.5 pr-8', disabled && 'cursor-not-allowed bg-surface-2 text-muted', invalid && 'border-danger')}
      >
        {multiple ? (
          chosen.length ? (
            chosen.map((v) => (
              <span key={v} className="inline-flex animate-pop-in items-center gap-1 rounded-lg bg-primary-soft px-2 py-0.5 text-xs text-fg">
                {v}
                {!disabled && (
                  <button type="button" aria-label={`Remove ${v}`} className="text-muted hover:text-fg" onClick={(e) => (e.stopPropagation(), onChange(chosen.filter((x) => x !== v)))}>
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))
          ) : (
            <span className="text-muted/80">{placeholder || 'Choose…'}</span>
          )
        ) : (
          <span className={clsx('truncate', !single && 'text-muted/80')}>{single || placeholder || emptyLabel}</span>
        )}
        <ChevronDown className={clsx('pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </div>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 animate-pop-in overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-float)]">
          <div className="flex items-center gap-2 border-b border-line/70 px-3">
            <Search className="size-4 shrink-0 text-muted" />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search…" aria-label="Search options" aria-controls={listId} className="h-10 w-full bg-transparent text-sm outline-none" />
          </div>
          <ul id={listId} role="listbox" aria-multiselectable={multiple} className="max-h-64 overflow-y-auto p-1">
            {!multiple && !q && single && (
              <li role="option" aria-selected={false} className="cursor-pointer rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2" onMouseDown={(e) => (e.preventDefault(), onChange(null), setOpen(false))}>
                {emptyLabel}
              </li>
            )}
            {filtered.length === 0 && <li className="px-2.5 py-2 text-sm text-muted">No matches</li>}
            {filtered.slice(0, 300).map((o, i) => (
              <li
                key={o}
                role="option"
                aria-selected={o === single}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => (e.preventDefault(), pick(o))}
                className={clsx('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-100', i === active ? 'bg-surface-2' : '')}
              >
                <span className="min-w-0 flex-1 truncate">{o}</span>
                {o === single && <Check className="size-4 text-success" />}
              </li>
            ))}
            {filtered.length > 300 && <li className="px-2.5 py-1.5 text-xs text-muted">Type to narrow {filtered.length - 300} more…</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
