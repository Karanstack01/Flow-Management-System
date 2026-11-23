/**
 * HTML → PDF for document steps. Covers what the document editor produces: headings,
 * paragraphs, bold / italic / underline, text colour, font family, alignment, bulleted and
 * numbered lists, links, line breaks and tables. Images and background colours are left out.
 *
 * The built-in PDF fonts cover Latin text only. For other scripts (₹, Hindi, …) point
 * DOCUMENT_FONT_PATH (and DOCUMENT_FONT_BOLD_PATH) at a Unicode TTF such as Noto Sans.
 */
import PDFDocument from 'pdfkit';

type Family = 'sans' | 'serif' | 'mono';
interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  family: Family;
  size: number;
  link?: string;
}
interface Run extends Style {
  text: string;
}
type Block =
  | { kind: 'text'; runs: Run[]; align: Align; indent: number; bullet?: string; spaceAfter: number }
  | { kind: 'table'; rows: { cells: { runs: Run[]; header: boolean }[] }[] }
  | { kind: 'rule' };
type Align = 'left' | 'center' | 'right' | 'justify';

const BASE: Style = { bold: false, italic: false, underline: false, color: '#1d1d1f', family: 'sans', size: 11 };
const HEADING: Record<string, number> = { h1: 22, h2: 18, h3: 15, h4: 13, h5: 12, h6: 11 };
const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section', 'article', 'header', 'footer', 'pre']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'img', 'svg', 'iframe', 'object']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', trade: '™', rupee: '₹' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)?.slice(2).find((x) => x !== undefined);
const css = (attrs: string, prop: string) => {
  const style = attr(attrs, 'style') ?? '';
  return new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style)?.[1]?.trim();
};

function toColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  const rgb = /^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  return /^[a-z]{3,20}$/.test(s) ? s : undefined;
}
function toFamily(v: string | undefined): Family | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (/courier|mono|consolas/.test(s)) return 'mono';
  if (/times|georgia|serif|garamond|cambria/.test(s) && !/sans/.test(s)) return 'serif';
  return 'sans';
}
const toAlign = (v: string | undefined): Align | undefined => (v && ['left', 'center', 'right', 'justify'].includes(v.toLowerCase()) ? (v.toLowerCase() as Align) : undefined);

/** Parse the editor's HTML into text blocks and tables. */
export function parseHtml(html: string): Block[] {
  const blocks: Block[] = [];
  const styles: Style[] = [BASE];
  const aligns: Align[] = ['left'];
  const lists: { ordered: boolean; n: number }[] = [];
  let runs: Run[] = [];
  let bullet: string | undefined;
  let skip = 0;
  let table: Extract<Block, { kind: 'table' }> | null = null;
  let cell: { runs: Run[]; header: boolean } | null = null;
  const tagStack: string[] = [];

  const cur = () => styles[styles.length - 1]!;
  const flush = (spaceAfter = 6) => {
    if (cell) return;
    const trimmed = runs.filter((r) => r.text.length);
    if (trimmed.length || bullet) blocks.push({ kind: 'text', runs: trimmed.length ? trimmed : [{ ...cur(), text: ' ' }], align: aligns[aligns.length - 1]!, indent: lists.length, bullet, spaceAfter });
    runs = [];
    bullet = undefined;
  };
  const push = (text: string) => {
    if (skip) return;
    const t = decode(text).replace(/[ \t\r\n]+/g, ' ');
    if (!t.trim() && !(cell ? cell.runs : runs).length) return;
    (cell ? cell.runs : runs).push({ ...cur(), text: t });
  };

  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[4] !== undefined) {
      push(m[4]);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';
    if (SKIP.has(tag)) {
      if (tag === 'img') continue;
      if (!closing && !attrs.trim().endsWith('/')) skip++;
      else if (closing) skip = Math.max(0, skip - 1);
      continue;
    }
    if (skip) continue;

    if (tag === 'br') {
      (cell ? cell.runs : runs).push({ ...cur(), text: '\n' });
      continue;
    }
    if (tag === 'hr') {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    if (tag === 'table') {
      if (!closing) {
        flush();
        table = { kind: 'table', rows: [] };
      } else if (table) {
        blocks.push(table);
        table = null;
      }
      continue;
    }
    if (tag === 'tr' && table) {
      if (!closing) table.rows.push({ cells: [] });
      continue;
    }
    if ((tag === 'td' || tag === 'th') && table) {
      if (!closing) {
        cell = { runs: [], header: tag === 'th' };
        styles.push({ ...cur(), bold: cur().bold || tag === 'th' });
      } else if (cell) {
        table.rows[table.rows.length - 1]?.cells.push(cell) ?? table.rows.push({ cells: [cell] });
        cell = null;
        styles.pop();
      }
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      if (!closing) lists.push({ ordered: tag === 'ol', n: 0 });
      else {
        lists.pop();
        const last = blocks[blocks.length - 1];
        if (last?.kind === 'text' && !lists.length) last.spaceAfter = 8;
      }
      continue;
    }

    if (!closing) {
      const s: Style = { ...cur() };
      if (['b', 'strong', 'th'].includes(tag)) s.bold = true;
      if (['i', 'em'].includes(tag)) s.italic = true;
      if (tag === 'u') s.underline = true;
      if (tag === 'a') {
        const href = attr(attrs, 'href');
        if (href && /^(https?:|mailto:)/i.test(href)) s.link = href;
        s.color = '#0066cc';
        s.underline = true;
      }
      if (HEADING[tag]) {
        s.size = HEADING[tag]!;
        s.bold = true;
      }
      if (tag === 'pre' || tag === 'code') s.family = 'mono';
      const weight = css(attrs, 'font-weight');
      if (weight && (weight === 'bold' || Number(weight) >= 600)) s.bold = true;
      if (css(attrs, 'font-style') === 'italic') s.italic = true;
      if (/underline/.test(css(attrs, 'text-decoration') ?? '')) s.underline = true;
      s.color = toColor(css(attrs, 'color') ?? (tag === 'font' ? attr(attrs, 'color') : undefined)) ?? s.color;
      s.family = toFamily(css(attrs, 'font-family') ?? (tag === 'font' ? attr(attrs, 'face') : undefined)) ?? s.family;
      const px = /^(\d+(?:\.\d+)?)px$/.exec(css(attrs, 'font-size') ?? '');
      if (px) s.size = Math.min(40, Math.max(6, Number(px[1]) * 0.75));

      if (BLOCKS.has(tag)) {
        flush();
        aligns.push(toAlign(css(attrs, 'text-align') ?? attr(attrs, 'align')) ?? aligns[aligns.length - 1]!);
        if (tag === 'li') {
          const list = lists[lists.length - 1];
          if (list) bullet = list.ordered ? `${++list.n}.` : '•';
          else bullet = '•';
        }
      }
      styles.push(s);
      tagStack.push(tag);
    } else {
      const at = tagStack.lastIndexOf(tag);
      if (at < 0) continue;
      // Close this tag and anything left open inside it.
      while (tagStack.length > at) {
        const t = tagStack.pop()!;
        styles.pop();
        if (BLOCKS.has(t)) {
          flush(HEADING[t] ? 8 : t === 'li' ? 2 : 6);
          aligns.pop();
        }
      }
    }
  }
  flush();
  if (table) blocks.push(table);
  return blocks;
}

const STANDARD: Record<Family, [string, string, string, string]> = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** Characters the built-in fonts can not draw would come out garbled: map the common ones. */
const latinOnly = (s: string) =>
  s
    .replace(/₹/g, 'Rs.')
    .replace(/[‐-‒]/g, '-')
    .replace(/[^\u0000-ÿ–—‘’“”•…€™]/g, '?');

export async function htmlToPdf(html: string, opts: { orientation: 'portrait' | 'landscape'; title?: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: opts.orientation, margin: 50, info: { Title: opts.title ?? 'Document', Producer: 'FMS' }, bufferPages: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const custom = process.env.DOCUMENT_FONT_PATH;
  if (custom) {
    doc.registerFont('U', custom);
    doc.registerFont('UB', process.env.DOCUMENT_FONT_BOLD_PATH || custom);
  }
  const font = (r: Style) => (custom ? (r.bold ? 'UB' : 'U') : STANDARD[r.family][(r.bold ? 1 : 0) + (r.italic ? 2 : 0)]!);
  const text = (s: string) => (custom ? s : latinOnly(s));
  const left = doc.page.margins.left;
  const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  for (const b of parseHtml(html)) {
    if (b.kind === 'rule') {
      doc.moveDown(0.3);
      doc.moveTo(left, doc.y).lineTo(left + width(), doc.y).strokeColor('#d2d2d7').lineWidth(0.75).stroke();
      doc.moveDown(0.6);
      continue;
    }
    if (b.kind === 'table') {
      const cols = Math.max(1, ...b.rows.map((r) => r.cells.length));
      const colW = width() / cols;
      for (const row of b.rows) {
        const cellText = row.cells.map((c) => text(c.runs.map((r) => r.text).join('').trim()));
        const heights = row.cells.map((c, i) => {
          doc.font(font(c.runs[0] ?? { ...BASE, bold: c.header })).fontSize(10);
          return doc.heightOfString(cellText[i] || ' ', { width: colW - 10 });
        });
        const h = Math.max(16, ...heights) + 8;
        if (doc.y + h > bottom()) doc.addPage();
        const y = doc.y;
        row.cells.forEach((c, i) => {
          const x = left + i * colW;
          if (c.header) doc.rect(x, y, colW, h).fillColor('#f2f2f5').fill();
          doc.rect(x, y, colW, h).strokeColor('#d2d2d7').lineWidth(0.5).stroke();
          const first = c.runs[0] ?? { ...BASE, bold: c.header };
          doc.font(font({ ...first, bold: first.bold || c.header })).fontSize(10).fillColor(first.color);
          doc.text(cellText[i] || '', x + 5, y + 4, { width: colW - 10 });
        });
        doc.x = left;
        doc.y = y + h;
      }
      doc.moveDown(0.6);
      continue;
    }

    const indent = b.indent * 16 + (b.bullet ? 14 : 0);
    const size = Math.max(...b.runs.map((r) => r.size));
    if (doc.y + size * 1.4 > bottom()) doc.addPage();
    const y = doc.y;
    if (b.bullet) {
      doc.font(font(BASE)).fontSize(size).fillColor(BASE.color).text(b.bullet, left + b.indent * 16, y, { lineBreak: false });
      doc.y = y;
    }
    // pdfkit's continued text can not carry a line break between runs, so each <br> starts a new line.
    const lines: Run[][] = [[]];
    for (const r of b.runs) {
      r.text.split('\n').forEach((part, k) => {
        if (k > 0) lines.push([]);
        if (part) lines[lines.length - 1]!.push({ ...r, text: text(part) });
      });
    }
    lines.forEach((line, li) => {
      const runs = line.map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/^ +/, '') } : r)).filter((r) => r.text.length);
      if (!runs.length) {
        if (li > 0) doc.moveDown(0.9);
        return;
      }
      runs.forEach((r, i) => {
        doc.font(font(r)).fontSize(r.size).fillColor(r.color);
        const opts = { continued: i < runs.length - 1, underline: r.underline, link: r.link ?? null, align: b.align, width: width() - indent, lineGap: 2 };
        if (i === 0) doc.text(r.text, left + indent, li === 0 ? y : doc.y, opts);
        else doc.text(r.text, opts);
      });
    });
    doc.x = left;
    doc.moveDown(b.spaceAfter / 12);
  }

  doc.end();
  return done;
}

/** Word opens HTML saved as .doc, keeping headings, lists, tables, colours and the page orientation. */
export function htmlToWord(html: string, opts: { orientation: 'portrait' | 'landscape'; title?: string }): Buffer {
  const landscape = opts.orientation === 'landscape';
  const page = landscape ? 'size: 841.9pt 595.3pt; mso-page-orientation: landscape;' : 'size: 595.3pt 841.9pt;';
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${(opts.title ?? 'Document').replace(/</g, '&lt;')}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>@page Section1 { ${page} margin: 54pt; } div.Section1 { page: Section1; }
body { font-family: Arial, sans-serif; font-size: 11pt; color: #1d1d1f; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #d2d2d7; padding: 4pt 6pt; vertical-align: top; } th { background: #f2f2f5; text-align: left; }</style></head>
<body><div class="Section1">${html}</div></body></html>`;
  return Buffer.from(`﻿${doc}`, 'utf8');
}
