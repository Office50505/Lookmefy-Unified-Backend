import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import User from '../server/models/User.js';
import {
  LEGACY_PASSWORD_SCHEME,
  PEPPERED_PASSWORD_SCHEME,
  hashPassword,
  parsePepperedPasswordHash,
  passwordHashingConfig,
  pepperedPasswordInput,
  verifyPassword
} from '../server/utils/passwordHashing.js';

const password = 'A-secure-password-123';
const pepperV1 = 'v1-test-pepper-with-at-least-32-random-bytes';
const pepperV2 = 'v2-test-pepper-with-at-least-32-random-bytes';
const v2Env = {
  PASSWORD_HASH_SCHEME: 'bcrypt-hmac-sha384-v2',
  PASSWORD_BCRYPT_ROUNDS: '10',
  PASSWORD_PEPPER_ACTIVE_ID: 'v1',
  PASSWORD_PEPPER_V1: pepperV1
};

test('peppered passwords use a versioned HMAC-SHA-384 and bcrypt envelope', async () => {
  const first = await hashPassword(password, { env: v2Env });
  const second = await hashPassword(password, { env: v2Env });
  const parsed = parsePepperedPasswordHash(first);

  assert.ok(first.startsWith('lmf$v2$v1$$2'));
  assert.notEqual(first, second);
  assert.equal(parsed.pepperId, 'v1');
  assert.equal(parsed.bcryptHash.length, 60);
  assert.equal(pepperedPasswordInput(password, pepperV1).length, 64);
  assert.equal((await verifyPassword(password, first, { env: v2Env })).valid, true);
  assert.equal((await verifyPassword('wrong-password', first, { env: v2Env })).valid, false);
});

test('legacy bcrypt credentials remain valid and request transparent migration', async () => {
  const legacyHash = await bcrypt.hash(password, 10);
  const legacyResult = await verifyPassword(password, legacyHash, { env: v2Env });

  assert.deepEqual(legacyResult, {
    valid: true,
    needsUpgrade: true,
    scheme: LEGACY_PASSWORD_SCHEME,
    pepperId: null
  });

  const upgradedHash = await hashPassword(password, { env: v2Env });
  const upgradedResult = await verifyPassword(password, upgradedHash, { env: v2Env });
  assert.equal(upgradedResult.valid, true);
  assert.equal(upgradedResult.needsUpgrade, false);
  assert.equal(upgradedResult.scheme, PEPPERED_PASSWORD_SCHEME);
});

test('pepper rotation verifies the previous version and marks it for upgrade', async () => {
  const oldHash = await hashPassword(password, { env: v2Env });
  const rotatedEnv = {
    ...v2Env,
    PASSWORD_PEPPER_ACTIVE_ID: 'v2',
    PASSWORD_PEPPER_V2: pepperV2
  };
  const result = await verifyPassword(password, oldHash, { env: rotatedEnv });

  assert.equal(result.valid, true);
  assert.equal(result.needsUpgrade, true);
  assert.equal(result.pepperId, 'v1');
  await assert.rejects(
    verifyPassword(password, oldHash, {
      env: { ...rotatedEnv, PASSWORD_PEPPER_V1: '' }
    }),
    /PASSWORD_PEPPER_V1 is required/
  );
});

test('password hashing configuration fails closed when v2 secrets are incomplete', () => {
  assert.deepEqual(passwordHashingConfig({}), {
    scheme: LEGACY_PASSWORD_SCHEME,
    rounds: 12,
    pepperId: null
  });
  assert.throws(
    () => passwordHashingConfig({
      PASSWORD_HASH_SCHEME: 'bcrypt-hmac-sha384-v2',
      PASSWORD_PEPPER_ACTIVE_ID: 'v1'
    }),
    /PASSWORD_PEPPER_V1 is required/
  );
  assert.throws(
    () => passwordHashingConfig({
      ...v2Env,
      PASSWORD_PEPPER_V1: 'too-short'
    }),
    /at least 32 bytes/
  );
});

test('user password hashes are excluded from ordinary MongoDB selections', () => {
  assert.equal(User.schema.path('passwordHash').options.select, false);
});

test('authentication routes use centralized hashing and atomic legacy upgrades', async () => {
  const source = await fs.readFile('server/routes/auth.js', 'utf8');
  assert.doesNotMatch(source, /bcrypt\.(?:hash|compare)/);
  assert.match(source, /\.select\('\+passwordHash'\)/);
  assert.match(source, /passwordVerification\.needsUpgrade/);
  assert.match(source, /passwordHash:\s*previousHash/);
  assert.match(source, /credentialHash:\s*previousHash/);
});
