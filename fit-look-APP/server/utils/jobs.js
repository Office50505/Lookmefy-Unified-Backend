import { randomUUID } from 'node:crypto';
import Job from '../models/Job.js';
import { logger } from './logger.js';

const handlers = new Map();
let workerTimer = null;
let workerRunning = false;
let workerId = '';

function envFlag(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function asyncJobsEnabled() {
  return envFlag(process.env.ASYNC_JOBS_ENABLED, true);
}

function jobWorkerEnabled() {
  return envFlag(process.env.JOB_WORKER_ENABLED, true);
}

function jobResultTtlMs() {
  const value = Number(process.env.JOB_RESULT_TTL_MS || 24 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60 * 1000;
}

function staleLockMs() {
  const value = Number(process.env.JOB_STALE_LOCK_MS || 10 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
}

function retryBackoffMs(attempt) {
  const base = Number(process.env.JOB_RETRY_BACKOFF_MS || 5000);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 5000;
  return Math.min(5 * 60 * 1000, safeBase * Math.max(1, attempt));
}

function jobToClient(job) {
  const source = job?.toObject ? job.toObject() : job;
  if (!source) return null;
  return {
    id: source._id?.toString?.() || source.id,
    type: source.type,
    status: source.status,
    attempts: source.attempts || 0,
    error: source.error?.message || '',
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    finishedAt: source.finishedAt || null
  };
}

function registerJobHandler(type, handler) {
  if (!type || typeof handler !== 'function') throw new Error('Job handler type and function are required');
  handlers.set(type, handler);
}

async function enqueueJob({ type, userId, payload = {}, key = '', maxAttempts = 2, priority = 0, runAfter = new Date() }) {
  const dedupeKey = key ? String(key).slice(0, 240) : '';
  if (dedupeKey) {
    const existing = await Job.findOne({
      type,
      key: dedupeKey,
      user: userId,
      status: { $in: ['queued', 'running'] }
    }).sort({ createdAt: -1 });
    if (existing) return existing;
  }

  return Job.create({
    type,
    user: userId,
    key: dedupeKey,
    payload,
    maxAttempts,
    priority,
    runAfter
  });
}

function queuedResponse(res, job, statusCode = 202) {
  return res.status(statusCode).json({
    queued: true,
    jobId: job._id.toString(),
    statusUrl: `/api/jobs/${job._id.toString()}`,
    job: jobToClient(job)
  });
}

async function claimNextJob() {
  const now = new Date();
  const staleBefore = new Date(Date.now() - staleLockMs());
  const types = [...handlers.keys()];
  if (!types.length) return null;
  return Job.findOneAndUpdate(
    {
      type: { $in: types },
      $or: [
        { status: 'queued', runAfter: { $lte: now } },
        { status: 'running', lockedAt: { $lte: staleBefore }, $expr: { $lt: ['$attempts', '$maxAttempts'] } }
      ]
    },
    {
      $set: {
        status: 'running',
        lockedAt: now,
        lockedBy: workerId,
        startedAt: now
      },
      $inc: { attempts: 1 }
    },
    { new: true, sort: { priority: -1, runAfter: 1, createdAt: 1 } }
  );
}

async function completeJob(job, result) {
  return Job.findByIdAndUpdate(job._id, {
    $set: {
      status: 'succeeded',
      result,
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + jobResultTtlMs())
    },
    $unset: { lockedAt: '', lockedBy: '', error: '' }
  });
}

async function failJob(job, error) {
  const message = error?.message || String(error || 'Job failed');
  const canRetry = job.attempts < job.maxAttempts;
  const update = canRetry
    ? {
        $set: {
          status: 'queued',
          runAfter: new Date(Date.now() + retryBackoffMs(job.attempts)),
          error: { message, code: error?.code || error?.name || '' }
        },
        $unset: { lockedAt: '', lockedBy: '' }
      }
    : {
        $set: {
          status: 'failed',
          error: {
            message,
            code: error?.code || error?.name || '',
            stack: process.env.NODE_ENV === 'production' ? '' : error?.stack || ''
          },
          finishedAt: new Date(),
          expiresAt: new Date(Date.now() + jobResultTtlMs())
        },
        $unset: { lockedAt: '', lockedBy: '' }
      };
  return Job.findByIdAndUpdate(job._id, update);
}

async function runClaimedJob(job) {
  const handler = handlers.get(job.type);
  if (!handler) {
    await failJob(job, new Error(`No job handler registered for ${job.type}`));
    return;
  }

  logger.info('job_started', {
    jobId: job._id.toString(),
    type: job.type,
    attempt: job.attempts,
    userId: job.user?.toString?.()
  });

  try {
    const result = await handler({ payload: job.payload || {}, job });
    await completeJob(job, result);
    logger.info('job_succeeded', {
      jobId: job._id.toString(),
      type: job.type,
      attempt: job.attempts,
      userId: job.user?.toString?.()
    });
  } catch (error) {
    await failJob(job, error);
    logger.error('job_failed', {
      jobId: job._id.toString(),
      type: job.type,
      attempt: job.attempts,
      userId: job.user?.toString?.(),
      error
    });
  }
}

async function workOnce() {
  if (workerRunning || !jobWorkerEnabled()) return;
  workerRunning = true;
  try {
    const concurrency = Math.max(1, Number(process.env.JOB_WORKER_CONCURRENCY || 2));
    const jobs = [];
    for (let index = 0; index < concurrency; index += 1) {
      const job = await claimNextJob();
      if (!job) break;
      jobs.push(job);
    }
    await Promise.all(jobs.map(runClaimedJob));
  } finally {
    workerRunning = false;
  }
}

function startJobWorker() {
  if (workerTimer || !jobWorkerEnabled()) return;
  workerId = `${process.pid}:${randomUUID()}`;
  const intervalMs = Math.max(500, Number(process.env.JOB_WORKER_POLL_MS || 1500));
  workerTimer = setInterval(() => {
    workOnce().catch((error) => logger.error('job_worker_tick_failed', { error }));
  }, intervalMs);
  workerTimer.unref?.();
  workOnce().catch((error) => logger.error('job_worker_boot_failed', { error }));
  logger.info('job_worker_started', { workerId, intervalMs });
}

async function inlineOrQueue({ req, res, type, key, payload, maxAttempts, priority, runInline }) {
  if (!asyncJobsEnabled() || req.headers['x-fitlook-sync'] === '1') {
    const result = await runInline();
    return res.status(result?.statusCode || 200).json(result?.body ?? result);
  }
  const job = await enqueueJob({
    type,
    userId: req.user?._id,
    payload,
    key,
    maxAttempts,
    priority
  });
  return queuedResponse(res, job);
}

function jobQueueHealth() {
  return {
    asyncJobsEnabled: asyncJobsEnabled(),
    workerEnabled: jobWorkerEnabled(),
    workerRunning,
    handlerCount: handlers.size
  };
}

export {
  asyncJobsEnabled,
  enqueueJob,
  inlineOrQueue,
  jobQueueHealth,
  jobToClient,
  registerJobHandler,
  startJobWorker
};
