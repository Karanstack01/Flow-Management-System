/**
 * Message templating. Supports `{{field_key}}` and the legacy `<<Field Label>>`
 * tags so existing Messages-tab templates can be imported unchanged.
 */
import type { FieldDef, RecordData } from './schema.js';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

/**
 * Clean email HTML written in the rich editor / HTML mode: drops scripts, styles, frames, forms,
 * event handlers and javascript: URLs; everything else (formatting, lists, links, tables) stays.
 */
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'\s>]*\2?/gi, '');
}

/** True when a message body is HTML (from the rich editor) rather than plain text. */
export const isHtmlBody = (body: string) => /<\/?(p|div|br|b|strong|i|em|u|h[1-6]|ul|ol|li|a|span|table|font)\b/i.test(body);

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/** Human title for a record: its search-key field(s), else "#number" (legacy SEARCHKEY). */
export function recordTitle(fields: readonly FieldDef[], data: RecordData, number: number): string {
  const parts = fields.filter((f) => f.searchKey).map((f) => formatValue(data[f.key])).filter(Boolean);
  return parts.length ? parts.join(' · ') : `#${number}`;
}

export interface TemplateContext {
  fields: readonly FieldDef[];
  data: RecordData;
  /** Extra variables, e.g. record_number, stage_name, link, planned_at. */
  extra?: Record<string, string | number | null | undefined>;
}

export function renderTemplate(template: string, ctx: TemplateContext, opts: { html?: boolean } = {}): string {
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(ctx.extra ?? {})) values.set(k.toLowerCase(), formatValue(v));
  for (const f of ctx.fields) {
    const v = formatValue(ctx.data[f.key]);
    values.set(f.key.toLowerCase(), v);
    values.set(f.label.trim().toLowerCase(), v);
  }
  const lookup = (name: string) => {
    const v = values.get(name.trim().toLowerCase()) ?? '';
    return opts.html ? escapeHtml(v) : v;
  };
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, n: string) => lookup(n)).replace(/<<([^<>]+)>>/g, (_, n: string) => lookup(n));
}
