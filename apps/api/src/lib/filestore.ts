/**
 * Saving a file the server produced (generated documents) the same way uploads are saved:
 * in the organization's Cloudinary when that connection is on, otherwise in local storage.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { cloudinaryUpload, loadConnection, prisma } from '@fms/db';
import type { Storage } from './storage.js';

let storage: Storage | null = null;

export function initFileStore(s: Storage) {
  storage = s;
}

export async function storeBuffer(input: { orgId: string; buffer: Buffer; name: string; mimeType: string; uploadedById: string | null }) {
  if (!storage) throw new Error('File storage is not initialised');
  const cloud = await loadConnection(prisma, input.orgId, { kind: 'storage', activeOnly: true });
  if (cloud?.provider === 'cloudinary') {
    const asset = await cloudinaryUpload(cloud, input.buffer, { filename: input.name, mimeType: input.mimeType, orgId: input.orgId });
    return prisma.fileObject.create({
      data: {
        orgId: input.orgId,
        storageKey: `cloudinary:${asset.cloudName}:${asset.resourceType}:${asset.publicId}`,
        storageProvider: 'cloudinary',
        storageMeta: { ...asset },
        originalName: input.name,
        mimeType: input.mimeType,
        size: input.buffer.length,
        sha256: createHash('sha256').update(input.buffer).digest('hex'),
        uploadedById: input.uploadedById,
      },
    });
  }
  const local = await storage.put(Readable.from(input.buffer));
  return prisma.fileObject.create({
    data: { orgId: input.orgId, storageKey: local.key, storageProvider: 'local', originalName: input.name, mimeType: input.mimeType, size: local.size, sha256: local.sha256, uploadedById: input.uploadedById },
  });
}
