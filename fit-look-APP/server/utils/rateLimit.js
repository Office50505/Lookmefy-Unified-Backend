import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getRedisClient, keyPrefix, ttlSeconds, withTimeout } from './cache.js';
import { envFlag } from './devMode.js';

const localWindows = new Map();
const localLocks = new Map();

function hashKey(value = '') {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown-ip';
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function tokenUserId(req) {
  if (req.user?._id) return req.user._id.toString();
  const token = bearerToken(req);
  if (!token || !process.env.JWT_SECRET) return '';
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.sub ? String(decoded.sub) : '';
  } catch {
    return '';
  }
}

function principal(req) {
  const userId = tokenUserId(req);
  return userId ? `user:${userId}` : `ip:${clientIp(req)}`;
}

function phonePrincipal(req) {
  const digits = String(req.body?.phone || req.body?.mobile || req.body?.mobileNumber || req.body?.email || req.body?.username || '').replace(/\D/g, '');
  const phone = digits.length >= 10 ? digits.slice(-12) : '';
  return phone ? `phone:${phone}` : `ip:${clientIp(req)}`;
}

function localRateLimit(key, windowMs, max) {
  const now = Date.now();
  const current = localWindows.get(key);
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    localWindows.set(key, next);
    return { allowed: true, remaining: Math.max(0, max - 1), resetMs: windowMs };
  }
  current.count += 1;
  return {
    allowed: current.count <= max,
    remaining: Math.max(0, max - current.count),
    resetMs: Math.max(0, current.resetAt - now)
  };
}

async function redisRateLimit(key, windowMs, max) {
  const redis = await getRedisClient();
  if (!redis) return null;
  const count = await withTimeout(redis.incr(key));
  if (count === 1) await withTimeout(redis.expire(key, ttlSeconds(windowMs)));
  const ttl = await withTimeout(redis.ttl(key)).catch(() => ttlSeconds(windowMs));
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetMs: Math.max(0, ttl * 1000)
  };
}

function limitValue(value, req) {
  return typeof value === 'function' ? value(req) : value;
}

function retrySeconds(resetMs) {
  return Math.max(1, Math.ceil((Number(resetMs) || 1000) / 1000));
}

function hasEnvValue(name) {
  return String(process.env[name] ?? '').trim() !== '';
}

function rateLimitsEnabled() {
  if (hasEnvValue('RATE_LIMIT_ENABLED')) return envFlag(process.env.RATE_LIMIT_ENABLED, true);
  return !envFlag(process.env.RATE_LIMIT_DISABLED, false);
}

function createRateLimiter(options = {}) {
  const name = options.name || 'default';
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 60;
  const keyGenerator = options.keyGenerator || principal;
  const message = options.message || 'Too many requests. Please try again soon.';
  const failClosed = Boolean(options.failClosed);

  return async function rateLimiter(req, res, next) {
    if (!rateLimitsEnabled()) return next();
    if (options.skip?.(req)) return next();

    const resolvedMax = Math.max(1, Number(limitValue(max, req)) || 1);
    const rawKey = keyGenerator(req);
    const key = `${keyPrefix()}:rate:${name}:${hashKey(rawKey)}`;
    let result = null;

    try {
      result = await redisRateLimit(key, windowMs, resolvedMax);
    } catch {
      result = null;
    }

    if (!result && failClosed && process.env.NODE_ENV === 'production' && process.env.REDIS_URL) {
      return res.status(503).json({ message: 'Rate limiter is temporarily unavailable. Please try again shortly.' });
    }

    result ||= localRateLimit(key, windowMs, resolvedMax);
    res.setHeader('RateLimit-Limit', String(resolvedMax));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(retrySeconds(result.resetMs)));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(retrySeconds(result.resetMs)));
      return res.status(429).json({ message });
    }

    return next();
  };
}

async function acquireRedisLock(key, ttlMs) {
  const redis = await getRedisClient();
  if (!redis) return null;
  const result = await withTimeout(redis.set(key, '1', { NX: true, PX: ttlMs }));
  return result === 'OK';
}

async function releaseRedisLock(key) {
  const redis = await getRedisClient();
  if (!redis) return false;
  await withTimeout(redis.del(key));
  return true;
}

function acquireLocalLock(key, ttlMs) {
  const now = Date.now();
  const current = localLocks.get(key);
  if (current && current > now) return false;
  localLocks.set(key, now + ttlMs);
  return true;
}

function releaseLocalLock(key) {
  localLocks.delete(key);
}

function createConcurrencyLimiter(options = {}) {
  const name = options.name || 'active';
  const ttlMs = options.ttlMs || 5 * 60_000;
  const keyGenerator = options.keyGenerator || principal;
  const message = options.message || 'A request is already running. Please wait for it to finish.';
  const failClosed = Boolean(options.failClosed);

  return async function concurrencyLimiter(req, res, next) {
    if (!rateLimitsEnabled()) return next();
    if (options.skip?.(req)) return next();

    const key = `${keyPrefix()}:lock:${name}:${hashKey(keyGenerator(req))}`;
    let acquired = false;
    let redisAcquired = false;
    let redisResult = null;

    try {
      redisResult = await acquireRedisLock(key, ttlMs);
      if (redisResult !== null) {
        acquired = redisResult;
        redisAcquired = redisResult;
      }
    } catch {
      acquired = false;
    }

    if (!acquired && failClosed && process.env.NODE_ENV === 'production' && process.env.REDIS_URL) {
      return res.status(503).json({ message: 'Concurrency guard is temporarily unavailable. Please try again shortly.' });
    }

    if (!acquired && redisResult === false) return res.status(429).json({ message });
    if (!acquired) acquired = acquireLocalLock(key, ttlMs);
    if (!acquired) return res.status(429).json({ message });

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      res.off('finish', release);
      res.off('close', release);
      try {
        if (redisAcquired) await releaseRedisLock(key);
        else releaseLocalLock(key);
      } catch {
        releaseLocalLock(key);
      }
    };
    res.on('finish', release);
    res.on('close', release);
    return next();
  };
}

const rateLimitKeys = { clientIp, phonePrincipal, principal, tokenUserId };

export { createConcurrencyLimiter, createRateLimiter, rateLimitKeys, rateLimitsEnabled };
