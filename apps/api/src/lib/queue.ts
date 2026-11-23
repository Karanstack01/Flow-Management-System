import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { JOBS, QUEUE_NAME, type JobName, type PeriodicJobPayload, type RecordChangedPayload } from '@fms/core';

let queue: Queue | null = null;
let log: FastifyBaseLogger | undefined;

export function initQueue(redisUrl: string, logger: FastifyBaseLogger) {
  log = logger;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: false });
  connection.on('error', (e) => logger.warn({ err: e.message }, 'redis connection error'));
  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 },
  });
  return queue;
}

export async function closeQueue() {
  await queue?.close();
}

/**
 * Best-effort publish. The worker's periodic sweep catches anything missed, so a
 * Redis outage degrades notification latency but never blocks or fails writes.
 */
async function add(name: JobName, data: object, jobId?: string) {
  if (!queue) return;
  try {
    await Promise.race([
      queue.add(name, data, jobId ? { jobId } : undefined),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queue timeout')), 2_000)),
    ]);
  } catch (e) {
    log?.warn({ err: (e as Error).message, job: name }, 'failed to enqueue job');
  }
}

export async function publishRecordChanged(recordIds: string[]) {
  await Promise.all(recordIds.map((recordId) => add(JOBS.recordChanged, { recordId } satisfies RecordChangedPayload)));
}

/** orgId pins the run to one organization; omit it (super admin only) for a platform-wide run. */
export async function enqueueManualJob(name: JobName, requestedBy: string, orgId?: string) {
  await add(name, { manual: true, requestedBy, ...(orgId ? { orgId } : {}) } satisfies PeriodicJobPayload);
}
