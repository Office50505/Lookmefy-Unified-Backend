import BlockedIp from '../models/BlockedIp.js';
import { createHash } from 'node:crypto';
import { createBlockedIp } from './ipBlocklist.js';
import { getRedisClient, keyPrefix, sharedStateUnavailableError, withTimeout } from './cache.js';
import { emitStructuredLog } from './logging.js';
import { requestPath } from './logSanitization.js';
import { clientIp } from './rateLimit.js';

const violationBuckets = new Map();

const SCANNER_PATH_PATTERNS = [
  /\/\.env(?:$|[/?#])/i,
  /\/wp-admin(?:$|[/?#])/i,
  /\/wp-login\.php(?:$|[/?#])/i,
  /\/phpmyadmin(?:$|[/?#])/i,
  /\/vendor\/phpunit/i,
  /\/server-status(?:$|[/?#])/i,
  /\/actuator(?:$|[/?#])/i
];

const SUSPICIOUS_USER_AGENT_PATTERNS = [
  /\bsqlmap\b/i,
  /\bnmap\b/i,
  /\bnikto\b/i,
  /\bmasscan\b/i,
  /\bdirbuster\b/i,
  /\bgobuster\b/i,
  /\bacunetix\b/i
];

function securityFiltersEnabled(env = process.env) {
  const raw = String(env.SECURITY_FILTERS_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function autoBlockEnabled(env = process.env) {
  const raw = String(env.SECURITY_AUTO_BLOCK_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function suspiciousRequest(req = {}) {
  const rawUrl = String(req.originalUrl || req.url || req.path || '');
  let decodedUrl = rawUrl;
  try {
    decodedUrl = decodeURIComponent(rawUrl.replace(/\+/g, '%20'));
  } catch {
    decodedUrl = rawUrl;
  }
  const userAgent = String(req.get?.('user-agent') || '');
  if (/(?:^|\/)\.\.(?:\/|$)|%2e%2e/i.test(rawUrl)) return { code: 'PATH_TRAVERSAL', reason: 'Path traversal pattern' };
  if (SCANNER_PATH_PATTERNS.some((pattern) => pattern.test(rawUrl) || pattern.test(decodedUrl))) {
    return { code: 'SCANNER_PATH', reason: 'Known scanner path' };
  }
  if (SUSPICIOUS_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return { code: 'SUSPICIOUS_USER_AGENT', reason: 'Known security scanner user agent' };
  }
  return null;
}

async function recordViolation(ip, violation, { env = process.env, redisClientProvider = getRedisClient } = {}) {
  const windowMs = Math.max(10_000, Number(env.SECURITY_AUTO_BLOCK_WINDOW_MS || 5 * 60_000));
  const threshold = Math.max(2, Number(env.SECURITY_AUTO_BLOCK_THRESHOLD || 8));
  const now = Date.now();
  let count;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    const redis = await redisClientProvider();
    if (!redis) throw sharedStateUnavailableError();
    const hashedIp = createHash('sha256').update(String(ip)).digest('hex').slice(0, 40);
    const key = `${keyPrefix()}:security:violations:${hashedIp}`;
    // The increment and expiry are one operation, including on a new key.
    const script = 'local n = redis.call("INCR", KEYS[1]); if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]); end; return n';
    try {
      count = Number(await withTimeout(redis.eval(script, { keys: [key], arguments: [String(windowMs)] })));
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid shared violation count');
    } catch (error) {
      throw sharedStateUnavailableError();
    }
  } else {
    const current = violationBuckets.get(ip);
    const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    violationBuckets.set(ip, bucket);
    count = bucket.count;
  }
  return {
    count,
    threshold,
    shouldAutoBlock: autoBlockEnabled(env) && count >= threshold,
    expiresAt: new Date(now + Math.max(60_000, Number(env.SECURITY_AUTO_BLOCK_TTL_MS || 60 * 60_000))),
    violation
  };
}

function securityFilterMiddleware() {
  return async function securityFilter(req, res, next) {
    if (!securityFiltersEnabled()) return next();
    const violation = suspiciousRequest(req);
    if (!violation) return next();
    const ip = clientIp(req);
    let result;
    try {
      result = await recordViolation(ip, violation);
    } catch (error) {
      emitStructuredLog({ level: 'warn', event: 'security_counter_unavailable', message: error.message });
      return res.status(503).json({ code: 'SHARED_STATE_UNAVAILABLE', message: 'Security checks are temporarily unavailable.' });
    }
    emitStructuredLog({
      level: 'warn',
      event: 'security_request_blocked',
      requestId: req.requestId,
      ip,
      method: req.method,
      path: requestPath(req),
      code: violation.code,
      reason: violation.reason,
      count: result.count,
      threshold: result.threshold
    });
    if (result.shouldAutoBlock) {
      try {
        if (BlockedIp.db?.readyState !== 1) throw sharedStateUnavailableError();
        await createBlockedIp({
          value: ip,
          reason: `Automatic block after repeated ${violation.code} violations`,
          source: 'auto',
          expiresAt: result.expiresAt
        });
      } catch (error) {
        emitStructuredLog({ level: 'warn', event: 'security_auto_block_failed', message: error.message });
        return res.status(503).json({ code: 'SHARED_STATE_UNAVAILABLE', message: 'Security checks are temporarily unavailable.' });
      }
    }
    return res.status(403).json({ code: violation.code, message: 'Request blocked.' });
  };
}

export {
  recordViolation,
  securityFilterMiddleware,
  suspiciousRequest
};
