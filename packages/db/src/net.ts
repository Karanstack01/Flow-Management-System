/**
 * Outbound HTTP to addresses an organization admin typed in (webhook URLs, the WhatsApp
 * provider endpoint). Without a guard, a tenant admin could make the server call internal
 * services: the database host, Redis, cloud metadata (169.254.169.254) and so on (SSRF).
 *
 * The host is resolved and every address it resolves to must be public. Redirects are not
 * followed, so a public URL can not bounce the request to an internal one.
 * Set ALLOW_PRIVATE_OUTBOUND=true for on-premise installs that post to intranet systems.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {}

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Private(mapped[1]!);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BlockedUrlError('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  if (process.env.ALLOW_PRIVATE_OUTBOUND === 'true') return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new BlockedUrlError(`Could not resolve ${host}`);
  if (addresses.some(isPrivateAddress)) throw new BlockedUrlError(`${host} points to a private network address; outbound calls there are blocked`);
  return url;
}

/** fetch() for admin-supplied URLs: public addresses only, redirects are an error. */
export async function guardedFetch(raw: string, init: RequestInit): Promise<Response> {
  const url = await assertPublicUrl(raw);
  const res = await fetch(url.toString(), { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) throw new BlockedUrlError(`${url.host} answered with a redirect (${res.status}); redirects are not followed`);
  return res;
}
