import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { runProfileFullBodyJob } from '../server/routes/auth.js';
import { runProductRecategorizationJob } from '../server/routes/products.js';
import { runProductTryOnJob } from '../server/routes/tryons.js';
import { closeRedisClient } from '../server/utils/cache.js';
import { closeJobQueues, queueEnabled, startWorker } from '../server/utils/jobQueue.js';
import { appRole, mongoConnectOptions, serviceMetadata } from '../server/utils/runtime.js';

dotenv.config();

if (!['worker', 'scheduler', 'all'].includes(appRole('worker'))) {
  throw new Error(`APP_ROLE=${appRole('worker')} cannot start the worker`);
}

const service = serviceMetadata('worker');
let shuttingDown = false;

async function connectMongo() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI, mongoConnectOptions());
}

async function main() {
  if (!queueEnabled()) {
    throw new Error('Queue is disabled or REDIS_URL is missing');
  }
  await connectMongo();

  const workers = [
    startWorker('profile', async (job) => {
      if (job.name !== 'full-body') throw new Error(`Unknown profile job: ${job.name}`);
      return runProfileFullBodyJob(job.data);
    }, { concurrency: Number(process.env.PROFILE_WORKER_CONCURRENCY || 1) }),

    startWorker('maintenance', async (job) => {
      if (job.name !== 'product-recategorize') throw new Error(`Unknown maintenance job: ${job.name}`);
      return runProductRecategorizationJob(job.data);
    }, { concurrency: Number(process.env.MAINTENANCE_WORKER_CONCURRENCY || 1) }),

    startWorker('tryon', async (job) => {
      if (job.name !== 'product-generate') throw new Error(`Unknown try-on job: ${job.name}`);
      return runProductTryOnJob(job.data);
    }, { concurrency: Number(process.env.TRYON_WORKER_CONCURRENCY || 1) })
  ].filter(Boolean);

  console.log(JSON.stringify({
    level: 'info',
    event: 'worker_started',
    ...service,
    queues: workers.map((worker) => worker.name)
  }));

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'worker_shutdown_started', signal, ...service }));
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', event: 'worker_shutdown_timeout', signal, ...service }));
      process.exit(1);
    }, Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 25_000));
    timeout.unref?.();

    try {
      await Promise.all(workers.map((worker) => worker.close()));
      await closeJobQueues();
      await closeRedisClient();
      await mongoose.disconnect();
      clearTimeout(timeout);
      console.log(JSON.stringify({ level: 'info', event: 'worker_shutdown_complete', signal, ...service }));
      process.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      console.error(JSON.stringify({ level: 'error', event: 'worker_shutdown_failed', signal, error: error.message, ...service }));
      process.exit(1);
    }
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: 'error',
    event: 'worker_failed',
    ...service,
    error: error.message
  }));
  process.exit(1);
});
