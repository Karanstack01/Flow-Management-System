import { useQuery } from '@tanstack/react-query';
import { Paperclip, Upload, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { FieldValue } from '@fms/core';
import { api, openFile, uploadFile } from '../lib/api';
import type { FieldView, RecordData } from '../lib/types';
import { Input, Select, Textarea } from './ui';

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

/** Form values from each field's default (`TODAY` / `NOW` for dates). Fields without one are left out. */
export function fieldDefaults(fields: FieldView[], zone: string): RecordData {
  const out: RecordData = {};
  for (const f of fields) {
    const d = f.defaultValue?.trim();
    if (!d || ['file', 'computed', 'user-email'].includes(f.type)) continue;
    const now = DateTime.now().setZone(zone);
    const upper = d.toUpperCase();
    if (f.type === 'date') out[f.key] = upper === 'TODAY' || upper === 'NOW' ? now.toISODate() : d;
    else if (f.type === 'datetime') out[f.key] = upper === 'NOW' || upper === 'TODAY' ? now.toUTC().toISO() : DateTime.fromISO(d, { zone }).toUTC().toISO();
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
          <input type="checkbox" className="size-4 accent-[var(--color-primary)]" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {value === true ? 'Yes' : 'No'}
        </label>
      );
    case 'select':
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
      const parent = field.dependsOn ? String(data?.[field.dependsOn] ?? '') : '';
      const options = field.optionMap?.[parent] ?? [];
      return (
        <Select {...common} disabled={disabled || !parent} value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{parent ? '— Select —' : 'Choose the parent field first'}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
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
      return <MultiSelect options={field.options ?? []} value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} placeholder={field.placeholder} />;
    case 'file':
      return <FileInput value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} multiple={!!field.allowMultiple} label={field.placeholder} />;
    case 'user-email':
    case 'computed':
      return <Input disabled value={str} placeholder={field.type === 'computed' ? 'Calculated automatically' : 'Filled with your email'} readOnly />;
    default:
      return <Input {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}

function MultiSelect({ options, value, onChange, disabled, placeholder }: { options: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string }) {
  const remaining = options.filter((o) => !value.includes(o));
  return (
    <div className="input flex min-h-9 flex-wrap items-center gap-1 py-1">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-primary-soft px-1.5 py-0.5 text-xs text-primary">
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && remaining.length > 0 && (
        <select className="min-w-24 flex-1 bg-transparent text-sm outline-none" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{placeholder || 'Add…'}</option>
          {remaining.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export function FileChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const { data } = useQuery({ queryKey: ['file', id], queryFn: () => api<{ name: string; size: number }>(`/files/${id}/meta`), staleTime: Infinity });
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
        <FileChip key={id} id={id} onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== id))} />
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
