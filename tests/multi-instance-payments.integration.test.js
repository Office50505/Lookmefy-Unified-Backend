import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import AppleTransaction from '../server/models/AppleTransaction.js';
import BlockedIp from '../server/models/BlockedIp.js';
import CreditEvent from '../server/models/CreditEvent.js';
import ProductOrder from '../server/models/ProductOrder.js';
import TokenOrder from '../server/models/TokenOrder.js';
import User from '../server/models/User.js';
import { updateAdminTokensAtomic } from '../server/utils/accountState.js';
import { createBlockedIp, ipBlocklistMiddleware } from '../server/utils/ipBlocklist.js';
import { grantAppleCreditsOnce, grantPaidTokens, grantRazorpaySubscriptionCycleTokens } from '../server/routes/payments.js';
import { reserveClosetToken, refundClosetToken } from '../server/routes/closet.js';
import { reconcileProductOrder } from '../server/routes/orders.js';
import { reserveTryOnToken, refundTryOnToken } from '../server/routes/tryons.js';
import { SUBSCRIPTION_PLAN } from '../shared/pricing.js';

const uri = process.env.LOOKMEFY_INTEGRATION_MONGO_URI;

async function setup(t) {
  await mongoose.connect(uri, { dbName: `lookmefy_phase7_${process.pid}_${Date.now()}` });
  t.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all([User.syncIndexes(), TokenOrder.syncIndexes(), CreditEvent.syncIndexes(), AppleTransaction.syncIndexes()]);
  return User.create({ name: 'Payment Test', email: `phase7-${Date.now()}@example.test`, passwordHash: 'test-hash', tokens: 0 });
}

function orderFor(user, overrides = {}) {
  return {
    user: user._id, merchantOrderId: `merchant-${Math.random()}`,
    provider: 'phonepe', planId: 'topup_7', planName: 'Seven credits',
    orderType: 'topup', amount: 100, dueTodayAmount: 100, tokens: 7,
    ...overrides
  };
}

test('real Mongo transactions deduplicate concurrent PhonePe token fulfillment and admin changes', { skip: !uri }, async (t) => {
  const user = await setup(t);
  const order = await TokenOrder.create(orderFor(user));
  await Promise.all([
    grantPaidTokens(order, { state: 'COMPLETED' }),
    grantPaidTokens(order, { state: 'COMPLETED' }),
    updateAdminTokensAtomic(User, user._id, 'add', 5)
  ]);
  assert.equal((await User.findById(user._id)).tokens, 12);
  assert.equal(await CreditEvent.countDocuments({ fulfillmentKey: `token_order:${order._id}` }), 1);
  assert.ok((await TokenOrder.findById(order._id)).creditedAt);
});

test('real Mongo transactions deduplicate concurrent Razorpay webhook shapes for one payment', { skip: !uri }, async (t) => {
  const user = await setup(t);
  const order = await TokenOrder.create(orderFor(user, {
    provider: 'razorpay', planId: SUBSCRIPTION_PLAN.id, planName: SUBSCRIPTION_PLAN.name,
    orderType: 'subscription', merchantSubscriptionId: 'sub-one', razorpaySubscriptionId: 'sub-one',
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount, tokens: SUBSCRIPTION_PLAN.tokens
  }));
  const payment = { id: 'pay-one', subscription_id: 'sub-one', amount: SUBSCRIPTION_PLAN.mandate.recurringAmount, status: 'captured' };
  await Promise.all([
    grantRazorpaySubscriptionCycleTokens({ order, payment, invoice: { id: 'inv-one' } }),
    grantRazorpaySubscriptionCycleTokens({ order, payment, invoice: {} })
  ]);
  assert.equal((await User.findById(user._id)).tokens, SUBSCRIPTION_PLAN.tokens);
  assert.equal(await CreditEvent.countDocuments({ fulfillmentKey: 'razorpay_subscription:sub-one:pay-one' }), 1);
});

test('real Mongo transactions deduplicate concurrent Apple notification and client verification', { skip: !uri }, async (t) => {
  const user = await setup(t);
  const record = await AppleTransaction.create({
    user: user._id, productId: 'com.lookmefy.credits150', productKind: 'consumable',
    transactionId: 'apple-tx-one', fulfillmentKey: 'apple:consumable:apple-tx-one', creditsGranted: 0
  });
  const args = {
    record, user, productConfig: { kind: 'consumable', credits: 150, name: '150 credits' },
    transaction: { transactionId: 'apple-tx-one', productId: 'com.lookmefy.credits150' }
  };
  await Promise.all([grantAppleCreditsOnce(args), grantAppleCreditsOnce(args)]);
  assert.equal((await User.findById(user._id)).tokens, 150);
  assert.equal(await CreditEvent.countDocuments({ fulfillmentKey: record.fulfillmentKey }), 1);
  assert.equal((await AppleTransaction.findById(record._id)).creditsGranted, 150);
});

test('closet and try-on atomic reserve/refund cannot overwrite a concurrent payment grant', { skip: !uri }, async (t) => {
  const user = await setup(t);
  await User.updateOne({ _id: user._id }, { $set: { tokens: 10 } });
  user.tokens = 10;
  const timer = { mark() {} };
  const order = await TokenOrder.create(orderFor(user));
  await Promise.all([
    reserveClosetToken(user, timer),
    reserveTryOnToken(user, timer, 1),
    grantPaidTokens(order, { state: 'COMPLETED' })
  ]);
  assert.equal((await User.findById(user._id)).tokens, 15);
  await Promise.all([refundClosetToken(user, timer), refundTryOnToken(user, timer, 1)]);
  assert.equal((await User.findById(user._id)).tokens, 17);
});

test('real Mongo block and unblock are immediately visible to both API handlers', { skip: !uri }, async (t) => {
  await setup(t);
  await BlockedIp.syncIndexes();
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const handlerA = ipBlocklistMiddleware();
  const handlerB = ipBlocklistMiddleware();
  const req = { ip: '203.0.113.73', path: '/api/products', method: 'GET', get: () => '' };
  const call = async (handler) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
    let allowed = false;
    await handler(req, res, () => { allowed = true; });
    return { allowed, statusCode: res.statusCode };
  };
  assert.equal((await call(handlerA)).allowed, true);
  const block = await createBlockedIp({ value: req.ip, reason: 'Integration test' });
  assert.equal((await call(handlerB)).statusCode, 403);
  assert.equal((await call(handlerA)).statusCode, 403);
  await BlockedIp.updateOne({ _id: block._id }, { $set: { active: false } });
  assert.equal((await call(handlerB)).allowed, true);
});

test('real Mongo paidAt guard survives simultaneous PhonePe product reconciliations', { skip: !uri }, async (t) => {
  await setup(t);
  await ProductOrder.syncIndexes();
  const inserted = await ProductOrder.collection.insertOne({
    merchantOrderId: 'product-concurrent-one', paymentMode: 'phonepe',
    paymentStatus: 'pending', providerState: 'PENDING', paidAt: null
  });
  const order = await ProductOrder.findById(inserted.insertedId);
  const keys = ['PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION', 'PHONEPE_ENV', 'PHONEPE_AUTH_URL', 'PHONEPE_BASE_URL'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    PHONEPE_CLIENT_ID: 'client', PHONEPE_CLIENT_SECRET: 'secret', PHONEPE_CLIENT_VERSION: '1',
    PHONEPE_ENV: 'sandbox', PHONEPE_AUTH_URL: 'https://phonepe.test/oauth/token', PHONEPE_BASE_URL: 'https://phonepe.test/apis/pg'
  });
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/oauth/token')
    ? { access_token: 'token', token_type: 'O-Bearer', expires_at: Math.floor(Date.now() / 1000) + 300 }
    : { state: 'COMPLETED', orderId: 'product-concurrent-one' }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const [first, second] = await Promise.all([reconcileProductOrder(order), reconcileProductOrder(order)]);
  assert.equal(first.paymentStatus, 'paid');
  assert.equal(second.paymentStatus, 'paid');
  const stored = await ProductOrder.findById(order._id);
  assert.equal(stored.paymentStatus, 'paid');
  assert.ok(stored.paidAt);
});
