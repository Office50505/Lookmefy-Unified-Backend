import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempSessionStore } from '../server/utils/tempSessions.js';

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
