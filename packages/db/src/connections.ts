/**
 * Runtime clients for Settings › Connections, shared by the API (storage, tests) and the
 * worker (email, WhatsApp). Every call takes a validated ResolvedConnection; nothing here
 * reads environment variables.
 */
import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import {
  normalizeWhatsAppNumber,
  validateConnection,
  type CloudinaryConfig,
  type CloudinarySecrets,
  type ConnectionKind,
  type ConnectionProvider,
  type ResolvedConnection,
} from '@fms/core';
import type { PrismaClient } from '@prisma/client';
import { guardedFetch } from './net.js';
import { decryptJson } from './secrets.js';

type Db = Pick<PrismaClient, 'connection'>;

// ------------------------------------------------------------------ loading
/** Decrypted, validated connection; null when missing, unreadable or incomplete. */
export async function loadConnection(db: Db, orgId: string, where: { kind: ConnectionKind; activeOnly: true } | { provider: ConnectionProvider }): Promise<ResolvedConnection | null> {
  const row = await db.connection.findFirst({
    where: 'provider' in where ? { orgId, provider: where.provider } : { orgId, kind: where.kind, isActive: true },
  });
  if (!row) return null;
  let secrets: unknown = {};
  try {
    secrets = row.secrets ? decryptJson(row.secrets) : {};
  } catch {
    return null; // key rotated / corrupted — treated as not configured
  }
  const v = validateConnection(row.provider as ConnectionProvider, row.config, secrets);
  return v.ok ? v.value : null;
}

// ------------------------------------------------------------------ email
export interface MailMessage {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
}

const graphTokens = new Map<string, { token: string; expires: number }>();

async function graphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = `${tenantId}:${clientId}`;
  const hit = graphTokens.get(cacheKey);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Microsoft sign-in failed: ${body.error_description?.split('\r\n')[0] ?? res.status}`);
  graphTokens.set(cacheKey, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

const fromHeader = (email: string, name?: string) => (name ? `"${name.replace(/"/g, "'")}" <${email}>` : email);

export async function sendMail(conn: ResolvedConnection, msg: MailMessage): Promise<void> {
  if (!msg.to.length) return;
  if (conn.provider === 'google' || (conn.provider === 'microsoft' && conn.config.mode === 'smtp')) {
    const pass = conn.provider === 'google' ? conn.secrets.appPassword : conn.secrets.appPassword!;
    const transport = nodemailer.createTransport(
      conn.provider === 'google'
        ? { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: conn.config.email, pass } }
        : { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, auth: { user: conn.config.email, pass } },
    );
    await transport.sendMail({ from: fromHeader(conn.config.email, conn.config.fromName), to: msg.to, cc: msg.cc?.length ? msg.cc : undefined, subject: msg.subject, html: msg.html, text: msg.text });
    return;
  }
  if (conn.provider === 'microsoft') {
    const token = await graphToken(conn.config.tenantId!, conn.config.clientId!, conn.secrets.clientSecret!);
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(conn.config.email)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: msg.subject,
          body: { contentType: 'HTML', content: msg.html },
          toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
          ccRecipients: (msg.cc ?? []).map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Microsoft Graph responded ${res.status}: ${err.error?.message ?? 'send failed'}`);
    }
    return;
  }
  throw new Error(`${conn.provider} is not an email connection`);
}

// ------------------------------------------------------------------ WhatsApp (RedLava, Meta Cloud API message format)
export interface WhatsAppMessage {
  text?: string;
  template?: { name: string; language?: string; params: string[] };
}

/**
 * POST {baseUrl}/{phoneNumberId}/messages with a Meta Cloud API payload. RedLava's public API
 * reference was not available while building this; if their endpoint or auth differs, change
 * only this function.
 */
export async function sendWhatsApp(conn: ResolvedConnection, rawTo: string, msg: WhatsAppMessage): Promise<{ id: string | null }> {
  if (conn.provider !== 'redlava') throw new Error(`${conn.provider} is not a WhatsApp connection`);
  const to = normalizeWhatsAppNumber(rawTo, conn.config.defaultCountryCode);
  if (!to) throw new Error(`Invalid WhatsApp number: ${rawTo}`);
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const payload = msg.template
    ? {
        ...base,
        type: 'template',
        template: {
          name: msg.template.name,
          language: { code: msg.template.language ?? conn.config.defaultLanguage },
          ...(msg.template.params.length ? { components: [{ type: 'body', parameters: msg.template.params.map((text) => ({ type: 'text', text })) }] } : {}),
        },
      }
    : { ...base, type: 'text', text: { preview_url: false, body: msg.text ?? '' } };
  const auth: Record<string, string> = conn.config.authStyle === 'bearer' ? { authorization: `Bearer ${conn.secrets.apiKey}` } : { [conn.config.headerName]: conn.secrets.apiKey };
  const res = await guardedFetch(`${conn.config.baseUrl}/${encodeURIComponent(conn.config.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...auth },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WhatsApp provider responded ${res.status}: ${text.slice(0, 300)}`);
  try {
    const body = JSON.parse(text) as { messages?: { id?: string }[] };
    return { id: body.messages?.[0]?.id ?? null };
  } catch {
    return { id: null };
  }
}

// ------------------------------------------------------------------ Cloudinary storage
type Cloudinary = { config: CloudinaryConfig; secrets: CloudinarySecrets };

export interface CloudinaryAsset {
  publicId: string;
  resourceType: 'image' | 'raw';
  type: 'authenticated';
  version: number;
  format: string | null;
  cloudName: string;
}

/** Upload API signature: SHA-1 of the sorted `key=value` pairs joined by `&`, followed by the API secret. */
export function cloudinarySignature(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

/**
 * Files are uploaded as `authenticated` assets: not reachable by public URL, only through a
 * signed delivery URL generated here. Images go to `image`, everything else to `raw`
 * (Cloudinary blocks PDF delivery on `image` by default).
 */
export async function cloudinaryUpload(c: Cloudinary, file: Buffer, meta: { filename: string; mimeType: string; orgId: string }): Promise<CloudinaryAsset> {
  const resourceType: CloudinaryAsset['resourceType'] = meta.mimeType.startsWith('image/') ? 'image' : 'raw';
  const now = new Date();
  const ext = (meta.filename.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? '').toLowerCase();
  const id = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomBytes(12).toString('hex')}`;
  // Raw assets keep their extension in the public id; images get their format from Cloudinary.
  const publicId = [c.config.folder, meta.orgId, resourceType === 'raw' && ext ? `${id}.${ext}` : id].filter(Boolean).join('/');
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000), type: 'authenticated' };
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type: meta.mimeType }), meta.filename);
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('api_key', c.config.apiKey);
  form.append('signature', cloudinarySignature(params, c.secrets.apiSecret));
  const res = await fetch(`https://api.cloudinary.com/v1_1/${c.config.cloudName}/${resourceType}/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  const body = (await res.json().catch(() => ({}))) as { public_id?: string; version?: number; format?: string; error?: { message?: string } };
  if (!res.ok || !body.public_id) throw new Error(`Cloudinary upload failed: ${body.error?.message ?? res.status}`);
  return { publicId: body.public_id, resourceType, type: 'authenticated', version: body.version ?? 1, format: body.format ?? null, cloudName: c.config.cloudName };
}

/** Signed delivery URL for an authenticated asset (`s--<8 chars of urlsafe-base64 SHA-1>--`). */
export function cloudinarySignedUrl(c: Cloudinary, a: CloudinaryAsset): string {
  const source = a.resourceType === 'image' && a.format ? `${a.publicId}.${a.format}` : a.publicId;
  const sig = createHash('sha1')
    .update(source + c.secrets.apiSecret)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .slice(0, 8);
  const path = source.split('/').map(encodeURIComponent).join('/');
  return `https://res.cloudinary.com/${a.cloudName}/${a.resourceType}/${a.type}/s--${sig}--/v${a.version}/${path}`;
}

export async function cloudinaryFetch(c: Cloudinary, a: CloudinaryAsset): Promise<Response> {
  const res = await fetch(cloudinarySignedUrl(c, a), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`Cloudinary download failed: ${res.status}`);
  return res;
}

export async function cloudinaryDestroy(c: Cloudinary, a: Pick<CloudinaryAsset, 'publicId' | 'resourceType' | 'type'>): Promise<void> {
  const params = { public_id: a.publicId, timestamp: Math.floor(Date.now() / 1000), type: a.type, invalidate: 'true' };
  const form = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: c.config.apiKey, signature: cloudinarySignature(params, c.secrets.apiSecret) });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${c.config.cloudName}/${a.resourceType}/destroy`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Cloudinary delete failed: ${res.status}`);
}

/** Admin API ping — proves the cloud name, key and secret are valid. */
export async function cloudinaryPing(c: Cloudinary): Promise<void> {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${c.config.cloudName}/ping`, {
    headers: { authorization: `Basic ${Buffer.from(`${c.config.apiKey}:${c.secrets.apiSecret}`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error('Cloudinary rejected the API key or secret');
  if (!res.ok) throw new Error(`Cloudinary responded ${res.status} — check the cloud name`);
}
