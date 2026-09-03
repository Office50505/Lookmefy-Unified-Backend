import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientSummary,
  hashSessionId,
  normalizeSessionPath,
  sessionActivityIncrement,
  sessionDisplayState
} from '../server/utils/userSessions.js';

test('session identifiers are stored as deterministic hashes', () => {
  const sessionId = 'session-secret-value';
  const hashed = hashSessionId(sessionId);
  assert.equal(hashed, hashSessionId(sessionId));
  assert.notEqual(hashed, sessionId);
  assert.equal(hashed.length, 64);
});

test('session paths exclude query strings and fragments', () => {
  assert.equal(normalizeSessionPath('/product/123?token=secret#details'), '/product/123');
  assert.equal(normalizeSessionPath('https://lookmefy.com/categories?gender=women'), '/categories');
});

test('active duration increments are capped and ignore stale gaps', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  assert.equal(sessionActivityIncrement(new Date(now.getTime() - 30_000), now, 60_000), 30_000);
  assert.equal(sessionActivityIncrement(new Date(now.getTime() - 120_000), now, 60_000), 60_000);
  assert.equal(sessionActivityIncrement(new Date(now.getTime() - (20 * 60_000)), now, 60_000), 0);
});

test('session display state distinguishes online, inactive, logout, and expiry', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  const base = { status: 'active', loginAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 60_000) };
  assert.equal(sessionDisplayState(base, now), 'online');
  assert.equal(sessionDisplayState({ ...base, lastSeenAt: new Date(now.getTime() - (20 * 60_000)) }, now), 'inactive');
  assert.equal(sessionDisplayState({ ...base, status: 'logged_out' }, now), 'logged_out');
  assert.equal(sessionDisplayState({ ...base, expiresAt: new Date(now.getTime() - 1) }, now), 'expired');
});

test('client summaries retain only coarse browser and device information', () => {
  assert.deepEqual(clientSummary('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1'), { deviceType: 'mobile', platform: 'ios', browser: 'Safari' });
  assert.deepEqual(clientSummary('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'), { deviceType: 'mobile', platform: 'android', browser: 'Chrome' });
  assert.deepEqual(clientSummary('Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36'), { deviceType: 'desktop', platform: 'unknown', browser: 'Chrome' });
});
