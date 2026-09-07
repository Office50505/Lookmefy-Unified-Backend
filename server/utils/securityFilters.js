import BlockedIp from '../models/BlockedIp.js';
import { createBlockedIp } from './ipBlocklist.js';
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

function recordViolation(ip, violation) {
  const windowMs = Math.max(10_000, Number(process.env.SECURITY_AUTO_BLOCK_WINDOW_MS || 5 * 60_000));
  const threshold = Math.max(2, Number(process.env.SECURITY_AUTO_BLOCK_THRESHOLD || 8));
  const now = Date.now();
  const current = violationBuckets.get(ip);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  violationBuckets.set(ip, bucket);
  return {
    count: bucket.count,
    threshold,
    shouldAutoBlock: autoBlockEnabled() && bucket.count >= threshold,
    expiresAt: new Date(now + Math.max(60_000, Number(process.env.SECURITY_AUTO_BLOCK_TTL_MS || 60 * 60_000))),
    violation
  };
}

function securityFilterMiddleware() {
  return async function securityFilter(req, res, next) {
    if (!securityFiltersEnabled()) return next();
    const violation = suspiciousRequest(req);
    if (!violation) return next();
    const ip = clientIp(req);
    const result = recordViolation(ip, violation);
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
    if (result.shouldAutoBlock && BlockedIp.db?.readyState === 1) {
      void createBlockedIp({
        value: ip,
        reason: `Automatic block after repeated ${violation.code} violations`,
        source: 'auto',
        expiresAt: result.expiresAt
      }).catch((error) => emitStructuredLog({ level: 'warn', event: 'security_auto_block_failed', message: error.message }));
    }
    return res.status(403).json({ code: violation.code, message: 'Request blocked.' });
  };
}

export {
  recordViolation,
  securityFilterMiddleware,
  suspiciousRequest
};
