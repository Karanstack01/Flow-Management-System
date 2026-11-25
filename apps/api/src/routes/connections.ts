/**
 * Settings › Connections (organization admins). Secrets are write-only: they are encrypted
 * on save, never returned, and an empty secret field on save means "keep the current one".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONNECTION_PROVIDERS, CONNECTION_SPECS, PROVIDER_KIND, maskSecret, validateConnection, type ConnectionProvider, type ResolvedConnection } from '@fms/core';
import { askClaude, checkSheet, cloudinaryDestroy, cloudinaryFetch, cloudinaryPing, cloudinaryUpload, decryptJson, encryptJson, prisma, Prisma, sendMail, sendWhatsApp } from '@fms/db';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';

const providerParam = z.object({ provider: z.enum(CONNECTION_PROVIDERS) });

function readSecrets(enc: string | null): Record<string, string> {
  if (!enc) return {};
  try {
    return decryptJson<Record<string, string>>(enc);
  } catch {
    return {};
  }
}

function view(row: { provider: string; kind: string; isActive: boolean; config: Prisma.JsonValue; secrets: string | null; lastTestAt: Date | null; lastTestOk: boolean | null; lastTestMessage: string | null; updatedAt: Date } | null, provider: ConnectionProvider) {
  const spec = CONNECTION_SPECS[provider];
  const secrets = readSecrets(row?.secrets ?? null);
  const valid = row ? validateConnection(provider, row.config, secrets).ok : false;
  return {
    provider,
    kind: spec.kind,
    label: spec.label,
    saved: !!row,
    complete: valid,
    isActive: row?.isActive ?? false,
    config: (row?.config ?? {}) as Record<string, unknown>,
    secrets: Object.fromEntries(spec.secretFields.map((f) => [f, maskSecret(secrets[f])])),
    lastTestAt: row?.lastTestAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestMessage: row?.lastTestMessage ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export default async function connectionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireCapability('ADMIN'));

  app.get('/admin/connections', async (req) => {
    const rows = await prisma.connection.findMany({ where: { orgId: req.principal.orgId } });
    const cloudFiles = await prisma.fileObject.count({ where: { orgId: req.principal.orgId, storageProvider: 'cloudinary' } });
    return { items: CONNECTION_PROVIDERS.map((p) => view(rows.find((r) => r.provider === p) ?? null, p)), cloudinaryFiles: cloudFiles };
  });

  app.put('/admin/connections/:provider', async (req) => {
    const { provider } = parse(providerParam, req.params);
    const body = parse(z.object({ config: z.record(z.string(), z.unknown()), secrets: z.record(z.string(), z.string()).default({}) }), req.body);
    const p = req.principal;
    const spec = CONNECTION_SPECS[provider];
    const existing = await prisma.connection.findUnique({ where: { orgId_provider: { orgId: p.orgId, provider } } });
    // Blank secret fields keep what is stored; only known secret fields are accepted.
    const merged: Record<string, string> = { ...readSecrets(existing?.secrets ?? null) };
    for (const f of spec.secretFields) {
      const v = body.secrets[f];
      if (typeof v === 'string' && v.trim()) merged[f] = v.trim();
    }
    const v = validateConnection(provider, body.config, merged);
    if (!v.ok) throw AppError.validation(Object.fromEntries(v.issues.map((i) => [i.path, i.message])));
    const config = v.value.config as Prisma.InputJsonObject;
    const before = readSecrets(existing?.secrets ?? null);
    const changedCredentials = JSON.stringify(existing?.config ?? {}) !== JSON.stringify(config) || spec.secretFields.some((f) => before[f] !== merged[f]);
    const row = await prisma.connection.upsert({
      where: { orgId_provider: { orgId: p.orgId, provider } },
      create: { orgId: p.orgId, kind: spec.kind, provider, config, secrets: encryptJson(v.value.secrets), updatedById: p.userId },
      update: { config, secrets: encryptJson(v.value.secrets), updatedById: p.userId, ...(changedCredentials ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}) },
    });
    // Audit the shape of the change, never the secret values.
    await audit(prisma, { orgId: p.orgId, actor: p, action: 'connection.saved', entityType: 'Connection', entityId: row.id, diff: { provider, config, secretsChanged: Object.keys(body.secrets).filter((k) => body.secrets[k]?.trim()) }, ip: req.ip });
    return view(row, provider);
  });

  /** Turn a connection on. For email this is the Google ⇄ Microsoft switch: the other one turns off. */
  app.post('/admin/connections/:provider/activate', async (req) => {
    const { provider } = parse(providerParam, req.params);
    const p = req.principal;
    const row = await prisma.connection.findUnique({ where: { orgId_provider: { orgId: p.orgId, provider } } });
    if (!row || !validateConnection(provider, row.config, readSecrets(row.secrets)).ok) throw AppError.badRequest('Save complete settings before switching this connection on');
    await prisma.$transaction(async (tx) => {
      await tx.connection.updateMany({ where: { orgId: p.orgId, kind: PROVIDER_KIND[provider], NOT: { provider } }, data: { isActive: false } });
      await tx.connection.update({ where: { id: row.id }, data: { isActive: true } });
      await audit(tx, { orgId: p.orgId, actor: p, action: 'connection.activated', entityType: 'Connection', entityId: row.id, diff: { provider }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/admin/connections/:provider/deactivate', async (req) => {
    const { provider } = parse(providerParam, req.params);
    const p = req.principal;
    const { count } = await prisma.connection.updateMany({ where: { orgId: p.orgId, provider }, data: { isActive: false } });
    if (count) await audit(prisma, { orgId: p.orgId, actor: p, action: 'connection.deactivated', entityType: 'Connection', entityId: provider, ip: req.ip });
    return { ok: true };
  });

  app.delete('/admin/connections/:provider', async (req) => {
    const { provider } = parse(providerParam, req.params);
    const p = req.principal;
    if (provider === 'cloudinary') {
      const files = await prisma.fileObject.count({ where: { orgId: p.orgId, storageProvider: 'cloudinary' } });
      if (files) throw AppError.conflict(`${files} attached file(s) are stored in Cloudinary and need these credentials to be opened. Switch Cloudinary off instead — new uploads will be stored on the server.`);
    }
    await prisma.connection.deleteMany({ where: { orgId: p.orgId, provider } });
    await audit(prisma, { orgId: p.orgId, actor: p, action: 'connection.removed', entityType: 'Connection', entityId: provider, ip: req.ip });
    return { ok: true };
  });

  /** Real round-trip with the saved settings; the result is remembered and shown on the card. */
  app.post('/admin/connections/:provider/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { provider } = parse(providerParam, req.params);
    const body = parse(z.object({ to: z.string().trim().max(200).optional(), template: z.string().trim().regex(/^[a-z0-9_]{1,512}$/).optional(), language: z.string().trim().max(10).optional() }), req.body ?? {});
    const p = req.principal;
    const row = await prisma.connection.findUnique({ where: { orgId_provider: { orgId: p.orgId, provider } } });
    if (!row) throw AppError.badRequest('Save the settings first');
    const v = validateConnection(provider, row.config, readSecrets(row.secrets));
    if (!v.ok) throw AppError.badRequest('The saved settings are incomplete');
    const conn: ResolvedConnection = v.value;

    let ok = false;
    let message = '';
    try {
      if (conn.provider === 'cloudinary') {
        await cloudinaryPing(conn);
        const probe = Buffer.from(`FMS connection test ${new Date().toISOString()}`);
        const asset = await cloudinaryUpload(conn, probe, { filename: 'connection-test.txt', mimeType: 'text/plain', orgId: p.orgId });
        try {
          const back = Buffer.from(await (await cloudinaryFetch(conn, asset)).arrayBuffer());
          if (!back.equals(probe)) throw new Error('Downloaded file did not match the upload');
        } finally {
          await cloudinaryDestroy(conn, asset).catch(() => undefined);
        }
        message = 'Credentials valid; private upload, signed download and delete all worked.';
      } else if (conn.provider === 'google' || conn.provider === 'microsoft') {
        const to = z.string().email().safeParse(body.to);
        if (!to.success) throw AppError.validation({ to: 'Enter an email address to send the test to' });
        await sendMail(conn, {
          to: [to.data],
          subject: 'FMS — test email',
          html: `<p>This is a test from <b>${CONNECTION_SPECS[conn.provider].label}</b> in your Flow Management System connection settings.</p>`,
          text: `This is a test from ${CONNECTION_SPECS[conn.provider].label} in your Flow Management System connection settings.`,
        });
        message = `Test email sent to ${to.data}.`;
      } else if (conn.provider === 'anthropic') {
        // A tiny real request: proves the key, the model and the account's access in one go.
        const a = await askClaude({ ...conn, config: { ...conn.config, effort: 'low' } }, { system: 'You check connections. Reply with exactly: OK', prompt: 'Connection test', maxTokens: 64 });
        message = `Claude answered (${a.model}). AI reports can use this connection.`;
      } else if (conn.provider === 'gsheets') {
        // Optional: a spreadsheet link in "to" checks that it has been shared with the account.
        message = await checkSheet(conn, body.to || undefined);
      } else {
        if (!body.to) throw AppError.validation({ to: 'Enter a WhatsApp number to send the test to' });
        const r = await sendWhatsApp(conn, body.to, body.template ? { template: { name: body.template, language: body.language || undefined, params: [] } } : { text: 'Test message from your Flow Management System.' });
        message = `Accepted by the provider${r.id ? ` (message ${r.id})` : ''}. ${body.template ? '' : 'Plain text only arrives if the number messaged you in the last 24 hours — use an approved template otherwise.'}`.trim();
      }
      ok = true;
    } catch (e) {
      if (e instanceof AppError) throw e;
      message = (e as Error).message.slice(0, 500);
    }
    await prisma.connection.update({ where: { id: row.id }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message } });
    await audit(prisma, { orgId: p.orgId, actor: p, action: 'connection.tested', entityType: 'Connection', entityId: row.id, diff: { provider, ok }, ip: req.ip });
    return { ok, message };
  });
}
