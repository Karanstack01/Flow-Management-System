/**
 * Scheduled reports (Flow settings › Notifications › Scheduled reports) — the legacy Rep_Stage,
 * Rep_Pending, Rep_Activity_Funnel, Rep_Ord_Status and Rep_Step PDFs, sent at up to four times a
 * day: an email with the tables (and a PDF of them attached) and a short WhatsApp summary.
 */
import PDFDocument from 'pdfkit';
import type { DateTime } from 'luxon';
import { escapeHtml, missingFields, pendingTasks, recordTitle, stageSummary, statusMatrix, type RecordData, type ReportKind } from '@fms/core';
import { prisma, toStageStates, type LoadedWorkflow } from '@fms/db';
import { fmtTime, recordUrl, type JobContext } from '../context.js';
import { layout, link, send, table } from '../notify.js';

export interface ReportSection {
  kind: ReportKind;
  title: string;
  headers: string[];
  /** Plain text cells (PDF, WhatsApp). */
  rows: string[][];
  /** HTML cells for the email (links, colours). */
  htmlRows: string[][];
  /** One line for WhatsApp. */
  line: string;
}

const STATUS_MARK: Record<string, string> = { done: 'D', active: 'P', waiting: '·', skipped: '–' };
const MAX_ROWS = 300;

export async function buildReports(ctx: Pick<JobContext, 'cfg'>, wf: LoadedWorkflow, now: Date, kinds: readonly ReportKind[], missingStage?: string): Promise<ReportSection[]> {
  const rows = await prisma.record.findMany({ where: { workflowId: wf.id, archivedAt: null }, include: { stages: true }, take: 20_000, orderBy: { number: 'desc' } });
  const records = rows.map((r) => ({ id: r.id, number: r.number, title: recordTitle(wf.def.fields, r.data as RecordData, r.number), data: r.data as RecordData, stages: toStageStates(r.stages) }));
  const stageName = (k: string) => wf.def.stages.find((s) => s.key === k)?.name ?? k;
  const recLink = (id: string, n: number) => link(recordUrl(ctx.cfg, wf, id), `#${n}`);
  const out: ReportSection[] = [];

  for (const kind of kinds) {
    if (kind === 'summary' || kind === 'funnel') {
      const summary = stageSummary(records, wf.def.stages, now, wf.calendar);
      if (kind === 'summary') {
        const r = summary.map((s) => [s.stageName, String(s.upcoming + s.unplanned), String(s.overdue), String(s.doneOnTime + s.doneLate), `${s.avgOverdueHours} h`]);
        out.push({
          kind,
          title: 'Stage summary',
          headers: ['Step', 'In progress', 'Overdue', 'Done', 'Avg delay'],
          rows: r,
          htmlRows: summary.map((s, i) => [
            `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:6px"></span>${escapeHtml(s.stageName)}`,
            r[i]![1]!,
            `<b style="color:${s.overdue ? '#b91c1c' : 'inherit'}">${s.overdue}</b>`,
            r[i]![3]!,
            r[i]![4]!,
          ]),
          line: `Overdue: ${summary.reduce((n, s) => n + s.overdue, 0)} · In progress: ${summary.reduce((n, s) => n + s.upcoming + s.unplanned, 0)}`,
        });
      } else {
        const r = summary.map((s) => {
          const done = s.doneOnTime + s.doneLate;
          return [s.stageName, String(s.doneOnTime), String(s.doneLate), String(s.overdue), String(s.upcoming + s.unplanned), done ? `${Math.round((s.doneOnTime / done) * 100)}%` : '—'];
        });
        out.push({ kind, title: 'On-time funnel', headers: ['Step', 'Done on time', 'Done late', 'Overdue', 'Upcoming', 'On-time rate'], rows: r, htmlRows: r.map((x) => x.map(escapeHtml)), line: `On-time: ${r.map((x) => `${x[0]} ${x[5]}`).join(', ')}` });
      }
    }
    if (kind === 'pending') {
      const tasks = pendingTasks(records, now, wf.calendar).slice(0, MAX_ROWS);
      const r = tasks.map((t) => [`#${t.recordNumber}`, t.title ?? '', stageName(t.stageKey), fmtTime(wf, t.plannedAt), t.delayHours === null ? '—' : t.delayHours > 0 ? `${t.delayHours} h late` : `${-t.delayHours} h left`]);
      out.push({
        kind,
        title: 'Pending tasks',
        headers: ['Record', 'Title', 'Step', 'Due', 'Delay'],
        rows: r,
        htmlRows: tasks.map((t, i) => [recLink(t.recordId, t.recordNumber), ...r[i]!.slice(1).map(escapeHtml)]),
        line: `Pending tasks: ${tasks.length} (${tasks.filter((t) => t.overdue).length} overdue)`,
      });
    }
    if (kind === 'matrix') {
      const open = records.filter((r) => r.stages.some((s) => s.status === 'active')).slice(0, MAX_ROWS);
      const matrix = statusMatrix(open, wf.def.stages);
      const r = matrix.map((m) => [`#${m.recordNumber}`, ...wf.def.stages.map((s) => STATUS_MARK[m.cells[s.key] ?? 'waiting'] ?? '·')]);
      out.push({ kind, title: 'Status matrix (D = done, P = pending)', headers: ['Record', ...wf.def.stages.map((s) => s.name)], rows: r, htmlRows: matrix.map((m, i) => [recLink(m.recordId, m.recordNumber), ...r[i]!.slice(1)]), line: `Open records: ${open.length}` });
    }
    if (kind === 'missing') {
      const miss = missingFields(records, wf.def.stages, wf.def.fields, { stageKey: missingStage }).slice(0, MAX_ROWS);
      const r = miss.map((m) => [`#${m.recordNumber}`, m.title ?? '', stageName(m.stageKey), m.missing.map((x) => `${x.label}${x.required ? ' *' : ''}`).join(', ')]);
      out.push({ kind, title: 'Fields still empty', headers: ['Record', 'Title', 'Step', 'Still empty (* required)'], rows: r, htmlRows: miss.map((m, i) => [recLink(m.recordId, m.recordNumber), ...r[i]!.slice(1).map(escapeHtml)]), line: `Records with empty fields: ${miss.length}` });
    }
  }
  return out;
}

/** The sections as an A4 landscape PDF (plain tables). */
export function reportsPdf(title: string, subtitle: string, sections: ReportSection[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    doc.font('Helvetica-Bold').fontSize(16).text(title, left, doc.page.margins.top);
    doc.font('Helvetica').fontSize(9).fillColor('#6e6e73').text(subtitle).fillColor('#1d1d1f');
    for (const s of sections) {
      doc.moveDown(1);
      if (doc.y > bottom() - 60) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(12).text(s.title, left);
      doc.moveDown(0.3);
      // First column a little wider when it holds names; the rest share the width.
      const n = s.headers.length;
      const colW = width / n;
      const row = (cells: string[], bold: boolean) => {
        if (doc.y > bottom() - 16) doc.addPage();
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        cells.forEach((c, i) => doc.text(c, left + i * colW, y, { width: colW - 6, height: 11, ellipsis: true, lineBreak: false }));
        doc.y = y + 13;
        doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).strokeColor('#e5e5ea').lineWidth(0.5).stroke();
      };
      row(s.headers, true);
      if (!s.rows.length) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#6e6e73').text('Nothing to show.', left).fillColor('#1d1d1f');
        continue;
      }
      for (const r of s.rows) row(r, false);
    }
    doc.end();
  });
}

/** Send the flow's scheduled reports if one of its send times is now (dedupe: once per hour slot). */
export async function scheduledReport(ctx: JobContext, wf: LoadedWorkflow, now: Date, local: DateTime): Promise<number> {
  const sr = wf.settings.summaryReport;
  if (!sr.enabled || (!sr.recipients.length && !sr.whatsapp.length)) return 0;
  const hours = sr.hours.length ? sr.hours : [sr.hour];
  if (!hours.includes(local.hour)) return 0;
  const day = local.toISODate()!;
  const key = `summary:${wf.id}:${day}${hours.length > 1 ? `:${local.hour}` : ''}`;
  // Already sent for this slot (the digests job runs every 15 minutes)?
  const already = await prisma.notificationLog.count({ where: { dedupeKey: { startsWith: `${key}:` }, status: 'sent' } });
  if (already >= sr.recipients.length + sr.whatsapp.length) return 0;

  const sections = await buildReports(ctx, wf, now, sr.reports, sr.missingStage);
  const when = local.toFormat('dd LLL yyyy, HH:mm');
  const subject = `[${wf.name}] Reports — ${when}`;
  let sent = 0;
  const channels = await ctx.channelsFor(wf.orgId);
  if (sr.recipients.length) {
    let attachments: { filename: string; contentType: string; content: Buffer }[] | undefined;
    if (sr.pdf) attachments = [{ filename: `${wf.key}-reports-${day}-${String(local.hour).padStart(2, '0')}00.pdf`, contentType: 'application/pdf', content: await reportsPdf(`${wf.name} — reports`, when, sections) }];
    const html = layout(
      `${wf.name} — reports`,
      `<p style="color:#6b7280">${escapeHtml(when)}${sr.pdf ? ' · the same tables are attached as a PDF' : ''}</p>` +
        sections.map((s) => `<h3 style="margin:20px 0 8px;font-size:15px">${escapeHtml(s.title)}</h3>${s.htmlRows.length ? table(s.headers, s.htmlRows.slice(0, 100)) : '<p style="color:#6b7280">Nothing to show.</p>'}${s.htmlRows.length > 100 ? `<p style="color:#6b7280;font-size:12px">${s.htmlRows.length - 100} more rows in the PDF.</p>` : ''}`).join(''),
    );
    const r = await send(channels, { key, kind: 'summary', recipients: sr.recipients.map((email) => ({ email })), cc: sr.cc, channels: ['email'], subject, html, text: `${subject}\n${sections.map((s) => s.line).join('\n')}`, attachments });
    sent += r.sent;
  }
  if (sr.whatsapp.length) {
    const text = `*${wf.name} — reports*\n${when}\n\n${sections.map((s) => `• ${s.line}`).join('\n')}\n\nOpen: ${ctx.cfg.APP_URL.replace(/\/$/, '')}/w/${wf.key}/reports`;
    const r = await send(channels, { key, kind: 'summary', recipients: sr.whatsapp.map((phone) => ({ phone })), channels: ['whatsapp'], subject, html: '', text });
    sent += r.sent;
  }
  return sent;
}
