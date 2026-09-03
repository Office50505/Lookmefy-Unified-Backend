import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdminUserSearchFilter, buildAdminUserTokenFilter } from '../server/utils/adminUserSearch.js';

function clauseFor(filter, field) {
  return filter.$or.find((clause) => Object.hasOwn(clause, field));
}

test('admin user search covers operational identity and account fields', () => {
  const filter = buildAdminUserSearchFilter('active');
  for (const field of ['name', 'email', 'phone', 'username', 'genderPreference', 'accountStatus', 'subscription.status', 'bodyPhoto.status']) {
    assert.ok(clauseFor(filter, field), `${field} should be searchable`);
  }
  assert.match(String(clauseFor(filter, 'accountStatus').accountStatus), /active/i);
});

test('admin user search normalizes formatted Indian mobile numbers', () => {
  const filter = buildAdminUserSearchFilter('98765 43210');
  const phoneClauses = filter.$or.filter((clause) => Object.hasOwn(clause, 'phone'));
  assert.equal(phoneClauses.length, 2);
  assert.ok(phoneClauses.some((clause) => clause.phone.test('+919876543210')));
});

test('admin user search supports exact numeric, boolean, date, and Mongo id fields', () => {
  const numeric = buildAdminUserSearchFilter('100');
  assert.equal(clauseFor(numeric, 'tokens').tokens, 100);
  assert.equal(clauseFor(numeric, 'subscription.tokensPerMonth')['subscription.tokensPerMonth'], 100);

  const boolean = buildAdminUserSearchFilter('true');
  assert.equal(clauseFor(boolean, 'devMode').devMode, true);

  const date = buildAdminUserSearchFilter('2026-08-21');
  assert.equal(clauseFor(date, 'createdAt').createdAt.$gte.toISOString(), '2026-08-21T00:00:00.000Z');

  const id = '507f1f77bcf86cd799439011';
  const objectId = buildAdminUserSearchFilter(id);
  assert.equal(String(clauseFor(objectId, '_id')._id), id);
});

test('admin user search does not expose sensitive user fields', () => {
  const keys = buildAdminUserSearchFilter('secret').$or.flatMap((clause) => Object.keys(clause));
  for (const field of ['passwordHash', 'bodyPhoto.path', 'bodyPhoto.url', 'bodyPhoto.original.path', 'bodyPhoto.original.url']) {
    assert.ok(!keys.includes(field), `${field} must not be searchable`);
  }
});

test('admin token filters support exact, minimum, maximum, and range queries', () => {
  assert.equal(buildAdminUserTokenFilter('', ''), null);
  assert.deepEqual(buildAdminUserTokenFilter('10', ''), { tokens: { $gte: 10 } });
  assert.deepEqual(buildAdminUserTokenFilter('', '50'), { tokens: { $lte: 50 } });
  assert.deepEqual(buildAdminUserTokenFilter('25', '25'), { tokens: { $gte: 25, $lte: 25 } });
  assert.deepEqual(buildAdminUserTokenFilter('10', '100'), { tokens: { $gte: 10, $lte: 100 } });
});

test('admin token filters reject malformed and reversed ranges', () => {
  assert.throws(() => buildAdminUserTokenFilter('-1', ''), /non-negative whole number/i);
  assert.throws(() => buildAdminUserTokenFilter('1.5', ''), /non-negative whole number/i);
  assert.throws(() => buildAdminUserTokenFilter('many', ''), /non-negative whole number/i);
  assert.throws(() => buildAdminUserTokenFilter('101', '100'), /cannot be greater/i);
  assert.throws(() => buildAdminUserTokenFilter(String(Number.MAX_SAFE_INTEGER + 1), ''), /safe whole number/i);
});
