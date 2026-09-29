import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import test from 'node:test';
import AppleTransaction from '../server/models/AppleTransaction.js';
import CreditEvent from '../server/models/CreditEvent.js';
import TokenOrder from '../server/models/TokenOrder.js';
import User from '../server/models/User.js';
import {
  grantAppleCreditsOnce,
  grantPaidTokens,
  grantRazorpayMandateSetupTokens,
  grantRazorpaySubscriptionCycleTokens,
  runLocalPaymentTransaction,
  setLocalPaymentTransactionRunnerForTests
} from '../server/routes/payments.js';
import { SUBSCRIPTION_PLAN } from '../shared/pricing.js';

function restoreModelMethods(t, replacements) {
  const originals = replacements.map(([model, name]) => [model, name, model[name]]);
  t.after(() => {
    for (const [model, name, original] of originals) {
      model[name] = original;
    }
  });
}

function tokenOrder(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    user: '507f1f77bcf86cd799439012',
    merchantOrderId: 'PHASE7-TOKEN-ORDER',
    provider: 'phonepe',
    phonePeOrderId: 'OMO_PHASE7',
    planId: 'topup_7',
    orderType: 'topup',
    tokens: 7,
    status: 'pending',
    providerState: 'PENDING',
    creditedAt: null,
    ...overrides
  };
}

function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function installNonTransactionalTestRunner(t) {
  setLocalPaymentTransactionRunnerForTests(async (work) => work(null));
  t.after(() => setLocalPaymentTransactionRunnerForTests(null));
}

test('Phase 7: production unavailable Mongo transaction returns 503 before fulfillment work runs', async (t) => {
  withEnv(t, 'NODE_ENV', 'production');
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

test('Phase 7: production transaction start failure returns 503 before fulfillment work runs', async (t) => {
  withEnv(t, 'NODE_ENV', 'production');
  let workCalls = 0;

  await assert.rejects(
    runLocalPaymentTransaction(async () => {
      workCalls += 1;
    }, {
      connectionReadyState: () => 1,
      startSession: async () => {
        throw new Error('Mongo session unavailable');
      }
    }),
    (error) => error.code === 'PAYMENT_TRANSACTION_UNAVAILABLE' && error.statusCode === 503
  );
  assert.equal(workCalls, 0);
});

test('Phase 7: successful payment transaction executes fulfillment work with a session', async () => {
  const session = {
    id: 'session-1',
    async withTransaction(work) {
      return work();
    },
    async endSession() {
      this.ended = true;
    }
  };
  let receivedSession = null;

  const result = await runLocalPaymentTransaction(async (activeSession) => {
    receivedSession = activeSession;
    return 'committed';
  }, {
    connectionReadyState: () => 1,
    startSession: async () => session
  });

  assert.equal(result, 'committed');
  assert.equal(receivedSession, session);
  assert.equal(session.ended, true);
});

test('Phase 7: explicit non-production test fallback is intentional and unavailable in production', async (t) => {
  withEnv(t, 'NODE_ENV', 'test');
  let workCalls = 0;
  const result = await runLocalPaymentTransaction(async (session) => {
    workCalls += 1;
    assert.equal(session, null);
    return 'test-fallback';
  }, {
    allowNonTransactionalForTests: true,
    connectionReadyState: () => 0
  });

  assert.equal(result, 'test-fallback');
  assert.equal(workCalls, 1);

  process.env.NODE_ENV = 'production';
  await assert.rejects(
    runLocalPaymentTransaction(async () => {
      throw new Error('must not run');
    }, {
      allowNonTransactionalForTests: true,
      connectionReadyState: () => 0
    }),
    (error) => error.code === 'PAYMENT_TRANSACTION_UNAVAILABLE' && error.statusCode === 503
  );
});

test('Phase 7: token fulfillment does not mark order credited when ledger write fails', async (t) => {
  installNonTransactionalTestRunner(t);
  const order = tokenOrder();
  let balanceMutations = 0;
  let orderFulfillmentWrites = 0;

  restoreModelMethods(t, [
    [TokenOrder, 'findById'],
    [TokenOrder, 'findOneAndUpdate'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.findById = async () => order;
  TokenOrder.findOneAndUpdate = async () => {
    orderFulfillmentWrites += 1;
    return { ...order, status: 'completed', creditedAt: new Date() };
  };
  User.findOneAndUpdate = async (_filter, update) => {
    balanceMutations += Number(update.$inc?.tokens || 0);
    return { _id: order.user, tokens: balanceMutations };
  };
  CreditEvent.findOne = async () => null;
  CreditEvent.create = async () => {
    const error = new Error('ledger write failed');
    error.code = 'ledger_write_failed';
    throw error;
  };

  await assert.rejects(
    grantPaidTokens(order, { state: 'COMPLETED' }),
    /ledger write failed/
  );
  assert.equal(orderFulfillmentWrites, 0);
});

test('Phase 7: existing token fulfillment event completes missing order marker without double credit', async (t) => {
  installNonTransactionalTestRunner(t);
  const order = tokenOrder({ status: 'completed', providerState: 'COMPLETED' });
  let balanceMutations = 0;
  let orderFulfillmentWrites = 0;

  restoreModelMethods(t, [
    [TokenOrder, 'findById'],
    [TokenOrder, 'findOneAndUpdate'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.findById = async () => order;
  TokenOrder.findOneAndUpdate = async () => {
    orderFulfillmentWrites += 1;
    return { ...order, status: 'completed', creditedAt: new Date() };
  };
  User.findById = async () => ({ _id: order.user, tokens: 99 });
  User.findOneAndUpdate = async (_filter, update) => {
    balanceMutations += Number(update.$inc?.tokens || 0);
    return { _id: order.user, tokens: 99 + balanceMutations };
  };
  CreditEvent.findOne = async () => ({
    _id: 'credit-event-existing',
    fulfillmentKey: `token_order:${order._id}`,
    tokens: order.tokens
  });
  CreditEvent.create = async () => {
    throw new Error('duplicate fulfillment must not create another ledger event');
  };

  const user = await grantPaidTokens(order, { state: 'COMPLETED' });
  assert.equal(user.tokens, 99);
  assert.equal(balanceMutations, 0);
  assert.equal(orderFulfillmentWrites, 1);
});

test('Phase 7: expected token fulfillment duplicate recovers missing order marker without another credit', async (t) => {
  installNonTransactionalTestRunner(t);
  const order = tokenOrder({ status: 'completed', providerState: 'COMPLETED' });
  let balanceMutations = 0;
  let orderFulfillmentWrites = 0;
  let creditEventLookupCount = 0;

  restoreModelMethods(t, [
    [TokenOrder, 'findById'],
    [TokenOrder, 'findOneAndUpdate'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.findById = async () => order;
  TokenOrder.findOneAndUpdate = async () => {
    orderFulfillmentWrites += 1;
    return { ...order, status: 'completed', creditedAt: new Date() };
  };
  User.findById = async () => ({ _id: order.user, tokens: 77 });
  User.findOneAndUpdate = async (_filter, update) => {
    balanceMutations += Number(update.$inc?.tokens || 0);
    return { _id: order.user, tokens: 77 + balanceMutations };
  };
  CreditEvent.findOne = async (filter) => {
    creditEventLookupCount += 1;
    if (creditEventLookupCount === 1) return null;
    assert.deepEqual(filter, { fulfillmentKey: `token_order:${order._id}` });
    return { _id: 'credit-event-expected-token', fulfillmentKey: `token_order:${order._id}` };
  };
  CreditEvent.create = async () => {
    const error = new Error('duplicate fulfillment key');
    error.code = 11000;
    throw error;
  };

  const user = await grantPaidTokens(order, { state: 'COMPLETED' });
  assert.equal(user.tokens, 77);
  assert.equal(balanceMutations, order.tokens);
  assert.equal(orderFulfillmentWrites, 1);
});

test('Phase 7: unrelated token duplicate key is rethrown and does not recover marker', async (t) => {
  installNonTransactionalTestRunner(t);
  const order = tokenOrder();
  const duplicateError = new Error('duplicate unrelated unique index');
  duplicateError.code = 11000;
  let orderFulfillmentWrites = 0;

  restoreModelMethods(t, [
    [TokenOrder, 'findById'],
    [TokenOrder, 'findOneAndUpdate'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.findById = async () => order;
  TokenOrder.findOneAndUpdate = async () => {
    orderFulfillmentWrites += 1;
    return { ...order, status: 'completed', creditedAt: new Date() };
  };
  User.findOneAndUpdate = async () => ({ _id: order.user, tokens: order.tokens });
  CreditEvent.findOne = async () => null;
  CreditEvent.create = async () => {
    throw duplicateError;
  };

  await assert.rejects(grantPaidTokens(order, { state: 'COMPLETED' }), duplicateError);
  assert.equal(orderFulfillmentWrites, 0);
});

test('Phase 7: Razorpay mandate setup duplicate succeeds only with expected fulfillment event', async (t) => {
  installNonTransactionalTestRunner(t);
  const order = tokenOrder({
    provider: 'razorpay',
    orderType: 'subscription',
    merchantSubscriptionId: 'sub_setup_phase7',
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    dueTodayAmount: SUBSCRIPTION_PLAN.mandate.setupAmount
  });
  let creditEventLookupCount = 0;

  restoreModelMethods(t, [
    [TokenOrder, 'updateOne'],
    [TokenOrder, 'findById'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.updateOne = async () => ({ modifiedCount: 1 });
  TokenOrder.findById = async () => order;
  User.findById = async () => ({ _id: order.user, tokens: 10 });
  User.findOneAndUpdate = async () => ({ _id: order.user, tokens: 10 + SUBSCRIPTION_PLAN.setupTokens });
  CreditEvent.findOne = async (filter) => {
    creditEventLookupCount += 1;
    if (creditEventLookupCount === 1) return null;
    assert.deepEqual(filter, { fulfillmentKey: `razorpay_mandate_setup:user:${order.user}` });
    return { _id: 'credit-event-mandate', fulfillmentKey: `razorpay_mandate_setup:user:${order.user}` };
  };
  CreditEvent.create = async () => {
    const error = new Error('duplicate expected mandate');
    error.code = 11000;
    throw error;
  };

  const result = await grantRazorpayMandateSetupTokens({
    order,
    subscription: { id: 'sub_setup_phase7', status: 'authenticated' },
    payment: { id: 'pay_setup_phase7', subscription_id: 'sub_setup_phase7', amount: SUBSCRIPTION_PLAN.mandate.setupAmount }
  });
  assert.equal(result.alreadyCredited, true);
  assert.equal(result.setupCredited, false);
});

test('Phase 7: unrelated Razorpay mandate duplicate key is rethrown', async (t) => {
  installNonTransactionalTestRunner(t);
  const order = tokenOrder({
    provider: 'razorpay',
    orderType: 'subscription',
    merchantSubscriptionId: 'sub_setup_phase7_bad',
    dueTodayAmount: SUBSCRIPTION_PLAN.mandate.setupAmount
  });
  const duplicateError = new Error('duplicate unrelated mandate index');
  duplicateError.code = 11000;

  restoreModelMethods(t, [
    [TokenOrder, 'updateOne'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.updateOne = async () => ({ modifiedCount: 1 });
  User.findOneAndUpdate = async () => ({ _id: order.user, tokens: SUBSCRIPTION_PLAN.setupTokens });
  CreditEvent.findOne = async () => null;
  CreditEvent.create = async () => {
    throw duplicateError;
  };

  await assert.rejects(
    grantRazorpayMandateSetupTokens({
      order,
      subscription: { id: 'sub_setup_phase7_bad', status: 'authenticated' },
      payment: { id: 'pay_setup_phase7_bad', subscription_id: 'sub_setup_phase7_bad', amount: SUBSCRIPTION_PLAN.mandate.setupAmount }
    }),
    duplicateError
  );
});

test('Phase 7: Razorpay monthly cycle uses one deterministic fulfillment key for duplicate delivery', async (t) => {
  installNonTransactionalTestRunner(t);
  const parentOrder = tokenOrder({
    _id: '507f1f77bcf86cd799439021',
    user: '507f1f77bcf86cd799439022',
    provider: 'razorpay',
    orderType: 'subscription',
    planId: SUBSCRIPTION_PLAN.id,
    tokens: SUBSCRIPTION_PLAN.tokens,
    merchantOrderId: 'RZP-SUB-PARENT',
    merchantSubscriptionId: 'sub_phase7',
    razorpaySubscriptionId: 'sub_phase7',
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount
  });
  const fulfillmentKeys = [];
  let cycleOrder = null;
  let creditedTokens = 0;
  let existingEvent = null;

  restoreModelMethods(t, [
    [TokenOrder, 'findOne'],
    [TokenOrder, 'create'],
    [TokenOrder, 'updateOne'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  TokenOrder.findOne = async (filter = {}) => {
    if (filter.merchantOrderId && filter.merchantOrderId !== parentOrder.merchantOrderId) return cycleOrder;
    return parentOrder;
  };
  TokenOrder.create = async (doc) => {
    cycleOrder = { _id: '507f1f77bcf86cd799439023', ...doc };
    return cycleOrder;
  };
  TokenOrder.updateOne = async () => ({ modifiedCount: 1 });
  User.findById = async () => ({ _id: parentOrder.user, tokens: creditedTokens });
  User.findOneAndUpdate = async (_filter, update) => {
    creditedTokens += Number(update.$inc?.tokens || 0);
    return { _id: parentOrder.user, tokens: creditedTokens };
  };
  CreditEvent.findOne = async () => existingEvent;
  CreditEvent.create = async (docOrDocs) => {
    const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
    fulfillmentKeys.push(doc.fulfillmentKey);
    existingEvent = { _id: 'credit-event-monthly', ...doc };
    return existingEvent;
  };

  const args = {
    order: parentOrder,
    subscription: { id: 'sub_phase7', status: 'active' },
    payment: { id: 'pay_phase7', subscription_id: 'sub_phase7', amount: SUBSCRIPTION_PLAN.mandate.recurringAmount },
    invoice: { id: 'inv_phase7', subscription_id: 'sub_phase7' },
    providerResponse: { verifiedBy: 'phase7-test' }
  };
  const first = await grantRazorpaySubscriptionCycleTokens(args);
  const duplicate = await grantRazorpaySubscriptionCycleTokens(args);

  assert.equal(first.alreadyCredited, false);
  assert.equal(duplicate.alreadyCredited, true);
  assert.equal(creditedTokens, SUBSCRIPTION_PLAN.tokens);
  assert.deepEqual(fulfillmentKeys, ['razorpay_subscription:sub_phase7:inv_phase7']);
});

test('Phase 7: unrelated Razorpay monthly duplicate key is rethrown', async (t) => {
  installNonTransactionalTestRunner(t);
  const parentOrder = tokenOrder({
    user: '507f1f77bcf86cd799439042',
    provider: 'razorpay',
    orderType: 'subscription',
    planId: SUBSCRIPTION_PLAN.id,
    tokens: SUBSCRIPTION_PLAN.tokens,
    merchantOrderId: 'RZP-SUB-PARENT-BAD',
    merchantSubscriptionId: 'sub_phase7_bad',
    razorpaySubscriptionId: 'sub_phase7_bad',
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount
  });
  const duplicateError = new Error('duplicate unrelated cycle index');
  duplicateError.code = 11000;

  restoreModelMethods(t, [
    [TokenOrder, 'findOne'],
    [TokenOrder, 'create'],
    [CreditEvent, 'findOne']
  ]);

  TokenOrder.findOne = async () => null;
  TokenOrder.create = async () => {
    throw duplicateError;
  };
  CreditEvent.findOne = async () => null;

  await assert.rejects(
    grantRazorpaySubscriptionCycleTokens({
      order: parentOrder,
      subscription: { id: 'sub_phase7_bad', status: 'active' },
      payment: { id: 'pay_phase7_bad', subscription_id: 'sub_phase7_bad', amount: SUBSCRIPTION_PLAN.mandate.recurringAmount },
      invoice: { id: 'inv_phase7_bad', subscription_id: 'sub_phase7_bad' }
    }),
    duplicateError
  );
});

test('Phase 7: Razorpay monthly duplicate requires same logical cycle order', async (t) => {
  installNonTransactionalTestRunner(t);
  const parentOrder = tokenOrder({
    user: '507f1f77bcf86cd799439052',
    provider: 'razorpay',
    orderType: 'subscription',
    planId: SUBSCRIPTION_PLAN.id,
    tokens: SUBSCRIPTION_PLAN.tokens,
    merchantOrderId: 'RZP-SUB-PARENT-MISMATCH',
    merchantSubscriptionId: 'sub_phase7_match',
    razorpaySubscriptionId: 'sub_phase7_match',
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount
  });
  const duplicateError = new Error('duplicate cycle order mismatch');
  duplicateError.code = 11000;
  let lookupCount = 0;
  let creditEventLookupCount = 0;

  restoreModelMethods(t, [
    [TokenOrder, 'findOne'],
    [TokenOrder, 'create'],
    [User, 'findById'],
    [CreditEvent, 'findOne']
  ]);

  TokenOrder.findOne = async (filter = {}) => {
    if (filter.merchantOrderId) {
      lookupCount += 1;
      if (lookupCount === 1) return null;
      return {
        merchantOrderId: filter.merchantOrderId,
        merchantSubscriptionId: 'different_sub',
        razorpayInvoiceId: 'inv_phase7_match'
      };
    }
    return parentOrder;
  };
  TokenOrder.create = async () => {
    throw duplicateError;
  };
  User.findById = async () => ({ _id: parentOrder.user, tokens: 0 });
  CreditEvent.findOne = async (filter) => {
    creditEventLookupCount += 1;
    if (creditEventLookupCount === 1) return null;
    if (filter.fulfillmentKey === 'razorpay_subscription:sub_phase7_match:inv_phase7_match') {
      return { _id: 'credit-event-cycle-expected', fulfillmentKey: filter.fulfillmentKey };
    }
    return null;
  };

  await assert.rejects(
    grantRazorpaySubscriptionCycleTokens({
      order: parentOrder,
      subscription: { id: 'sub_phase7_match', status: 'active' },
      payment: { id: 'pay_phase7_match', subscription_id: 'sub_phase7_match', amount: SUBSCRIPTION_PLAN.mandate.recurringAmount },
      invoice: { id: 'inv_phase7_match', subscription_id: 'sub_phase7_match' }
    }),
    duplicateError
  );
});

test('Phase 7: duplicate Apple StoreKit delivery does not grant credits twice', async (t) => {
  const userId = '507f1f77bcf86cd799439032';
  const record = {
    _id: '507f1f77bcf86cd799439033',
    user: userId,
    fulfillmentKey: 'apple:consumable:tx_phase7',
    environment: 'Sandbox',
    creditsGranted: 0,
    status: 'verified',
    async save() {
      savedRecord = { ...this };
      return this;
    }
  };
  let savedRecord = record;
  let creditedTokens = 0;
  let existingEvent = null;
  const fakeSession = {
    async withTransaction(work) {
      await work();
    },
    async endSession() {}
  };

  restoreModelMethods(t, [
    [mongoose, 'startSession'],
    [AppleTransaction, 'findOne'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  mongoose.startSession = async () => fakeSession;
  AppleTransaction.findOne = () => ({
    session: async () => savedRecord
  });
  User.findById = () => ({
    session: async () => ({ _id: userId, tokens: creditedTokens })
  });
  User.findOneAndUpdate = async (_filter, update) => {
    creditedTokens += Number(update.$inc?.tokens || 0);
    return { _id: userId, tokens: creditedTokens };
  };
  CreditEvent.findOne = () => ({
    session: async () => existingEvent
  });
  CreditEvent.create = async (docOrDocs) => {
    const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
    existingEvent = { _id: 'credit-event-apple', ...doc };
    return [existingEvent];
  };

  const args = {
    record,
    user: { _id: userId },
    productConfig: { kind: 'consumable', credits: 150, name: '150 credits', planId: 'apple_credits_150' },
    transaction: { transactionId: 'tx_phase7', productId: 'lookmefy.credits.150' },
    renewalInfo: null,
    subscriptionStatus: ''
  };
  const first = await grantAppleCreditsOnce(args);
  const duplicate = await grantAppleCreditsOnce(args);

  assert.equal(first.grantedCredits, 150);
  assert.equal(duplicate.grantedCredits, 0);
  assert.equal(creditedTokens, 150);
  assert.equal(savedRecord.creditsGranted, 150);
  assert.equal(existingEvent.fulfillmentKey, 'apple:consumable:tx_phase7');
});

test('Phase 7: expected Apple duplicate key returns already credited only with expected transaction record', async (t) => {
  const userId = '507f1f77bcf86cd799439062';
  const record = {
    _id: '507f1f77bcf86cd799439063',
    user: userId,
    fulfillmentKey: 'apple:consumable:tx_phase7_expected',
    environment: 'Sandbox',
    creditsGranted: 0,
    status: 'verified',
    async save() {
      return this;
    }
  };
  const duplicateError = new Error('duplicate expected Apple fulfillment');
  duplicateError.code = 11000;
  const fakeSession = {
    async withTransaction(work) {
      await work();
    },
    async endSession() {}
  };

  restoreModelMethods(t, [
    [mongoose, 'startSession'],
    [AppleTransaction, 'findOne'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  mongoose.startSession = async () => fakeSession;
  AppleTransaction.findOne = (filter = {}) => {
    if (filter.transactionId === 'tx_phase7_expected' && filter.fulfillmentKey === 'apple:consumable:tx_phase7_expected') {
      return { ...record, transactionId: 'tx_phase7_expected', creditsGranted: 150 };
    }
    return { session: async () => record };
  };
  User.findById = () => ({
    session: async () => ({ _id: userId, tokens: 150 })
  });
  User.findOneAndUpdate = async () => ({ _id: userId, tokens: 150 });
  CreditEvent.findOne = () => ({
    session: async () => null
  });
  CreditEvent.create = async () => {
    throw duplicateError;
  };

  const result = await grantAppleCreditsOnce({
    record,
    user: { _id: userId },
    productConfig: { kind: 'consumable', credits: 150, name: '150 credits', planId: 'apple_credits_150' },
    transaction: { transactionId: 'tx_phase7_expected', productId: 'lookmefy.credits.150' },
    renewalInfo: null,
    subscriptionStatus: ''
  });

  assert.equal(result.grantedCredits, 0);
  assert.equal(result.alreadyCredited, true);
  assert.equal(result.record.transactionId, 'tx_phase7_expected');
});

test('Phase 7: unrelated Apple duplicate key is rethrown', async (t) => {
  const userId = '507f1f77bcf86cd799439072';
  const record = {
    _id: '507f1f77bcf86cd799439073',
    user: userId,
    fulfillmentKey: 'apple:consumable:tx_phase7_unrelated',
    environment: 'Sandbox',
    creditsGranted: 0,
    status: 'verified',
    async save() {
      return this;
    }
  };
  const duplicateError = new Error('duplicate unrelated Apple index');
  duplicateError.code = 11000;
  const fakeSession = {
    async withTransaction(work) {
      await work();
    },
    async endSession() {}
  };

  restoreModelMethods(t, [
    [mongoose, 'startSession'],
    [AppleTransaction, 'findOne'],
    [User, 'findById'],
    [User, 'findOneAndUpdate'],
    [CreditEvent, 'findOne'],
    [CreditEvent, 'create']
  ]);

  mongoose.startSession = async () => fakeSession;
  AppleTransaction.findOne = (filter = {}) => {
    if (filter.transactionId === 'tx_phase7_unrelated' && filter.fulfillmentKey === 'apple:consumable:tx_phase7_unrelated') {
      return null;
    }
    return { session: async () => record };
  };
  User.findById = () => ({
    session: async () => ({ _id: userId, tokens: 0 })
  });
  User.findOneAndUpdate = async () => ({ _id: userId, tokens: 150 });
  CreditEvent.findOne = () => ({
    session: async () => null
  });
  CreditEvent.create = async () => {
    throw duplicateError;
  };

  await assert.rejects(
    grantAppleCreditsOnce({
      record,
      user: { _id: userId },
      productConfig: { kind: 'consumable', credits: 150, name: '150 credits', planId: 'apple_credits_150' },
      transaction: { transactionId: 'tx_phase7_unrelated', productId: 'lookmefy.credits.150' },
      renewalInfo: null,
      subscriptionStatus: ''
    }),
    duplicateError
  );
});
