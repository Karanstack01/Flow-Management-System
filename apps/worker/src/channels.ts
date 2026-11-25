import nodemailer, { type Transporter } from 'nodemailer';
import { loadConnection, prisma, sendMail, sendWhatsApp, type MailMessage, type WhatsAppMessage } from '@fms/db';
import type { WorkerConfig } from './config.js';

export type OutboundMessage = MailMessage;

export interface Channels {
  email(msg: OutboundMessage): Promise<void>;
  /** Returns false when WhatsApp is not configured for the organization or the server. */
  whatsapp(to: string, msg: WhatsAppMessage): Promise<boolean>;
}

/**
 * Server-wide defaults from environment variables: SMTP for email and a generic HTTP
 * WhatsApp gateway (POST {to, text} with a bearer token). Used when an organization has
 * not switched on its own connection in Settings › Connections.
 */
export function createChannels(cfg: WorkerConfig): Channels {
  const transporter: Transporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === 465,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
  });

  return {
    async email(msg) {
      if (!msg.to.length) return;
      // A per-message sender name keeps the configured address.
      const address = /<([^>]+)>/.exec(cfg.SMTP_FROM)?.[1] ?? cfg.SMTP_FROM;
      await transporter.sendMail({
        from: msg.fromName ? { name: msg.fromName, address } : cfg.SMTP_FROM,
        to: msg.to,
        cc: msg.cc?.length ? msg.cc : undefined,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
    },
    async whatsapp(to, msg) {
      if (!cfg.WHATSAPP_API_URL || !msg.text) return false; // the generic gateway has no template support
      const res = await fetch(cfg.WHATSAPP_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.WHATSAPP_API_TOKEN ? { authorization: `Bearer ${cfg.WHATSAPP_API_TOKEN}` } : {}) },
        body: JSON.stringify({ to: to.replace(/[^\d+]/g, ''), text: msg.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`WhatsApp provider responded ${res.status}`);
      return true;
    },
  };
}

const TTL_MS = 60_000;

/**
 * Per-organization channels: the organization's active email connection (Google or
 * Microsoft) and RedLava WhatsApp, falling back to the server defaults. Cached for a minute,
 * so changes in Settings › Connections apply within 60 seconds.
 */
export function createChannelResolver(defaults: Channels) {
  const cache = new Map<string, { at: number; channels: Channels }>();
  return async function channelsFor(orgId: string): Promise<Channels> {
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.channels;
    const [mail, wa] = await Promise.all([
      loadConnection(prisma, orgId, { kind: 'email', activeOnly: true }),
      loadConnection(prisma, orgId, { kind: 'whatsapp', activeOnly: true }),
    ]);
    const channels: Channels = {
      email: mail ? (msg) => sendMail(mail, msg) : defaults.email,
      whatsapp: wa ? async (to, msg) => (await sendWhatsApp(wa, to, msg), true) : defaults.whatsapp,
    };
    cache.set(orgId, { at: Date.now(), channels });
    return channels;
  };
}
