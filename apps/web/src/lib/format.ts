import { DateTime } from 'luxon';
import type { FieldView } from './types';

export function fmtDateTime(iso: string | null | undefined, zone?: string) {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso, { zone: zone ?? 'local' });
  return dt.isValid ? dt.toFormat('dd LLL yyyy, HH:mm') : '—';
}

/** A calendar date in the app's one date format (dd LLL yyyy). */
export function fmtDate(iso: string | null | undefined, zone?: string) {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso, { zone: zone ?? 'local' });
  return dt.isValid ? dt.toFormat('dd LLL yyyy') : '—';
}

export function fmtRelative(iso: string | null | undefined) {
  if (!iso) return '';
  return DateTime.fromISO(iso).toRelative() ?? '';
}

export function fmtHours(h: number | null | undefined) {
  if (h === null || h === undefined) return '—';
  // Working hours (the calendar decides the day length, so we never convert to days here).
  const text = `${Math.round(Math.abs(h) * 10) / 10} wh`;
  return h < 0 ? `in ${text}` : text;
}

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const fmtNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : nf.format(n));

/** Display text for a field value (tables, history). */
export function displayValue(field: Pick<FieldView, 'type'> | undefined, v: unknown, zone?: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return field?.type === 'file' ? `${v.length} file${v.length === 1 ? '' : 's'}` : v.join(', ');
  switch (field?.type) {
    case 'checkbox':
      return v ? 'Yes' : 'No';
    case 'datetime':
      return fmtDateTime(String(v), zone);
    case 'date': {
      const d = DateTime.fromISO(String(v));
      return d.isValid ? d.toFormat('dd LLL yyyy') : String(v);
    }
    case 'number':
    case 'computed':
      // A formula may also give text, a date or TRUE / FALSE.
      return typeof v === 'number' ? fmtNumber(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    default:
      return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  }
}
