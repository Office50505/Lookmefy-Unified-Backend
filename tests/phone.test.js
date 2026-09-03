import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidIndianMobile, normalizeIndianMobile } from '../server/utils/phone.js';

test('normalizes supported Indian mobile number formats', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('+91 98765 43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('09876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('91-98765-43210'), '+919876543210');
});

test('rejects blank, alphabetic, short, long, malformed, and unsupported phone inputs', () => {
  for (const value of [
    '',
    'call me',
    'abc9876543210',
    '12345',
    '9876543210123',
    '+1 987 654 3210',
    '+91 58765 43210',
    '++91--',
    '91 98765 4321'
  ]) {
    assert.equal(normalizeIndianMobile(value), '', value);
    assert.equal(isValidIndianMobile(value), false, value);
  }
});
