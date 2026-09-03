import { serviceMetadata } from './runtime.js';

let Queue;
let QueueEvents;
let Worker;

try {
  ({ Queue, QueueEvents, Worker } = await import('bullmq'));
} catch (error) {
  console.warn('[jobs] bullmq unavailable; queue features disabled', { error: error.message });
}

const queues = new Map();
const queueEvents = new Map();

function enabled() {
  const raw = String(process.env.QUEUE_ENABLED ?? 'true').toLowerCase();
  return Boolean(Queue && QueueEvents && Worker) && ['1', 'true', 'yes', 'on'].includes(raw) && Boolean(process.env.REDIS_URL);
}

function redisConnection() {
  if (!process.env.REDIS_URL) return null;
  const url = new URL(process.env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null
  };
}

function queuePrefix() {
  return process.env.QUEUE_PREFIX || process.env.REDIS_KEY_PREFIX || 'fitlook';
}

function safeJobId(...parts) {
  return parts
    .flat()
    .map((part) => String(part ?? '')
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120))
    .filter(Boolean)
    .join('-') || `job-${Date.now()}`;
}

function getQueue(name) {
  if (!enabled()) return null;
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, {
      connection: redisConnection(),
      prefix: queuePrefix(),
      defaultJobOptions: {
        attempts: Number(process.env.QUEUE_JOB_ATTEMPTS || 3),
        backoff: {
          type: 'exponential',
          delay: Number(process.env.QUEUE_JOB_BACKOFF_MS || 5000)
        },
        removeOnComplete: {
          age: Number(process.env.QUEUE_REMOVE_COMPLETE_SECONDS || 86400),
          count: Number(process.env.QUEUE_REMOVE_COMPLETE_COUNT || 1000)
        },
        removeOnFail: {
          age: Number(process.env.QUEUE_REMOVE_FAIL_SECONDS || 7 * 86400),
          count: Number(process.env.QUEUE_REMOVE_FAIL_COUNT || 1000)
        }
      }
    }));
  }
  return queues.get(name);
}

function getQueueEvents(name) {
  if (!enabled()) return null;
  if (!queueEvents.has(name)) {
    queueEvents.set(name, new QueueEvents(name, {
      connection: redisConnection(),
      prefix: queuePrefix()
    }));
  }
  return queueEvents.get(name);
}

async function enqueueJob(queueName, jobName, data = {}, options = {}) {
  const queue = getQueue(queueName);
  if (!queue) return null;
  return queue.add(jobName, data, options);
}

async function enqueueJobAndWait(queueName, jobName, data = {}, options = {}) {
  const queue = getQueue(queueName);
  const events = getQueueEvents(queueName);
  if (!queue || !events) return null;
  await events.waitUntilReady();
  const job = await queue.add(jobName, data, options);
  const timeoutMs = Number(options.waitTimeoutMs || process.env.QUEUE_WAIT_TIMEOUT_MS || 120_000);
  const result = await job.waitUntilFinished(events, timeoutMs);
  return { job, result };
}

async function getJobStatus(queueName, jobId) {
  const queue = getQueue(queueName);
  if (!queue || !jobId) return null;
  const job = await queue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    id: job.id,
    queue: queueName,
    name: job.name,
    state,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    data: job.data,
    result: job.returnvalue || null,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
  };
}

function startWorker(queueName, processor, options = {}) {
  if (!enabled()) return null;
  const worker = new Worker(queueName, processor, {
    connection: redisConnection(),
    prefix: queuePrefix(),
    concurrency: Number(options.concurrency || process.env.QUEUE_WORKER_CONCURRENCY || 2)
  });
  worker.on('completed', (job) => {
    console.log(JSON.stringify({
      level: 'info',
      event: 'job_completed',
      ...serviceMetadata('worker'),
      queue: queueName,
      jobName: job.name,
      jobId: job.id
    }));
  });
  worker.on('failed', (job, error) => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'job_failed',
      ...serviceMetadata('worker'),
      queue: queueName,
      jobName: job?.name,
      jobId: job?.id,
      error: error?.message || String(error)
    }));
  });
  return worker;
}

async function closeJobQueues() {
  const closers = [
    ...[...queueEvents.values()].map((events) => events.close()),
    ...[...queues.values()].map((queue) => queue.close())
  ];
  queueEvents.clear();
  queues.clear();
  await Promise.allSettled(closers);
}

export { closeJobQueues, enabled as queueEnabled, enqueueJob, enqueueJobAndWait, getJobStatus, getQueue, getQueueEvents, safeJobId, startWorker };
