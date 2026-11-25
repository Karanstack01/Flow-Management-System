/**
 * Batched hand-offs (Flow settings › Hand-off › "One message per person"), like the legacy
 * onformsubmit: every sweep, each person gets one message per flow listing all the tasks that
 * reached them since the last run, instead of one message per record.
 *
 * The per-record hand-off marker (`handoff:<record>:<stage>[:r<n>]`) is written `queued` by
 * record-changed; this job sends, then records one delivery per record and recipient under the same
 * keys an unbatched hand-off uses — so the record page shows them and "Send again" works.
 */
import { escapeHtml, recordTitle, type RecordData } from '@fms/core';
import { prisma, roundSuffix } from '@fms/db';
import { fmtTime, recordUrl, stageRecipients, workflowById, type JobContext } from '../context.js';
import { layout, link, send, table, type Recipient } from '../notify.js';

interface Task {
  markerId: string;
  recordId: string;
  number: number;
  title: string;
  stageName: string;
  due: string;
  url: string;
  keyBase: string;
}

export async function handoffBatches(ctx: JobContext): Promise<{ batches: number; tasks: number }> {
  const markers = await prisma.notificationLog.findMany({ where: { kind: 'handoff-marker', status: 'queued' }, orderBy: { createdAt: 'asc' }, take: 2000 });
  if (!markers.length) return { batches: 0, tasks: 0 };

  // flow id → recipient key → { recipient, tasks }
  const groups = new Map<string, Map<string, { r: Recipient; tasks: Task[] }>>();
  const done = new Map<string, 'skipped'>();
  /** Markers whose recipients were all reached on an earlier attempt. */
  const sentMarkersPre = new Set<string>();
  for (const m of markers) {
    const match = /^handoff:([^:]+):([^:]+?)(?::r(\d+))?$/.exec(m.dedupeKey);
    const row = match ? await prisma.record.findUnique({ where: { id: match[1]! }, include: { stages: true } }) : null;
    const wf = row ? await workflowById(row.workflowId) : null;
    if (ctx.orgId && wf && wf.orgId !== ctx.orgId) continue;
    const state = row?.stages.find((s) => s.stageKey === match?.[2]);
    const stage = wf?.def.stages.find((s) => s.key === match?.[2]);
    // Archived, moved on, or the flow was paused: nothing to announce any more.
    if (!row || !wf || !stage || !state || row.archivedAt || state.status !== 'active' || !wf.automationLive) {
      done.set(m.id, 'skipped');
      continue;
    }
    const data = row.data as RecordData;
    const recipients = await stageRecipients(wf, stage, data);
    if (!recipients.length) {
      done.set(m.id, 'skipped');
      continue;
    }
    const task: Task = {
      markerId: m.id,
      recordId: row.id,
      number: row.number,
      title: recordTitle(wf.def.fields, data, row.number),
      stageName: stage.name,
      due: fmtTime(wf, state.plannedAt),
      url: recordUrl(ctx.cfg, wf, row.id),
      keyBase: `handoff:${row.id}:${stage.key}${roundSuffix(state.round)}`,
    };
    const byPerson = groups.get(wf.id) ?? new Map();
    groups.set(wf.id, byPerson);
    // On a retry, people already reached for this record are not told again.
    const sentKeys = new Set((await prisma.notificationLog.findMany({ where: { dedupeKey: { startsWith: `${task.keyBase}:` }, status: 'sent' }, select: { dedupeKey: true } })).map((x) => x.dedupeKey));
    for (const r of recipients) {
      const key = (r.email ?? r.phone ?? r.userId ?? '').toLowerCase();
      if (!key) continue;
      const needed = wf.settings.channels.flatMap((ch) => {
        const to = ch === 'email' ? r.email : r.phone;
        return to ? [`${task.keyBase}:${ch}:${ch === 'email' ? to.toLowerCase() : to}`] : [];
      });
      if (needed.length && needed.every((k) => sentKeys.has(k))) {
        sentMarkersPre.add(m.id);
        continue;
      }
      const g = byPerson.get(key) ?? { r, tasks: [] };
      g.tasks.push(task);
      byPerson.set(key, g);
    }
  }

  let batches = 0;
  const failedMarkers = new Set<string>();
  const sentMarkers = new Set<string>();
  const runId = Date.now();
  for (const [wfId, byPerson] of groups) {
    const wf = (await workflowById(wfId))!;
    const channels = await ctx.channelsFor(wf.orgId);
    for (const { r, tasks } of byPerson.values()) {
      const subject = `[${wf.name}] ${tasks.length} new task${tasks.length === 1 ? '' : 's'} for you`;
      const html = layout(
        subject,
        `<p>These records have reached a step you work on:</p>` +
          table(
            ['Record', 'Step', 'Due by', ''],
            tasks.map((t) => [`<b>#${t.number}</b> ${escapeHtml(t.title)}`, escapeHtml(t.stageName), escapeHtml(t.due), link(t.url, 'Open')]),
          ),
      );
      const text = `${subject}\n${tasks.map((t) => `#${t.number} ${t.title} — ${t.stageName}, due ${t.due}: ${t.url}`).join('\n')}`;
      const res = await send(channels, { key: `handoff-batch:${wf.id}:${runId}`, kind: 'handoff-batch', recipients: [r], channels: wf.settings.channels, subject, html, text });
      batches++;
      // One delivery per record and channel, under the keys an unbatched hand-off would use.
      for (const t of tasks) {
        (res.failed ? failedMarkers : sentMarkers).add(t.markerId);
        for (const ch of wf.settings.channels) {
          const to = ch === 'email' ? r.email : r.phone;
          if (!to) continue;
          const dedupeKey = `${t.keyBase}:${ch}:${ch === 'email' ? to.toLowerCase() : to}`;
          const status = res.failed ? 'failed' : 'sent';
          const error = res.failed ? 'The combined task list could not be sent (see the delivery log)' : null;
          await prisma.notificationLog.upsert({
            where: { dedupeKey },
            create: { dedupeKey, kind: 'handoff', channel: ch, recipient: to, recordId: t.recordId, status, error },
            update: { status, error },
          });
        }
      }
    }
  }
  for (const m of markers) {
    const status = done.get(m.id) ?? (failedMarkers.has(m.id) ? 'failed' : sentMarkers.has(m.id) || sentMarkersPre.has(m.id) ? 'sent' : null);
    if (status) await prisma.notificationLog.update({ where: { id: m.id }, data: { status, error: status === 'failed' ? 'Some deliveries failed' : null } });
  }
  return { batches, tasks: sentMarkers.size + failedMarkers.size };
}
