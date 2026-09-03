import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_STORE_CREDITS_150_PRODUCT_ID,
  APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
  appleAppAccountTokenForUserId,
  appleProductConfig,
  userIdFromAppleAppAccountToken
} from '../server/utils/appleStoreKit.js';
import {
  appleFulfillmentKey,
  appleGrantableTransaction,
  appleStatusForTransaction,
  appleSubscriptionUpdateForTransaction
} from '../server/routes/payments.js';
import { SUBSCRIPTION_PLAN } from '../shared/pricing.js';

test('Apple product config maps mobile StoreKit products onto unified credit plans', () => {
  const subscription = appleProductConfig(APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID);
  const topUp = appleProductConfig(APP_STORE_CREDITS_150_PRODUCT_ID);

  assert.equal(subscription.kind, 'subscription');
  assert.equal(subscription.planId, SUBSCRIPTION_PLAN.id);
  assert.equal(subscription.credits, SUBSCRIPTION_PLAN.tokens);
  assert.equal(topUp.kind, 'consumable');
  assert.equal(topUp.planId, 'apple_credits_150');
  assert.equal(topUp.credits, 150);
  assert.equal(appleProductConfig('unknown.product'), null);
});

test('Apple app account token round-trips a Lookmefy user id', () => {
  const userId = '64f0c2ca3f1d2a0012345678';
  const token = appleAppAccountTokenForUserId(userId);

  assert.equal(token, '00000000-64f0-c2ca-3f1d-2a0012345678');
  assert.equal(userIdFromAppleAppAccountToken(token), userId);
  assert.equal(appleAppAccountTokenForUserId('not-a-mongo-id'), '');
  assert.equal(userIdFromAppleAppAccountToken('not-a-token'), '');
});

test('Apple fulfillment keys are stable for consumables and subscription periods', () => {
  assert.equal(
    appleFulfillmentKey({ transactionId: 'tx_1' }, { kind: 'consumable' }),
    'apple:consumable:tx_1'
  );
  assert.equal(
    appleFulfillmentKey({
      transactionId: 'tx_2',
      originalTransactionId: 'orig_1',
      webOrderLineItemId: 'line_2026_09'
    }, { kind: 'subscription' }),
    'apple:subscription:orig_1:line_2026_09'
  );
});

test('Apple transaction status and grantability reject revoked or upgraded purchases', () => {
  const config = { kind: 'subscription' };
  assert.equal(appleGrantableTransaction({ transactionId: 'tx_1' }, config), true);
  assert.equal(appleGrantableTransaction({ transactionId: 'tx_1', isUpgraded: true }, config), false);
  assert.equal(appleGrantableTransaction({ transactionId: 'tx_1', revocationDate: Date.now() }, config), false);
  assert.equal(appleStatusForTransaction({ transactionId: 'tx_1', revocationDate: Date.now() }, config), 'revoked');
  assert.equal(appleStatusForTransaction({ transactionId: 'tx_1', expiresDate: Date.now() - 1000 }, config), 'expired');
  assert.equal(appleStatusForTransaction({ transactionId: 'tx_1' }, config, 'billing_retry'), 'billing_retry');
});

test('Apple subscription snapshot keeps provider state in the unified User subscription object', () => {
  const now = Date.now();
  const update = appleSubscriptionUpdateForTransaction({
    productId: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
    transactionId: 'tx_1',
    originalTransactionId: 'orig_1',
    environment: 'Sandbox',
    purchaseDate: now,
    expiresDate: now + 30 * 24 * 60 * 60 * 1000,
    currency: 'INR',
    price: 49900
  }, {
    autoRenewStatus: 1,
    renewalDate: now + 30 * 24 * 60 * 60 * 1000
  }, 'active', 'Sandbox');

  assert.equal(update.provider, 'apple');
  assert.equal(update.planId, SUBSCRIPTION_PLAN.id);
  assert.equal(update.appleProductId, APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID);
  assert.equal(update.appleOriginalTransactionId, 'orig_1');
  assert.equal(update.appleTransactionId, 'tx_1');
  assert.equal(update.appleEnvironment, 'Sandbox');
  assert.equal(update.status, 'active');
  assert.equal(update.willAutoRenew, true);
  assert.equal(update.tokensPerMonth, SUBSCRIPTION_PLAN.tokens);
});
