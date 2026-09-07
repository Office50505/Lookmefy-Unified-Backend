import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import AppleTransaction from '../server/models/AppleTransaction.js';
import CreditEvent from '../server/models/CreditEvent.js';
import TokenOrder from '../server/models/TokenOrder.js';
import User from '../server/models/User.js';

function objectId() {
  return new mongoose.Types.ObjectId();
}

test('user model accepts additive app profile and subscription fields', () => {
  const user = new User({
    name: 'Unified User',
    email: 'unified@example.com',
    phone: '+919999999999',
    phoneVerifiedAt: new Date('2026-09-01T10:00:00.000Z'),
    username: 'unified_user',
    passwordHash: 'hashed-password',
    passwordSetAt: new Date('2026-09-01T10:01:00.000Z'),
    subscription: {
      planId: 'monthly_150_tokens',
      status: 'active',
      provider: 'apple',
      appleProductId: 'lookmefy.monthly.150',
      appleOriginalTransactionId: '100000000000001',
      appleTransactionId: '100000000000002',
      appleEnvironment: 'Sandbox',
      amount: 49900,
      currency: 'INR',
      tokensPerMonth: 150,
      currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      nextBillingAt: new Date('2026-10-01T00:00:00.000Z'),
      willAutoRenew: true,
      billingRetry: false
    },
    avatarPhoto: {
      path: 'uploads/profile/avatar/avatar.jpg',
      source: 'upload',
      uploadedAt: new Date('2026-09-01T10:02:00.000Z')
    },
    avatarCrop: {
      scale: 1.2,
      translateX: 8,
      translateY: -6,
      updatedAt: new Date('2026-09-01T10:03:00.000Z')
    }
  });

  assert.equal(user.validateSync(), undefined);
  const client = user.toClient();
  assert.equal(client.phoneVerified, true);
  assert.equal(client.hasPassword, true);
  assert.equal(client.subscription.provider, 'apple');
  assert.equal(client.subscription.appleOriginalTransactionId, '100000000000001');
  assert.equal(client.subscription.amount, 49900);
  assert.equal(client.subscription.willAutoRenew, true);
  assert.equal(client.avatarPhotoUrl, '/uploads/profile/avatar/avatar.jpg');
  assert.deepEqual(client.avatarCrop.scale, 1.2);
});

test('user client payload hides generated internal login emails', () => {
  const user = new User({
    name: 'Mobile Signup User',
    email: 'profile_mtmvdp22e0n0y5@fitlook.local',
    phone: '+919876543210',
    username: 'mobile_signup_user',
    passwordHash: 'hashed-password'
  });

  assert.equal(user.validateSync(), undefined);
  const client = user.toClient();
  assert.equal(client.email, '');
  assert.equal(client.phone, '+919876543210');
});

test('token order model accepts app purchase compatibility fields', () => {
  const order = new TokenOrder({
    user: objectId(),
    merchantOrderId: 'FL_UNIFIED_1',
    provider: 'razorpay',
    merchantSubscriptionId: 'sub_legacy_1',
    razorpayOrderId: 'order_razorpay_1',
    razorpayPaymentId: 'pay_razorpay_1',
    razorpaySignature: 'signature',
    planId: 'topup_50',
    planName: '50 credits',
    orderType: 'topup',
    purchaseType: 'top_up',
    amount: 19900,
    dueTodayAmount: 19900,
    ratePerCredit: 398,
    currency: 'INR',
    tokens: 50,
    status: 'pending'
  });

  assert.equal(order.validateSync(), undefined);
  const client = order.toClient();
  assert.equal(client.provider, 'razorpay');
  assert.equal(client.merchantSubscriptionId, 'sub_legacy_1');
  assert.equal(client.purchaseType, 'top_up');
  assert.equal(client.ratePerCredit, 398);
  assert.equal(client.razorpayOrderId, 'order_razorpay_1');
});

test('credit event model records idempotent credit ledger entries', () => {
  const event = new CreditEvent({
    user: objectId(),
    action: 'razorpay_topup',
    tokens: 50,
    balanceAfter: 108,
    direction: 'credit',
    source: 'razorpay',
    sourceId: 'pay_razorpay_1',
    fulfillmentKey: 'razorpay:pay_razorpay_1',
    metadata: { planId: 'topup_50' }
  });

  assert.equal(event.validateSync(), undefined);
  const client = event.toClient();
  assert.equal(client.action, 'razorpay_topup');
  assert.equal(client.direction, 'credit');
  assert.equal(client.source, 'razorpay');
  assert.equal(client.tokens, 50);
  assert.equal(client.balanceAfter, 108);

  const invalid = new CreditEvent({
    user: objectId(),
    action: 'bad_fraction',
    tokens: 1.5,
    direction: 'credit'
  });
  assert.match(invalid.validateSync().errors.tokens.message, /whole number/i);
});

test('apple transaction model captures purchase and subscription state', () => {
  const transaction = new AppleTransaction({
    user: objectId(),
    productId: 'lookmefy.monthly.150',
    productKind: 'subscription',
    transactionId: '100000000000002',
    originalTransactionId: '100000000000001',
    fulfillmentKey: 'apple:subscription:100000000000001:2026-09',
    appAccountToken: 'd6f44943-bcad-4dad-970a-b42166721b11',
    environment: 'Sandbox',
    status: 'granted',
    creditsGranted: 150,
    purchaseDate: new Date('2026-09-01T00:00:00.000Z'),
    expiresDate: new Date('2026-10-01T00:00:00.000Z'),
    autoRenewStatus: '1',
    source: 'purchase'
  });

  assert.equal(transaction.validateSync(), undefined);
  const client = transaction.toClient();
  assert.equal(client.productKind, 'subscription');
  assert.equal(client.originalTransactionId, '100000000000001');
  assert.equal(client.status, 'granted');
  assert.equal(client.creditsGranted, 150);
});
