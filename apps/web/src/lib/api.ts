import { handleMockRequest, isMockAuth, setMockAuth } from './mockApi';

/**
 * API client. The access token lives in memory only; the refresh token is an
 * httpOnly cookie the browser sends to /api/v1/auth/refresh. On a 401 we refresh
 * once (single-flight) and retry.
 */
const BASE = '/api/v1';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionExpired: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

/**
 * The offline mock (lib/mockApi) is a development aid. It is never used in a production build
 * unless explicitly enabled with VITE_ENABLE_MOCK=true (e.g. for a static demo).
 */
export const MOCK_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_MOCK === 'true';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refreshOnce(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (r.ok) {
      accessToken = ((await r.json()) as { accessToken: string }).accessToken;
      return true;
    }
    // Another tab rotated the shared cookie a moment ago: retry once with the new cookie.
    if (r.status === 409 && attempt === 0) {
      await sleep(300);
      continue;
    }
    return false;
  }
  return false;
}

export function refreshSession(): Promise<boolean> {
  if (MOCK_ENABLED && isMockAuth()) return Promise.resolve(true);
  refreshing ??= refreshOnce()
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function rawRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  const isForm = opts.body instanceof FormData;
  const send = () =>
    fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      credentials: 'include',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });

  let res = await send();
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    if (await refreshSession()) res = await send();
    else onSessionExpired?.();
  }
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: Record<string, string> } } | undefined;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res;
}

/** The API server is not reachable (dev without a backend) — as opposed to it answering "no". */
const unreachable = (err: unknown) =>
  (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) || (err instanceof ApiError && [404, 500, 502, 503, 504].includes(err.status) && err.code.startsWith('HTTP_'));

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (MOCK_ENABLED && isMockAuth()) return handleMockRequest(path, opts) as T;
  try {
    const res = await rawRequest(path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    // Development only: with no API server running, serve the offline mock. A real answer such as
    // 401 "wrong password" is never replaced by mock data.
    if (MOCK_ENABLED && unreachable(err)) {
      if (path.startsWith('/auth/login')) setMockAuth(true);
      return handleMockRequest(path, opts) as T;
    }
    throw err;
  }
}

/** Authenticated download (files and CSV exports need the bearer token, so plain links won't do). */
export async function download(path: string, query?: Query, fallbackName = 'download') {
  const res = await rawRequest(path, { query });
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = decodeURIComponent(/filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** POST that answers with a file (e.g. a sample document), saved by the browser. */
export async function downloadPost(path: string, body: unknown, fallbackName = 'download') {
  if (MOCK_ENABLED && isMockAuth()) {
    handleMockRequest(path, { method: 'POST', body }); // throws a readable "needs the API" message
    return;
  }
  const res = await rawRequest(path, { method: 'POST', body });
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = decodeURIComponent(/filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Open an attachment in a new tab (images/PDF render inline). */
export async function openFile(fileId: string) {
  const res = await rawRequest(`/files/${fileId}`);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function uploadFile(file: File): Promise<{ id: string; name: string; size: number }> {
  const form = new FormData();
  form.append('file', file);
  return api('/files', { method: 'POST', body: form });
}
