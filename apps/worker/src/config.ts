import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('FMS <no-reply@example.com>'),
  WHATSAPP_API_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  WHATSAPP_API_TOKEN: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  /** The API's upload folder (shared disk / volume): needed to attach files stored on the server. */
  UPLOAD_DIR: z.string().default('./uploads'),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error(`Invalid worker configuration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}
