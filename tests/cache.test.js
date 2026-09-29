import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SHARED_REQUIRED_CACHE,
  cleanRedisError,
  createHybridCache,
  redisTargetLabel,
  sharedStateRequiresRedis
} from '../server/utils/cache.js';
import { createFakeRedisServer } from './fakeRedis.js';

test('hybrid cache coalesces concurrent misses for the same key', async () => {
  const previousRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    const cache = createHybridCache(`test:coalesce:${Date.now()}`, { ttlMs: 1000, maxItems: 10 });
    let loads = 0;
    const values = await Promise.all(Array.from({ length: 20 }, () => cache.remember('hot-key', async () => {
      loads += 1;
      await delay(10);
      return { ok: true, loads };
    })));

    assert.equal(loads, 1);
    assert.deepEqual([...new Set(values.map((value) => value.loads))], [1]);

    const cached = await cache.remember('hot-key', async () => {
      loads += 1;
      return { ok: false, loads };
    });

    assert.deepEqual(cached, { ok: true, loads: 1 });
    assert.equal(loads, 1);
  } finally {
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  }
});

test('redis diagnostics mask credentials in targets and errors', () => {
  assert.equal(redisTargetLabel('redis://:secret@172.31.11.104:6379/2'), 'redis://172.31.11.104:6379/2');
  assert.equal(redisTargetLabel('rediss://user:secret@example.com/0'), 'rediss://example.com:6380/0');
  assert.equal(cleanRedisError(new Error('Failed to connect redis://:secret@example.com:6379')), 'Failed to connect redis://[redacted]@example.com:6379');
});

test('production always requires Redis for shared state', () => {
  assert.equal(sharedStateRequiresRedis({ NODE_ENV: 'production', TEMP_SESSION_REQUIRE_REDIS: 'false' }), true);
  assert.equal(sharedStateRequiresRedis({ NODE_ENV: 'test', TEMP_SESSION_REQUIRE_REDIS: 'false' }), false);
  assert.equal(sharedStateRequiresRedis({ NODE_ENV: 'staging', TEMP_SESSION_REQUIRE_REDIS: 'true' }), true);
});

test('shared-required cache instances share Redis-backed values and invalidation', async () => {
  const redis = createFakeRedisServer();
  const instanceA = createHybridCache('test:shared-cache', {
    ttlMs: 1000,
    mode: SHARED_REQUIRED_CACHE,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  });
  const instanceB = createHybridCache('test:shared-cache', {
    ttlMs: 1000,
    mode: SHARED_REQUIRED_CACHE,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  });

  await instanceA.set('shared-key', { source: 'instance-a' });
  assert.deepEqual(await instanceB.get('shared-key'), { source: 'instance-a' });

  await instanceA.remove('shared-key');
  assert.equal(await instanceB.get('shared-key'), null);
});

test('shared-required cache does not use a populated local copy when Redis fails', async () => {
  const redis = createFakeRedisServer();
  let available = true;
  const cache = createHybridCache('test:required-failure', {
    mode: SHARED_REQUIRED_CACHE,
    requireRedis: true,
    getRedisClient: async () => available ? redis.createClient() : null
  });

  await cache.set('key', { stored: true });
  available = false;

  await assert.rejects(cache.get('key'), (error) => {
    assert.equal(error.code, 'SHARED_STATE_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    return true;
  });
});

test('shared-required cache permits an explicitly scoped local fallback outside production', async () => {
  const cache = createHybridCache('test:local-shared-fallback', {
    mode: SHARED_REQUIRED_CACHE,
    requireRedis: false,
    getRedisClient: async () => null
  });

  await cache.set('key', { local: true });
  assert.deepEqual(await cache.get('key'), { local: true });
  await cache.remove('key');
  assert.equal(await cache.get('key'), null);
});

test('shared-required cache preserves Redis TTL behavior', async () => {
  const redis = createFakeRedisServer();
  const cacheOptions = {
    ttlMs: 1000,
    mode: SHARED_REQUIRED_CACHE,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createHybridCache('test:shared-ttl', cacheOptions);
  const instanceB = createHybridCache('test:shared-ttl', cacheOptions);

  await instanceA.set('expiring-key', { present: true });
  assert.deepEqual(await instanceB.get('expiring-key'), { present: true });
  redis.advanceBy(1001);
  assert.equal(await instanceB.get('expiring-key'), null);
});
