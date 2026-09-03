import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAYMENT_PLANS,
  SUBSCRIPTION_PLAN,
  TOP_UP_PLANS,
  creditRateLabel,
  formatMinorAmount,
  planById
} from '../shared/pricing.js';

test('subscription pricing separates due-today setup amount from recurring mandate amount', () => {
  assert.equal(SUBSCRIPTION_PLAN.id, 'monthly_150_tokens');
  assert.equal(SUBSCRIPTION_PLAN.amount, SUBSCRIPTION_PLAN.dueTodayAmount);
  assert.equal(SUBSCRIPTION_PLAN.dueTodayAmount, SUBSCRIPTION_PLAN.mandate.setupAmount);
  assert.equal(SUBSCRIPTION_PLAN.dueTodayAmount, 100);
  assert.equal(SUBSCRIPTION_PLAN.tokens, 150);
  assert.equal(SUBSCRIPTION_PLAN.mandate.recurringAmount, 49900);
  assert.equal(formatMinorAmount(SUBSCRIPTION_PLAN.dueTodayAmount, 'INR'), '₹1');
  assert.equal(formatMinorAmount(SUBSCRIPTION_PLAN.mandate.recurringAmount, 'INR'), '₹499');
});

test('all payment plans are resolved from one shared pricing catalog', () => {
  for (const plan of PAYMENT_PLANS) {
    assert.equal(planById(plan.id), plan);
    assert.equal(plan.amount, plan.dueTodayAmount);
    assert.ok(plan.tokens > 0);
    assert.ok(creditRateLabel(plan));
  }

  assert.equal(PAYMENT_PLANS.length, TOP_UP_PLANS.length + 1);
});
