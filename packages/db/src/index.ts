import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export * from './workflow.js';

const globalForPrisma = globalThis as unknown as { __fmsPrisma?: PrismaClient };

/** Process-wide Prisma client (re-used across hot reloads in dev). */
export const prisma: PrismaClient =
  globalForPrisma.__fmsPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.__fmsPrisma = prisma;

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
export * from './secrets.js';
export * from './connections.js';
export * from './net.js';
