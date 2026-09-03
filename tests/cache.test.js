import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanRedisError, createHybridCache, redisTargetLabel } from '../server/utils/cache.js';

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
