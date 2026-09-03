import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCreditLedgerEntry,
  creditUser,
  debitUser,
  normalizeDirection,
  normalizeTokenAmount
} from '../server/services/creditLedger.js';

function fakeModels({ startingTokens = 10, existingEvent = null, updateReturnsUser = true } = {}) {
  const calls = {
    findOne: [],
    findById: [],
    findOneAndUpdate: [],
    create: []
  };
  const user = { _id: 'user1', tokens: startingTokens, accountStatus: 'active' };
  return {
    calls,
    models: {
      User: {
        findById(id) {
          calls.findById.push(id);
          return { ...user };
        },
        async findOneAndUpdate(filter, update) {
          calls.findOneAndUpdate.push({ filter, update });
          if (!updateReturnsUser) return null;
          user.tokens += Number(update.$inc?.tokens || 0);
          return { ...user };
        }
      },
      CreditEvent: {
        findOne(filter) {
          calls.findOne.push(filter);
          return existingEvent;
        },
        async create(docOrDocs) {
          const doc = Array.isArray(docOrDocs) ? docOrDocs[0] : docOrDocs;
          calls.create.push(doc);
          return { _id: 'event1', ...doc };
        }
      }
    }
  };
}

test('credit ledger normalization keeps app-compatible positive token amounts', () => {
  assert.equal(normalizeTokenAmount(5), 5);
  assert.equal(normalizeTokenAmount(-5), 5);
  assert.equal(normalizeDirection('', -2), 'debit');
  assert.equal(normalizeDirection('', 2), 'credit');
  assert.throws(() => normalizeTokenAmount(1.5), /whole number/i);
});

test('creditUser increments balance and records a credit event', async () => {
  const { models, calls } = fakeModels({ startingTokens: 8 });
  const result = await creditUser({
    userId: 'user1',
    action: 'razorpay_topup',
    tokens: 50,
    source: 'razorpay',
    sourceId: 'pay_1',
    fulfillmentKey: 'razorpay:pay_1',
    metadata: { planId: 'topup_50' },
    models
  });

  assert.equal(result.alreadyRecorded, false);
  assert.equal(result.user.tokens, 58);
  assert.equal(calls.findOneAndUpdate[0].update.$inc.tokens, 50);
  assert.equal(calls.create[0].tokens, 50);
  assert.equal(calls.create[0].direction, 'credit');
  assert.equal(calls.create[0].balanceAfter, 58);
  assert.equal(calls.create[0].fulfillmentKey, 'razorpay:pay_1');
});

test('debitUser decrements balance only when enough credits exist', async () => {
  const { models, calls } = fakeModels({ startingTokens: 3 });
  const result = await debitUser({
    userId: 'user1',
    action: 'tryon_image_debit',
    tokens: 1,
    source: 'tryon',
    sourceId: 'tryon_1',
    models
  });

  assert.equal(result.user.tokens, 2);
  assert.deepEqual(calls.findOneAndUpdate[0].filter.tokens, { $gte: 1 });
  assert.equal(calls.findOneAndUpdate[0].update.$inc.tokens, -1);
  assert.equal(calls.create[0].tokens, 1);
  assert.equal(calls.create[0].direction, 'debit');
  assert.equal(calls.create[0].balanceAfter, 2);
});

test('credit ledger returns an existing fulfillment event without mutating balance again', async () => {
  const existingEvent = {
    _id: 'event-existing',
    fulfillmentKey: 'apple:tx_1',
    tokens: 150,
    direction: 'credit'
  };
  const { models, calls } = fakeModels({ startingTokens: 42, existingEvent });
  const result = await creditUser({
    userId: 'user1',
    action: 'apple_subscription',
    tokens: 150,
    source: 'apple',
    sourceId: 'tx_1',
    fulfillmentKey: 'apple:tx_1',
    models
  });

  assert.equal(result.alreadyRecorded, true);
  assert.equal(result.event, existingEvent);
  assert.equal(result.user.tokens, 42);
  assert.equal(calls.findOneAndUpdate.length, 0);
  assert.equal(calls.create.length, 0);
});

test('credit ledger rejects insufficient debit attempts', async () => {
  const { models } = fakeModels({ updateReturnsUser: false });
  await assert.rejects(
    debitUser({
      userId: 'user1',
      action: 'tryon_image_debit',
      tokens: 5,
      models
    }),
    (error) => error.code === 'insufficient_credits' && error.statusCode === 402
  );
});

test('applyCreditLedgerEntry supports zero-token dev-mode events without changing balance', async () => {
  const { models, calls } = fakeModels({ startingTokens: 8 });
  const result = await applyCreditLedgerEntry({
    userId: 'user1',
    action: 'dev_mode_tryon',
    tokens: 0,
    direction: 'debit',
    source: 'tryon',
    models
  });

  assert.equal(result.user.tokens, 8);
  assert.equal(calls.findOneAndUpdate.length, 0);
  assert.equal(calls.create[0].tokens, 0);
  assert.equal(calls.create[0].direction, 'debit');
  assert.equal(calls.create[0].balanceAfter, 8);
});
