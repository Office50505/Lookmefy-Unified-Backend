import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempSessionStore } from '../server/utils/tempSessions.js';
import { createFakeRedisServer } from './fakeRedis.js';

test('temporary sessions are readable, updateable, removable, and expire', async () => {
  const originalRequireRedis = process.env.TEMP_SESSION_REQUIRE_REDIS;
  const originalRedisUrl = process.env.REDIS_URL;
  process.env.TEMP_SESSION_REQUIRE_REDIS = 'false';
  delete process.env.REDIS_URL;

  try {
    const sessions = createTempSessionStore(`test-${Date.now()}`, { ttlMs: 20 });
    const { id } = await sessions.create({ phone: '+911234567890', verified: false });

    assert.equal((await sessions.get(id)).phone, '+911234567890');
    await sessions.update(id, (session) => ({ ...session, verified: true }));
    assert.equal((await sessions.get(id)).verified, true);

    await delay(30);
    assert.equal(await sessions.get(id), null);

    const { id: secondId } = await sessions.create({ phone: '+919999999999' });
    await sessions.remove(secondId);
    assert.equal(await sessions.get(secondId), null);
  } finally {
    if (originalRequireRedis === undefined) delete process.env.TEMP_SESSION_REQUIRE_REDIS;
    else process.env.TEMP_SESSION_REQUIRE_REDIS = originalRequireRedis;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  }
});

test('temporary sessions are shared, deleted, and consumed across Redis-backed instances', async () => {
  const redis = createFakeRedisServer();
  const options = {
    ttlMs: 1000,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createTempSessionStore('test-shared-sessions', options);
  const instanceB = createTempSessionStore('test-shared-sessions', options);

  await instanceA.create({ userId: 'user-a' }, 'session-delete');
  assert.equal((await instanceB.get('session-delete')).userId, 'user-a');
  await instanceA.remove('session-delete');
  assert.equal(await instanceB.get('session-delete'), null);

  await instanceA.create({ userId: 'user-b' }, 'session-consume');
  assert.equal((await instanceB.consume('session-consume')).userId, 'user-b');
  assert.equal(await instanceA.get('session-consume'), null);
});

test('temporary Redis sessions expire according to their TTL', async () => {
  const redis = createFakeRedisServer();
  const options = {
    ttlMs: 1000,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createTempSessionStore('test-shared-session-ttl', options);
  const instanceB = createTempSessionStore('test-shared-session-ttl', options);

  await instanceA.create({ active: true }, 'expiring-session');
  assert.equal((await instanceB.get('expiring-session')).active, true);
  redis.advanceBy(1001);
  assert.equal(await instanceB.get('expiring-session'), null);
});

test('temporary sessions fail with a controlled dependency error when Redis is required', async () => {
  const sessions = createTempSessionStore('test-required-session-failure', {
    requireRedis: true,
    getRedisClient: async () => null
  });

  await assert.rejects(sessions.create({ active: true }), (error) => {
    assert.equal(error.code, 'SHARED_STATE_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    return true;
  });
});
