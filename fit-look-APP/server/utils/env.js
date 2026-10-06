import { envFlag, isProductionRuntime } from './devMode.js';
import { storageHealthSnapshot } from './storage.js';

const placeholderSecretPatterns = [
  /change[-_\s]?me/i,
  /local[-_\s]?dev/i,
  /^secret$/i,
  /^jwt[-_\s]?secret$/i,
  /^fitlook[-_\s]?local[-_\s]?dev[-_\s]?change[-_\s]?me$/i
];

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is missing. Add it to the server environment before starting.`);
  return value;
}

function requireAnyEnv(names, label = names[0]) {
  const value = names.map((name) => String(process.env[name] || '').trim()).find(Boolean);
  if (!value) throw new Error(`${label} is missing. Add one of ${names.join(', ')} before starting.`);
  return value;
}

function assertJwtSecret() {
  const secret = requireEnv('JWT_SECRET');
  if (!isProductionRuntime()) return;
  if (secret.length < 32 || placeholderSecretPatterns.some((pattern) => pattern.test(secret))) {
    throw new Error('JWT_SECRET must be a strong production secret of at least 32 characters.');
  }
}

function assertStrongSecret(name) {
  const value = requireEnv(name);
  if (!isProductionRuntime()) return;
  if (value.length < 32 || placeholderSecretPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${name} must be a strong production secret of at least 32 characters.`);
  }
}

function assertHttpsUrl(name, { required = false } = {}) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    if (required) throw new Error(`${name} must be set to an HTTPS URL in production.`);
    return;
  }
  const urls = name === 'ALLOWED_ORIGINS'
    ? value.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [value];
  for (const urlValue of urls) {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'https:') {
      throw new Error(`${name} must use HTTPS in production: ${urlValue}`);
    }
  }
}

function validateStartupEnvironment() {
  requireEnv('MONGODB_URI');
  assertJwtSecret();

  if (!isProductionRuntime()) return;

  if (envFlag(process.env.AUTH_OTP_EXPOSE, false)) {
    throw new Error('AUTH_OTP_EXPOSE must be disabled in production.');
  }
  if (envFlag(process.env.ALLOW_LEGACY_EMAIL_SIGNUP, false)) {
    throw new Error('ALLOW_LEGACY_EMAIL_SIGNUP must stay disabled in production.');
  }
  if (
    envFlag(process.env.ENABLE_DEV_MODE_BYPASS, false) ||
    envFlag(process.env.SIGNUP_DEV_MODE_DEFAULT, false) ||
    envFlag(process.env.ALLOW_USER_DEV_MODE_TOGGLE, false)
  ) {
    throw new Error('Dev-mode bypass environment flags must stay disabled in production.');
  }

  assertHttpsUrl('CLIENT_ORIGIN', { required: true });
  assertHttpsUrl('ADMIN_ORIGIN');
  assertHttpsUrl('ALLOWED_ORIGINS');
  requireEnv('REDIS_URL');

  const storage = storageHealthSnapshot();
  if (!storage.configured || storage.provider === 'local') {
    throw new Error('Production storage must use configured remote object storage, not local uploads.');
  }

  if (envFlag(process.env.PAYMENTS_ENABLED, true)) {
    ['PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION'].forEach(requireEnv);
  }
  requireEnv('FAL_KEY');
  requireEnv('FITROOM_API_KEY');
  requireAnyEnv(['PRUNA_API_KEY', 'PRUNA_KEY', 'PRUNA_TOKEN'], 'PRUNA_API_KEY');
  assertHttpsUrl('FITROOM_BASE_URL');
  assertHttpsUrl('PRUNA_BASE_URL');
  assertStrongSecret('ADMIN_KEY');
  ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'].forEach(requireEnv);
}

export { validateStartupEnvironment };
