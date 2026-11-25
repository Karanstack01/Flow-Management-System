/**
 * Reading stored files outside the API (e.g. the worker attaching them to emails). Files remember
 * where they live: the organization's Cloudinary, or the server's upload folder (`UPLOAD_DIR`, which
 * the worker must share with the API — same machine or a shared volume).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { cloudinaryFetch, loadConnection, type CloudinaryAsset } from './connections.js';

export interface StoredFile {
  id: string;
  orgId: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  storageProvider: string;
  storageMeta: unknown;
}

export interface FileAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export async function readStoredFile(db: PrismaClient, file: StoredFile, uploadDir: string): Promise<Buffer> {
  if (file.storageProvider === 'cloudinary') {
    const conn = await loadConnection(db, file.orgId, { provider: 'cloudinary' });
    if (conn?.provider !== 'cloudinary') throw new Error(`"${file.originalName}" is in Cloudinary, but the Cloudinary connection is missing`);
    const res = await cloudinaryFetch(conn, file.storageMeta as CloudinaryAsset);
    return Buffer.from(await res.arrayBuffer());
  }
  const root = path.resolve(uploadDir);
  const full = path.resolve(root, file.storageKey);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return readFile(full);
}

/**
 * The files held in some file fields of a record, ready to attach (largest-first files are kept
 * until `maxBytes`; the rest are listed in `skipped`).
 */
export async function loadAttachments(
  db: PrismaClient,
  orgId: string,
  fileIds: string[],
  uploadDir: string,
  maxBytes = 20 * 1024 * 1024,
): Promise<{ files: FileAttachment[]; skipped: string[] }> {
  if (!fileIds.length) return { files: [], skipped: [] };
  const rows = await db.fileObject.findMany({ where: { id: { in: [...new Set(fileIds)] }, orgId } });
  const files: FileAttachment[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of rows) {
    if (total + f.size > maxBytes) {
      skipped.push(f.originalName);
      continue;
    }
    try {
      files.push({ filename: f.originalName, contentType: f.mimeType, content: await readStoredFile(db, f, uploadDir) });
      total += f.size;
    } catch (e) {
      throw new Error(`Attachment "${f.originalName}" could not be read: ${(e as Error).message}`);
    }
  }
  return { files, skipped };
}
