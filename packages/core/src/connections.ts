/**
 * Settings › Connections — per-organization external services.
 *
 *   storage   cloudinary            uploaded attachments
 *   email     google | microsoft    outgoing mail (one active at a time — the switch)
 *   whatsapp  redlava               official WhatsApp Business messages
 *
 * Non-secret settings (`config`) and secrets are validated separately: secrets are
 * stored encrypted and never sent back to the browser.
 */
import { z } from 'zod';

export const CONNECTION_KINDS = ['storage', 'email', 'whatsapp'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_PROVIDERS = ['cloudinary', 'google', 'microsoft', 'redlava'] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const PROVIDER_KIND: Record<ConnectionProvider, ConnectionKind> = {
  cloudinary: 'storage',
  google: 'email',
  microsoft: 'email',
  redlava: 'whatsapp',
};

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => u.startsWith('https://'), 'Must start with https://')
  .transform((u) => u.replace(/\/+$/, ''));

// ------------------------------------------------------------------ Cloudinary
export const cloudinaryConfigSchema = z.object({
  cloudName: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Letters, digits, - and _ only'),
  apiKey: z.string().trim().regex(/^\d{6,20}$/, 'The API key is a number from your Cloudinary dashboard'),
  folder: z
    .string()
    .trim()
    .max(100)
    .regex(/^[\w\-/]*$/, 'Letters, digits, -, _ and /')
    .transform((f) => f.replace(/^\/+|\/+$/g, ''))
    .default('fms'),
});
export const cloudinarySecretsSchema = z.object({ apiSecret: z.string().trim().min(10, 'API secret looks too short').max(128) });

// ------------------------------------------------------------------ Google (Gmail / Workspace SMTP + app password)
export const googleConfigSchema = z.object({
  email: z.string().trim().email(),
  fromName: z.string().trim().max(80).optional(),
});
export const googleSecretsSchema = z.object({
  appPassword: z
    .string()
    .transform((s) => s.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^[a-zA-Z]{16}$/, 'A Google app password is 16 letters (spaces are ignored)')),
});

// ------------------------------------------------------------------ Microsoft (Graph app or SMTP + app password)
export const microsoftConfigSchema = z
  .object({
    /** graph = Microsoft 365 app registration (recommended); smtp = mailbox + app password. */
    mode: z.enum(['graph', 'smtp']).default('graph'),
    email: z.string().trim().email(),
    fromName: z.string().trim().max(80).optional(),
    tenantId: z.string().trim().max(64).optional(),
    clientId: z.string().trim().max(64).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.mode !== 'graph') return;
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!c.tenantId || (!guid.test(c.tenantId) && !/^[\w.-]+\.[a-z]{2,}$/i.test(c.tenantId))) ctx.addIssue({ code: 'custom', path: ['tenantId'], message: 'Directory (tenant) ID — a GUID or your domain' });
    if (!c.clientId || !guid.test(c.clientId)) ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'Application (client) ID — a GUID' });
  });
export const microsoftSecretsSchema = z.object({
  clientSecret: z.string().trim().min(8).max(200).optional(),
  appPassword: z.string().transform((s) => s.replace(/\s+/g, '')).pipe(z.string().min(8).max(64)).optional(),
});

// ------------------------------------------------------------------ RedLava (WhatsApp Business, Meta Cloud API format)
export const redlavaConfigSchema = z.object({
  /** API endpoint from the RedLava dashboard (messages are POSTed to `{baseUrl}/{phoneNumberId}/messages`). */
  baseUrl: httpsUrl,
  phoneNumberId: z.string().trim().min(1).max(64).regex(/^[\w-]+$/, 'Letters, digits, - and _ only'),
  /** How the key is sent: `Authorization: Bearer <key>` or `<headerName>: <key>`. */
  authStyle: z.enum(['bearer', 'header']).default('bearer'),
  headerName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .default('x-api-key'),
  /** Template language used when a message node does not set one (e.g. en, en_US, hi). */
  defaultLanguage: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Like en, en_US or hi').default('en'),
  /** Prefixed to 10-digit local numbers (legacy sheets often store numbers without +91). */
  defaultCountryCode: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, 'Digits only, e.g. 91')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/** Digits-only international number as WhatsApp expects, applying the default country code to local numbers. */
export function normalizeWhatsAppNumber(raw: string, defaultCountryCode?: string): string | null {
  const digits = raw.replace(/[^\d]/g, '').replace(/^00/, '');
  if (digits.length < 8) return null;
  if (defaultCountryCode && digits.length === 10 && !raw.trim().startsWith('+')) return `${defaultCountryCode}${digits}`;
  return digits;
}
export const redlavaSecretsSchema = z.object({ apiKey: z.string().trim().min(8, 'API key looks too short').max(512) });

export const CONNECTION_SPECS = {
  cloudinary: { kind: 'storage', label: 'Cloudinary', config: cloudinaryConfigSchema, secrets: cloudinarySecretsSchema, secretFields: ['apiSecret'] },
  google: { kind: 'email', label: 'Google', config: googleConfigSchema, secrets: googleSecretsSchema, secretFields: ['appPassword'] },
  microsoft: { kind: 'email', label: 'Microsoft', config: microsoftConfigSchema, secrets: microsoftSecretsSchema, secretFields: ['clientSecret', 'appPassword'] },
  redlava: { kind: 'whatsapp', label: 'RedLava WhatsApp', config: redlavaConfigSchema, secrets: redlavaSecretsSchema, secretFields: ['apiKey'] },
} as const satisfies Record<ConnectionProvider, { kind: ConnectionKind; label: string; config: z.ZodTypeAny; secrets: z.ZodTypeAny; secretFields: readonly string[] }>;

export type CloudinaryConfig = z.infer<typeof cloudinaryConfigSchema>;
export type CloudinarySecrets = z.infer<typeof cloudinarySecretsSchema>;
export type GoogleConfig = z.infer<typeof googleConfigSchema>;
export type GoogleSecrets = z.infer<typeof googleSecretsSchema>;
export type MicrosoftConfig = z.infer<typeof microsoftConfigSchema>;
export type MicrosoftSecrets = z.infer<typeof microsoftSecretsSchema>;
export type RedlavaConfig = z.infer<typeof redlavaConfigSchema>;
export type RedlavaSecrets = z.infer<typeof redlavaSecretsSchema>;

export type ResolvedConnection =
  | { provider: 'cloudinary'; config: CloudinaryConfig; secrets: CloudinarySecrets }
  | { provider: 'google'; config: GoogleConfig; secrets: GoogleSecrets }
  | { provider: 'microsoft'; config: MicrosoftConfig; secrets: MicrosoftSecrets }
  | { provider: 'redlava'; config: RedlavaConfig; secrets: RedlavaSecrets };

export interface ConnectionIssue {
  path: string;
  message: string;
}

/**
 * Validate a full connection (config + merged secrets). Returns the typed connection or field-level issues.
 * Microsoft needs a client secret in Graph mode and an app password in SMTP mode.
 */
export function validateConnection(provider: ConnectionProvider, config: unknown, secrets: unknown): { ok: true; value: ResolvedConnection } | { ok: false; issues: ConnectionIssue[] } {
  const spec = CONNECTION_SPECS[provider];
  const c = spec.config.safeParse(config ?? {});
  const s = spec.secrets.safeParse(secrets ?? {});
  const issues: ConnectionIssue[] = [];
  if (!c.success) issues.push(...c.error.issues.map((i) => ({ path: `config.${i.path.join('.')}`, message: i.message })));
  if (!s.success) issues.push(...s.error.issues.map((i) => ({ path: `secrets.${i.path.join('.')}`, message: i.message })));
  if (c.success && s.success && provider === 'microsoft') {
    const cfg = c.data as MicrosoftConfig;
    const sec = s.data as MicrosoftSecrets;
    if (cfg.mode === 'graph' && !sec.clientSecret) issues.push({ path: 'secrets.clientSecret', message: 'Client secret is required for Microsoft Graph' });
    if (cfg.mode === 'smtp' && !sec.appPassword) issues.push({ path: 'secrets.appPassword', message: 'App password is required for SMTP' });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { provider, config: c.data, secrets: s.data } as ResolvedConnection };
}

/** Last 4 characters only — the browser never receives a secret. */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}
