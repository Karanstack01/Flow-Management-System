/**
 * Time-based jobs — replace the Apps Script triggers:
 *   sweep      (5 min)  ← updatetimestamp/timestamp/planningtime safety net + missed hand-offs
 *   reminders  (10 min) ← sendreminder (upcoming tiers) + stage_overdue rules
 *   digests    (15 min) ← sendpending (daily overdue list) + Rep_Stage/Rep_Activity_Funnel emails
 *   archive    (hourly) ← archiveall + archive trigger
 */
import { DateTime } from 'luxon';
import {
  canSeeRecord,
  computeTimeline,
  escapeHtml,
  evaluateGroup,
  notificationRuleSchema,
  recordTitle,
  stageSummary,
  type RecordData,
} from '@fms/core';
import { prisma, Prisma, principalFromUser, saveStageStates, toStageStates } from '@fms/db';
import { activeWorkflows, fmtTime, isQuietDay, recordUrl, stageRecipients, type JobContext } from '../context.js';
import { groupMembers, layout, link, MAX_ATTEMPTS, retryDelayMs, send, table } from '../notify.js';
import { periodKey, processRecord, sendRule } from './record-changed.js';

const BATCH = 500;

/**
 * One record's dispatch failing (a webhook that is down, a bad template) must not abort the
 * sweep for every other record and organization. The failure is logged; the record's own
 * record-changed job retries it with back-off.
 */
async function dispatch(ctx: JobContext, recordId: string): Promise<boolean> {
  try {
    await processRecord(ctx, recordId);
    return true;
  } catch (e) {
    ctx.log.warn({ recordId, err: (e as Error).message }, 'dispatch failed during sweep');
    return false;
  }
}

// ------------------------------------------------------------------ sweep
export async function sweep(ctx: JobContext) {
  const now = new Date();
  let recomputed = 0;
  let dispatched = 0;
  const workflows = await activeWorkflows(ctx.orgId);

  // Job runs left "running" by a crash or deploy are closed so the Audit page stops showing them as in progress.
  await prisma.jobRun.updateMany({ where: { status: 'running', startedAt: { lt: new Date(now.getTime() - 30 * 60_000) } }, data: { status: 'failed', error: 'Interrupted (worker stopped before the job finished)', finishedAt: now } });

  for (const wf of workflows) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.record.findMany({
        where: { workflowId: wf.id, archivedAt: null, completedAt: null },
        include: { stages: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.id;
      for (const row of rows) {
        const previous = toStageStates(row.stages);
        const t = computeTimeline({ stages: wf.def.stages, data: row.data as RecordData, createdAt: row.createdAt, now, calendar: wf.calendar, previous });
        const changed = t.events.length > 0 || t.currentStageKey !== row.currentStageKey || t.states.length !== previous.length;
        if (!changed) continue;
        const ok = await prisma.$transaction(async (tx) => {
          const u = await tx.record.updateMany({
            where: { id: row.id, version: row.version },
            data: {
              currentStageKey: t.currentStageKey,
              completedAt: t.currentStageKey ? null : now,
              version: { increment: 1 },
              // A backward Stage Jump cleared fields that must be filled in again.
              ...(t.dataPatch ? { data: { ...(row.data as RecordData), ...t.dataPatch } as Prisma.InputJsonObject } : {}),
            },
          });
          if (u.count !== 1) return false; // concurrently edited — the API already recomputed
          await saveStageStates(tx, row.id, previous, t.states);
          return true;
        });
        if (ok) {
          recomputed++;
          if (await dispatch(ctx, row.id)) dispatched++;
        }
      }
      if (rows.length < BATCH) break;
    }
  }

  // Active stages that never got a hand-off (e.g. Redis was down when the API wrote).
  const handoffWorkflows = workflows.filter((w) => w.settings.handoff.enabled).map((w) => w.id);
  if (handoffWorkflows.length) {
    const missed = await prisma.$queryRaw<{ recordId: string }[]>`
      SELECT DISTINCT s."recordId" FROM "RecordStage" s JOIN "Record" r ON r."id" = s."recordId"
      WHERE s."status" = 'active' AND r."archivedAt" IS NULL AND r."workflowId" = ANY(${handoffWorkflows}::text[])
        AND NOT EXISTS (SELECT 1 FROM "NotificationLog" n WHERE n."dedupeKey" = 'handoff:' || s."recordId" || ':' || s."stageKey" || CASE WHEN s."round" > 0 THEN ':r' || s."round" ELSE '' END)
      LIMIT 1000`;
    for (const m of missed) if (await dispatch(ctx, m.recordId)) dispatched++;
  }

  // Deliveries to retry: failed with attempts left, or stuck pending after a crash. Reprocessing the
  // record re-runs its hand-offs and rules; claim() re-claims exactly the retryable keys.
  let retried = 0;
  const wfIds = workflows.map((w) => w.id);
  if (wfIds.length) {
    const due = await prisma.$queryRaw<{ recordId: string }[]>`
      SELECT DISTINCT n."recordId" FROM "NotificationLog" n JOIN "Record" r ON r."id" = n."recordId"
      WHERE r."workflowId" = ANY(${wfIds}::text[]) AND r."archivedAt" IS NULL
        AND ((n."status" = 'failed' AND n."attempts" < ${MAX_ATTEMPTS} AND n."updatedAt" < ${new Date(now.getTime() - retryDelayMs(1))})
          OR (n."status" = 'pending' AND n."updatedAt" < ${new Date(now.getTime() - 10 * 60_000)}))
      LIMIT 500`;
    for (const d of due) if (await dispatch(ctx, d.recordId)) retried++;
  }
  return { recomputed, dispatched, retried };
}

// ------------------------------------------------------------------ reminders
export async function reminders(ctx: JobContext) {
  const now = new Date();
  let upcoming = 0;
  let overdueRules = 0;
  for (const wf of await activeWorkflows(ctx.orgId)) {
    if (isQuietDay(wf, now)) continue;

    if (wf.settings.upcoming.enabled) {
      const horizon = wf.calendar.addWorkingHours(now, wf.settings.upcoming.hoursBefore);
      const due = await prisma.recordStage.findMany({
        where: { status: 'active', plannedAt: { gt: now, lte: horizon }, record: { workflowId: wf.id, archivedAt: null } },
        include: { record: true },
        take: 5000,
      });
      for (const s of due) {
        const stage = wf.def.stages.find((x) => x.key === s.stageKey);
        if (!stage?.responsibleGroups.length) continue;
        const data = s.record.data as RecordData;
        const title = recordTitle(wf.def.fields, data, s.record.number);
        const url = recordUrl(ctx.cfg, wf, s.recordId);
        const subject = `[${wf.name}] Due ${fmtTime(wf, s.plannedAt)} — ${stage.name}: #${s.record.number} ${title}`;
        const r = await send(await ctx.channelsFor(wf.orgId), {
          key: `upcoming:${s.recordId}:${s.stageKey}:${s.plannedAt!.getTime()}`,
          kind: 'upcoming',
          recordId: s.recordId,
          recipients: await stageRecipients(wf, stage.responsibleGroups, data),
          channels: wf.settings.channels,
          subject,
          html: layout('Task due soon', `<p><b>${escapeHtml(stage.name)}</b> for <b>#${s.record.number} ${escapeHtml(title)}</b> is due at <b>${escapeHtml(fmtTime(wf, s.plannedAt))}</b>.</p><p>${link(url, 'Open record')}</p>`),
          text: `${subject}\n${url}`,
        });
        upcoming += r.sent;
      }
    }

    const rules = await prisma.notificationRule.findMany({ where: { workflowId: wf.id, isActive: true } });
    for (const rule of rules) {
      const def = notificationRuleSchema.safeParse(rule.definition);
      if (!def.success || def.data.trigger.type !== 'stage_overdue') continue;
      const stageKey = def.data.trigger.stageKey;
      const late = await prisma.recordStage.findMany({
        where: { status: 'active', stageKey, plannedAt: { lt: now }, record: { workflowId: wf.id, archivedAt: null } },
        include: { record: true },
        take: 5000,
      });
      for (const s of late) {
        await sendRule(ctx, wf, s.record, rule.id, def.data, `rule:${rule.id}:${s.recordId}:overdue:${periodKey(def.data.repeatEveryDays)}`);
        overdueRules++;
      }
    }
  }
  return { upcoming, overdueRules };
}

// ------------------------------------------------------------------ digests
export async function digests(ctx: JobContext) {
  const now = new Date();
  let digestsSent = 0;
  let summaries = 0;
  for (const wf of await activeWorkflows(ctx.orgId)) {
    if (isQuietDay(wf, now)) continue;
    const local = DateTime.fromJSDate(now).setZone(wf.calendar.config.timezone);
    const day = local.toISODate()!;

    if (wf.settings.overdueDigest.enabled && local.hour === wf.settings.overdueDigest.hour) {
      const overdue = await prisma.recordStage.findMany({
        where: { status: 'active', plannedAt: { lt: now }, record: { workflowId: wf.id, archivedAt: null } },
        include: { record: true },
        orderBy: { plannedAt: 'asc' },
        take: 10_000,
      });
      const groups = [...new Set(wf.def.stages.flatMap((s) => s.responsibleGroups))];
      for (const user of await groupMembers(wf.orgId, groups)) {
        const p = principalFromUser(user, wf.orgId);
        const mineStages = new Set(wf.def.stages.filter((s) => s.responsibleGroups.some((g) => p.groups.includes(g))).map((s) => s.key));
        const tasks = overdue.filter((s) => mineStages.has(s.stageKey) && canSeeRecord(p, s.record.data as RecordData));
        if (!tasks.length) continue;
        const rows = tasks.slice(0, 200).map((s) => {
          const stage = wf.def.stages.find((x) => x.key === s.stageKey)!;
          const title = recordTitle(wf.def.fields, s.record.data as RecordData, s.record.number);
          const late = Math.round(wf.calendar.workingHoursBetween(s.plannedAt!, now) * 10) / 10;
          return [link(recordUrl(ctx.cfg, wf, s.recordId), `#${s.record.number}`), escapeHtml(title), escapeHtml(stage.name), escapeHtml(fmtTime(wf, s.plannedAt)), `${late} h`];
        });
        const subject = `[${wf.name}] ${tasks.length} overdue task${tasks.length === 1 ? '' : 's'} — ${local.toFormat('dd LLL yyyy')}`;
        const r = await send(await ctx.channelsFor(wf.orgId), {
          key: `digest:${wf.id}:${user.id}:${day}`,
          kind: 'digest',
          recipients: [{ email: user.email, phone: user.phone }],
          channels: wf.settings.channels,
          subject,
          html: layout('Pending tasks', `<p>Hi ${escapeHtml(user.name)}, these tasks are past their planned time:</p>${table(['Record', 'Title', 'Stage', 'Planned', 'Delay'], rows)}`),
          text: `${subject}\n${tasks.map((t) => `#${t.record.number} ${t.stageKey}`).join('\n')}`,
        });
        digestsSent += r.sent;
      }
    }

    const sr = wf.settings.summaryReport;
    if (sr.enabled && sr.recipients.length && local.hour === sr.hour) {
      const records = await prisma.record.findMany({ where: { workflowId: wf.id, archivedAt: null }, include: { stages: true }, take: 20_000, orderBy: { number: 'desc' } });
      const summary = stageSummary(
        records.map((r) => ({ id: r.id, number: r.number, stages: toStageStates(r.stages) })),
        wf.def.stages,
        now,
        wf.calendar,
      );
      const rows = summary.map((s) => [
        `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:6px"></span>${escapeHtml(s.stageName)}`,
        String(s.upcoming),
        `<b style="color:${s.overdue ? '#b91c1c' : 'inherit'}">${s.overdue}</b>`,
        String(s.doneOnTime),
        String(s.doneLate),
        `${s.avgOverdueHours} h`,
      ]);
      const subject = `[${wf.name}] Daily stage summary — ${local.toFormat('dd LLL yyyy')}`;
      const r = await send(await ctx.channelsFor(wf.orgId), {
        key: `summary:${wf.id}:${day}`,
        kind: 'summary',
        recipients: sr.recipients.map((email) => ({ email })),
        channels: ['email'],
        subject,
        html: layout('Stage summary', table(['Stage', 'Upcoming', 'Overdue', 'Done on time', 'Done late', 'Avg delay'], rows)),
        text: subject,
      });
      summaries += r.sent;
    }
  }
  return { digestsSent, summaries };
}

// ------------------------------------------------------------------ archive
export async function archive(ctx: JobContext) {
  let archived = 0;
  for (const wf of await activeWorkflows(ctx.orgId)) {
    const a = wf.settings.archive;
    if (!a.enabled) continue;
    const cutoff = new Date(Date.now() - a.completedDaysAgo * 86_400_000);
    const candidates = await prisma.record.findMany({ where: { workflowId: wf.id, archivedAt: null, completedAt: { lte: cutoff } }, select: { id: true, data: true }, take: 5000 });
    const ids = candidates.filter((c) => evaluateGroup(a.when, c.data as RecordData)).map((c) => c.id);
    if (!ids.length) continue;
    await prisma.$transaction([
      prisma.record.updateMany({ where: { id: { in: ids } }, data: { archivedAt: new Date(), version: { increment: 1 } } }),
      prisma.auditLog.createMany({ data: ids.map((entityId) => ({ orgId: wf.orgId, action: 'record.auto_archived', entityType: 'Record', entityId, diff: { rule: 'settings.archive' } as Prisma.InputJsonObject })) }),
    ]);
    archived += ids.length;
    ctx.log.info({ workflow: wf.key, count: ids.length }, 'auto-archived records');
  }
  return { archived };
}
