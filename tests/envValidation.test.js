import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationReadiness, phonePeEnabled, razorpayEnabled, validateServerEnv } from '../server/utils/envValidation.js';

const productionAiEnv = {
  CLIENT_ORIGIN: 'https://fitlook.in',
  AI_PROVIDER: 'pruna',
  TRYON_VIDEO_PROVIDER: 'pixverse',
  PRUNA_API_KEY: 'pruna-test-key',
  FAL_KEY: 'fal-test-key',
  FITROOM_API_KEY: 'fitroom-test-key'
};

test('validateServerEnv requires production-critical values', () => {
  assert.throws(() => validateServerEnv({ MONGODB_URI: '', JWT_SECRET: '' }), /MONGODB_URI, JWT_SECRET/);
});

test('validateServerEnv validates peppered password hashing as one complete configuration', () => {
  const base = {
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    PASSWORD_HASH_SCHEME: 'bcrypt-hmac-sha384-v2',
    PASSWORD_BCRYPT_ROUNDS: '12',
    PASSWORD_PEPPER_ACTIVE_ID: 'v1'
  };
  assert.throws(() => validateServerEnv(base), /PASSWORD_PEPPER_V1 is required/);
  assert.throws(
    () => validateServerEnv({ ...base, PASSWORD_PEPPER_V1: 'too-short' }),
    /at least 32 bytes/
  );
  assert.doesNotThrow(() => validateServerEnv({
    ...base,
    PASSWORD_PEPPER_V1: 'production-like-test-pepper-with-32-bytes'
  }));
});

test('validateServerEnv reports partial feature configuration without failing startup', () => {
  const report = validateServerEnv({
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    PHONEPE_CLIENT_ID: 'id'
  });

  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /PhonePe payments/);
});

test('validateServerEnv warns when OTP webhook delivery is incomplete outside production', () => {
  const report = validateServerEnv({
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'webhook'
  });

  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /OTP delivery webhook/);
});

test('MSG91 OTP delivery is valid and reported configured with complete server credentials', () => {
  const env = {
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    PHONEPE_ENABLED: 'false',
    OTP_DELIVERY_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'server-only-key',
    MSG91_TEMPLATE_ID: 'template-1',
    MSG91_BASE_URL: 'https://control.msg91.com/api/v5'
  };

  assert.deepEqual(validateServerEnv(env), { warnings: [] });
  assert.deepEqual(configurationReadiness(env), {
    otpProvider: 'configured',
    otpProviderType: 'msg91',
    phonePe: 'disabled',
    razorpay: 'not_configured',
    appleIap: 'disabled'
  });
});

test('MSG91 OTP delivery reports missing required credentials', () => {
  assert.throws(() => validateServerEnv({
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    PHONEPE_ENABLED: 'false',
    OTP_DELIVERY_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'server-only-key'
  }), /MSG91_TEMPLATE_ID/);
});

test('validateServerEnv rejects unsafe OTP delivery but permits fail-closed OTP in production', () => {
  assert.throws(
    () => validateServerEnv({
      NODE_ENV: 'production',
      ...productionAiEnv,
      MONGODB_URI: 'mongodb://localhost:27017/fitlook',
      JWT_SECRET: 'secret',
      OTP_DELIVERY_PROVIDER: 'mock',
      OTP_MOCK_STORE_PATH: '/tmp/otp.jsonl'
    }),
    /Production requires OTP_DELIVERY_PROVIDER=msg91, webhook, or disabled/
  );

  assert.throws(
    () => validateServerEnv({
      NODE_ENV: 'production',
      ...productionAiEnv,
      MONGODB_URI: 'mongodb://localhost:27017/fitlook',
      JWT_SECRET: 'secret',
      OTP_DELIVERY_PROVIDER: 'webhook',
      OTP_DELIVERY_WEBHOOK_URL: 'http://localhost:3000/otp'
    }),
    /HTTPS|localhost/
  );

  assert.doesNotThrow(() => validateServerEnv({
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    CLIENT_ORIGIN: 'https://fitlook.in',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'false'
  }));
});

test('PhonePe can be explicitly disabled without validating stale partial credentials', () => {
  const env = {
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'false',
    PHONEPE_CLIENT_ID: 'partial'
  };

  assert.equal(phonePeEnabled(env), false);
  assert.deepEqual(validateServerEnv(env), { warnings: [] });
  assert.deepEqual(configurationReadiness(env), {
    otpProvider: 'disabled',
    otpProviderType: 'disabled',
    phonePe: 'disabled',
    razorpay: 'not_configured',
    appleIap: 'disabled'
  });
});

test('partial PhonePe production configuration still fails when payments are enabled', () => {
  assert.throws(() => validateServerEnv({
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'true',
    PHONEPE_CLIENT_ID: 'partial'
  }), /PhonePe payments are partially configured/);
});

test('Razorpay readiness reports configured test credentials and validates partial production config', () => {
  const configured = {
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'false',
    RAZORPAY_KEY_ID: 'rzp_test_123',
    RAZORPAY_KEY_SECRET: 'secret'
  };
  assert.equal(razorpayEnabled(configured), true);
  assert.deepEqual(validateServerEnv(configured), { warnings: [] });
  assert.equal(configurationReadiness(configured).razorpay, 'configured');

  assert.throws(() => validateServerEnv({
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'false',
    RAZORPAY_KEY_ID: 'rzp_test_partial'
  }), /Razorpay payments are partially configured/);
});

test('Apple IAP readiness is disabled by default and validates production configuration when enabled', () => {
  const base = {
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'false',
    RAZORPAY_ENABLED: 'false'
  };

  assert.deepEqual(configurationReadiness(base).appleIap, 'disabled');
  assert.throws(
    () => validateServerEnv({ ...base, APPLE_IAP_ENABLED: 'true', APPLE_IAP_KEY_ID: 'key-id' }),
    /Apple in-app purchases are partially configured/
  );
  assert.deepEqual(validateServerEnv({
    ...base,
    APPLE_IAP_ENABLED: 'true',
    APPLE_IAP_KEY_ID: 'key-id',
    APPLE_IAP_ISSUER_ID: 'issuer-id',
    APPLE_BUNDLE_ID: 'com.lookmefy.app',
    APPLE_IAP_PRIVATE_KEY: 'private-key-placeholder',
    APPLE_ROOT_CA_CERTS_BASE64: 'cert'
  }), { warnings: [] });
  assert.equal(configurationReadiness({
    ...base,
    APPLE_IAP_ENABLED: 'true',
    APPLE_IAP_KEY_ID: 'key-id',
    APPLE_IAP_ISSUER_ID: 'issuer-id',
    APPLE_BUNDLE_ID: 'com.lookmefy.app',
    APPLE_IAP_PRIVATE_KEY: 'private-key-placeholder',
    APPLE_ROOT_CA_CERTS_BASE64: 'cert'
  }).appleIap, 'configured');
});

test('validateServerEnv warns when mock OTP delivery is incomplete outside production', () => {
  const report = validateServerEnv({
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    NODE_ENV: 'test',
    OTP_DELIVERY_PROVIDER: 'mock'
  });

  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings.join(' '), /OTP_MOCK_STORE_PATH/);
});

test('validateServerEnv rejects fixed OTP in production', () => {
  assert.throws(
    () => validateServerEnv({
      NODE_ENV: 'production',
      ...productionAiEnv,
      MONGODB_URI: 'mongodb://localhost:27017/fitlook',
      JWT_SECRET: 'secret',
      OTP_DELIVERY_PROVIDER: 'webhook',
      OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send',
      OTP_FIXED_CODE: '123456'
    }),
    /OTP_FIXED_CODE is not allowed in production/
  );
});

test('validateServerEnv allows explicitly enabled fixed OTP in production', () => {
  const env = {
    NODE_ENV: 'production',
    ...productionAiEnv,
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'disabled',
    OTP_FIXED_CODE: '123456',
    ALLOW_FIXED_OTP_IN_PRODUCTION: 'true',
    PHONEPE_ENABLED: 'false'
  };

  assert.deepEqual(validateServerEnv(env), { warnings: [] });
  assert.deepEqual(configurationReadiness(env), {
    otpProvider: 'configured',
    otpProviderType: 'fixed',
    phonePe: 'disabled',
    razorpay: 'not_configured',
    appleIap: 'disabled'
  });
});

test('production requires keys for selected AI providers and enabled generation features', () => {
  const base = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    CLIENT_ORIGIN: 'https://fitlook.in',
    OTP_DELIVERY_PROVIDER: 'disabled',
    PHONEPE_ENABLED: 'false'
  };
  assert.throws(() => validateServerEnv(base), /PRUNA_API_KEY.*FAL_KEY.*FITROOM_API_KEY/);
  assert.doesNotThrow(() => validateServerEnv({ ...base, ...productionAiEnv }));
  assert.doesNotThrow(() => validateServerEnv({ ...base, AI_FEATURES_ENABLED: 'false' }));
});

test('validateServerEnv allows fixed OTP for staging mock delivery', () => {
  const report = validateServerEnv({
    NODE_ENV: 'staging',
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    OTP_DELIVERY_PROVIDER: 'mock',
    OTP_MOCK_STORE_PATH: '/tmp/otp.jsonl',
    OTP_FIXED_CODE: '123456'
  });

  assert.equal(report.warnings.length, 0);
});
