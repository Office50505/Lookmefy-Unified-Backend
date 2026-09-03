import { createHash } from 'node:crypto';
import { getRedisClient, keyPrefix, ttlSeconds, withTimeout } from './cache.js';
import { requestPath } from './logSanitization.js';
import { normalizeIndianMobile } from './phone.js';

const localBuckets = new Map();
let lastWarningAt = 0;

function warnOnce(message) {
  const now = Date.now();
  if (now - lastWarningAt < 30_000) return;
  lastWarningAt = now;
  console.warn(`[rate-limit] ${message}`);
}

function hashIdentifier(value) {
  return createHash('sha256').update(String(value || 'anonymous')).digest('hex').slice(0, 40);
}

function clientIp(req) {
  return String(req.ip || req.get('x-forwarded-for')?.split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();
}

function userId(req) {
  return req.user?._id?.toString?.() || req.admin?.email || '';
}

function normalizedBodyPhone(req) {
  return normalizeIndianMobile(req.body?.phone);
}

function bodyIdentifier(req) {
  return String(req.body?.email || req.body?.username || req.body?.identifier || '').trim().toLowerCase();
}

function otpSession(req) {
  return String(req.body?.otpSession || '').trim();
}

function localHit(key, windowMs) {
  const now = Date.now();
  const existing = localBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    localBuckets.set(key, { count: 1, resetAt });
    return { count: 1, resetAt };
  }
  existing.count += 1;
  return existing;
}

async function redisHit(key, windowMs) {
  const redis = await getRedisClient();
  if (!redis) return null;
  const count = await withTimeout(redis.incr(key));
  if (count === 1) await withTimeout(redis.expire(key, ttlSeconds(windowMs)));
  const ttl = await withTimeout(redis.ttl(key)).catch(() => ttlSeconds(windowMs));
  return {
    count,
    resetAt: Date.now() + Math.max(1, ttl) * 1000
  };
}

function defaultMessage(retryAfterSeconds) {
  return `Too many requests. Please try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute${retryAfterSeconds > 60 ? 's' : ''}.`;
}

function developmentRateLimitBypass(flagName, env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(env[flagName] || '').toLowerCase());
}

function setHeaders(res, { limit, remaining, resetAt, retryAfterSeconds }) {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
  if (retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(retryAfterSeconds));
}

function createRateLimiter(options = {}) {
  const {
    name = 'default',
    windowMs = 60_000,
    max = 60,
    keyGenerator = (req) => `ip:${clientIp(req)}`,
    message,
    skip
  } = options;

  return async function rateLimitMiddleware(req, res, next) {
    try {
      if (skip?.(req)) return next();
      const identity = keyGenerator(req) || `ip:${clientIp(req)}`;
      const redisKey = `${keyPrefix()}:rl:${name}:${hashIdentifier(identity)}`;
      const bucket = await redisHit(redisKey, windowMs) || localHit(redisKey, windowMs);
      const remaining = max - bucket.count;
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));

      setHeaders(res, {
        limit: max,
        remaining,
        resetAt: bucket.resetAt,
        retryAfterSeconds: bucket.count > max ? retryAfterSeconds : undefined
      });

      if (bucket.count <= max) return next();

      console.warn(JSON.stringify({
        level: 'warn',
        event: 'rate_limited',
        name,
        method: req.method,
        path: requestPath(req),
        userId: userId(req) || undefined,
        ip: clientIp(req),
        retryAfterSeconds
      }));

      return res.status(429).json({
        code: 'RATE_LIMITED',
        message: typeof message === 'function' ? message({ retryAfterSeconds, req }) : message || defaultMessage(retryAfterSeconds),
        retryAfterSeconds
      });
    } catch (error) {
      warnOnce(error.message || `${name} unavailable`);
      return next();
    }
  };
}

const rateLimitKeys = {
  clientIp: (req) => `ip:${clientIp(req)}`,
  user: (req) => `user:${userId(req) || clientIp(req)}`,
  userOrIp: (req) => `user-or-ip:${userId(req) || clientIp(req)}`,
  bodyPhone: (req) => `phone:${normalizedBodyPhone(req) || clientIp(req)}`,
  bodyIdentifier: (req) => `identifier:${bodyIdentifier(req) || normalizedBodyPhone(req) || clientIp(req)}`,
  otpSession: (req) => `otp-session:${otpSession(req) || normalizedBodyPhone(req) || clientIp(req)}`
};

export { clientIp, createRateLimiter, developmentRateLimitBypass, rateLimitKeys };
