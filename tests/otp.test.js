import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cancelOtpChallenge,
  createOtpChallenge,
  currentSessionMatches,
  fixedOtpCode,
  normalizeOtp,
  verifyOtpChallenge
} from '../server/utils/otp.js';
import { createTempSessionStore } from '../server/utils/tempSessions.js';

function testStores(name, ttlMs = 1_000) {
  return {
    sessions: createTempSessionStore(`test:${name}:challenge:${Date.now()}:${Math.random()}`, { ttlMs }),
    currentSessions: createTempSessionStore(`test:${name}:current:${Date.now()}:${Math.random()}`, { ttlMs })
  };
}

async function withLocalTempSessions(fn) {
  const originalRequireRedis = process.env.TEMP_SESSION_REQUIRE_REDIS;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOtpProvider = process.env.OTP_DELIVERY_PROVIDER;
  const originalFixedOtp = process.env.OTP_FIXED_CODE;
  const originalAllowProductionFixedOtp = process.env.ALLOW_FIXED_OTP_IN_PRODUCTION;
  const originalOtpRateLimitBypass = process.env.DISABLE_AUTH_OTP_RATE_LIMITS;
  process.env.TEMP_SESSION_REQUIRE_REDIS = 'false';
  delete process.env.REDIS_URL;
  process.env.JWT_SECRET = 'otp-test-secret';

  try {
    await fn();
  } finally {
    if (originalRequireRedis === undefined) delete process.env.TEMP_SESSION_REQUIRE_REDIS;
    else process.env.TEMP_SESSION_REQUIRE_REDIS = originalRequireRedis;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalOtpProvider === undefined) delete process.env.OTP_DELIVERY_PROVIDER;
    else process.env.OTP_DELIVERY_PROVIDER = originalOtpProvider;
    if (originalFixedOtp === undefined) delete process.env.OTP_FIXED_CODE;
    else process.env.OTP_FIXED_CODE = originalFixedOtp;
    if (originalAllowProductionFixedOtp === undefined) delete process.env.ALLOW_FIXED_OTP_IN_PRODUCTION;
    else process.env.ALLOW_FIXED_OTP_IN_PRODUCTION = originalAllowProductionFixedOtp;
    if (originalOtpRateLimitBypass === undefined) delete process.env.DISABLE_AUTH_OTP_RATE_LIMITS;
    else process.env.DISABLE_AUTH_OTP_RATE_LIMITS = originalOtpRateLimitBypass;
  }
}

async function createChallenge(name, overrides = {}) {
  const stores = testStores(name, overrides.ttlMs);
  const phone = overrides.phone || '+919876543210';
  const challenge = await createOtpChallenge({
    ...stores,
    purpose: overrides.purpose || 'signup',
    phone,
    maxAttempts: overrides.maxAttempts
  });
  return { ...stores, ...challenge, phone, purpose: overrides.purpose || 'signup' };
}

async function verify({ sessions, currentSessions, purpose, phone, otpSession, otp }) {
  return verifyOtpChallenge({ sessions, currentSessions, purpose, phone, otpSession, otp });
}

test('OTP normalization rejects blank, alphabetic, short, and long values', () => {
  assert.equal(normalizeOtp(''), '');
  assert.equal(normalizeOtp('abcdef'), '');
  assert.equal(normalizeOtp('12345'), '');
  assert.equal(normalizeOtp('1234567'), '');
  assert.equal(normalizeOtp('123456'), '123456');
});

test('created OTP challenge stores only a hash and never the raw OTP', async () => withLocalTempSessions(async () => {
  const challenge = await createChallenge('hash-only');
  const stored = await challenge.sessions.get(challenge.otpSession);

  assert.equal(stored.otp, undefined);
  assert.equal(stored.code, undefined);
  assert.notEqual(stored.otpHash, challenge.otp);
  assert.match(stored.otpHash, /^[a-f0-9]{64}$/);
}));

test('correct OTP verifies once and rejects reuse', async () => withLocalTempSessions(async () => {
  const challenge = await createChallenge('single-use');
  const first = await verify(challenge);
  const second = await verify(challenge);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.message, /already been used/i);
}));

test('fixed OTP is allowed for staging mock delivery and explicit production testing', async () => withLocalTempSessions(async () => {
  process.env.NODE_ENV = 'staging';
  process.env.OTP_DELIVERY_PROVIDER = 'mock';
  process.env.OTP_FIXED_CODE = '123456';

  const challenge = await createChallenge('fixed-code', { purpose: 'login' });
  assert.equal(challenge.otp, '123456');
  assert.equal(fixedOtpCode(), '123456');
  assert.equal((await verify({ ...challenge, otp: '123456' })).ok, true);

  process.env.NODE_ENV = 'production';
  assert.equal(fixedOtpCode(), '');

  process.env.OTP_DELIVERY_PROVIDER = 'disabled';
  process.env.ALLOW_FIXED_OTP_IN_PRODUCTION = 'true';
  assert.equal(fixedOtpCode(), '123456');
}));

test('blank, alphabetic, short, long, and wrong OTPs are rejected', async () => withLocalTempSessions(async () => {
  for (const [label, otp] of [
    ['blank', ''],
    ['alphabetic', 'abcdef'],
    ['short', '12345'],
    ['long', '1234567'],
    ['wrong', '000000']
  ]) {
    const challenge = await createChallenge(`invalid-${label}`);
    const result = await verify({ ...challenge, otp });
    assert.equal(result.ok, false, label);
    assert.equal(result.status, 400, label);
  }
}));

test('expired OTP is rejected and removed', async () => withLocalTempSessions(async () => {
  const challenge = await createChallenge('expired', { ttlMs: 20 });
  await delay(30);

  const result = await verify(challenge);
  assert.equal(result.ok, false);
  assert.match(result.message, /Request a new OTP|expired/i);
  assert.equal(await challenge.sessions.get(challenge.otpSession), null);
}));

test('old OTP is rejected after resend for the same phone', async () => withLocalTempSessions(async () => {
  const first = await createChallenge('resend');
  const second = await createOtpChallenge({
    sessions: first.sessions,
    currentSessions: first.currentSessions,
    purpose: first.purpose,
    phone: first.phone
  });

  const stale = await verify(first);
  const fresh = await verify({ ...first, otpSession: second.otpSession, otp: second.otp });

  assert.equal(stale.ok, false);
  assert.match(stale.message, /Request a new OTP/i);
  assert.equal(fresh.ok, true);
}));

test('OTP cannot be verified after the phone number changes', async () => withLocalTempSessions(async () => {
  const challenge = await createChallenge('phone-change');
  const result = await verify({ ...challenge, phone: '+919999999999' });

  assert.equal(result.ok, false);
  assert.match(result.message, /Request a new OTP/i);
}));

test('Change Number cancellation invalidates the server-side OTP session', async () => withLocalTempSessions(async () => {
  const challenge = await createChallenge('cancel');
  const cancelled = await cancelOtpChallenge(challenge);
  const result = await verify(challenge);

  assert.equal(cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(await challenge.sessions.get(challenge.otpSession), null);
}));

test('verified signup session becomes stale after a later resend', async () => withLocalTempSessions(async () => {
  const first = await createChallenge('verified-stale');
  const verified = await verify(first);
  const second = await createOtpChallenge({
    sessions: first.sessions,
    currentSessions: first.currentSessions,
    purpose: first.purpose,
    phone: first.phone
  });

  assert.equal(verified.ok, true);
  assert.equal(await currentSessionMatches(first), false);
  assert.equal(await currentSessionMatches({ ...first, otpSession: second.otpSession }), true);
}));

test('excessive incorrect attempts invalidate the OTP challenge', async () => withLocalTempSessions(async () => {
  const challenge = await createChallenge('attempt-limit', { maxAttempts: 2 });
  const first = await verify({ ...challenge, otp: '111111' });
  const second = await verify({ ...challenge, otp: '222222' });
  const correctAfterLock = await verify(challenge);

  assert.equal(first.ok, false);
  assert.equal(first.status, 400);
  assert.equal(second.ok, false);
  assert.equal(second.status, 429);
  assert.equal(correctAfterLock.ok, false);
  assert.equal(await challenge.sessions.get(challenge.otpSession), null);
}));

test('OTP attempt lockout can be bypassed outside production for testing', async () => withLocalTempSessions(async () => {
  process.env.NODE_ENV = 'development';
  process.env.DISABLE_AUTH_OTP_RATE_LIMITS = 'true';

  const challenge = await createChallenge('attempt-limit-bypass', { maxAttempts: 2 });
  const first = await verify({ ...challenge, otp: '111111' });
  const second = await verify({ ...challenge, otp: '222222' });
  const correctAfterLimit = await verify(challenge);

  assert.equal(first.ok, false);
  assert.equal(first.status, 400);
  assert.equal(second.ok, false);
  assert.equal(second.status, 400);
  assert.equal(correctAfterLimit.ok, true);
}));

test('frontend and backend sources do not contain the old exposed OTP UI/API keys', async () => {
  const frontendSource = await fs.readFile('src/App.jsx', 'utf8');
  assert.doesNotMatch(frontendSource, /devOtp/);
  if (/Test OTP|Test code/.test(frontendSource)) {
    assert.match(frontendSource, /ENABLE_TEST_OTP_HELPER/);
    assert.match(frontendSource, /\/auth\/test-otp/);
  }

  const backendSource = await fs.readFile('server/routes/auth.js', 'utf8');
  assert.doesNotMatch(backendSource, /devOtp|Test OTP|Test code/);
});
