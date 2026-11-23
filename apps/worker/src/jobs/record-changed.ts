/**
 * Per-record dispatch (legacy onformsubmit + send_custom_rem + post_data), triggered by
 * the API after every write and by the sweep for anything missed. Fully idempotent.
 */
import { createHmac } from 'node:crypto';
import {
  escapeHtml,
  evaluateGroup,
  isHtmlBody,
  sanitizeEmailHtml,
  notificationRuleSchema,
  recordTitle,
  renderTemplate,
  type NotificationRuleDef,
  type RecordData,
  type StageState,
} from '@fms/core';
import { BlockedUrlError, guardedFetch, prisma, roundSuffix, toStageStates, type LoadedWorkflow, type Record as RecordRow } from '@fms/db';
import { fmtTime, recordUrl, stageRecipients, workflowById, type JobContext } from '../context.js';
import { claim, layout, link, MAX_ATTEMPTS, send, splitList, table } from '../notify.js';

const stripTags = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');

export function periodKey(repeatEveryDays: number | undefined, now = new Date()) {
  return repeatEveryDays ? `p${Math.floor(now.getTime() / (repeatEveryDays * 86_400_000))}` : 'once';
}

export async function processRecord(ctx: JobContext, recordId: string) {
  const row = await prisma.record.findUnique({ where: { id: recordId }, include: { stages: true } });
  if (!row || row.archivedAt) return;
  const wf = await workflowById(row.workflowId);
  // Suspended / licence-expired organization, draft or trashed flow: hold notifications.
  // Hand-off markers are not written, so the sweep delivers them once the flow is live again.
  if (!wf || !wf.automationLive) return;
  const states = toStageStates(row.stages);

  if (wf.settings.handoff.enabled) await handoffs(ctx, wf, row, states);
  await rules(ctx, wf, row, states);
  await webhooks(ctx, wf, row, states);
}

async function handoffs(ctx: JobContext, wf: LoadedWorkflow, row: RecordRow, states: StageState[]) {
  const data = row.data as RecordData;
  const title = recordTitle(wf.def.fields, data, row.number);
  for (const state of states.filter((s) => s.status === 'active')) {
    const stage = wf.def.stages.find((s) => s.key === state.stageKey);
    if (!stage) continue;
    // Marker claim: one hand-off per (record, stage), even with zero recipients.
    const marker = await claim(`handoff:${row.id}:${stage.key}${roundSuffix(state.round)}`, { kind: 'handoff-marker', channel: 'none', recipient: '*', recordId: row.id });
    if (!marker) continue;
    const recipients = await stageRecipients(wf, stage.responsibleGroups, data);
    const url = recordUrl(ctx.cfg, wf, row.id);
    const subject = `[${wf.name}] New task — ${stage.name}: #${row.number} ${title}`;
    const html = layout(
      `${stage.name}: action needed`,
      `<p>Record <b>#${row.number} ${escapeHtml(title)}</b> has reached <b>${escapeHtml(stage.name)}</b>.</p>` +
        table(['Planned by', 'Open'], [[escapeHtml(fmtTime(wf, state.plannedAt)), link(url, 'Update record')]]),
    );
    const text = `${subject}\nPlanned by: ${fmtTime(wf, state.plannedAt)}\n${url}`;
    const r = await send(await ctx.channelsFor(wf.orgId), { key: `handoff:${row.id}:${stage.key}${roundSuffix(state.round)}`, kind: 'handoff', recordId: row.id, recipients, channels: wf.settings.channels, subject, html, text });
    // A marker with failed deliveries stays `failed`, so the retry pass re-runs this hand-off;
    // recipients already reached are skipped by their own dedupe keys.
    await prisma.notificationLog.update({ where: { id: marker }, data: { status: !recipients.length ? 'skipped' : r.failed ? 'failed' : 'sent', error: r.failed ? `${r.failed} deliveries failed` : null } });
  }
}

async function rules(ctx: JobContext, wf: LoadedWorkflow, row: RecordRow, states: StageState[]) {
  const defs = await prisma.notificationRule.findMany({ where: { workflowId: wf.id, isActive: true } });
  for (const r of defs) {
    const parsed = notificationRuleSchema.safeParse(r.definition);
    if (!parsed.success) {
      ctx.log.warn({ ruleId: r.id }, 'invalid notification rule definition');
      continue;
    }
    const def = parsed.data;
    const t = def.trigger;
    const state = 'stageKey' in t ? states.find((s) => s.stageKey === t.stageKey) : undefined;
    let key: string | null = null;
    if (t.type === 'condition' && evaluateGroup(t.when, row.data as RecordData)) key = `rule:${r.id}:${row.id}:${periodKey(def.repeatEveryDays)}`;
    if (t.type === 'stage_activated' && state?.status === 'active') key = `rule:${r.id}:${row.id}:activated${roundSuffix(state.round)}:${periodKey(def.repeatEveryDays)}`;
    if (t.type === 'stage_completed' && state?.status === 'done') key = `rule:${r.id}:${row.id}:completed${roundSuffix(state.round)}`;
    if (key) await sendRule(ctx, wf, row, r.id, def, key);
  }
}

/** Render and send one rule (also used by the reminders job for stage_overdue rules). */
export async function sendRule(ctx: JobContext, wf: LoadedWorkflow, row: Pick<RecordRow, 'id' | 'number' | 'data' | 'currentStageKey'>, ruleId: string, def: NotificationRuleDef, key: string) {
  const data = row.data as RecordData;
  const title = recordTitle(wf.def.fields, data, row.number);
  const tctx = {
    fields: wf.def.fields,
    data,
    extra: {
      record_number: row.number,
      record_title: title,
      workflow_name: wf.name,
      current_stage: wf.def.stages.find((s) => s.key === row.currentStageKey)?.name ?? 'Completed',
      link: recordUrl(ctx.cfg, wf, row.id),
    },
  };
  if (def.email) {
    const subject = renderTemplate(def.email.subject, tctx);
    // Rich-editor bodies are HTML (sanitised); plain-text bodies keep their line breaks.
    const rendered = renderTemplate(def.email.body, tctx, { html: true });
    const body = isHtmlBody(def.email.body) ? sanitizeEmailHtml(rendered) : rendered.replace(/\n/g, '<br>');
    await send(await ctx.channelsFor(wf.orgId), {
      key,
      kind: 'rule',
      ruleId,
      recordId: row.id,
      recipients: splitList(renderTemplate(def.email.to, tctx)).map((email) => ({ email })),
      cc: splitList(def.email.cc ? renderTemplate(def.email.cc, tctx) : ''),
      channels: ['email'],
      subject,
      html: layout(subject, body),
      text: stripTags(body),
    });
  }
  if (def.whatsapp) {
    const text = renderTemplate(def.whatsapp.body, tctx);
    const tpl = def.whatsapp.template;
    await send(await ctx.channelsFor(wf.orgId), {
      key,
      kind: 'rule',
      ruleId,
      recordId: row.id,
      recipients: splitList(renderTemplate(def.whatsapp.to, tctx)).map((phone) => ({ phone })),
      channels: ['whatsapp'],
      subject: '',
      html: '',
      text,
      // Approved template (needed to start a conversation on official WhatsApp); variables use the same placeholders.
      whatsapp: tpl ? { template: { name: tpl.name, language: tpl.language, params: tpl.params.map((p) => renderTemplate(p, tctx)) } } : { text },
    });
  }
}

async function webhooks(ctx: JobContext, wf: LoadedWorkflow, row: RecordRow, states: StageState[]) {
  const data = row.data as RecordData;
  for (const hook of wf.settings.webhooks) {
    // Webhook node connected after a stage on the canvas: wait until that stage is done.
    if (hook.afterStage && states.find((s) => s.stageKey === hook.afterStage)?.status !== 'done') continue;
    if (!evaluateGroup(hook.when, data)) continue;
    const dedupeKey = `webhook:${hook.key}:${row.id}`;
    if (await prisma.notificationLog.findUnique({ where: { dedupeKey } })) continue;
    const picked = hook.fields.length ? Object.fromEntries(hook.fields.map((k) => [k, data[k] ?? null])) : data;
    const body = JSON.stringify({ event: 'record.matched', webhook: hook.key, workflow: wf.key, record: { id: row.id, number: row.number, data: picked }, sentAt: new Date().toISOString() });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-fms-delivery': dedupeKey };
    if (hook.secret) headers['x-fms-signature'] = `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`;
    let res: Response;
    try {
      res = await guardedFetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      if (!(e instanceof BlockedUrlError)) throw e;
      // A blocked address never becomes deliverable by retrying: record it once and move on.
      await prisma.notificationLog.create({ data: { dedupeKey, kind: 'webhook', channel: 'webhook', recipient: hook.url, status: 'failed', attempts: MAX_ATTEMPTS, error: e.message, recordId: row.id } });
      ctx.log.warn({ recordId: row.id, webhook: hook.key, err: e.message }, 'webhook blocked');
      continue;
    }
    // Throwing makes BullMQ retry with backoff; other side effects of this job are deduped.
    if (!res.ok) throw new Error(`Webhook ${hook.key} responded ${res.status}`);
    await prisma.notificationLog.create({ data: { dedupeKey, kind: 'webhook', channel: 'webhook', recipient: hook.url, status: 'sent', recordId: row.id } });
    ctx.log.info({ recordId: row.id, webhook: hook.key }, 'webhook delivered');
  }
}
