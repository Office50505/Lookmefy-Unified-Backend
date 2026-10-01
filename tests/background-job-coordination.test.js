import assert from 'node:assert/strict';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import test from 'node:test';
import TokenOrder from '../server/models/TokenOrder.js';
import { generateFullBodyProfileInBackground } from '../server/routes/auth.js';
import { handleProductPhonePeCallback, runPhonePeProductOrderReconciliationJob } from '../server/routes/orders.js';
import { createPhonePePayment, handlePhonePeCallback, runPhonePeTokenOrderReconciliationJob } from '../server/routes/payments.js';
import {
  enqueuePhonePeReconciliation,
  phonePeReconciliationJobSpec
} from '../server/services/phonePeReconciliation.js';
import { enqueueCriticalJob } from '../server/utils/jobQueue.js';

function restoreEnvironment(t, names) {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
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

function callbackOptions({ order, enqueue }) {
  return {
    requireCallbackConfig: () => {},
    validateCallbackAuth: () => true,
    getAuthorizationHeader: () => 'valid-auth',
    findOrder: async () => order,
    enqueueReconciliation: enqueue
  };
}

function productCallbackOptions({ order, enqueue }) {
  return {
    requireCallbackConfig: () => {},
    validateCallbackAuth: () => true,
    getAuthorizationHeader: () => 'valid-auth',
    findOrder: async () => order,
    enqueueReconciliation: enqueue
  };
}

function checkoutRequest(idempotencyKey) {
  return {
    body: {},
    protocol: 'https',
    get(name) {
      if (String(name).toLowerCase() === 'idempotency-key') return idempotencyKey;
      if (String(name).toLowerCase() === 'host') return 'fitlook.in';
      return '';
    }
  };
}

test('two backend instances enqueue one logical PhonePe job identity', async () => {
  const persistedJobs = new Map();
  const fakeRedisBackedEnqueue = async (queueName, jobName, data, options) => {
    if (!persistedJobs.has(options.jobId)) {
      persistedJobs.set(options.jobId, { queueName, jobName, data, options });
    }
    return persistedJobs.get(options.jobId);
  };

  const backendA = () => enqueuePhonePeReconciliation('token-order', 'MERCHANT-42', { enqueue: fakeRedisBackedEnqueue });
  const backendB = () => enqueuePhonePeReconciliation('token-order', 'MERCHANT-42', { enqueue: fakeRedisBackedEnqueue });
  const [first, second] = await Promise.all([backendA(), backendB()]);

  assert.equal(persistedJobs.size, 1);
  assert.equal(first.options.jobId, second.options.jobId);
  assert.equal(first.options.jobId, 'phonepe-token-order-reconcile-MERCHANT-42');
  assert.deepEqual(first.data, { merchantOrderId: 'MERCHANT-42' });
});

test('PhonePe callback acknowledges after successful durable enqueue', async () => {
  const res = responseRecorder();
  const enqueued = [];

  await handlePhonePeCallback({}, res, callbackOptions({
    order: { merchantOrderId: 'CALLBACK-ENQUEUE-1', providerState: 'PENDING', status: 'pending' },
    enqueue: async (kind, merchantOrderId) => enqueued.push({ kind, merchantOrderId })
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(enqueued, [{ kind: 'token-order', merchantOrderId: 'CALLBACK-ENQUEUE-1' }]);
});

test('PhonePe callback enqueues providerState COMPLETED token orders until credits are fulfilled', async () => {
  const res = responseRecorder();
  const enqueued = [];

  await handlePhonePeCallback({}, res, callbackOptions({
    order: { merchantOrderId: 'CALLBACK-COMPLETED-UNFULFILLED', providerState: 'COMPLETED', status: 'completed' },
    enqueue: async (kind, merchantOrderId) => enqueued.push({ kind, merchantOrderId })
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(enqueued, [{ kind: 'token-order', merchantOrderId: 'CALLBACK-COMPLETED-UNFULFILLED' }]);
});

test('PhonePe callback enqueues status completed token orders until credits are fulfilled', async () => {
  const res = responseRecorder();
  const enqueued = [];

  await handlePhonePeCallback({}, res, callbackOptions({
    order: { merchantOrderId: 'CALLBACK-STATUS-COMPLETED-UNFULFILLED', providerState: 'PENDING', status: 'completed' },
    enqueue: async (kind, merchantOrderId) => enqueued.push({ kind, merchantOrderId })
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(enqueued, [{ kind: 'token-order', merchantOrderId: 'CALLBACK-STATUS-COMPLETED-UNFULFILLED' }]);
});

test('PhonePe callback returns controlled 503 when durable enqueue fails', async (t) => {
  const res = responseRecorder();
  const originalError = console.error;
  const enqueueError = new Error('Redis unavailable');
  enqueueError.code = 'JOB_QUEUE_UNAVAILABLE';
  enqueueError.statusCode = 503;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  await handlePhonePeCallback({}, res, callbackOptions({
    order: { merchantOrderId: 'CALLBACK-ENQUEUE-FAIL', providerState: 'PENDING', status: 'pending' },
    enqueue: async () => {
      throw enqueueError;
    }
  }));

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, message: 'Redis unavailable' });
});

test('PhonePe callback does not perform provider reconciliation directly', async (t) => {
  const res = responseRecorder();
  const originalFetch = globalThis.fetch;
  let enqueued = 0;
  globalThis.fetch = async () => {
    throw new Error('provider reconciliation must not run in callback');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handlePhonePeCallback({}, res, callbackOptions({
    order: { merchantOrderId: 'CALLBACK-NO-PROVIDER', providerState: 'PENDING', status: 'pending' },
    enqueue: async () => {
      enqueued += 1;
    }
  }));

  assert.equal(res.statusCode, 202);
  assert.equal(enqueued, 1);
});

test('PhonePe callback fast-acknowledges credited orders without unnecessary enqueue', async () => {
  const res = responseRecorder();
  let enqueued = 0;

  await handlePhonePeCallback({}, res, callbackOptions({
    order: { merchantOrderId: 'CALLBACK-CREDITED', creditedAt: new Date(), providerState: 'COMPLETED', status: 'completed' },
    enqueue: async () => {
      enqueued += 1;
    }
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(enqueued, 0);
});

test('PhonePe callback fast-acknowledges explicit terminal failures without unnecessary enqueue', async () => {
  const terminalFailures = [
    { merchantOrderId: 'CALLBACK-FAILED', providerState: 'FAILED', status: 'failed' },
    { merchantOrderId: 'CALLBACK-CANCELLED', providerState: 'CANCELLED', status: 'pending' },
    { merchantOrderId: 'CALLBACK-EXPIRED', providerState: 'EXPIRED', status: 'pending' },
    { merchantOrderId: 'CALLBACK-TIMEOUT', providerState: 'TIMED_OUT', status: 'pending' }
  ];

  for (const order of terminalFailures) {
    const res = responseRecorder();
    let enqueued = 0;

    await handlePhonePeCallback({}, res, callbackOptions({
      order,
      enqueue: async () => {
        enqueued += 1;
      }
    }));

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(enqueued, 0);
  }
});

test('createPhonePePayment existing-order recovery enqueues completed-but-uncredited token orders', async (t) => {
  restoreEnvironment(t, ['PHONEPE_ENABLED', 'PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION']);
  process.env.PHONEPE_ENABLED = 'true';
  process.env.PHONEPE_CLIENT_ID = 'client';
  process.env.PHONEPE_CLIENT_SECRET = 'secret';
  process.env.PHONEPE_CLIENT_VERSION = '1';
  const originalFindOne = TokenOrder.findOne;
  const existingOrder = {
    merchantOrderId: 'CREATE-COMPLETED-UNFULFILLED',
    providerState: 'COMPLETED',
    status: 'completed',
    creditedAt: null
  };
  const enqueued = [];
  TokenOrder.findOne = async () => existingOrder;
  t.after(() => {
    TokenOrder.findOne = originalFindOne;
  });

  const result = await createPhonePePayment({
    req: checkoutRequest('checkout-completed-unfulfilled-1'),
    user: { _id: 'user-create-recovery' },
    enqueueReconciliation: async (kind, merchantOrderId) => enqueued.push({ kind, merchantOrderId })
  });

  assert.equal(result, existingOrder);
  assert.deepEqual(enqueued, [{ kind: 'token-order', merchantOrderId: 'CREATE-COMPLETED-UNFULFILLED' }]);
});

test('duplicate PhonePe callbacks resolve to the same deterministic BullMQ job identity', async () => {
  const persistedJobs = new Map();
  const fakeRedisBackedEnqueue = async (queueName, jobName, data, options) => {
    if (!persistedJobs.has(options.jobId)) {
      persistedJobs.set(options.jobId, { queueName, jobName, data, options });
    }
    return persistedJobs.get(options.jobId);
  };
  const jobs = [];
  const enqueue = async (kind, merchantOrderId) => {
    const job = await enqueuePhonePeReconciliation(kind, merchantOrderId, { enqueue: fakeRedisBackedEnqueue });
    jobs.push(job);
    return job;
  };
  const order = { merchantOrderId: 'CALLBACK-DUPLICATE', providerState: 'PENDING', status: 'pending' };

  const responses = [responseRecorder(), responseRecorder()];
  await Promise.all(responses.map((res) => handlePhonePeCallback({}, res, callbackOptions({ order, enqueue }))));

  assert.equal(persistedJobs.size, 1);
  assert.deepEqual(responses.map((res) => res.statusCode), [202, 202]);
  assert.equal(jobs[0].options.jobId, 'phonepe-token-order-reconcile-CALLBACK-DUPLICATE');
  assert.equal(jobs[0].options.jobId, jobs[1].options.jobId);
  assert.deepEqual(jobs[0].data, { merchantOrderId: 'CALLBACK-DUPLICATE' });
});

test('product PhonePe callback enqueues durable reconciliation for pending orders', async () => {
  const res = responseRecorder();
  const enqueued = [];

  await handleProductPhonePeCallback({}, res, productCallbackOptions({
    order: { merchantOrderId: 'PRODUCT-CALLBACK-PENDING', providerState: 'PENDING', paymentStatus: 'pending' },
    enqueue: async (kind, merchantOrderId) => enqueued.push({ kind, merchantOrderId })
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(enqueued, [{ kind: 'product-order', merchantOrderId: 'PRODUCT-CALLBACK-PENDING' }]);
});

test('product PhonePe callback enqueues COMPLETED provider state until paid fulfillment is recorded', async () => {
  const res = responseRecorder();
  const enqueued = [];

  await handleProductPhonePeCallback({}, res, productCallbackOptions({
    order: { merchantOrderId: 'PRODUCT-CALLBACK-COMPLETED-UNPAID', providerState: 'COMPLETED', paymentStatus: 'pending' },
    enqueue: async (kind, merchantOrderId) => enqueued.push({ kind, merchantOrderId })
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(enqueued, [{ kind: 'product-order', merchantOrderId: 'PRODUCT-CALLBACK-COMPLETED-UNPAID' }]);
});

test('product PhonePe callback fast-acknowledges paid fulfilled orders without unnecessary enqueue', async () => {
  const res = responseRecorder();
  let enqueued = 0;

  await handleProductPhonePeCallback({}, res, productCallbackOptions({
    order: { merchantOrderId: 'PRODUCT-CALLBACK-PAID', paidAt: new Date(), providerState: 'COMPLETED', paymentStatus: 'paid' },
    enqueue: async () => {
      enqueued += 1;
    }
  }));

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(enqueued, 0);
});

test('product PhonePe callback fast-acknowledges explicit terminal failures without enqueue', async () => {
  const terminalFailures = [
    { merchantOrderId: 'PRODUCT-CALLBACK-FAILED', providerState: 'FAILED', paymentStatus: 'failed' },
    { merchantOrderId: 'PRODUCT-CALLBACK-CANCELLED', providerState: 'CANCELLED', paymentStatus: 'pending' },
    { merchantOrderId: 'PRODUCT-CALLBACK-EXPIRED', providerState: 'EXPIRED', paymentStatus: 'pending' },
    { merchantOrderId: 'PRODUCT-CALLBACK-TIMEOUT', providerState: 'TIMED_OUT', paymentStatus: 'pending' }
  ];

  for (const order of terminalFailures) {
    const res = responseRecorder();
    let enqueued = 0;

    await handleProductPhonePeCallback({}, res, productCallbackOptions({
      order,
      enqueue: async () => {
        enqueued += 1;
      }
    }));

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(enqueued, 0);
  }
});

test('product PhonePe callback returns controlled 503 when durable enqueue fails', async (t) => {
  const res = responseRecorder();
  const originalError = console.error;
  const enqueueError = new Error('Redis unavailable');
  enqueueError.code = 'JOB_QUEUE_UNAVAILABLE';
  enqueueError.statusCode = 503;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  await handleProductPhonePeCallback({}, res, productCallbackOptions({
    order: { merchantOrderId: 'PRODUCT-CALLBACK-QUEUE-FAIL', providerState: 'PENDING', paymentStatus: 'pending' },
    enqueue: async () => {
      throw enqueueError;
    }
  }));

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, message: 'Redis unavailable' });
});

test('product PhonePe callback does not perform provider reconciliation directly', async (t) => {
  const res = responseRecorder();
  const originalFetch = globalThis.fetch;
  let enqueued = 0;
  globalThis.fetch = async () => {
    throw new Error('provider reconciliation must not run in product callback');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleProductPhonePeCallback({}, res, productCallbackOptions({
    order: { merchantOrderId: 'PRODUCT-CALLBACK-NO-PROVIDER', providerState: 'PENDING', paymentStatus: 'pending' },
    enqueue: async () => {
      enqueued += 1;
    }
  }));

  assert.equal(res.statusCode, 202);
  assert.equal(enqueued, 1);
});

test('duplicate product PhonePe callbacks resolve to the same deterministic BullMQ job identity', async () => {
  const persistedJobs = new Map();
  const fakeRedisBackedEnqueue = async (queueName, jobName, data, options) => {
    if (!persistedJobs.has(options.jobId)) {
      persistedJobs.set(options.jobId, { queueName, jobName, data, options });
    }
    return persistedJobs.get(options.jobId);
  };
  const jobs = [];
  const enqueue = async (kind, merchantOrderId) => {
    const job = await enqueuePhonePeReconciliation(kind, merchantOrderId, { enqueue: fakeRedisBackedEnqueue });
    jobs.push(job);
    return job;
  };
  const order = { merchantOrderId: 'PRODUCT-CALLBACK-DUPLICATE', providerState: 'PENDING', paymentStatus: 'pending' };

  await handleProductPhonePeCallback({}, responseRecorder(), productCallbackOptions({ order, enqueue }));
  await handleProductPhonePeCallback({}, responseRecorder(), productCallbackOptions({ order, enqueue }));

  assert.equal(persistedJobs.size, 1);
  assert.equal(jobs[0].options.jobId, 'phonepe-product-order-reconcile-PRODUCT-CALLBACK-DUPLICATE');
  assert.equal(jobs[0].options.jobId, jobs[1].options.jobId);
  assert.deepEqual(jobs[0].data, { merchantOrderId: 'PRODUCT-CALLBACK-DUPLICATE' });
});

test('PhonePe job payload survives request-process loss and refetches authoritative state', async () => {
  const durableJob = structuredClone(phonePeReconciliationJobSpec('token-order', 'MERCHANT-RESTART'));
  let reconciled = 0;

  const result = await runPhonePeTokenOrderReconciliationJob(durableJob.data, {
    findOrder: async (merchantOrderId) => ({ merchantOrderId, providerState: 'PENDING', status: 'pending' }),
    reconcile: async (order) => {
      reconciled += 1;
      return { order: { ...order, providerState: 'COMPLETED', status: 'completed', creditedAt: new Date() } };
    }
  });

  assert.equal(reconciled, 1);
  assert.deepEqual(result, { status: 'completed', providerState: 'COMPLETED' });
  assert.deepEqual(durableJob.data, { merchantOrderId: 'MERCHANT-RESTART' });
});

test('pending PhonePe reconciliation requests bounded BullMQ retries with fixed backoff', async () => {
  const spec = phonePeReconciliationJobSpec('token-order', 'MERCHANT-PENDING', {
    PHONEPE_SHORT_POLL_ATTEMPTS: '3',
    PHONEPE_SHORT_POLL_MS: '750'
  });
  let providerChecks = 0;
  const runAttempt = () => runPhonePeTokenOrderReconciliationJob(spec.data, {
    findOrder: async () => ({ providerState: 'PENDING', status: 'pending' }),
    reconcile: async (order) => {
      providerChecks += 1;
      return { order };
    }
  });

  for (let attempt = 0; attempt < spec.options.attempts; attempt += 1) {
    await assert.rejects(runAttempt, (error) => error.code === 'PHONEPE_RECONCILIATION_PENDING');
  }

  assert.equal(providerChecks, 3);
  assert.equal(spec.options.delay, 750);
  assert.deepEqual(spec.options.backoff, { type: 'fixed', delay: 750 });
  assert.equal(spec.options.attempts, 3);
});

test('successful and permanently timed-out payment states stop without another provider reconciliation', async () => {
  let tokenReconciles = 0;
  const tokenResult = await runPhonePeTokenOrderReconciliationJob({ merchantOrderId: 'TOKEN-DONE' }, {
    findOrder: async () => ({ creditedAt: new Date(), providerState: 'COMPLETED', status: 'completed' }),
    reconcile: async () => {
      tokenReconciles += 1;
    }
  });

  let productReconciles = 0;
  const productResult = await runPhonePeProductOrderReconciliationJob({ merchantOrderId: 'PRODUCT-FAILED' }, {
    findOrder: async () => ({ providerState: 'TIMEOUT', paymentStatus: 'failed' }),
    reconcile: async () => {
      productReconciles += 1;
    }
  });

  assert.equal(tokenReconciles, 0);
  assert.deepEqual(tokenResult, { status: 'completed', providerState: 'COMPLETED' });
  assert.equal(productReconciles, 0);
  assert.deepEqual(productResult, { status: 'failed', providerState: 'TIMEOUT' });
});

test('critical enqueue fails with a controlled 503 when Redis is unavailable', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'QUEUE_ENABLED', 'REDIS_URL']);
  process.env.NODE_ENV = 'production';
  process.env.QUEUE_ENABLED = 'true';
  delete process.env.REDIS_URL;

  await assert.rejects(
    enqueueCriticalJob('payments', 'phonepe-token-order-reconcile', { merchantOrderId: 'NO-REDIS' }),
    (error) => error.code === 'JOB_QUEUE_UNAVAILABLE' && error.statusCode === 503
  );
});

test('production profile generation never falls back to the API process', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'QUEUE_ENABLED', 'REDIS_URL', 'PROFILE_FULL_BODY_QUEUE_MODE', 'PROFILE_FULL_BODY_GENERATION']);
  process.env.NODE_ENV = 'production';
  process.env.QUEUE_ENABLED = 'true';
  process.env.PROFILE_FULL_BODY_QUEUE_MODE = 'inline';
  process.env.PROFILE_FULL_BODY_GENERATION = 'true';
  delete process.env.REDIS_URL;
  let localRuns = 0;

  await assert.rejects(
    generateFullBodyProfileInBackground('user-1', { path: 'uploads/profiles/source.jpg', storage: 'bunny' }, {
      runLocal: async () => {
        localRuns += 1;
      }
    }),
    (error) => error.code === 'JOB_QUEUE_UNAVAILABLE' && error.statusCode === 503
  );
  await nextImmediate();
  assert.equal(localRuns, 0);
});

test('non-production profile fallback is explicit and remains locally usable', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'PROFILE_FULL_BODY_QUEUE_MODE', 'PROFILE_FULL_BODY_GENERATION']);
  process.env.NODE_ENV = 'test';
  process.env.PROFILE_FULL_BODY_QUEUE_MODE = 'worker';
  process.env.PROFILE_FULL_BODY_GENERATION = 'true';
  let localRuns = 0;

  await generateFullBodyProfileInBackground('user-2', { path: 'profiles/source.jpg' }, {
    enqueue: async () => null,
    runLocal: async () => {
      localRuns += 1;
    }
  });
  await nextImmediate();
  assert.equal(localRuns, 1);
});
