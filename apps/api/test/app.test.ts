import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** Boots the real app (all plugins and routes) without touching the database. */
describe('app wiring', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
    });
    app = await buildApp(config);
    await app.ready();
  });
  afterAll(() => app.close());

  it('serves liveness', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects unauthenticated API calls with a JSON error', async () => {
    for (const url of ['/api/v1/workflows', '/api/v1/me/tasks', '/api/v1/admin/users', '/api/v1/workflows/orders/records', '/api/v1/platform/overview', '/api/v1/platform/orgs', '/api/v1/flows', '/api/v1/templates', '/api/v1/dashboard', '/api/v1/flows/orders/editor']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects forged tokens', async () => {
    const forged = app.jwt.sign({ sub: 'u', org: 'o' }, { key: 'not-the-secret-not-the-secret-not-the-secret' } as never);
    const r = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: { authorization: `Bearer ${forged}` } });
    expect(r.statusCode).toBe(401);
  });

  it('validates login input before touching the database', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'not-an-email', password: '' } });
    expect(r.statusCode).toBe(400);
    expect(Object.keys(r.json().error.details)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('organization switching requires authentication', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/switch-org', payload: { orgId: 'x' } });
    expect(r.statusCode).toBe(401);
  });

  it('refresh without a session cookie is 401', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(r.statusCode).toBe(401);
  });
});
