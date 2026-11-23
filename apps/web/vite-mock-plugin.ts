import type { Plugin } from 'vite';
import { handleMockRequest } from './src/lib/mockApi';

export function mockApiPlugin(): Plugin {
  let isAuthed = false;

  return {
    name: 'fms-dev-mock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith('/api/v1')) return next();

        const json = (data: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        };

        if (url === '/api/v1/auth/login' && req.method === 'POST') {
          isAuthed = true;
          res.setHeader('Set-Cookie', 'fms_refresh=mock_refresh_token; Path=/; HttpOnly; SameSite=Strict');
          return json({ accessToken: 'mock_access_token_admin_2026' });
        }

        if (url === '/api/v1/auth/refresh') {
          if (isAuthed) {
            return json({ accessToken: 'mock_access_token_admin_2026' });
          }
          return json({ error: { message: 'Unauthorized' } }, 401);
        }

        if (url === '/api/v1/auth/logout') {
          isAuthed = false;
          handleMockRequest('/auth/logout', { method: 'POST' });
          res.statusCode = 204;
          return res.end();
        }

        const cleanPath = url.slice('/api/v1'.length);
        const query = Object.fromEntries(new URL(req.url ?? '', 'http://mock').searchParams);
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        req.on('end', () => {
          try {
            const body = raw ? (JSON.parse(raw) as unknown) : undefined;
            const result = handleMockRequest(cleanPath, { method: req.method, body, query });
            if (result !== undefined) {
              return json(result);
            }
            return next();
          } catch (e) {
            json({ error: { code: 'MOCK_ERROR', message: (e as Error).message } }, 400);
          }
        });
      });
    },
  };
}
