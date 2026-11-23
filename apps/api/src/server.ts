import { prisma } from '@fms/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeQueue, initQueue } from './lib/queue.js';

const config = loadConfig();
const app = await buildApp(config);
initQueue(config.REDIS_URL, app.log);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeQueue();
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
