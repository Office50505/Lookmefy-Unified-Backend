import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIpRule, ipMatchesRule } from '../server/utils/ipBlocklist.js';
import { shouldWriteConsole, sanitizeLog } from '../server/utils/logging.js';
import { requestContext, requestIdFromHeader } from '../server/utils/requestContext.js';
import { suspiciousRequest } from '../server/utils/securityFilters.js';
import { validateServerEnv } from '../server/utils/envValidation.js';

test('request context accepts safe request ids and generates missing ids', () => {
  assert.equal(requestIdFromHeader('trace-12345678'), 'trace-12345678');
  assert.equal(requestIdFromHeader('bad whitespace'), '');
  const req = { get: () => '' };
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name.toLowerCase()] = value; } };
  requestContext(req, res, () => {});
  assert.match(req.requestId, /^req_/);
  assert.equal(headers['x-request-id'], req.requestId);
});

test('production console policy keeps request console output to 5xx by default', () => {
  const env = { NODE_ENV: 'production' };
  assert.equal(shouldWriteConsole({ event: 'http_request', status: 200, level: 'info' }, env), false);
  assert.equal(shouldWriteConsole({ event: 'http_request', status: 404, level: 'warn' }, env), false);
  assert.equal(shouldWriteConsole({ event: 'http_request', status: 500, level: 'error' }, env), true);
  assert.equal(shouldWriteConsole({ event: 'api_started', level: 'info', forceConsole: true }, env), true);
});

test('structured logs redact sensitive metadata', () => {
  const log = sanitizeLog({
    level: 'info',
    event: 'test',
    url: 'https://example.com/callback?token=abc&ok=1',
    nested: { password: 'secret-value' }
  });
  assert.match(log.url, /token=\[redacted\]/);
  assert.notEqual(log.nested.password, 'secret-value');
});

test('IP block rules normalize exact IPs and IPv4 CIDR ranges', () => {
  assert.equal(normalizeIpRule(' 203.0.113.4 '), '203.0.113.4');
  assert.equal(normalizeIpRule('203.0.113.0/24'), '203.0.113.0/24');
  assert.equal(normalizeIpRule('not-ip'), '');
  assert.equal(ipMatchesRule('203.0.113.44', '203.0.113.0/24'), true);
  assert.equal(ipMatchesRule('203.0.114.44', '203.0.113.0/24'), false);
});

test('suspicious request filter catches scanner paths, traversal, and scanners', () => {
  assert.equal(suspiciousRequest({ originalUrl: '/.env', get: () => '' }).code, 'SCANNER_PATH');
  assert.equal(suspiciousRequest({ originalUrl: '/api/../admin', get: () => '' }).code, 'PATH_TRAVERSAL');
  assert.equal(suspiciousRequest({ originalUrl: '/api/products', get: () => 'sqlmap' }).code, 'SUSPICIOUS_USER_AGENT');
  assert.equal(suspiciousRequest({ originalUrl: '/api/products', get: () => 'Mozilla/5.0' }), null);
});

test('production env hardening rejects local origins and dev flags', () => {
  assert.throws(() => validateServerEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://example.invalid/fitlook',
    JWT_SECRET: 'secret',
    PHONEPE_ENABLED: 'false',
    AI_FEATURES_ENABLED: 'false',
    CLIENT_ORIGIN: 'http://localhost:5173'
  }), /CLIENT_ORIGIN.*localhost/);
  assert.throws(() => validateServerEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://example.invalid/fitlook',
    JWT_SECRET: 'secret',
    PHONEPE_ENABLED: 'false',
    AI_FEATURES_ENABLED: 'false',
    CLIENT_ORIGIN: 'https://fitlook.in',
    ALLOW_LOCAL_ORIGINS: 'true'
  }), /ALLOW_LOCAL_ORIGINS/);
});
