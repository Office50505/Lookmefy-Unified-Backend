import bcrypt from 'bcryptjs';
import { createHmac } from 'node:crypto';

const LEGACY_PASSWORD_SCHEME = 'bcrypt-v1';
const PEPPERED_PASSWORD_SCHEME = 'bcrypt-hmac-sha384-v2';
const PASSWORD_HASH_PREFIX = 'lmf$v2$';
const DEFAULT_BCRYPT_ROUNDS = 12;
const MIN_BCRYPT_ROUNDS = 10;
const MAX_BCRYPT_ROUNDS = 15;
const MIN_PEPPER_BYTES = 32;
const PEPPER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function configuredPasswordScheme(env = process.env) {
  const requested = String(env.PASSWORD_HASH_SCHEME || '').trim().toLowerCase();
  if (!requested) {
    return String(env.PASSWORD_PEPPER_ACTIVE_ID || '').trim()
      ? PEPPERED_PASSWORD_SCHEME
      : LEGACY_PASSWORD_SCHEME;
  }
  if (['bcrypt', 'bcrypt-v1', 'legacy'].includes(requested)) return LEGACY_PASSWORD_SCHEME;
  if (['bcrypt-hmac-sha384-v2', 'peppered-bcrypt-v2', 'v2'].includes(requested)) {
    return PEPPERED_PASSWORD_SCHEME;
  }
  throw new Error(`Unsupported PASSWORD_HASH_SCHEME "${requested}".`);
}

function configuredBcryptRounds(env = process.env) {
  const value = Number(env.PASSWORD_BCRYPT_ROUNDS || DEFAULT_BCRYPT_ROUNDS);
  if (!Number.isSafeInteger(value) || value < MIN_BCRYPT_ROUNDS || value > MAX_BCRYPT_ROUNDS) {
    throw new Error(`PASSWORD_BCRYPT_ROUNDS must be a whole number from ${MIN_BCRYPT_ROUNDS} to ${MAX_BCRYPT_ROUNDS}.`);
  }
  return value;
}

function normalizePepperId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!PEPPER_ID_PATTERN.test(id)) {
    throw new Error('PASSWORD_PEPPER_ACTIVE_ID must contain 1-32 letters, numbers, underscores, or hyphens.');
  }
  return id;
}

function pepperEnvironmentKey(id) {
  return `PASSWORD_PEPPER_${normalizePepperId(id).toUpperCase().replace(/-/g, '_')}`;
}

function configuredPepper(id, env = process.env) {
  const key = pepperEnvironmentKey(id);
  const pepper = String(env[key] || '');
  if (!pepper) throw new Error(`${key} is required for password verification.`);
  if (Buffer.byteLength(pepper, 'utf8') < MIN_PEPPER_BYTES) {
    throw new Error(`${key} must contain at least ${MIN_PEPPER_BYTES} bytes.`);
  }
  return pepper;
}

function passwordHashingConfig(env = process.env) {
  const scheme = configuredPasswordScheme(env);
  const rounds = configuredBcryptRounds(env);
  if (scheme === LEGACY_PASSWORD_SCHEME) return { scheme, rounds, pepperId: null };
  const pepperId = normalizePepperId(env.PASSWORD_PEPPER_ACTIVE_ID);
  configuredPepper(pepperId, env);
  return { scheme, rounds, pepperId };
}

function pepperedPasswordInput(password, pepper) {
  return createHmac('sha384', Buffer.from(pepper, 'utf8'))
    .update(Buffer.from(String(password || ''), 'utf8'))
    .digest('base64');
}

function parsePepperedPasswordHash(value) {
  const stored = String(value || '');
  if (!stored.startsWith(PASSWORD_HASH_PREFIX)) return null;
  const remainder = stored.slice(PASSWORD_HASH_PREFIX.length);
  const separator = remainder.indexOf('$');
  if (separator <= 0) return null;
  const pepperId = remainder.slice(0, separator);
  const bcryptHash = remainder.slice(separator + 1);
  if (!PEPPER_ID_PATTERN.test(pepperId) || !BCRYPT_HASH_PATTERN.test(bcryptHash)) return null;
  return { pepperId: pepperId.toLowerCase(), bcryptHash };
}

function isLegacyBcryptHash(value) {
  return BCRYPT_HASH_PATTERN.test(String(value || ''));
}

async function hashPassword(password, { env = process.env } = {}) {
  const config = passwordHashingConfig(env);
  if (config.scheme === LEGACY_PASSWORD_SCHEME) {
    return bcrypt.hash(String(password || ''), config.rounds);
  }
  const pepper = configuredPepper(config.pepperId, env);
  const bcryptHash = await bcrypt.hash(pepperedPasswordInput(password, pepper), config.rounds);
  return `${PASSWORD_HASH_PREFIX}${config.pepperId}$${bcryptHash}`;
}

async function verifyPassword(password, storedHash, { env = process.env } = {}) {
  const parsed = parsePepperedPasswordHash(storedHash);
  const activeConfig = passwordHashingConfig(env);

  if (parsed) {
    const pepper = configuredPepper(parsed.pepperId, env);
    const valid = await bcrypt.compare(
      pepperedPasswordInput(password, pepper),
      parsed.bcryptHash
    );
    const needsUpgrade = valid
      && activeConfig.scheme === PEPPERED_PASSWORD_SCHEME
      && (parsed.pepperId !== activeConfig.pepperId
        || bcrypt.getRounds(parsed.bcryptHash) !== activeConfig.rounds);
    return { valid, needsUpgrade, scheme: PEPPERED_PASSWORD_SCHEME, pepperId: parsed.pepperId };
  }

  if (!isLegacyBcryptHash(storedHash)) {
    return { valid: false, needsUpgrade: false, scheme: 'unknown', pepperId: null };
  }
  const valid = await bcrypt.compare(String(password || ''), storedHash);
  return {
    valid,
    needsUpgrade: valid && activeConfig.scheme === PEPPERED_PASSWORD_SCHEME,
    scheme: LEGACY_PASSWORD_SCHEME,
    pepperId: null
  };
}

export {
  DEFAULT_BCRYPT_ROUNDS,
  LEGACY_PASSWORD_SCHEME,
  MAX_BCRYPT_ROUNDS,
  MIN_BCRYPT_ROUNDS,
  MIN_PEPPER_BYTES,
  PASSWORD_HASH_PREFIX,
  PEPPERED_PASSWORD_SCHEME,
  hashPassword,
  isLegacyBcryptHash,
  parsePepperedPasswordHash,
  passwordHashingConfig,
  pepperEnvironmentKey,
  pepperedPasswordInput,
  verifyPassword
};
