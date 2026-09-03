import assert from 'node:assert/strict';
import test from 'node:test';
import { adminPasswordError, normalizeAdminName } from '../server/utils/adminCredentials.js';

test('admin passwords only require a non-empty bcrypt-safe value', () => {
  assert.match(adminPasswordError(''), /required/i);
  assert.equal(adminPasswordError('short'), '');
  assert.match(adminPasswordError('x'.repeat(73)), /at most 72 bytes/i);
});

test('admin display names are normalized or derived from email', () => {
  assert.equal(normalizeAdminName('  Zoher   Shakir  ', 'ignored@example.com'), 'Zoher Shakir');
  assert.equal(normalizeAdminName('', 'new.admin@lookmefy.com'), 'New Admin');
});
