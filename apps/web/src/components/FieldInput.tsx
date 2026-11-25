import { useQuery } from '@tanstack/react-query';
import { Paperclip, Upload, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { dependentOptions, staleDependents, type FieldValue } from '@fms/core';
import { api, fileThumbnail, openFile, uploadFile } from '../lib/api';
import type { FieldView, RecordData } from '../lib/types';
import { SearchSelect } from './SearchSelect';
import { Input, Select, Textarea } from './ui';

/** Dropdowns with more options than this get a search box. */
const SEARCH_FROM = 7;

interface Props {
  field: FieldView;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
  disabled?: boolean;
  zone: string;
  /** Sibling values, for dependent selects. */
  data?: RecordData;
  invalid?: boolean;
}

/**
 * Set one value and clear dependent dropdowns below it that the new value no longer offers
 * (Country → State → City). `context` holds values the form shows but does not edit (e.g. the
 * header for a repeating row); `canClear` limits clearing to fields this form may write (the server
 * clears the rest itself).
 */
export function changeWithDependents(fields: readonly FieldView[], data: RecordData, key: string, value: FieldValue, opts: { context?: RecordData; canClear?: (key: string) => boolean } = {}): RecordData {
  const next = { ...data, [key]: value };
  const stale = staleDependents(fields, { ...opts.context, ...next }, [key]);
  for (const k of Object.keys(stale)) if (!opts.canClear || opts.canClear(k)) next[k] = null;
  return next;
}

/** Form values from each field's default (`TODAY` / `NOW` for dates). Fields without one are left out. */
export function fieldDefaults(fields: FieldView[], zone: string): RecordData {
  const out: RecordData = {};
  for (const f of fields) {
    const d = f.defaultValue?.trim();
    if (!d || ['file', 'computed', 'user-email'].includes(f.type)) continue;
    const now = DateTime.now().setZone(zone);
    const upper = d.toUpperCase();
    if (f.type === 'date') out[f.key] = upper === 'TODAY' || upper === 'NOW' ? now.toISODate() : d;
    // Same as the server (core defaultFieldValues): TODAY = start of the day, NOW = this moment.
    else if (f.type === 'datetime') out[f.key] = upper === 'NOW' ? now.toUTC().toISO() : upper === 'TODAY' ? now.startOf('day').toUTC().toISO() : DateTime.fromISO(d, { zone }).toUTC().toISO();
    else if (f.type === 'number') out[f.key] = Number.isFinite(Number(d)) ? Number(d) : null;
    else if (f.type === 'checkbox') out[f.key] = ['true', 'yes', '1', 'on'].includes(d.toLowerCase());
    else if (f.type === 'multiselect') out[f.key] = d.split(',').map((x) => x.trim()).filter(Boolean);
    else out[f.key] = d;
  }
  return out;
}

export function FieldInput({ field, value, onChange, disabled, zone, data, invalid }: Props) {
  const listId = useId();
  const common = { disabled, 'aria-invalid': invalid || undefined, className: invalid ? 'border-danger' : undefined, placeholder: field.placeholder || undefined };
  const str = value === null || value === undefined ? '' : String(value);

  switch (field.type) {
    case 'textarea':
      return <Textarea {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <Input {...common} type="number" inputMode="decimal" step="any" value={str} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'email':
      return <Input {...common} type="email" autoComplete="off" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'phone':
      return <Input {...common} type="tel" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <Input {...common} type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} />;
    case 'datetime': {
      const local = str ? DateTime.fromISO(str).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm") : '';
      return (
        <Input
          {...common}
          type="datetime-local"
          value={local}
          onChange={(e) => onChange(e.target.value ? DateTime.fromISO(e.target.value, { zone }).toUTC().toISO() : null)}
        />
      );
    }
    case 'checkbox':
      return (
        <label className="inline-flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {value === true ? 'Yes' : 'No'}
        </label>
      );
    case 'select':
      // Long lists get a search box (legacy dropdown-search).
      if ((field.options?.length ?? 0) > SEARCH_FROM) return <SearchSelect options={field.options ?? []} value={str || null} onChange={(v) => onChange((v as string | null) ?? null)} placeholder={field.placeholder} disabled={disabled} invalid={invalid} aria-label={field.label} />;
      return (
        <Select {...common} value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{field.placeholder || '— Select —'}</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case 'dependent-select': {
      const parentValue = field.dependsOn ? data?.[field.dependsOn] : undefined;
      const parent = parentValue === null || parentValue === undefined ? '' : String(parentValue).trim();
      const options = dependentOptions(field, parent);
      const parentName = field.dependsOnLabel ? `“${field.dependsOnLabel}”` : 'the field it depends on';
      // A stored value from an older option list is still shown (and can be changed), not blanked.
      const legacy = str && !options.includes(str);
      const hint = !parent ? `Choose ${parentName} first` : !options.length ? `No choices for “${parent}”` : null;
      if (!hint && !legacy && options.length > SEARCH_FROM) return <SearchSelect options={options} value={str || null} onChange={(v) => onChange((v as string | null) ?? null)} placeholder={field.placeholder} disabled={disabled} invalid={invalid} aria-label={field.label} />;
      return (
        <>
          <Select {...common} disabled={disabled || (!parent && !str) || (!options.length && !str)} value={str} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">{hint ?? (field.placeholder || '— Select —')}</option>
            {legacy && <option value={str}>{str} (not offered for “{parent || '—'}”)</option>}
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
          {hint && !disabled && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
        </>
      );
    }
    case 'combobox':
      return (
        <>
          <Input {...common} list={listId} value={str} onChange={(e) => onChange(e.target.value)} />
          <datalist id={listId}>{(field.options ?? []).map((o) => <option key={o} value={o} />)}</datalist>
        </>
      );
    case 'multiselect':
      return <SearchSelect multiple options={field.options ?? []} value={Array.isArray(value) ? value : []} onChange={(v) => onChange(Array.isArray(v) ? v : [])} disabled={disabled} invalid={invalid} placeholder={field.placeholder} aria-label={field.label} />;
    case 'file':
      return <FileInput value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} multiple={!!field.allowMultiple} label={field.placeholder} />;
    case 'user-email':
    case 'computed':
      return <Input disabled value={str} placeholder={field.type === 'computed' ? 'Calculated automatically' : 'Filled with your email'} readOnly />;
    default:
      return <Input {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Image files show as a small picture (legacy image columns, Settings AE83); click opens it. */
export function FileThumb({ id, size = 40 }: { id: string; size?: number }) {
  const meta = useQuery({ queryKey: ['file', id], queryFn: () => api<{ name: string; size: number; mimeType?: string }>(`/files/${id}/meta`), staleTime: Infinity });
  const isImage = meta.data?.mimeType?.startsWith('image/');
  const src = useQuery({ queryKey: ['file-thumb', id], queryFn: () => fileThumbnail(id), enabled: !!isImage, staleTime: Infinity });
  if (!isImage) return <FileChip id={id} />;
  return (
    <button
      type="button"
      title={meta.data?.name}
      onClick={(e) => (e.stopPropagation(), openFile(id).catch((err: Error) => toast.error(err.message)))}
      className="shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2 transition-transform duration-200 hover:scale-105"
      style={{ width: size, height: size }}
    >
      {src.data ? <img src={src.data} alt={meta.data?.name ?? 'Image'} className="size-full object-cover" /> : <span className="block size-full animate-pulse" />}
    </button>
  );
}

export function FileChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const { data } = useQuery({ queryKey: ['file', id], queryFn: () => api<{ name: string; size: number; mimeType?: string }>(`/files/${id}/meta`), staleTime: Infinity });
  return (
    <span className="inline-flex max-w-64 items-center gap-1 rounded border border-line bg-surface-2 px-2 py-1 text-xs">
      <Paperclip className="size-3 shrink-0" />
      <button type="button" className="truncate text-primary hover:underline" onClick={() => openFile(id).catch((e: Error) => toast.error(e.message))}>
        {data?.name ?? 'Attachment'}
      </button>
      {onRemove && (
        <button type="button" aria-label="Remove attachment" onClick={onRemove}>
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function FileInput({ value, onChange, disabled, multiple, label }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; multiple: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const uploaded = await Promise.all([...files].slice(0, multiple ? undefined : 1).map(uploadFile));
      // A single-file field replaces its file instead of adding another.
      onChange(multiple ? [...value, ...uploaded.map((u) => u.id)] : uploaded.map((u) => u.id));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((id) => (
        <span key={id} className="inline-flex items-center gap-1">
          <FileThumb id={id} size={44} />
          {!disabled && (
            <button type="button" aria-label="Remove attachment" className="grid size-6 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-danger" onClick={() => onChange(value.filter((x) => x !== id))}>
              <X className="size-3.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 text-xs text-muted hover:bg-surface-2">
          <Upload className="size-3.5" /> {busy ? 'Uploading…' : !multiple && value.length ? 'Replace' : label || (multiple ? 'Attach files' : 'Attach')}
          <input type="file" multiple={multiple} className="sr-only" disabled={busy} onChange={(e) => (void pick(e.target.files), (e.target.value = ''))} />
        </label>
      )}
    </div>
  );
}
