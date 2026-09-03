import express from 'express';
import { requireUser } from './auth.js';
import { getJobStatus } from '../utils/jobQueue.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';

const router = express.Router();
const allowedQueues = new Set(['tryon', 'profile']);
const jobStatusLimiter = createRateLimiter({
  name: 'jobs:status',
  windowMs: 5 * 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKeys.user,
  message: 'Job status checks are temporarily limited. Please wait a moment before checking again.'
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function jobStateToMobileStatus(state = '') {
  const normalized = String(state || '').trim().toLowerCase();
  if (normalized === 'completed') return 'succeeded';
  if (normalized === 'failed') return 'failed';
  if (['active', 'waiting', 'waiting-children', 'prioritized', 'delayed'].includes(normalized)) return 'processing';
  return normalized || 'processing';
}

function jobToMobilePayload(job) {
  const status = jobStateToMobileStatus(job?.state);
  const attempts = Number(job?.attemptsMade ?? job?.attempts ?? 0) || 0;
  const updatedAt = job?.finishedAt || job?.processedAt || job?.createdAt || null;
  const type = job?.type || job?.name || job?.queue || '';
  return {
    job: {
      id: job.id,
      type,
      queue: job.queue,
      name: job.name,
      status,
      state: job.state,
      progress: job.progress,
      attempts,
      attemptsMade: job.attemptsMade,
      error: job.failedReason || '',
      failedReason: job.failedReason,
      createdAt: job.createdAt,
      updatedAt,
      processedAt: job.processedAt,
      finishedAt: job.finishedAt
    },
    statusUrl: job.id ? `/api/jobs/${encodeURIComponent(job.id)}` : '',
    statusPath: job.id ? `/jobs/${encodeURIComponent(job.id)}` : '',
    result: status === 'succeeded' ? job.result : undefined
  };
}

async function loadOwnedJob({ queueName, jobId, userId }) {
  if (!allowedQueues.has(queueName) || !jobId) return null;
  const job = await getJobStatus(queueName, jobId);
  if (!job) return null;
  const ownerId = String(job.data?.userId || '');
  if (!ownerId || ownerId !== String(userId)) return null;
  return job;
}

router.get('/:jobId', requireUser, jobStatusLimiter, asyncRoute(async (req, res) => {
  const jobId = String(req.params.jobId || '').trim();
  for (const queueName of allowedQueues) {
    const job = await loadOwnedJob({ queueName, jobId, userId: req.user._id });
    if (job) return res.json(jobToMobilePayload(job));
  }
  return res.status(404).json({ message: 'Job not found' });
}));

router.get('/:queueName/:jobId', requireUser, jobStatusLimiter, asyncRoute(async (req, res) => {
  const queueName = String(req.params.queueName || '').trim();
  const jobId = String(req.params.jobId || '').trim();
  const job = await loadOwnedJob({ queueName, jobId, userId: req.user._id });
  if (!job) return res.status(404).json({ message: 'Job not found' });

  const payload = jobToMobilePayload(job);
  res.json({
    ...payload,
    job: {
      ...payload.job,
      result: job.result
    }
  });
}));

export default router;
export { jobStateToMobileStatus, jobToMobilePayload, loadOwnedJob };
