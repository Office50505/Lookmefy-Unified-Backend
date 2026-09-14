import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter, developmentRateLimitBypass, rateLimitsEnabled } from '../server/utils/rateLimit.js';

function createReq(ip = '127.0.0.1') {
  return {
    ip,
    method: 'GET',
    originalUrl: '/api/test',
    get() {
      return '';
    },
    socket: { remoteAddress: ip }
  };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

function runMiddleware(middleware, req) {
  const res = createRes();
  let nextCalled = false;
  return Promise.resolve(middleware(req, res, () => {
    nextCalled = true;
  })).then(() => ({ res, nextCalled }));
}

test('rate limiter allows requests until max and returns 429 after the limit', async () => {
  const previousRedisUrl = process.env.REDIS_URL;
  const previousRateLimitsEnabled = process.env.RATE_LIMITS_ENABLED;
  delete process.env.REDIS_URL;
  process.env.RATE_LIMITS_ENABLED = 'true';
  const limiter = createRateLimiter({
    name: `test:${Date.now()}`,
    windowMs: 60_000,
    max: 2,
    keyGenerator: (req) => `ip:${req.ip}`
  });

  try {
    const first = await runMiddleware(limiter, createReq());
    const second = await runMiddleware(limiter, createReq());
    const third = await runMiddleware(limiter, createReq());

    assert.equal(first.nextCalled, true);
    assert.equal(second.nextCalled, true);
    assert.equal(third.nextCalled, false);
    assert.equal(third.res.statusCode, 429);
    assert.equal(third.res.body.code, 'RATE_LIMITED');
    assert.equal(third.res.headers['ratelimit-limit'], '2');
    assert.equal(third.res.headers['ratelimit-remaining'], '0');
    assert.ok(Number(third.res.headers['retry-after']) > 0);
  } finally {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    if (previousRateLimitsEnabled === undefined) delete process.env.RATE_LIMITS_ENABLED;
    else process.env.RATE_LIMITS_ENABLED = previousRateLimitsEnabled;
  }
});

test('global rate-limit switch bypasses generated middleware', async () => {
  const previousRedisUrl = process.env.REDIS_URL;
  const previousRateLimitsEnabled = process.env.RATE_LIMITS_ENABLED;
  delete process.env.REDIS_URL;
  process.env.RATE_LIMITS_ENABLED = 'false';
  const limiter = createRateLimiter({
    name: `test-global-bypass:${Date.now()}`,
    windowMs: 60_000,
    max: 1,
    keyGenerator: (req) => `ip:${req.ip}`
  });

  try {
    const first = await runMiddleware(limiter, createReq());
    const second = await runMiddleware(limiter, createReq());
    const third = await runMiddleware(limiter, createReq());

    assert.equal(first.nextCalled, true);
    assert.equal(second.nextCalled, true);
    assert.equal(third.nextCalled, true);
    assert.equal(third.res.statusCode, 200);
    assert.deepEqual(third.res.headers, {});
  } finally {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    if (previousRateLimitsEnabled === undefined) delete process.env.RATE_LIMITS_ENABLED;
    else process.env.RATE_LIMITS_ENABLED = previousRateLimitsEnabled;
  }
});

test('global rate-limit switch defaults on and accepts false values', () => {
  assert.equal(rateLimitsEnabled({}), true);
  assert.equal(rateLimitsEnabled({ RATE_LIMITS_ENABLED: 'true' }), true);
  assert.equal(rateLimitsEnabled({ RATE_LIMITS_ENABLED: 'false' }), false);
  assert.equal(rateLimitsEnabled({ RATE_LIMITS_ENABLED: 'off' }), false);
  assert.equal(rateLimitsEnabled({ RATE_LIMITS_ENABLED: '0' }), false);
});

test('development rate-limit bypass cannot disable production protection', () => {
  assert.equal(developmentRateLimitBypass('DISABLE_ADMIN_LOGIN_RATE_LIMIT', {
    NODE_ENV: 'development',
    DISABLE_ADMIN_LOGIN_RATE_LIMIT: 'true'
  }), true);
  assert.equal(developmentRateLimitBypass('DISABLE_ADMIN_LOGIN_RATE_LIMIT', {
    NODE_ENV: 'production',
    DISABLE_ADMIN_LOGIN_RATE_LIMIT: 'true'
  }), false);
});
