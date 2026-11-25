/**
 * Export to a Google Sheet (legacy pastedatafun / Messages "export data"): a Google service
 * account (Settings › Connections › Google Sheets) writes rows into a tab of a spreadsheet that has
 * been shared with it. The tab is cleared first, so it always holds the latest export.
 */
import { createSign } from 'node:crypto';
import type { GsheetsConfig, GsheetsSecrets } from '@fms/core';

type Conn = { config: GsheetsConfig; secrets: GsheetsSecrets };
const tokens = new Map<string, { token: string; expires: number }>();
const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

async function accessToken(c: Conn): Promise<string> {
  const hit = tokens.get(c.config.clientEmail);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: c.config.clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(c.secrets.privateKey, 'base64url');
  } catch {
    throw new Error('The service account private key could not be read — paste it again from the JSON key file');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? res.status}`);
  tokens.set(c.config.clientEmail, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/** The spreadsheet id from a link (…/spreadsheets/d/<id>/…) or a bare id. */
export function spreadsheetId(urlOrId: string): string | null {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(urlOrId) ?? /^([a-zA-Z0-9_-]{20,})$/.exec(urlOrId.trim());
  return m?.[1] ?? null;
}

async function call<T>(c: Conn, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${await accessToken(c)}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) throw new Error(`Google Sheets: no access — share the spreadsheet with ${c.config.clientEmail} as Editor`);
    throw new Error(`Google Sheets: ${body.error?.message ?? res.status}`);
  }
  return body;
}

const a1Tab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Replace the contents of one tab with `rows` (the first row is the header). Creates the tab if needed. */
export async function writeSheet(c: Conn, urlOrId: string, tab: string, rows: (string | number | boolean | null)[][]): Promise<{ url: string; rows: number }> {
  const id = spreadsheetId(urlOrId);
  if (!id) throw new Error('That is not a Google Sheets link');
  const meta = await call<{ sheets?: { properties: { title: string } }[] }>(c, `${id}?fields=sheets.properties.title`);
  if (!meta.sheets?.some((s) => s.properties.title === tab)) {
    await call(c, `${id}:batchUpdate`, { method: 'POST', body: { requests: [{ addSheet: { properties: { title: tab } } }] } });
  }
  await call(c, `${id}/values/${encodeURIComponent(a1Tab(tab))}:clear`, { method: 'POST', body: {} });
  // RAW keeps values as typed: a value starting with "=" stays text, never a formula.
  await call(c, `${id}/values/${encodeURIComponent(`${a1Tab(tab)}!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: rows } });
  return { url: `https://docs.google.com/spreadsheets/d/${id}`, rows: Math.max(0, rows.length - 1) };
}

/** Connection test: can we sign in and read this spreadsheet? */
export async function checkSheet(c: Conn, urlOrId?: string): Promise<string> {
  await accessToken(c);
  if (!urlOrId) return 'Signed in to Google as the service account.';
  const id = spreadsheetId(urlOrId);
  if (!id) throw new Error('That is not a Google Sheets link');
  const meta = await call<{ properties?: { title?: string } }>(c, `${id}?fields=properties.title`);
  return `Signed in and can open “${meta.properties?.title ?? id}”.`;
}
