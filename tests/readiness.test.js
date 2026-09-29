import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  dependencyReadiness,
  createReadinessHandler
} from '../server/utils/readiness.js';

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    REDIS_URL: 'redis://:super-secret-redis@example.redis.internal:6379/0',
    MONGODB_URI: 'mongodb+srv://user:super-secret-mongo@example.mongodb.net/lookmefy',
    ...overrides
  };
}

function fakeMongoose({ readyState = 1, ping = async () => ({ ok: 1 }) } = {}) {
  return {
    connection: {
      readyState,
      db: {
        admin() {
          return { ping };
        }
      }
    }
  };
}

function fakeMongooseWithAdminThrow() {
  return {
    connection: {
      readyState: 1,
      db: {
        admin() {
          throw new Error('mongodb+srv://user:super-secret-mongo@example.mongodb.net failed');
        }
      }
    }
  };
}

function fakeMongooseWithPingThrow() {
  return {
    connection: {
      readyState: 1,
      db: {
        admin() {
          return {
            ping() {
              throw new Error('sync ping failure with super-secret-mongo');
            }
          };
        }
      }
    }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function ready(options = {}) {
  return dependencyReadiness({
    env: productionEnv(),
    role: 'api',
    mongooseInstance: fakeMongoose(),
    getRedis: async () => ({ ping: async () => 'PONG' }),
    queueIsEnabled: () => true,
    metadata: { role: 'api', hostname: 'host-a', instanceId: 'instance-a' },
    timeoutMs: 25,
    ...options
  });
}

test('Phase 8 readiness returns 200 when Mongo, Redis, and queue are ready', async () => {
  const result = await ready();

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'ready');
  assert.deepEqual(result.body.checks, {
    mongo: 'ready',
    redis: 'ready',
    queue: 'ready',
    storage: 'not_checked'
  });
});

test('Phase 8 readiness returns 503 when Mongo is unavailable', async () => {
  const result = await ready({
    mongooseInstance: fakeMongoose({ readyState: 0 })
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.mongo, 'unavailable');
  assert.equal(result.body.checks.redis, 'ready');
  assert.equal(result.body.checks.queue, 'ready');
});

test('Phase 8 Mongo admin synchronous throw returns 503 unavailable', async () => {
  const result = await ready({
    mongooseInstance: fakeMongooseWithAdminThrow()
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.mongo, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result.body), /super-secret-mongo|mongodb\+srv:\/\//);
});

test('Phase 8 Mongo ping synchronous throw returns 503 unavailable', async () => {
  const result = await ready({
    mongooseInstance: fakeMongooseWithPingThrow()
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.mongo, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result.body), /super-secret-mongo/);
});

test('Phase 8 Mongo rejected ping returns 503 unavailable', async () => {
  const result = await ready({
    mongooseInstance: fakeMongoose({
      ping: async () => {
        throw new Error('async ping failure with super-secret-mongo');
      }
    })
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.mongo, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result.body), /super-secret-mongo/);
});

test('Phase 8 readiness returns 503 when Redis is unavailable', async () => {
  const result = await ready({
    getRedis: async () => null
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.mongo, 'ready');
  assert.equal(result.body.checks.redis, 'unavailable');
  assert.equal(result.body.checks.queue, 'unavailable');
});

test('Phase 8 readiness returns 503 when queue is required but disabled', async () => {
  const result = await ready({
    queueIsEnabled: () => false
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.queue, 'unavailable');
});

test('Phase 8 readiness returns 503 for multiple dependency failures', async () => {
  const result = await ready({
    mongooseInstance: fakeMongoose({ readyState: 0 }),
    getRedis: async () => null,
    queueIsEnabled: () => false
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.status, 'not_ready');
  assert.equal(result.body.checks.mongo, 'unavailable');
  assert.equal(result.body.checks.redis, 'unavailable');
  assert.equal(result.body.checks.queue, 'unavailable');
});

test('Phase 8 readiness response does not expose secret values', async () => {
  const result = await ready({
    getRedis: async () => {
      throw new Error('redis://:super-secret-redis@example.redis.internal:6379 failed');
    }
  });
  const serialized = JSON.stringify(result.body);

  assert.equal(result.httpStatus, 503);
  assert.doesNotMatch(serialized, /super-secret-redis/);
  assert.doesNotMatch(serialized, /super-secret-mongo/);
  assert.doesNotMatch(serialized, /mongodb\+srv:\/\//);
  assert.doesNotMatch(serialized, /redis:\/\//);
});

test('Phase 8 readiness aliases can share the exact same handler result', async () => {
  const handler = createReadinessHandler({
    env: productionEnv(),
    role: 'api',
    mongooseInstance: fakeMongoose(),
    getRedis: async () => ({ ping: async () => 'PONG' }),
    queueIsEnabled: () => true,
    metadata: { role: 'api', hostname: 'host-a', instanceId: 'instance-a' },
    timeoutMs: 25
  });
  const first = responseRecorder();
  const second = responseRecorder();

  await handler({}, first);
  await handler({}, second);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(first.body, second.body);
});

test('Phase 8 liveness route remains shallow while ready route is canonicalized', async () => {
  const source = await fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8');

  assert.match(source, /app\.get\('\/api\/health', \(_req, res\) => \{\s*res\.json\(\{ ok: true \}\);/s);
  assert.match(source, /const readinessHandler = createReadinessHandler/);
  assert.match(source, /app\.get\('\/api\/health\/ready', readinessHandler\);/);
  assert.match(source, /app\.get\('\/api\/ready', readinessHandler\);/);
});

test('Phase 8 readiness timeout returns 503 instead of hanging', async () => {
  const result = await ready({
    mongooseInstance: fakeMongoose({
      ping: () => new Promise(() => {})
    }),
    timeoutMs: 10
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.checks.mongo, 'unavailable');
});

test('Phase 8 readiness handler unexpected failure returns controlled 503 without secrets', async () => {
  const handler = createReadinessHandler({
    env: productionEnv(),
    role: 'api',
    mongooseInstance: fakeMongoose(),
    getRedis: async () => ({ ping: async () => 'PONG' }),
    queueIsEnabled() {
      throw new Error('unexpected secret super-secret-mongo redis://:super-secret-redis@example');
    },
    metadata: { role: 'api', hostname: 'host-a', instanceId: 'instance-a' }
  });
  const res = responseRecorder();

  await handler({}, res);

  const serialized = JSON.stringify(res.body);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'not_ready');
  assert.equal(res.body.checks.mongo, 'unavailable');
  assert.doesNotMatch(serialized, /super-secret-mongo|super-secret-redis|redis:\/\//);
});

test('Phase 8 non-production can intentionally skip Redis and queue readiness', async () => {
  const result = await ready({
    env: { NODE_ENV: 'test' },
    getRedis: async () => {
      throw new Error('Redis should not be checked when not required');
    },
    queueIsEnabled: () => false
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.checks.redis, 'skipped');
  assert.equal(result.body.checks.queue, 'skipped');
});
