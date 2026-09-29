import mongoose from 'mongoose';
import { getRedisClient, sharedStateRequiresRedis, withTimeout } from './cache.js';
import { queueEnabled } from './jobQueue.js';
import { appRole, serviceMetadata } from './runtime.js';
import { isProductionEnv } from './urlValidation.js';

const READY = 'ready';
const UNAVAILABLE = 'unavailable';
const SKIPPED = 'skipped';
const NOT_CHECKED = 'not_checked';

function readinessTimeoutMs(env = process.env) {
  const value = Number(env.READINESS_CHECK_TIMEOUT_MS || 750);
  return Number.isFinite(value) && value > 0 ? Math.max(100, value) : 750;
}

function bounded(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} readiness check timed out`)), timeoutMs);
      timeout.unref?.();
    })
  ]).finally(() => clearTimeout(timeout));
}

function queueRequiredForRole(role, env = process.env) {
  if (isProductionEnv(env)) return ['api', 'all', 'worker', 'scheduler'].includes(String(role || '').toLowerCase());
  return ['1', 'true', 'yes', 'on'].includes(String(env.READINESS_REQUIRE_QUEUE || '').trim().toLowerCase());
}

async function checkMongo({ mongooseInstance = mongoose, timeoutMs = readinessTimeoutMs() } = {}) {
  if (mongooseInstance?.connection?.readyState !== 1) return UNAVAILABLE;
  try {
    const admin = mongooseInstance.connection.db?.admin?.();
    const ping = admin?.ping?.();
    if (!ping) return READY;
    await bounded(Promise.resolve(ping), timeoutMs, 'MongoDB');
    return READY;
  } catch {
    return UNAVAILABLE;
  }
}

async function checkRedis({
  env = process.env,
  getRedis = getRedisClient,
  timeoutMs = readinessTimeoutMs(env),
  requireRedis = sharedStateRequiresRedis(env)
} = {}) {
  if (!requireRedis) return SKIPPED;
  if (!String(env.REDIS_URL || '').trim()) return UNAVAILABLE;
  try {
    const redis = await bounded(Promise.resolve(getRedis()), timeoutMs, 'Redis connect');
    if (!redis) return UNAVAILABLE;
    if (typeof redis.ping === 'function') {
      await withTimeout(Promise.resolve(redis.ping()), timeoutMs);
    }
    return READY;
  } catch {
    return UNAVAILABLE;
  }
}

async function checkQueue({
  env = process.env,
  role = appRole('api'),
  queueIsEnabled = queueEnabled,
  redisStatus = READY
} = {}) {
  const required = queueRequiredForRole(role, env);
  if (!required) return SKIPPED;
  if (redisStatus !== READY) return UNAVAILABLE;
  return queueIsEnabled() ? READY : UNAVAILABLE;
}

async function dependencyReadiness({
  env = process.env,
  role = appRole('api'),
  shuttingDown = false,
  mongooseInstance = mongoose,
  getRedis = getRedisClient,
  queueIsEnabled = queueEnabled,
  metadata = serviceMetadata(role),
  timeoutMs = readinessTimeoutMs(env)
} = {}) {
  const isShuttingDown = typeof shuttingDown === 'function' ? Boolean(shuttingDown()) : Boolean(shuttingDown);
  const mongo = await checkMongo({ mongooseInstance, timeoutMs });
  const redis = await checkRedis({
    env,
    getRedis,
    timeoutMs,
    requireRedis: sharedStateRequiresRedis(env)
  });
  const queue = await checkQueue({ env, role, queueIsEnabled, redisStatus: redis });
  const checks = {
    mongo,
    redis,
    queue,
    storage: NOT_CHECKED
  };
  const ok = !isShuttingDown && [mongo, redis, queue].every((value) => value === READY || value === SKIPPED);
  return {
    httpStatus: ok ? 200 : 503,
    body: {
      ok,
      status: ok ? 'ready' : 'not_ready',
      checks,
      shuttingDown: isShuttingDown,
      role,
      ...metadata
    }
  };
}

function createReadinessHandler(options = {}) {
  return async function readinessHandler(_req, res) {
    try {
      const result = await dependencyReadiness(options);
      return res.status(result.httpStatus).json(result.body);
    } catch {
      return res.status(503).json({
        ok: false,
        status: 'not_ready',
        checks: {
          mongo: UNAVAILABLE,
          redis: UNAVAILABLE,
          queue: UNAVAILABLE,
          storage: NOT_CHECKED
        }
      });
    }
  };
}

export {
  NOT_CHECKED,
  READY,
  SKIPPED,
  UNAVAILABLE,
  checkMongo,
  checkQueue,
  checkRedis,
  createReadinessHandler,
  dependencyReadiness,
  queueRequiredForRole,
  readinessTimeoutMs
};
