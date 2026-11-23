import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { JOBS, QUEUE_NAME, type PeriodicJobPayload, type RecordChangedPayload } from '@fms/core';
import { prisma, Prisma } from '@fms/db';
import { createChannelResolver, createChannels } from './channels.js';
import { loadConfig } from './config.js';
import type { JobContext, Logger } from './context.js';
import { processRecord } from './jobs/record-changed.js';
import { archive, digests, reminders, sweep } from './jobs/periodic.js';

const cfg = loadConfig();
const log: Logger = {
  info: (o, m) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: m, ...o })),
  warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg: m, ...o })),
  error: (o, m) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: m, ...o })),
};
const ctx: JobContext = { cfg, channelsFor: createChannelResolver(createChannels(cfg)), log };

const periodic: Record<string, (c: JobContext) => Promise<object>> = {
  [JOBS.sweep]: sweep,
  [JOBS.reminders]: reminders,
  [JOBS.digests]: digests,
  [JOBS.archive]: archive,
};

/** Record a JobRun row so admins can see when automation last ran (legacy "Trigger Active" cell). */
async function tracked(name: string, payload: PeriodicJobPayload, fn: () => Promise<object>) {
  const run = await prisma.jobRun.create({ data: { name, status: 'running', orgId: payload.orgId ?? null, requestedBy: payload.requestedBy ?? null } });
  try {
    const stats = await fn();
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'succeeded', stats: stats as Prisma.InputJsonObject, finishedAt: new Date() } });
    return stats;
  } catch (e) {
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'failed', error: String((e as Error).stack ?? e).slice(0, 4000), finishedAt: new Date() } });
    throw e;
  }
}

async function handle(job: Job) {
  if (job.name === JOBS.recordChanged) {
    await processRecord(ctx, (job.data as RecordChangedPayload).recordId);
    return;
  }
  const fn = periodic[job.name];
  if (!fn) throw new Error(`Unknown job ${job.name}`);
  const payload = (job.data ?? {}) as PeriodicJobPayload;
  // An organization admin's manual run only touches that organization.
  return tracked(job.name, payload, () => fn(payload.orgId ? { ...ctx, orgId: payload.orgId } : ctx));
}

const connection = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });

// Idempotent: re-registering on every boot updates the schedule in place.
await queue.upsertJobScheduler('sweep', { every: 5 * 60_000 }, { name: JOBS.sweep });
await queue.upsertJobScheduler('reminders', { every: 10 * 60_000 }, { name: JOBS.reminders });
await queue.upsertJobScheduler('digests', { pattern: '*/15 * * * *' }, { name: JOBS.digests });
await queue.upsertJobScheduler('archive', { every: 60 * 60_000 }, { name: JOBS.archive });

const worker = new Worker(QUEUE_NAME, handle, { connection, concurrency: cfg.WORKER_CONCURRENCY });
worker.on('failed', (job, err) => log.error({ job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
worker.on('error', (err) => log.error({ err: err.message }, 'worker error'));
log.info({ queue: QUEUE_NAME, concurrency: cfg.WORKER_CONCURRENCY }, 'worker started');

async function shutdown(signal: string) {
  log.info({ signal }, 'worker shutting down');
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  connection.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
