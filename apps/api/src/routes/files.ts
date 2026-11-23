import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canSeeRecord, isAdmin, visibleFieldKeys, type RecordData } from '@fms/core';
import { cloudinaryFetch, cloudinaryUpload, loadConnection, prisma, Prisma, type CloudinaryAsset } from '@fms/db';
import { audit } from '../lib/audit.js';
import { AppError, parse } from '../lib/errors.js';
import type { Storage } from '../lib/storage.js';
import { getWorkflow } from '../lib/workflows.js';
import type { AuthUser } from '../plugins/auth.js';

/** Content types we accept; everything else is rejected (no HTML/SVG/JS → no stored XSS). */
const ALLOWED = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/**
 * Who may open an attachment: admins, the person who uploaded it, and anyone who can see a
 * record that holds it in a file field they are allowed to see. File ids alone are not a
 * capability — before this check any member of the organization could open any file, including
 * ones on records hidden by their row filter or in fields restricted to other users.
 */
export async function canReadFile(p: AuthUser, file: { id: string; orgId: string; uploadedById: string | null }): Promise<boolean> {
  if (isAdmin(p) || file.uploadedById === p.userId) return true;
  const flows = await prisma.workflow.findMany({ where: { orgId: file.orgId, deletedAt: null }, select: { id: true, isDraft: true, definition: true } });
  const conds = flows.flatMap((w) => {
    const keys = ((w.definition as { fields?: { key: string; type: string }[] }).fields ?? []).filter((f) => f.type === 'file').map((f) => f.key);
    if (!keys.length || w.isDraft) return [];
    return [Prisma.sql`(r."workflowId" = ${w.id} AND (${Prisma.join(keys.map((k) => Prisma.sql`jsonb_exists(r."data"->${k}, ${file.id})`), ' OR ')}))`];
  });
  if (!conds.length) return false;
  const rows = await prisma.$queryRaw<{ workflowId: string; data: RecordData }[]>`
    SELECT r."workflowId", r."data" FROM "Record" r
    WHERE r."orgId" = ${file.orgId} AND (${Prisma.join(conds, ' OR ')})
    LIMIT 50`;
  for (const r of rows) {
    const wf = await getWorkflow(file.orgId, r.workflowId).catch(() => null);
    if (!wf || !canSeeRecord(p, r.data)) continue;
    const visible = visibleFieldKeys(wf.def.fields, p, wf.def.stages);
    if (wf.def.fields.some((f) => f.type === 'file' && visible.has(f.key) && Array.isArray(r.data[f.key]) && (r.data[f.key] as string[]).includes(file.id))) return true;
  }
  return false;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

export default async function fileRoutes(app: FastifyInstance, opts: { storage: Storage }) {
  app.addHook('preHandler', app.authenticate);

  /**
   * Stored in the organization's Cloudinary when that connection is switched on
   * (Settings › Connections), otherwise on the server. Files remember where they live,
   * so switching providers never breaks existing attachments.
   */
  app.post('/files', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const part = await req.file();
    if (!part) throw AppError.badRequest('No file uploaded');
    if (!ALLOWED.has(part.mimetype)) throw AppError.badRequest(`File type ${part.mimetype} is not allowed`);
    const p = req.principal;
    const originalName = part.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 200);
    const cloud = await loadConnection(prisma, p.orgId, { kind: 'storage', activeOnly: true });

    let stored: { key: string; size: number; sha256: string; provider: 'local' | 'cloudinary'; meta?: CloudinaryAsset };
    if (cloud?.provider === 'cloudinary') {
      const buf = await readAll(part.file);
      if (part.file.truncated) throw new AppError(413, 'TOO_LARGE', 'File is too large');
      let asset: CloudinaryAsset;
      try {
        asset = await cloudinaryUpload(cloud, buf, { filename: originalName, mimeType: part.mimetype, orgId: p.orgId });
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'cloudinary upload failed');
        throw new AppError(502, 'STORAGE_UNAVAILABLE', 'Cloud storage did not accept the file. Try again, or ask an admin to check Settings › Connections.');
      }
      stored = { key: `cloudinary:${asset.cloudName}:${asset.resourceType}:${asset.publicId}`, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), provider: 'cloudinary', meta: asset };
    } else {
      const local = await opts.storage.put(part.file);
      if (part.file.truncated) {
        await opts.storage.remove(local.key);
        throw new AppError(413, 'TOO_LARGE', 'File is too large');
      }
      stored = { ...local, provider: 'local' };
    }

    const file = await prisma.fileObject.create({
      data: {
        orgId: p.orgId,
        storageKey: stored.key,
        storageProvider: stored.provider,
        storageMeta: stored.meta ? { ...stored.meta } : undefined,
        originalName,
        mimeType: part.mimetype,
        size: stored.size,
        sha256: stored.sha256,
        uploadedById: p.userId,
      },
    });
    await audit(prisma, { orgId: file.orgId, actor: p, action: 'file.uploaded', entityType: 'FileObject', entityId: file.id, diff: { name: file.originalName, size: file.size, storage: stored.provider }, ip: req.ip });
    reply.code(201);
    return { id: file.id, name: file.originalName, size: file.size, mimeType: file.mimeType };
  });

  app.get('/files/:id/meta', async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(40) }), req.params);
    const file = await prisma.fileObject.findFirst({ where: { id, orgId: req.principal.orgId } });
    if (!file || !(await canReadFile(req.principal, file))) throw AppError.notFound('File');
    return { id: file.id, name: file.originalName, size: file.size, mimeType: file.mimeType, createdAt: file.createdAt };
  });

  /** Always streamed through the API (permission check + safe headers); Cloudinary assets are private. */
  app.get('/files/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(40) }), req.params);
    const file = await prisma.fileObject.findFirst({ where: { id, orgId: req.principal.orgId } });
    if (!file || !(await canReadFile(req.principal, file))) throw AppError.notFound('File');

    let body: Readable;
    if (file.storageProvider === 'cloudinary') {
      // Credentials of the Cloudinary connection, even if it has since been switched off.
      const conn = await loadConnection(prisma, file.orgId, { provider: 'cloudinary' });
      if (conn?.provider !== 'cloudinary') throw new AppError(503, 'STORAGE_UNAVAILABLE', 'This file is stored in Cloudinary, but the Cloudinary connection is missing. Ask an admin to restore it in Settings › Connections.');
      const res = await cloudinaryFetch(conn, file.storageMeta as unknown as CloudinaryAsset).catch((e: Error) => {
        req.log.warn({ err: e.message, fileId: file.id }, 'cloudinary download failed');
        throw new AppError(502, 'STORAGE_UNAVAILABLE', 'Could not fetch the file from cloud storage');
      });
      body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
    } else {
      body = opts.storage.get(file.storageKey);
    }

    const inline = file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf';
    reply
      .header('content-type', file.mimeType)
      .header('content-length', file.size)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.originalName)}"`);
    return reply.send(body);
  });
}
