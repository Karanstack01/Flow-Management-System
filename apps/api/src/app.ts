import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { Prisma, prisma } from '@fms/db';
import type { Config } from './config.js';
import { AppError } from './lib/errors.js';
import { initFileStore } from './lib/filestore.js';
import { LocalDiskStorage, type Storage } from './lib/storage.js';
import publicRoutes from './routes/public.js';
import authPlugin from './plugins/auth.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import platformRoutes from './routes/platform.js';
import flowRoutes from './routes/flows.js';
import connectionRoutes from './routes/connections.js';
import recordRoutes from './routes/records.js';
import workflowRoutes from './routes/workflows.js';

export async function buildApp(config: Config, deps: { storage?: Storage } = {}) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : config.NODE_ENV === 'test' ? 'silent' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    trustProxy: config.TRUST_PROXY === 'true' ? true : config.TRUST_PROXY === 'false' ? false : config.TRUST_PROXY.split(',').map((s) => s.trim()),
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false }); // API serves JSON only; the SPA host sets its own CSP
  await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
  await app.register(authPlugin, { config });

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'A record with these values already exists' } });
      if (err.code === 'P2025') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id } });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  const storage = deps.storage ?? new LocalDiskStorage(config.UPLOAD_DIR);
  initFileStore(storage);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth', config });
      await v1.register(workflowRoutes);
      await v1.register(recordRoutes);
      await v1.register(adminRoutes);
      await v1.register(fileRoutes, { storage });
      await v1.register(platformRoutes);
      await v1.register(flowRoutes);
      await v1.register(connectionRoutes);
      // No sign-in: the public intake form (only for flows that switch it on).
      await v1.register(publicRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
