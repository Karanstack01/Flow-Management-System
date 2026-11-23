import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(20),
  APP_URL: z.string().url().default('http://localhost:5173'),
  /**
   * Trust X-Forwarded-For from a reverse proxy (needed for real client IPs in rate limits and audit).
   * Only enable when the API is reachable through the proxy alone; otherwise clients can spoof
   * their IP and slip past the login rate limit. `true`, `false`, or a comma list of proxy IPs/CIDRs.
   */
  TRUST_PROXY: z.string().default('true'),
});

/** Placeholder values from .env.example must never reach production. */
const PLACEHOLDER = /^change-me/i;

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    const bad = (['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const).filter((k) => PLACEHOLDER.test(c[k]));
    if (c.JWT_ACCESS_SECRET === c.JWT_REFRESH_SECRET) bad.push('JWT_REFRESH_SECRET');
    if (bad.length) throw new Error(`Invalid environment configuration:\n${bad.map((k) => `  ${k}: set a unique random secret (the .env.example value is not allowed in production)`).join('\n')}`);
  }
  return c;
}
