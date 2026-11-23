import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for connection secrets (app passwords, API secrets) at rest.
 * Key: CONNECTIONS_SECRET_KEY — 32 bytes as base64, or any long random string (hashed to 32 bytes).
 * Rotating the key makes stored secrets unreadable; re-enter them in Settings › Connections.
 */
function key(): Buffer {
  const raw = process.env.CONNECTIONS_SECRET_KEY;
  if (raw && /^change-me/i.test(raw) && process.env.NODE_ENV === 'production') throw new Error('CONNECTIONS_SECRET_KEY still has the .env.example value; set a random key');
  if (raw) {
    const b64 = Buffer.from(raw, 'base64');
    return b64.length === 32 ? b64 : createHash('sha256').update(raw).digest();
  }
  if (process.env.NODE_ENV === 'production') throw new Error('CONNECTIONS_SECRET_KEY must be set in production');
  return createHash('sha256').update('fms-development-only-connections-key').digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptJson<T = Record<string, unknown>>(payload: string): T {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')) as T;
}
