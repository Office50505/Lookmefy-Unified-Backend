import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import CreditEvent from '../server/models/CreditEvent.js';
import TokenOrder from '../server/models/TokenOrder.js';
import User from '../server/models/User.js';
import { createAiConversationStore } from '../server/services/aiStudio.js';
import {
  enqueuePhonePeReconciliation,
  phonePeReconciliationJobSpec
} from '../server/services/phonePeReconciliation.js';
import { generateFullBodyProfileInBackground, profileFullBodyJobSource } from '../server/routes/auth.js';
import {
  grantPaidTokens,
  runLocalPaymentTransaction,
  setLocalPaymentTransactionRunnerForTests
} from '../server/routes/payments.js';
import { createTempSessionStore } from '../server/utils/tempSessions.js';
import { createReadinessHandler } from '../server/utils/readiness.js';
import { createFakeRedisServer } from './fakeRedis.js';

function restoreEnvironment(t, names) {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function restoreModelMethods(t, replacements) {
  const originals = replacements.map(([model, name]) => [model, name, model[name]]);
  t.after(() => {
    for (const [model, name, original] of originals) {
      model[name] = original;
    }
  });
}

function productionSharedEnv(t) {
  restoreEnvironment(t, [
    'NODE_ENV',
    'REDIS_URL',
    'QUEUE_ENABLED',
    'STORAGE_PROVIDER',
    'BUNNY_STORAGE_ZONE',
    'BUNNY_STORAGE_API_KEY',
    'BUNNY_CDN_BASE_URL',
    'PROFILE_FULL_BODY_GENERATION',
    'PROFILE_FULL_BODY_QUEUE_MODE',
    'TEMP_SESSION_REQUIRE_REDIS'
  ]);
  process.env.NODE_ENV = 'production';
  process.env.REDIS_URL = 'redis://localhost:6379/0';
  process.env.QUEUE_ENABLED = 'true';
  process.env.STORAGE_PROVIDER = 'bunny';
  process.env.BUNNY_STORAGE_ZONE = 'phase10';
  process.env.BUNNY_STORAGE_API_KEY = 'test-key';
  process.env.BUNNY_CDN_BASE_URL = 'https://cdn.lookmefy.test';
  process.env.PROFILE_FULL_BODY_GENERATION = 'true';
  process.env.PROFILE_FULL_BODY_QUEUE_MODE = 'worker';
  process.env.TEMP_SESSION_REQUIRE_REDIS = 'true';
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

function tokenOrder(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439031',
    user: '507f1f77bcf86cd799439032',
    merchantOrderId: 'PHASE10-TOKEN-ORDER',
    provider: 'phonepe',
    phonePeOrderId: 'OMO_PHASE10',
    planId: 'topup_7',
    orderType: 'topup',
    tokens: 7,
    status: 'pending',
    providerState: 'PENDING',
    creditedAt: null,
    ...overrides
  };
}

test('Phase 10: shared temp session created on instance A is read and consumed on instance B', async (t) => {
  productionSharedEnv(t);
  const redis = createFakeRedisServer();
  const options = {
    ttlMs: 5000,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createTempSessionStore('phase10-otp', options);
  const instanceB = createTempSessionStore('phase10-otp', options);

  await instanceA.create({ userId: 'user-1', purpose: 'login' }, 'session-1');

  assert.equal((await instanceB.get('session-1')).userId, 'user-1');
  assert.equal((await instanceB.consume('session-1')).purpose, 'login');
  assert.equal(await instanceA.get('session-1'), null);
});

test('Phase 10: shared AI conversation written on instance A is visible on instance B', async (t) => {
  productionSharedEnv(t);
  const redis = createFakeRedisServer();
  const options = {
    ttlMs: 5000,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createAiConversationStore(options);
  const instanceB = createAiConversationStore(options);

  const conversation = await instanceA.getOrCreate({ userId: 'user-1', conversationId: 'thread-1' });
  conversation.pendingProductChoice = { kind: 'product', message: 'red kurta' };
  conversation.turns.push({ role: 'user', text: 'show red kurtas' });
  await instanceA.save(conversation);

  const shared = await instanceB.getOrCreate({ userId: 'user-1', conversationId: 'thread-1' });
  assert.equal(shared.pendingProductChoice.message, 'red kurta');
  assert.deepEqual(shared.turns, [{ role: 'user', text: 'show red kurtas' }]);
});

test('Phase 10: duplicate critical payment job enqueue across instances has one deterministic identity', async (t) => {
  productionSharedEnv(t);
  const persistedJobs = new Map();
  const enqueue = async (queueName, jobName, data, options) => {
    if (!persistedJobs.has(options.jobId)) {
      persistedJobs.set(options.jobId, { queueName, jobName, data, options });
    }
    return persistedJobs.get(options.jobId);
  };

  const [first, second] = await Promise.all([
    enqueuePhonePeReconciliation('token-order', 'PHASE10-MERCHANT', { enqueue }),
    enqueuePhonePeReconciliation('token-order', 'PHASE10-MERCHANT', { enqueue })
  ]);

  assert.equal(persistedJobs.size, 1);
  assert.equal(first.options.jobId, second.options.jobId);
  assert.equal(first.options.jobId, phonePeReconciliationJobSpec('token-order', 'PHASE10-MERCHANT').options.jobId);
});

test('Phase 10: callback and worker duplicate payment fulfillment results in one credit', async (t) => {
  restoreEnvironment(t, ['NODE_ENV']);
  process.env.NODE_ENV = 'test';
  setLocalPaymentTransactionRunnerForTests(async (work) => work(null));
  t.after(() => setLocalPaymentTransactionRunnerForTests(null));
  const order = tokenOrder();
  let balanceMutations = 0;
  let orderFulfillmentWrites = 0;
  const creditEvents = new Map();

  restoreModelMethods(t, [
    [TokenOrder, 'findById'],
    [TokenOrder, 'findOneAndUpdate'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.findById = async () => order;
  TokenOrder.findOneAndUpdate = async (_filter, update) => {
    if (order.creditedAt) return null;
    order.creditedAt = update.$set.creditedAt;
    order.status = update.$set.status;
    order.providerState = update.$set.providerState;
    orderFulfillmentWrites += 1;
    return order;
  };
  User.findById = async () => ({ _id: order.user, tokens: balanceMutations });
  User.findOneAndUpdate = async (_filter, update) => {
    balanceMutations += Number(update.$inc?.tokens || 0);
    return { _id: order.user, tokens: balanceMutations };
  };
  CreditEvent.findOne = async (filter) => creditEvents.get(filter.fulfillmentKey) || null;
  CreditEvent.create = async (doc) => {
    const event = Array.isArray(doc) ? doc[0] : doc;
    if (creditEvents.has(event.fulfillmentKey)) {
      const duplicate = new Error('duplicate fulfillment');
      duplicate.code = 11000;
      throw duplicate;
    }
    creditEvents.set(event.fulfillmentKey, event);
    return [event];
  };

  const callbackUser = await grantPaidTokens(order, { state: 'COMPLETED' });
  const workerUser = await grantPaidTokens(order, { state: 'COMPLETED' });

  assert.equal(callbackUser.tokens, 7);
  assert.equal(workerUser.tokens, 7);
  assert.equal(balanceMutations, 7);
  assert.equal(orderFulfillmentWrites, 1);
  assert.equal(creditEvents.size, 1);
});

test('Phase 10: storage producer queues a shared reference that worker can resolve without local bytes', async (t) => {
  productionSharedEnv(t);
  let queued = null;

  await generateFullBodyProfileInBackground('64f000000000000000000001', {
    filename: 'body.jpg',
    path: 'uploads/users/64f000000000000000000001/profile/body.jpg',
    storage: 'bunny',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('producer-local-buffer')
  }, {
    enqueueCritical: async (queueName, jobName, data, options) => {
      queued = { queueName, jobName, data, options };
      return { id: options.jobId };
    }
  });

  assert.equal(queued.queueName, 'profile');
  assert.equal(queued.data.sourceBodyPhoto.storage, 'bunny');
  assert.equal(queued.data.sourceBodyPhoto.path, 'uploads/users/64f000000000000000000001/profile/body.jpg');
  assert.equal(queued.data.sourceBodyPhoto.buffer, undefined);
  assert.equal(profileFullBodyJobSource(queued.data.sourceBodyPhoto).storage, 'bunny');
});

test('Phase 10: readiness reports not ready when Redis and queue are unavailable', async (t) => {
  productionSharedEnv(t);
  delete process.env.REDIS_URL;
  const res = responseRecorder();
  const handler = createReadinessHandler({
    env: process.env,
    role: 'api',
    mongooseInstance: { connection: { readyState: 1 } },
    getRedis: async () => null,
    queueIsEnabled: () => false,
    metadata: {}
  });

  await handler({}, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'not_ready');
  assert.equal(res.body.checks.redis, 'unavailable');
  assert.equal(res.body.checks.queue, 'unavailable');
});

test('Phase 10: Mongo transaction unavailable in production prevents partial payment fulfillment', async (t) => {
  productionSharedEnv(t);
  let workCalls = 0;

  await assert.rejects(
    runLocalPaymentTransaction(async () => {
      workCalls += 1;
    }, {
      connectionReadyState: () => 0
    }),
    (error) => error.code === 'PAYMENT_TRANSACTION_UNAVAILABLE' && error.statusCode === 503
  );

  assert.equal(workCalls, 0);
});

test('Phase 10: production shared-required state does not silently fall back to local state', async (t) => {
  productionSharedEnv(t);
  delete process.env.REDIS_URL;
  const store = createTempSessionStore('phase10-no-local-fallback', {
    requireRedis: true,
    getRedisClient: async () => null
  });
  let localRuns = 0;

  await assert.rejects(
    store.create({ userId: 'user-no-local' }, 'no-local'),
    (error) => error.code === 'SHARED_STATE_UNAVAILABLE' && error.statusCode === 503
  );
  await assert.rejects(
    generateFullBodyProfileInBackground('64f000000000000000000001', {
      filename: 'local.jpg',
      path: 'uploads/users/64f000000000000000000001/profile/local.jpg',
      mimetype: 'image/jpeg'
    }, {
      runLocal: async () => {
        localRuns += 1;
      }
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );
  assert.equal(localRuns, 0);
});

test('Phase 10: worker role owns durable consumers while API startup remains consumer-free', async () => {
  const [apiSource, workerSource, roleSource] = await Promise.all([
    fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/start-role.js', import.meta.url), 'utf8')
  ]);

  assert.equal(/\bstartWorker\s*\(/.test(apiSource), false);
  assert.match(workerSource, /\bstartWorker\s*\(\s*'payments'/);
  assert.match(workerSource, /\bstartWorker\s*\(\s*'profile'/);
  assert.match(roleSource, /role === 'api'[\s\S]+server\/index\.js/);
  assert.match(roleSource, /role === 'worker' \|\| role === 'scheduler'[\s\S]+worker\.js/);
});

test('Phase 10: remaining process-local maps are connection/cache registries, not authoritative shared state', async () => {
  const [cacheSource, tempSessionSource, queueSource, observabilitySource] = await Promise.all([
    fs.readFile(new URL('../server/utils/cache.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/utils/tempSessions.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/utils/jobQueue.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/utils/observability.js', import.meta.url), 'utf8')
  ]);

  assert.match(cacheSource, /if \(redisRequired\(\)\) throw sharedStateUnavailableError\(\)/);
  assert.match(tempSessionSource, /if \(redisRequired\(\)\) throw sharedStateUnavailableError\(\)/);
  assert.match(queueSource, /const queues = new Map\(\)/);
  assert.match(queueSource, /const queueEvents = new Map\(\)/);
  assert.match(observabilitySource, /const endpointStats = new Map\(\)/);
  assert.match(observabilitySource, /const pendingMetricBuckets = new Map\(\)/);
});
