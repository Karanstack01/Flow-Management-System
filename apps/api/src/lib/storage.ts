import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

/**
 * Storage abstraction. LocalDiskStorage is for single-node/dev deployments; swap in
 * an S3/GCS/Azure implementation of the same interface for production clusters.
 */
export interface Storage {
  put(stream: Readable): Promise<{ key: string; size: number; sha256: string }>;
  get(key: string): Readable;
  remove(key: string): Promise<void>;
}

export class LocalDiskStorage implements Storage {
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(stream: Readable) {
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomBytes(16).toString('hex')}`;
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(tmp));
      await rename(tmp, full);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return { key, size, sha256: hash.digest('hex') };
  }

  get(key: string) {
    return createReadStream(this.resolve(key));
  }

  async remove(key: string) {
    const full = this.resolve(key);
    if (await stat(full).catch(() => null)) await rm(full);
  }
}
