import { DOCUMENT_MIME, documentBodyHtml, documentFileName, type DocumentConfig, type FieldDef, type RecordData } from '@fms/core';
import { htmlToPdf, htmlToWord } from './pdf.js';

export interface DocumentContext {
  fields: readonly FieldDef[];
  data: RecordData;
  extra: Record<string, string | number | null | undefined>;
}

/** Fill the body, then produce the file in the configured format. */
export async function renderDocument(cfg: DocumentConfig, ctx: DocumentContext): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const html = documentBodyHtml(cfg, ctx);
  const fileName = documentFileName(cfg, ctx);
  const title = fileName.replace(/\.[a-z]+$/, '');
  const buffer = cfg.format === 'doc' ? htmlToWord(html, { orientation: cfg.orientation, title }) : await htmlToPdf(html, { orientation: cfg.orientation, title });
  return { buffer, fileName, mimeType: DOCUMENT_MIME[cfg.format] };
}
