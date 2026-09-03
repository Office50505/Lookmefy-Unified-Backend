import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import User from '../server/models/User.js';
import { createOtpChallenge, verifyOtpChallenge } from '../server/utils/otp.js';
import { createTempSessionStore } from '../server/utils/tempSessions.js';
import {
  authenticationVersion,
  tokenAuthenticationVersionMatches,
  userPasswordError
} from '../server/utils/userCredentials.js';

async function withLocalTempSessions(fn) {
  const originalRequireRedis = process.env.TEMP_SESSION_REQUIRE_REDIS;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalJwtSecret = process.env.JWT_SECRET;
  process.env.TEMP_SESSION_REQUIRE_REDIS = 'false';
  delete process.env.REDIS_URL;
  process.env.JWT_SECRET = 'password-reset-test-secret';
  try {
    await fn();
  } finally {
    if (originalRequireRedis === undefined) delete process.env.TEMP_SESSION_REQUIRE_REDIS;
    else process.env.TEMP_SESSION_REQUIRE_REDIS = originalRequireRedis;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }
}

test('user password validation matches the bcrypt-safe website policy', () => {
  assert.match(userPasswordError('short'), /at least 12/i);
  assert.equal(userPasswordError('A-secure-password-123'), '');
  assert.match(userPasswordError('x'.repeat(73)), /at most 72 bytes/i);
  assert.match(userPasswordError('🔐'.repeat(19)), /at most 72 bytes/i);
});

test('authentication versions preserve existing users and invalidate old tokens after reset', () => {
  assert.equal(authenticationVersion(undefined), 0);
  assert.equal(tokenAuthenticationVersionMatches({ authVersion: 0 }, {}), true);
  assert.equal(tokenAuthenticationVersionMatches({ authVersion: 1 }, {}), false);
  assert.equal(tokenAuthenticationVersionMatches({ authVersion: 1 }, { ver: 0 }), false);
  assert.equal(tokenAuthenticationVersionMatches({ authVersion: 1 }, { ver: 1 }), true);
  assert.equal(tokenAuthenticationVersionMatches({ authVersion: 1 }, { ver: '1' }), false);
});

test('user model accepts only non-negative whole authentication versions', () => {
  const base = {
    name: 'Reset Test',
    email: 'reset-test@fitlook.local',
    phone: '+919876543210',
    passwordHash: 'not-used'
  };
  assert.equal(new User({ ...base, authVersion: 1 }).validateSync(), undefined);
  assert.ok(new User({ ...base, authVersion: -1 }).validateSync()?.errors?.authVersion);
  assert.ok(new User({ ...base, authVersion: 1.5 }).validateSync()?.errors?.authVersion);
});

test('verified password-reset grants are purpose-bound and consumable only once', async () => withLocalTempSessions(async () => {
  const id = `${Date.now()}:${Math.random()}`;
  const sessions = createTempSessionStore(`test:password-reset:${id}`, { ttlMs: 1_000 });
  const currentSessions = createTempSessionStore(`test:password-reset-current:${id}`, { ttlMs: 1_000 });
  const phone = '+919876543210';
  const challenge = await createOtpChallenge({
    sessions,
    currentSessions,
    purpose: 'password-reset',
    phone,
    metadata: { userId: '507f1f77bcf86cd799439011' }
  });

  const wrongPurpose = await verifyOtpChallenge({
    sessions,
    currentSessions,
    purpose: 'login',
    phone,
    otpSession: challenge.otpSession,
    otp: challenge.otp
  });
  assert.equal(wrongPurpose.ok, false);

  const verified = await verifyOtpChallenge({
    sessions,
    currentSessions,
    purpose: 'password-reset',
    phone,
    otpSession: challenge.otpSession,
    otp: challenge.otp
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.session.userId, '507f1f77bcf86cd799439011');

  const consumed = await sessions.consume(challenge.otpSession);
  assert.equal(consumed.verified, true);
  assert.equal(await sessions.consume(challenge.otpSession), null);
}));

test('password reset routes and website keep the complete security contract', async () => {
  const [backend, frontend] = await Promise.all([
    fs.readFile('server/routes/auth.js', 'utf8'),
    fs.readFile('src/App.jsx', 'utf8')
  ]);

  for (const endpoint of [
    '/password-reset/request-otp',
    '/password-reset/verify-otp',
    '/password-reset/cancel-otp',
    '/password-reset'
  ]) {
    assert.match(backend, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.match(backend, /purpose:\s*'password-reset'/);
  assert.match(backend, /passwordResetOtpSessions\.consume\(otpSession\)/);
  assert.match(backend, /\$inc:\s*\{\s*authVersion:\s*1\s*\}/);
  assert.match(backend, /revokeUserSessions\(user\._id\)/);
  assert.match(backend, /If an active account exists for this number/);
  assert.match(frontend, /href="\/forgot-password"/);
  assert.match(frontend, /path === '\/forgot-password'/);
  assert.match(frontend, /Forgot Password\?/);
  assert.match(frontend, /Password reset successfully/);
});
