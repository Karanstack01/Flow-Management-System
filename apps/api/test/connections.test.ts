import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskSecret, normalizeWhatsAppNumber, validateConnection } from '@fms/core';
import { BlockedUrlError, cloudinarySignature, cloudinarySignedUrl, decryptJson, encryptJson, guardedFetch, isPrivateAddress, sendMail, sendWhatsApp } from '@fms/db';

afterEach(() => vi.unstubAllGlobals());

describe('connection settings validation', () => {
  it('accepts a Google app password with spaces and normalises it', () => {
    const r = validateConnection('google', { email: 'ops@company.com' }, { appPassword: 'abcd efgh ijkl mnop' });
    expect(r.ok && r.value.provider === 'google' && r.value.secrets.appPassword).toBe('abcdefghijklmnop');
  });
  it('rejects a Google password that is not an app password', () => {
    const r = validateConnection('google', { email: 'ops@company.com' }, { appPassword: 'MyNormalPassword1' });
    expect(r.ok).toBe(false);
  });
  it('needs a client secret in Microsoft Graph mode and an app password in SMTP mode', () => {
    const graph = validateConnection('microsoft', { mode: 'graph', email: 'ops@contoso.com', tenantId: 'contoso.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, {});
    expect(graph.ok ? [] : graph.issues.map((i) => i.path)).toContain('secrets.clientSecret');
    const smtp = validateConnection('microsoft', { mode: 'smtp', email: 'ops@contoso.com' }, { appPassword: 'abcdefghijklmnop' });
    expect(smtp.ok).toBe(true);
  });
  it('requires https for the WhatsApp endpoint', () => {
    const r = validateConnection('redlava', { baseUrl: 'http://api.example.com', phoneNumberId: '123' }, { apiKey: 'k'.repeat(20) });
    expect(r.ok).toBe(false);
  });
  it('masks secrets to the last four characters', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('••••mnop');
    expect(maskSecret(undefined)).toBeNull();
  });
});

describe('secret encryption', () => {
  it('round-trips and produces a different ciphertext every time', () => {
    const a = encryptJson({ apiSecret: 's3cret' });
    const b = encryptJson({ apiSecret: 's3cret' });
    expect(a).not.toBe(b);
    expect(a).not.toContain('s3cret');
    expect(decryptJson(a)).toEqual({ apiSecret: 's3cret' });
  });
  it('detects tampering', () => {
    const parts = encryptJson({ x: 1 }).split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptJson(parts.join('.'))).toThrow();
  });
});

describe('WhatsApp numbers', () => {
  it('adds the default country code to 10-digit local numbers only', () => {
    expect(normalizeWhatsAppNumber('98765 43210', '91')).toBe('919876543210');
    expect(normalizeWhatsAppNumber('+91 98765 43210', '91')).toBe('919876543210');
    expect(normalizeWhatsAppNumber('+44 7700 900123', '91')).toBe('447700900123');
    expect(normalizeWhatsAppNumber('123', '91')).toBeNull();
  });
});

describe('Cloudinary signing', () => {
  it('matches the documented upload signature example', () => {
    // From Cloudinary's "Generating authentication signatures" guide.
    const sig = cloudinarySignature({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd');
    expect(sig).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });
  it('builds a signed delivery URL for private raw files', () => {
    const url = cloudinarySignedUrl(
      { config: { cloudName: 'demo', apiKey: '123456', folder: 'fms' }, secrets: { apiSecret: 'abcdefghijklmn' } },
      { publicId: 'fms/org1/202611/abc.pdf', resourceType: 'raw', type: 'authenticated', version: 7, format: null, cloudName: 'demo' },
    );
    expect(url).toMatch(/^https:\/\/res\.cloudinary\.com\/demo\/raw\/authenticated\/s--[\w-]{8}--\/v7\/fms\/org1\/202611\/abc\.pdf$/);
  });
});

describe('outbound address guard (SSRF)', () => {
  it('classifies private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('blocks internal targets before any request is made', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const url of ['http://127.0.0.1:5432/', 'https://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'ftp://93.184.216.34/', 'https://user:pw@93.184.216.34/']) {
      await expect(guardedFetch(url, { method: 'POST' }), url).rejects.toBeInstanceOf(BlockedUrlError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not follow redirects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })));
    await expect(guardedFetch('https://93.184.216.34/hook', { method: 'POST' })).rejects.toThrow(/redirect/);
  });
});

describe('outgoing providers', () => {
  // The fake provider host does not resolve; the address guard is covered above.
  beforeEach(() => void (process.env.ALLOW_PRIVATE_OUTBOUND = 'true'));
  afterEach(() => void delete process.env.ALLOW_PRIVATE_OUTBOUND);

  it('sends WhatsApp templates in the Meta Cloud API format with the configured auth header', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const v = validateConnection('redlava', { baseUrl: 'https://wa.example.com/v1/', phoneNumberId: 'PN1', authStyle: 'header', headerName: 'x-api-key', defaultCountryCode: '91' }, { apiKey: 'key-1234567890' });
    if (!v.ok) throw new Error('invalid');
    const r = await sendWhatsApp(v.value, '9876543210', { template: { name: 'order_update', params: ['#1001', 'Dispatch'] } });
    expect(r.id).toBe('wamid.1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wa.example.com/v1/PN1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('key-1234567890');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: { name: 'order_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '#1001' }, { type: 'text', text: 'Dispatch' }] }] },
    });
  });

  it('surfaces provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"template not approved"}', { status: 400 })));
    const v = validateConnection('redlava', { baseUrl: 'https://wa.example.com', phoneNumberId: 'PN1' }, { apiKey: 'key-1234567890' });
    if (!v.ok) throw new Error('invalid');
    await expect(sendWhatsApp(v.value, '+447700900123', { text: 'hi' })).rejects.toThrow(/400.*template not approved/);
  });

  it('sends Microsoft 365 mail through Graph with an app token', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('login.microsoftonline.com') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }) : new Response(null, { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const v = validateConnection('microsoft', { mode: 'graph', email: 'ops@contoso.com', tenantId: 'contoso.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, { clientSecret: 'secret-value-123' });
    if (!v.ok) throw new Error('invalid');
    await sendMail(v.value, { to: ['a@b.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
    const send = fetchMock.mock.calls.find((c) => String(c[0]).includes('graph.microsoft.com')) as unknown as [string, RequestInit];
    expect(send[0]).toBe('https://graph.microsoft.com/v1.0/users/ops%40contoso.com/sendMail');
    expect((send[1].headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(send[1].body as string).message.toRecipients).toEqual([{ emailAddress: { address: 'a@b.com' } }]);
  });
});
