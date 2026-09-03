import assert from 'node:assert/strict';
import test from 'node:test';
import User from '../server/models/User.js';
import {
  accountAccessError,
  accountStatusFor,
  anonymizedIdentity,
  tokenBalanceAfter
} from '../server/utils/accountState.js';

test('legacy users remain active while banned and deleted accounts are blocked', () => {
  assert.equal(accountStatusFor({}), 'active');
  assert.equal(accountAccessError({}), null);
  assert.equal(accountAccessError({ accountStatus: 'banned' }).statusCode, 403);
  assert.equal(accountAccessError({ accountStatus: 'deleted' }).statusCode, 401);
});

test('token changes reject negative, fractional, and unsafe values', () => {
  assert.equal(tokenBalanceAfter({ current: 8, mode: 'add', amount: 3 }), 11);
  assert.equal(tokenBalanceAfter({ current: 8, mode: 'set', amount: 0 }), 0);
  assert.throws(() => tokenBalanceAfter({ current: 8, mode: 'set', amount: '' }), /non-negative/);
  assert.throws(() => tokenBalanceAfter({ current: 8, mode: 'add', amount: -1 }), /non-negative/);
  assert.throws(() => tokenBalanceAfter({ current: 8, mode: 'set', amount: 1.5 }), /non-negative/);
  assert.throws(() => tokenBalanceAfter({ current: 8, mode: 'add', amount: Number.MAX_VALUE }), /non-negative/);
});

test('user model rejects invalid token balances', () => {
  const base = {
    name: 'Test User',
    email: 'test@example.com',
    passwordHash: 'not-used-in-this-unit-test'
  };
  assert.match(new User({ ...base, tokens: -1 }).validateSync().errors.tokens.message, /minimum|non-negative/i);
  assert.match(new User({ ...base, tokens: 1.5 }).validateSync().errors.tokens.message, /whole number/i);
  assert.equal(new User({ ...base, tokens: 0 }).validateSync(), undefined);
});

test('anonymized identities are deterministic, unique, and non-identifying', () => {
  const id = '507f1f77bcf86cd799439011';
  const identity = anonymizedIdentity(id);
  assert.equal(identity.name, 'Deleted user');
  assert.match(identity.email, new RegExp(id));
  assert.match(identity.username, new RegExp(id));
  assert.throws(() => anonymizedIdentity('bad-id'), /Invalid user id/);
});
