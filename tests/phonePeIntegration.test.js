import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  amountForPlan,
  billingFrequencyForPlan,
  calculatePhonePeCallbackAuthorization,
  checkoutIdempotencyKey,
  configuredRedirectUrl,
  activateRazorpaySubscriptionNow,
  createDemoCreditPayment,
  createRazorpayPayment,
  completeRazorpayPayment,
  hasMandateForTopUp,
  mandateSetupAmountForPlan,
  orderIdFromCallback,
  processRazorpayWebhook,
  reconcileOrder,
  recurringAmountForPlan,
  requireMandateForTopUp,
  setupTokensForPlan,
  statusFromRazorpayOrderStatus,
  statusFromPhonePeState,
  validatePhonePeCallbackAuth,
  verifyRazorpaySignature,
  verifyRazorpaySubscriptionSignature
} from '../server/routes/payments.js';
import TokenOrder from '../server/models/TokenOrder.js';
import User from '../server/models/User.js';
import CreditEvent from '../server/models/CreditEvent.js';
import { SUBSCRIPTION_PLAN, TOP_UP_PLANS } from '../shared/pricing.js';

function requestStub({ headers = {}, body = {}, query = {}, protocol = 'https', host = 'fitlook.in' } = {}) {
  return {
    body,
    query,
    protocol,
    get(name) {
      return headers[String(name).toLowerCase()] || headers[name] || (String(name).toLowerCase() === 'host' ? host : '');
    }
  };
}

test('PhonePe callback authorization follows current v2 SDK username/password hash contract', () => {
  const authorization = calculatePhonePeCallbackAuthorization('username', 'password');
  assert.equal(authorization, 'bc842c31a9e54efe320d30d948be61291f3ceee4766e36ab25fa65243cd76e0e');
  assert.equal(validatePhonePeCallbackAuth(authorization, {
    PHONEPE_CALLBACK_USERNAME: 'username',
    PHONEPE_CALLBACK_PASSWORD: 'password'
  }), true);
  assert.equal(validatePhonePeCallbackAuth('bad', {
    PHONEPE_CALLBACK_USERNAME: 'username',
    PHONEPE_CALLBACK_PASSWORD: 'password'
  }), false);
});

test('PhonePe callback order id extraction supports v2 payload shapes', () => {
  assert.equal(orderIdFromCallback(requestStub({ body: { payload: { merchantOrderId: 'FL_1' } } })), 'FL_1');
  assert.equal(orderIdFromCallback(requestStub({ body: { payload: { orderId: 'OMO_1' } } })), 'OMO_1');
  assert.equal(orderIdFromCallback(requestStub({ query: { merchantOrderId: 'FL_Q' } })), 'FL_Q');
});

test('PhonePe redirect URL is generated from approved server configuration', () => {
  const previousClientOrigin = process.env.CLIENT_ORIGIN;
  const previousRedirectUrl = process.env.PHONEPE_REDIRECT_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    process.env.CLIENT_ORIGIN = 'https://fitlook.in';
    delete process.env.PHONEPE_REDIRECT_URL;
    const url = configuredRedirectUrl(requestStub(), 'FL_123', SUBSCRIPTION_PLAN.id);
    assert.equal(url, `https://fitlook.in/tokens?merchantOrderId=FL_123&plan=${SUBSCRIPTION_PLAN.id}`);

    process.env.PHONEPE_REDIRECT_URL = 'http://localhost:5173/tokens';
    assert.throws(() => configuredRedirectUrl(requestStub(), 'FL_123', SUBSCRIPTION_PLAN.id), /HTTPS|localhost/);

    process.env.PHONEPE_REDIRECT_URL = 'https://payments.example.com/tokens';
    assert.throws(() => configuredRedirectUrl(requestStub(), 'FL_123', SUBSCRIPTION_PLAN.id), /approved CLIENT_ORIGIN/);
  } finally {
    if (previousClientOrigin === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = previousClientOrigin;
    if (previousRedirectUrl === undefined) delete process.env.PHONEPE_REDIRECT_URL;
    else process.env.PHONEPE_REDIRECT_URL = previousRedirectUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('payment amounts are derived server-side from shared pricing', () => {
  assert.equal(amountForPlan(SUBSCRIPTION_PLAN), SUBSCRIPTION_PLAN.dueTodayAmount);
  assert.equal(mandateSetupAmountForPlan(SUBSCRIPTION_PLAN), SUBSCRIPTION_PLAN.mandate.setupAmount);
  assert.equal(setupTokensForPlan(SUBSCRIPTION_PLAN), SUBSCRIPTION_PLAN.setupTokens);
  assert.equal(recurringAmountForPlan(SUBSCRIPTION_PLAN), SUBSCRIPTION_PLAN.mandate.recurringAmount);
  assert.equal(billingFrequencyForPlan(SUBSCRIPTION_PLAN), SUBSCRIPTION_PLAN.mandate.frequency);
  assert.equal(amountForPlan(TOP_UP_PLANS[0]), TOP_UP_PLANS[0].amount);
  assert.equal(recurringAmountForPlan(TOP_UP_PLANS[0]), null);
});

test('top-ups require an authenticated or active mandate', () => {
  assert.equal(hasMandateForTopUp({ subscription: { status: 'none', merchantSubscriptionId: '' } }), false);
  assert.equal(hasMandateForTopUp({ subscription: { status: 'created', merchantSubscriptionId: 'sub_1' } }), false);
  assert.equal(hasMandateForTopUp({ subscription: { status: 'authenticated', merchantSubscriptionId: 'sub_1' } }), true);
  assert.equal(hasMandateForTopUp({ subscription: { status: 'active', merchantSubscriptionId: 'sub_1' } }), true);
  assert.throws(() => requireMandateForTopUp({ subscription: { status: 'none' } }), /monthly mandate/);
});

test('checkout idempotency key accepts only bounded opaque keys', () => {
  assert.equal(checkoutIdempotencyKey(requestStub({ headers: { 'idempotency-key': 'checkout:abc-123456789' } })), 'checkout:abc-123456789');
  assert.throws(() => checkoutIdempotencyKey(requestStub({ headers: { 'idempotency-key': 'short' } })), /Invalid checkout idempotency key/);
  assert.throws(() => checkoutIdempotencyKey(requestStub({ headers: { 'idempotency-key': 'bad key with spaces' } })), /Invalid checkout idempotency key/);
});

test('demo credit checkout credits the user once and does not require a redirect URL', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenCreate: TokenOrder.create,
    tokenFindOneAndUpdate: TokenOrder.findOneAndUpdate,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    creditEventFindOne: CreditEvent.findOne,
    creditEventCreate: CreditEvent.create
  };
  const plan = TOP_UP_PLANS[0];
  const user = {
    _id: 'user-demo-123456789',
    tokens: 8,
    toClient() {
      return { id: this._id, tokens: this.tokens };
    }
  };
  let order = null;
  let createCount = 0;
  let creditedTokens = 0;
  try {
    TokenOrder.findOne = async (filter) => {
      if (filter.idempotencyKey && order?.idempotencyKey === filter.idempotencyKey) return order;
      return null;
    };
    TokenOrder.create = async (doc) => {
      createCount += 1;
      order = {
        _id: 'demo-order-1',
        ...doc,
        creditedAt: null
      };
      return order;
    };
    TokenOrder.findOneAndUpdate = async (filter, update) => {
      if (filter.creditedAt === null && order.creditedAt) return null;
      order = {
        ...order,
        ...update.$set
      };
      return order;
    };
    User.findById = async () => ({
      _id: user._id,
      tokens: user.tokens + creditedTokens,
      toClient() {
        return { id: this._id, tokens: this.tokens };
      }
    });
    User.findOneAndUpdate = async (_filter, update) => {
      creditedTokens += Number(update.$inc?.tokens || 0);
      return {
        _id: user._id,
        tokens: user.tokens + creditedTokens,
        toClient() {
          return { id: this._id, tokens: this.tokens };
        }
      };
    };
    CreditEvent.findOne = async () => null;
    CreditEvent.create = async (docOrDocs) => {
      const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
      return { _id: 'credit-event-1', ...doc };
    };

    const req = requestStub({ headers: { 'idempotency-key': 'demo-credit-checkout-1' } });
    const first = await createDemoCreditPayment({ req, user, plan });
    assert.equal(first.order.status, 'completed');
    assert.equal(first.order.providerState, 'DEMO_COMPLETED');
    assert.equal(first.order.redirectUrl, '');
    assert.equal(first.order.merchantOrderId.startsWith('FLDEMO_'), true);
    assert.equal(first.order.merchantOrderId.length <= 63, true);
    assert.equal(first.user.tokens, user.tokens + plan.tokens);
    assert.equal(first.alreadyCredited, false);
    assert.equal(creditedTokens, plan.tokens);

    const duplicate = await createDemoCreditPayment({ req, user, plan });
    assert.equal(duplicate.alreadyCredited, true);
    assert.equal(createCount, 1);
    assert.equal(creditedTokens, plan.tokens);
    assert.equal(duplicate.user.tokens, user.tokens + plan.tokens);
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.create = original.tokenCreate;
    TokenOrder.findOneAndUpdate = original.tokenFindOneAndUpdate;
    User.findById = original.userFindById;
    User.findOneAndUpdate = original.userFindOneAndUpdate;
    CreditEvent.findOne = original.creditEventFindOne;
    CreditEvent.create = original.creditEventCreate;
  }
});

test('PhonePe state mapping handles success, failure, cancellation, timeout, and pending states', () => {
  assert.equal(statusFromPhonePeState('COMPLETED'), 'completed');
  assert.equal(statusFromPhonePeState('FAILED'), 'failed');
  assert.equal(statusFromPhonePeState('CANCELLED'), 'failed');
  assert.equal(statusFromPhonePeState('EXPIRED'), 'failed');
  assert.equal(statusFromPhonePeState('TIMED_OUT'), 'failed');
  assert.equal(statusFromPhonePeState('PENDING'), 'pending');
  assert.equal(statusFromPhonePeState('UNKNOWN'), '');
});

test('Razorpay signature verification uses order id, payment id, and key secret', () => {
  const signature = createHmac('sha256', 'secret').update('order_test|pay_test').digest('hex');
  assert.equal(verifyRazorpaySignature({
    orderId: 'order_test',
    paymentId: 'pay_test',
    signature,
    secret: 'secret'
  }), true);
  assert.equal(verifyRazorpaySignature({
    orderId: 'order_test',
    paymentId: 'pay_test',
    signature: 'bad',
    secret: 'secret'
  }), false);
  assert.equal(statusFromRazorpayOrderStatus('paid'), 'completed');
  assert.equal(statusFromRazorpayOrderStatus('created'), 'pending');
  assert.equal(statusFromRazorpayOrderStatus('attempted'), 'pending');
});

test('Razorpay subscription signature verification uses payment id and subscription id', () => {
  const signature = createHmac('sha256', 'secret').update('pay_test|sub_test').digest('hex');
  assert.equal(verifyRazorpaySubscriptionSignature({
    subscriptionId: 'sub_test',
    paymentId: 'pay_test',
    signature,
    secret: 'secret'
  }), true);
  assert.equal(verifyRazorpaySubscriptionSignature({
    subscriptionId: 'sub_test',
    paymentId: 'pay_test',
    signature: 'bad',
    secret: 'secret'
  }), false);
});

test('Razorpay checkout creates a provider order without a redirect URL', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenCreate: TokenOrder.create,
    fetch: global.fetch,
    env: {
      RAZORPAY_ENABLED: process.env.RAZORPAY_ENABLED,
      RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
      RAZORPAY_BASE_URL: process.env.RAZORPAY_BASE_URL
    }
  };
  const created = [];
  try {
    process.env.RAZORPAY_ENABLED = 'true';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    process.env.RAZORPAY_BASE_URL = 'https://razorpay.test/v1';
    TokenOrder.findOne = async () => null;
    TokenOrder.create = async (doc) => {
      const order = {
        _id: 'token-order-1',
        ...doc,
        async save() {
          created.push({ saved: true, razorpayOrderId: this.razorpayOrderId, provider: this.provider });
        }
      };
      created.push(order);
      return order;
    };
    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://razorpay.test/v1/orders');
      assert.match(String(options.headers?.Authorization || ''), /^Basic /);
      const body = JSON.parse(options.body);
      assert.equal(body.amount, TOP_UP_PLANS[0].amount);
      assert.equal(body.currency, 'INR');
      assert.equal(body.notes.planId, TOP_UP_PLANS[0].id);
      return new Response(JSON.stringify({ id: 'order_rzp_1', status: 'created', amount: body.amount, currency: body.currency }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const order = await createRazorpayPayment({
      req: requestStub({ headers: { 'idempotency-key': 'razorpay-checkout-1' } }),
      user: { _id: 'user-rzp-12345678', name: 'Test User' },
      plan: TOP_UP_PLANS[0]
    });
    assert.equal(order.provider, 'razorpay');
    assert.equal(order.razorpayOrderId, 'order_rzp_1');
    assert.equal(order.redirectUrl, '');
    assert.equal(order.status, 'pending');
    assert.equal(created.some((entry) => entry.saved && entry.provider === 'razorpay'), true);
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.create = original.tokenCreate;
    global.fetch = original.fetch;
    for (const [key, value] of Object.entries(original.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Razorpay monthly checkout creates a subscription instead of a one rupee order', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenCreate: TokenOrder.create,
    fetch: global.fetch,
    env: {
      RAZORPAY_ENABLED: process.env.RAZORPAY_ENABLED,
      RAZORPAY_MODE: process.env.RAZORPAY_MODE,
      RAZORPAY_TEST_KEY_ID: process.env.RAZORPAY_TEST_KEY_ID,
      RAZORPAY_TEST_KEY_SECRET: process.env.RAZORPAY_TEST_KEY_SECRET,
      RAZORPAY_TEST_MONTHLY_PLAN_ID: process.env.RAZORPAY_TEST_MONTHLY_PLAN_ID,
      RAZORPAY_SUBSCRIPTIONS_ENABLED: process.env.RAZORPAY_SUBSCRIPTIONS_ENABLED,
      RAZORPAY_BASE_URL: process.env.RAZORPAY_BASE_URL
    }
  };
  const created = [];
  try {
    process.env.RAZORPAY_ENABLED = 'true';
    process.env.RAZORPAY_MODE = 'test';
    process.env.RAZORPAY_TEST_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_TEST_KEY_SECRET = 'rzp_test_secret';
    process.env.RAZORPAY_TEST_MONTHLY_PLAN_ID = 'plan_test_monthly';
    process.env.RAZORPAY_SUBSCRIPTIONS_ENABLED = 'true';
    process.env.RAZORPAY_BASE_URL = 'https://razorpay.test/v1';
    TokenOrder.findOne = async () => null;
    TokenOrder.create = async (doc) => {
      const order = {
        _id: 'token-order-subscription-1',
        ...doc,
        async save() {
          created.push({ saved: true, subscriptionId: this.merchantSubscriptionId, provider: this.provider });
        }
      };
      created.push(order);
      return order;
    };
    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://razorpay.test/v1/subscriptions');
      const body = JSON.parse(options.body);
      assert.equal(body.plan_id, 'plan_test_monthly');
      assert.equal(body.total_count, 120);
      assert.ok(Number(body.start_at) > Math.floor(Date.now() / 1000));
      assert.deepEqual(body.addons, [{
        item: {
          name: `${SUBSCRIPTION_PLAN.name} setup credits`,
          amount: SUBSCRIPTION_PLAN.mandate.setupAmount,
          currency: SUBSCRIPTION_PLAN.currency
        }
      }]);
      assert.equal(body.notes.planId, SUBSCRIPTION_PLAN.id);
      return new Response(JSON.stringify({ id: 'sub_rzp_1', status: 'created' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const order = await createRazorpayPayment({
      req: requestStub({ headers: { 'idempotency-key': 'razorpay-subscription-1' } }),
      user: { _id: 'user-rzp-12345678', name: 'Test User' },
      plan: SUBSCRIPTION_PLAN
    });
    assert.equal(order.provider, 'razorpay');
    assert.equal(order.razorpayOrderId || '', '');
    assert.equal(order.merchantSubscriptionId, 'sub_rzp_1');
    assert.equal(order.razorpaySubscriptionId, 'sub_rzp_1');
    assert.equal(order.amount, SUBSCRIPTION_PLAN.mandate.recurringAmount);
    assert.equal(order.dueTodayAmount, SUBSCRIPTION_PLAN.dueTodayAmount);
    assert.equal(created.some((entry) => entry.saved && entry.subscriptionId === 'sub_rzp_1'), true);
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.create = original.tokenCreate;
    global.fetch = original.fetch;
    for (const [key, value] of Object.entries(original.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Razorpay verification credits tokens once after signature validation', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenFindById: TokenOrder.findById,
    tokenFindByIdAndUpdate: TokenOrder.findByIdAndUpdate,
    tokenFindOneAndUpdate: TokenOrder.findOneAndUpdate,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    creditEventFindOne: CreditEvent.findOne,
    creditEventCreate: CreditEvent.create,
    fetch: global.fetch,
    env: {
      RAZORPAY_ENABLED: process.env.RAZORPAY_ENABLED,
      RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
      RAZORPAY_BASE_URL: process.env.RAZORPAY_BASE_URL
    }
  };
  const signature = createHmac('sha256', 'rzp_secret').update('order_rzp_1|pay_rzp_1').digest('hex');
  let order = {
    _id: 'order1',
    user: 'user1',
    provider: 'razorpay',
    merchantOrderId: 'FLRZP_TEST',
    razorpayOrderId: 'order_rzp_1',
    amount: TOP_UP_PLANS[0].amount,
    dueTodayAmount: TOP_UP_PLANS[0].amount,
    planId: TOP_UP_PLANS[0].id,
    orderType: 'topup',
    tokens: TOP_UP_PLANS[0].tokens,
    status: 'pending',
    creditedAt: null
  };
  let creditedTokens = 0;
  try {
    process.env.RAZORPAY_ENABLED = 'true';
    process.env.RAZORPAY_KEY_ID = 'rzp_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_secret';
    process.env.RAZORPAY_BASE_URL = 'https://razorpay.test/v1';
    TokenOrder.findOne = async () => order;
    TokenOrder.findById = async () => order;
    TokenOrder.findByIdAndUpdate = async (_id, update) => {
      order = { ...order, ...update.$set };
      return order;
    };
    TokenOrder.findOneAndUpdate = async (filter, update) => {
      if (filter.creditedAt === null && order.creditedAt) return null;
      order = { ...order, ...update.$set };
      return order;
    };
    User.findById = async () => ({ _id: 'user1', tokens: 8 + creditedTokens });
    User.findOneAndUpdate = async (_filter, update) => {
      creditedTokens += Number(update.$inc?.tokens || 0);
      return { _id: 'user1', tokens: 8 + creditedTokens };
    };
    CreditEvent.findOne = async () => null;
    CreditEvent.create = async (docOrDocs) => {
      const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
      return { _id: 'credit-event-1', ...doc };
    };
    global.fetch = async (url) => {
      assert.equal(String(url), 'https://razorpay.test/v1/payments/pay_rzp_1');
      return new Response(JSON.stringify({ id: 'pay_rzp_1', order_id: 'order_rzp_1', amount: TOP_UP_PLANS[0].amount, status: 'captured' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const first = await completeRazorpayPayment({
      user: { _id: 'user1' },
      merchantOrderId: 'FLRZP_TEST',
      razorpayOrderId: 'order_rzp_1',
      razorpayPaymentId: 'pay_rzp_1',
      razorpaySignature: signature
    });
    assert.equal(first.order.status, 'completed');
    assert.equal(first.user.tokens, 8 + TOP_UP_PLANS[0].tokens);
    assert.equal(creditedTokens, TOP_UP_PLANS[0].tokens);

    const duplicate = await completeRazorpayPayment({
      user: { _id: 'user1' },
      merchantOrderId: 'FLRZP_TEST',
      razorpayOrderId: 'order_rzp_1',
      razorpayPaymentId: 'pay_rzp_1',
      razorpaySignature: signature
    });
    assert.equal(duplicate.alreadyCredited, true);
    assert.equal(creditedTokens, TOP_UP_PLANS[0].tokens);
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.findById = original.tokenFindById;
    TokenOrder.findByIdAndUpdate = original.tokenFindByIdAndUpdate;
    TokenOrder.findOneAndUpdate = original.tokenFindOneAndUpdate;
    User.findById = original.userFindById;
    User.findOneAndUpdate = original.userFindOneAndUpdate;
    CreditEvent.findOne = original.creditEventFindOne;
    CreditEvent.create = original.creditEventCreate;
    global.fetch = original.fetch;
    for (const [key, value] of Object.entries(original.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Razorpay subscription authorization credits starter tokens but not monthly tokens', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenFindById: TokenOrder.findById,
    tokenFindByIdAndUpdate: TokenOrder.findByIdAndUpdate,
    tokenUpdateOne: TokenOrder.updateOne,
    userFindById: User.findById,
    userFindByIdAndUpdate: User.findByIdAndUpdate,
    userFindOneAndUpdate: User.findOneAndUpdate,
    creditEventFindOne: CreditEvent.findOne,
    creditEventCreate: CreditEvent.create,
    fetch: global.fetch,
    env: {
      RAZORPAY_ENABLED: process.env.RAZORPAY_ENABLED,
      RAZORPAY_MODE: process.env.RAZORPAY_MODE,
      RAZORPAY_TEST_KEY_ID: process.env.RAZORPAY_TEST_KEY_ID,
      RAZORPAY_TEST_KEY_SECRET: process.env.RAZORPAY_TEST_KEY_SECRET,
      RAZORPAY_BASE_URL: process.env.RAZORPAY_BASE_URL
    }
  };
  const signature = createHmac('sha256', 'rzp_secret').update('pay_auth_1|sub_rzp_1').digest('hex');
  let order = {
    _id: 'order-subscription-1',
    user: 'user1',
    provider: 'razorpay',
    merchantOrderId: 'FLRZP_SUB_TEST',
    merchantSubscriptionId: 'sub_rzp_1',
    razorpaySubscriptionId: 'sub_rzp_1',
    razorpayMode: 'test',
    amount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    dueTodayAmount: SUBSCRIPTION_PLAN.dueTodayAmount,
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    planId: SUBSCRIPTION_PLAN.id,
    orderType: 'subscription',
    tokens: SUBSCRIPTION_PLAN.tokens,
    status: 'pending',
    creditedAt: null
  };
  let creditedTokens = 0;
  try {
    process.env.RAZORPAY_ENABLED = 'true';
    process.env.RAZORPAY_MODE = 'test';
    process.env.RAZORPAY_TEST_KEY_ID = 'rzp_key';
    process.env.RAZORPAY_TEST_KEY_SECRET = 'rzp_secret';
    process.env.RAZORPAY_BASE_URL = 'https://razorpay.test/v1';
    TokenOrder.findOne = async () => order;
    TokenOrder.findById = async () => order;
    TokenOrder.findByIdAndUpdate = async (_id, update) => {
      order = { ...order, ...update.$set };
      return order;
    };
    TokenOrder.updateOne = async (_filter, update) => {
      order = { ...order, ...update.$set };
      return { modifiedCount: 1 };
    };
    User.findById = async () => ({ _id: 'user1', tokens: 8 + creditedTokens });
    User.findByIdAndUpdate = async (_id, update) => ({ _id: 'user1', tokens: 8 + creditedTokens, subscription: update.$set.subscription });
    User.findOneAndUpdate = async (_filter, update) => {
      creditedTokens += Number(update.$inc?.tokens || 0);
      return { _id: 'user1', tokens: 8 + creditedTokens, subscription: update.$set?.subscription };
    };
    CreditEvent.findOne = async () => null;
    CreditEvent.create = async (docOrDocs) => {
      const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
      return { _id: 'credit-event-setup-1', ...doc };
    };
    global.fetch = async (url) => {
      if (String(url).endsWith('/subscriptions/sub_rzp_1')) {
        return new Response(JSON.stringify({ id: 'sub_rzp_1', status: 'authenticated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      assert.equal(String(url), 'https://razorpay.test/v1/payments/pay_auth_1');
      return new Response(JSON.stringify({ id: 'pay_auth_1', subscription_id: 'sub_rzp_1', amount: 100, status: 'captured' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const result = await completeRazorpayPayment({
      user: { _id: 'user1' },
      merchantOrderId: 'FLRZP_SUB_TEST',
      razorpaySubscriptionId: 'sub_rzp_1',
      razorpayPaymentId: 'pay_auth_1',
      razorpaySignature: signature
    });
    assert.equal(result.pendingSubscriptionCredit, true);
    assert.equal(result.mandateSetupCredit, true);
    assert.equal(result.setupTokens, SUBSCRIPTION_PLAN.setupTokens);
    assert.equal(creditedTokens, SUBSCRIPTION_PLAN.setupTokens);
    assert.equal(order.creditedAt, null);
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.findById = original.tokenFindById;
    TokenOrder.findByIdAndUpdate = original.tokenFindByIdAndUpdate;
    TokenOrder.updateOne = original.tokenUpdateOne;
    User.findById = original.userFindById;
    User.findByIdAndUpdate = original.userFindByIdAndUpdate;
    User.findOneAndUpdate = original.userFindOneAndUpdate;
    CreditEvent.findOne = original.creditEventFindOne;
    CreditEvent.create = original.creditEventCreate;
    global.fetch = original.fetch;
    for (const [key, value] of Object.entries(original.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Razorpay early subscription activation moves first debit without crediting tokens', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenFindById: TokenOrder.findById,
    tokenUpdateOne: TokenOrder.updateOne,
    userFindById: User.findById,
    userFindByIdAndUpdate: User.findByIdAndUpdate,
    userFindOneAndUpdate: User.findOneAndUpdate,
    creditEventFindOne: CreditEvent.findOne,
    fetch: global.fetch,
    env: {
      RAZORPAY_ENABLED: process.env.RAZORPAY_ENABLED,
      RAZORPAY_MODE: process.env.RAZORPAY_MODE,
      RAZORPAY_TEST_KEY_ID: process.env.RAZORPAY_TEST_KEY_ID,
      RAZORPAY_TEST_KEY_SECRET: process.env.RAZORPAY_TEST_KEY_SECRET,
      RAZORPAY_BASE_URL: process.env.RAZORPAY_BASE_URL
    }
  };
  let order = {
    _id: 'order-subscription-early',
    user: 'user1',
    provider: 'razorpay',
    merchantOrderId: 'FLRZP_SUB_EARLY',
    merchantSubscriptionId: 'sub_rzp_early',
    razorpaySubscriptionId: 'sub_rzp_early',
    razorpayMode: 'test',
    amount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    dueTodayAmount: SUBSCRIPTION_PLAN.dueTodayAmount,
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    planId: SUBSCRIPTION_PLAN.id,
    planName: SUBSCRIPTION_PLAN.name,
    orderType: 'subscription',
    tokens: SUBSCRIPTION_PLAN.tokens,
    status: 'pending',
    creditedAt: null
  };
  let creditedTokens = 0;
  let patchBody = null;
  try {
    process.env.RAZORPAY_ENABLED = 'true';
    process.env.RAZORPAY_MODE = 'test';
    process.env.RAZORPAY_TEST_KEY_ID = 'rzp_key';
    process.env.RAZORPAY_TEST_KEY_SECRET = 'rzp_secret';
    process.env.RAZORPAY_BASE_URL = 'https://razorpay.test/v1';
    TokenOrder.findOne = async () => order;
    TokenOrder.findById = async () => order;
    TokenOrder.updateOne = async (_filter, update) => {
      order = { ...order, ...update.$set };
      return { modifiedCount: 1 };
    };
    User.findById = async () => ({ _id: 'user1', tokens: 4 + creditedTokens });
    User.findByIdAndUpdate = async (_id, update) => ({
      _id: 'user1',
      tokens: 4 + creditedTokens,
      subscription: update.$set.subscription,
      toClient() {
        return { id: this._id, tokens: this.tokens, subscription: this.subscription };
      }
    });
    User.findOneAndUpdate = async (_filter, update) => {
      creditedTokens += Number(update.$inc?.tokens || 0);
      return { _id: 'user1', tokens: 4 + creditedTokens };
    };
    CreditEvent.findOne = async () => null;
    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://razorpay.test/v1/subscriptions/sub_rzp_early');
      assert.equal(options.method, 'PATCH');
      patchBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        id: 'sub_rzp_early',
        status: 'authenticated',
        charge_at: patchBody.start_at
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const result = await activateRazorpaySubscriptionNow({
      user: {
        _id: {
          toString: () => 'user1'
        },
        subscription: {
          provider: 'razorpay',
          status: 'authenticated',
          merchantSubscriptionId: 'sub_rzp_early',
          razorpayMode: 'test'
        }
      }
    });

    assert.equal(patchBody.schedule_change_at, 'now');
    assert.equal(patchBody.customer_notify, 1);
    assert.equal(patchBody.notes.earlyActivation, 'true');
    assert.equal(Number.isInteger(patchBody.start_at), true);
    assert.equal(creditedTokens, 0);
    assert.equal(result.activation.requested, true);
    assert.equal(result.user.subscription.nextBillingAt.getTime(), order.debitScheduledAt.getTime());
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.findById = original.tokenFindById;
    TokenOrder.updateOne = original.tokenUpdateOne;
    User.findById = original.userFindById;
    User.findByIdAndUpdate = original.userFindByIdAndUpdate;
    User.findOneAndUpdate = original.userFindOneAndUpdate;
    CreditEvent.findOne = original.creditEventFindOne;
    global.fetch = original.fetch;
    for (const [key, value] of Object.entries(original.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Razorpay subscription monthly webhook credits 150 tokens once per payment', async () => {
  const original = {
    tokenFindOne: TokenOrder.findOne,
    tokenCreate: TokenOrder.create,
    tokenUpdateOne: TokenOrder.updateOne,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    creditEventFindOne: CreditEvent.findOne,
    creditEventCreate: CreditEvent.create
  };
  let parentOrder = {
    _id: 'order-subscription-parent',
    user: 'user1',
    provider: 'razorpay',
    merchantOrderId: 'FLRZP_SUB_PARENT',
    merchantSubscriptionId: 'sub_rzp_1',
    razorpaySubscriptionId: 'sub_rzp_1',
    razorpayMode: 'test',
    amount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    dueTodayAmount: SUBSCRIPTION_PLAN.dueTodayAmount,
    recurringAmount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
    planId: SUBSCRIPTION_PLAN.id,
    planName: SUBSCRIPTION_PLAN.name,
    orderType: 'subscription',
    tokens: SUBSCRIPTION_PLAN.tokens,
    status: 'pending',
    creditedAt: null
  };
  let cycleOrder = null;
  let creditEvent = null;
  let creditedTokens = 0;
  const query = (value) => ({
    lean: async () => value,
    then: (resolve) => Promise.resolve(resolve(value))
  });

  try {
    TokenOrder.findOne = async (filter = {}) => {
      if (filter.merchantOrderId) return cycleOrder;
      return parentOrder;
    };
    TokenOrder.create = async (doc) => {
      cycleOrder = { _id: 'order-subscription-cycle', ...doc };
      return cycleOrder;
    };
    TokenOrder.updateOne = async (_filter, update) => {
      parentOrder = { ...parentOrder, ...update.$set };
      return { modifiedCount: 1 };
    };
    User.findById = async () => ({ _id: 'user1', tokens: 8 + creditedTokens });
    User.findOneAndUpdate = async (_filter, update) => {
      creditedTokens += Number(update.$inc?.tokens || 0);
      return { _id: 'user1', tokens: 8 + creditedTokens, subscription: update.$set?.subscription };
    };
    CreditEvent.findOne = () => query(creditEvent);
    CreditEvent.create = async (docOrDocs) => {
      const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
      creditEvent = { _id: 'credit-event-monthly-1', ...doc };
      return creditEvent;
    };

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_monthly_1',
            subscription_id: 'sub_rzp_1',
            amount: SUBSCRIPTION_PLAN.mandate.recurringAmount,
            status: 'captured'
          }
        },
        subscription: {
          entity: {
            id: 'sub_rzp_1',
            status: 'active',
            current_start: 1788760000,
            current_end: 1791438400
          }
        }
      }
    };

    const first = await processRazorpayWebhook(payload, { mode: 'test' });
    assert.equal(first.alreadyCredited, false);
    assert.equal(creditedTokens, SUBSCRIPTION_PLAN.tokens);
    assert.equal(cycleOrder.tokens, SUBSCRIPTION_PLAN.tokens);

    const duplicate = await processRazorpayWebhook(payload, { mode: 'test' });
    assert.equal(duplicate.alreadyCredited, true);
    assert.equal(creditedTokens, SUBSCRIPTION_PLAN.tokens);
  } finally {
    TokenOrder.findOne = original.tokenFindOne;
    TokenOrder.create = original.tokenCreate;
    TokenOrder.updateOne = original.tokenUpdateOne;
    User.findById = original.userFindById;
    User.findOneAndUpdate = original.userFindOneAndUpdate;
    CreditEvent.findOne = original.creditEventFindOne;
    CreditEvent.create = original.creditEventCreate;
  }
});

async function withMockedPhonePeStatus(states, callback) {
  const previousFetch = global.fetch;
  const previousEnv = {
    PHONEPE_CLIENT_ID: process.env.PHONEPE_CLIENT_ID,
    PHONEPE_CLIENT_SECRET: process.env.PHONEPE_CLIENT_SECRET,
    PHONEPE_CLIENT_VERSION: process.env.PHONEPE_CLIENT_VERSION,
    PHONEPE_ENV: process.env.PHONEPE_ENV,
    PHONEPE_AUTH_URL: process.env.PHONEPE_AUTH_URL,
    PHONEPE_BASE_URL: process.env.PHONEPE_BASE_URL
  };
  const queue = [...states];
  const calls = [];
  process.env.PHONEPE_CLIENT_ID = 'client';
  process.env.PHONEPE_CLIENT_SECRET = 'secret';
  process.env.PHONEPE_CLIENT_VERSION = '1';
  process.env.PHONEPE_ENV = 'sandbox';
  process.env.PHONEPE_AUTH_URL = 'https://phonepe.test/oauth/token';
  process.env.PHONEPE_BASE_URL = 'https://phonepe.test/apis/pg';
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({
        access_token: 'token',
        token_type: 'O-Bearer',
        expires_at: Math.floor(Date.now() / 1000) + 300
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const state = queue.shift() || states.at(-1) || 'PENDING';
    return new Response(JSON.stringify({ state, orderId: 'OMO_TEST' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    await callback({ calls });
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withMockedModels(callback) {
  const original = {
    tokenFindOneAndUpdate: TokenOrder.findOneAndUpdate,
    tokenFindById: TokenOrder.findById,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    creditEventFindOne: CreditEvent.findOne,
    creditEventCreate: CreditEvent.create
  };
  const calls = { credits: 0, saves: 0, findById: 0 };
  TokenOrder.findOneAndUpdate = async (_filter, update) => ({ _id: 'order1', ...update.$set });
  TokenOrder.findById = async () => ({ _id: 'order1', status: 'completed', creditedAt: new Date() });
  User.findById = async () => {
    calls.findById += 1;
    return { _id: 'user1', tokens: 10 };
  };
  User.findOneAndUpdate = async (_filter, update) => {
    calls.credits += Number(update.$inc?.tokens || 0);
    return { _id: 'user1', tokens: calls.credits };
  };
  CreditEvent.findOne = async () => null;
  CreditEvent.create = async (docOrDocs) => {
    const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
    return { _id: 'credit-event-1', ...doc };
  };
  try {
    await callback(calls);
  } finally {
    TokenOrder.findOneAndUpdate = original.tokenFindOneAndUpdate;
    TokenOrder.findById = original.tokenFindById;
    User.findById = original.userFindById;
    User.findOneAndUpdate = original.userFindOneAndUpdate;
    CreditEvent.findOne = original.creditEventFindOne;
    CreditEvent.create = original.creditEventCreate;
  }
}

function mockOrder(overrides = {}) {
  return {
    _id: 'order1',
    user: 'user1',
    merchantOrderId: 'FL_TEST',
    planId: TOP_UP_PLANS[0].id,
    orderType: 'topup',
    tokens: 7,
    status: 'pending',
    creditedAt: null,
    providerState: 'PENDING',
    providerResponse: null,
    async save() {
      this.saved = true;
    },
    ...overrides
  };
}

test('mocked PhonePe success grants credits exactly once and duplicate refresh does not add again', async () => {
  await withMockedModels(async (modelCalls) => {
    await withMockedPhonePeStatus(['COMPLETED'], async ({ calls }) => {
      const order = mockOrder();
      const result = await reconcileOrder(order);
      assert.equal(result.order.status, 'completed');
      assert.equal(modelCalls.credits, 7);
      assert.ok(calls.some((url) => url.includes('/checkout/v2/order/FL_TEST/status')));

      const duplicate = await reconcileOrder(mockOrder({ creditedAt: new Date(), tokens: 7 }));
      assert.equal(duplicate.user.tokens, 10);
      assert.equal(modelCalls.credits, 7);
    });
  });
});

test('mocked PhonePe failure, cancellation, and timeout do not credit tokens', async () => {
  await withMockedModels(async (modelCalls) => {
    for (const state of ['FAILED', 'CANCELLED', 'TIMED_OUT']) {
      await withMockedPhonePeStatus([state], async () => {
        const order = mockOrder();
        const result = await reconcileOrder(order);
        assert.equal(result.order.status, 'failed');
        assert.equal(result.order.providerState, state);
        assert.equal(result.order.saved, true);
      });
    }
    assert.equal(modelCalls.credits, 0);
  });
});

test('mocked PhonePe pending and delayed success keep backend status authoritative', async () => {
  await withMockedModels(async (modelCalls) => {
    await withMockedPhonePeStatus(['PENDING'], async () => {
      const order = mockOrder();
      const result = await reconcileOrder(order);
      assert.equal(result.order.status, 'pending');
      assert.equal(modelCalls.credits, 0);
    });

    await withMockedPhonePeStatus(['COMPLETED'], async () => {
      const order = mockOrder();
      const result = await reconcileOrder(order);
      assert.equal(result.order.status, 'completed');
      assert.equal(modelCalls.credits, 7);
    });
  });
});
