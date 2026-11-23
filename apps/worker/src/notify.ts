import { escapeHtml } from '@fms/core';
import { prisma, Prisma, type WhatsAppMessage } from '@fms/db';
import type { Channels } from './channels.js';

export interface Recipient {
  email?: string | null;
  phone?: string | null;
  userId?: string;
}

/**
 * Claim a dedupe key. Returns false if it was already claimed — the message was sent
 * (or attempted) before. This is what makes every job safely re-runnable.
 */
export async function claim(dedupeKey: string, meta: { kind: string; channel: string; recipient: string; ruleId?: string; recordId?: string }): Promise<string | null> {
  try {
    const log = await prisma.notificationLog.create({ data: { dedupeKey, status: 'pending', ...meta } });
    return log.id;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }
  // Already claimed. Re-claim only a failed delivery whose back-off has passed, or a claim left
  // `pending` by a crashed process. The conditional update makes the re-claim atomic across workers.
  const row = await prisma.notificationLog.findUnique({ where: { dedupeKey } });
  if (!row || !isRetryable(row)) return null;
  const { count } = await prisma.notificationLog.updateMany({
    where: { id: row.id, status: row.status, attempts: row.attempts },
    data: { status: 'pending', attempts: { increment: 1 }, error: null },
  });
  return count === 1 ? row.id : null;
}

export const MAX_ATTEMPTS = 5;
const STALE_PENDING_MS = 10 * 60_000;
/** Back-off before attempt n+1: 5, 10, 20, 40 minutes. */
export const retryDelayMs = (attempts: number) => 5 * 60_000 * 2 ** (attempts - 1);

export function isRetryable(row: { status: string; attempts: number; updatedAt: Date }, now = new Date()): boolean {
  const age = now.getTime() - row.updatedAt.getTime();
  if (row.status === 'pending') return age > STALE_PENDING_MS;
  if (row.status === 'failed') return row.attempts < MAX_ATTEMPTS && age > retryDelayMs(row.attempts);
  return false;
}

async function settle(id: string, error?: unknown) {
  await prisma.notificationLog.update({
    where: { id },
    data: error ? { status: 'failed', error: String((error as Error).message ?? error).slice(0, 1000) } : { status: 'sent' },
  });
}

export interface SendSpec {
  /** Unique per logical message, e.g. `handoff:<record>:<stage>`. Channel/recipient are appended. */
  key: string;
  kind: string;
  ruleId?: string;
  recordId?: string;
  recipients: Recipient[];
  cc?: string[];
  channels: readonly ('email' | 'whatsapp')[];
  subject: string;
  html: string;
  text: string;
  /** WhatsApp content; defaults to `text`. Carries an approved template when the rule has one. */
  whatsapp?: WhatsAppMessage;
}

export async function send(ch: Channels, spec: SendSpec): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const emails = [...new Set(spec.recipients.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => !!e))];
  const phones = [...new Set(spec.recipients.map((r) => r.phone?.trim()).filter((p): p is string => !!p))];

  if (spec.channels.includes('email')) {
    for (const email of emails) {
      const id = await claim(`${spec.key}:email:${email}`, { kind: spec.kind, channel: 'email', recipient: email, ruleId: spec.ruleId, recordId: spec.recordId });
      if (!id) continue;
      try {
        await ch.email({ to: [email], cc: spec.cc, subject: spec.subject, html: spec.html, text: spec.text });
        await settle(id);
        sent++;
      } catch (e) {
        await settle(id, e);
        failed++;
      }
    }
  }
  if (spec.channels.includes('whatsapp')) {
    for (const phone of phones) {
      const id = await claim(`${spec.key}:whatsapp:${phone}`, { kind: spec.kind, channel: 'whatsapp', recipient: phone, ruleId: spec.ruleId, recordId: spec.recordId });
      if (!id) continue;
      try {
        const ok = await ch.whatsapp(phone, spec.whatsapp ?? { text: spec.text });
        if (ok) {
          await settle(id);
          sent++;
        } else {
          await prisma.notificationLog.update({ where: { id }, data: { status: 'skipped', error: 'WhatsApp not configured' } });
        }
      } catch (e) {
        await settle(id, e);
        failed++;
      }
    }
  }
  return { sent, failed };
}

/** Active users in any of the given groups. */
export async function groupMembers(orgId: string, groups: readonly string[]) {
  if (!groups.length) return [];
  return prisma.user.findMany({
    where: { orgId, isActive: true, groups: { some: { group: { name: { in: [...groups] } } } } },
    include: { groups: { include: { group: true } } },
  });
}

/** Split a rendered recipients template ("a@x.com, b@y.com") into a clean list. */
export function splitList(s: string | undefined): string[] {
  return (s ?? '')
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------- HTML helpers

export function layout(title: string, inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:600">${escapeHtml(title)}</td></tr>
<tr><td style="padding:20px 24px;font-size:14px;line-height:1.5">${inner}</td></tr>
<tr><td style="padding:12px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">Sent by FMS. You receive this because you belong to a responsible group.</td></tr>
</table></td></tr></table></body></html>`;
}

export function table(headers: string[], rows: string[][]): string {
  const th = headers.map((h) => `<th align="left" style="padding:8px;border-bottom:2px solid #e5e7eb;font-size:12px;text-transform:uppercase;color:#6b7280">${escapeHtml(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td style="padding:8px;border-bottom:1px solid #f3f4f6">${c}</td>`).join('')}</tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

export const link = (href: string, label: string) => `<a href="${escapeHtml(href)}" style="color:#2563eb">${escapeHtml(label)}</a>`;
