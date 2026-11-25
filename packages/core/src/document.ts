/**
 * Document step content: the body with the record's values filled in, as clean HTML, and the
 * file name. The API turns the HTML into a PDF / Word file; the editor shows the same HTML as
 * a preview, so what the admin sees is what gets generated.
 */
import type { DocumentConfig, DocumentFormat, FieldDef, RecordData } from './schema.js';
import { escapeHtml, formatValue, isHtmlBody, renderTemplate, sanitizeEmailHtml, type TemplateContext } from './template.js';

export const DOCUMENT_EXTENSION: Record<DocumentFormat, string> = { pdf: 'pdf', doc: 'doc' };
export const DOCUMENT_MIME: Record<DocumentFormat, string> = { pdf: 'application/pdf', doc: 'application/msword' };

/** The filled-in body as safe HTML (values are escaped; markup from the editor is sanitised). */
export function documentBodyHtml(cfg: Pick<DocumentConfig, 'source' | 'body' | 'fieldKey'>, ctx: TemplateContext): string {
  if (cfg.source === 'all_fields') {
    const rows = ctx.fields
      .filter((f: FieldDef) => f.key !== cfg.fieldKey && f.type !== 'file' && !f.hidden)
      .map((f) => `<tr><th align="left">${escapeHtml(f.label)}</th><td>${escapeHtml(formatValue(ctx.data[f.key])) || '—'}</td></tr>`)
      .join('');
    const title = escapeHtml(String(ctx.extra?.record_title ?? ''));
    return `<h2>${escapeHtml(String(ctx.extra?.workflow_name ?? ''))}${title ? ` — ${title}` : ''}</h2><table>${rows}</table>`;
  }
  const rendered = renderTemplate(cfg.body, ctx, { html: true });
  return isHtmlBody(cfg.body) ? sanitizeEmailHtml(rendered) : rendered.replace(/\n/g, '<br>');
}

/** File name from the template, safe for every OS, with the format's extension. */
export function documentFileName(cfg: Pick<DocumentConfig, 'fileName' | 'format'>, ctx: TemplateContext): string {
  const ext = DOCUMENT_EXTENSION[cfg.format];
  const base = renderTemplate(cfg.fileName || 'Document {{record_number}}', ctx)
    .replace(new RegExp(`\\.${ext}$`, 'i'), '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${base || 'Document'}.${ext}`;
}

/** Sample values for previews: field labels, numbers and today's date. */
export function sampleRecord(fields: readonly FieldDef[]): RecordData {
  const today = new Date().toISOString().slice(0, 10);
  const out = Object.fromEntries(
    fields.map((f) => {
      switch (f.type) {
        case 'number':
        case 'computed':
          return [f.key, 1250];
        case 'date':
          return [f.key, today];
        case 'datetime':
          return [f.key, `${today}T10:30:00Z`];
        case 'checkbox':
          return [f.key, true];
        case 'email':
        case 'user-email':
          return [f.key, 'priya@example.com'];
        case 'phone':
          return [f.key, '+91 98765 43210'];
        case 'select':
        case 'combobox':
        case 'dependent-select':
          return [f.key, f.options?.[0] ?? f.label];
        case 'multiselect':
          return [f.key, f.options?.slice(0, 2) ?? [f.label]];
        case 'file':
          return [f.key, []];
        default:
          return [f.key, `Sample ${f.label}`];
      }
    }),
  ) as RecordData;
  // A dependent dropdown takes a choice its (sample) parent really offers — down the chain.
  for (let pass = 0; pass < fields.length; pass++) {
    let changed = false;
    for (const f of fields) {
      if (f.type !== 'dependent-select' || !f.dependsOn) continue;
      const v = f.optionMap?.[String(out[f.dependsOn] ?? '')]?.[0] ?? Object.values(f.optionMap ?? {})[0]?.[0] ?? f.label;
      if (out[f.key] !== v) (out[f.key] = v), (changed = true);
    }
    if (!changed) break;
  }
  return out;
}
