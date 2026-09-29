import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  mongoConnectConfig,
  mongoConnectOptions
} from '../server/utils/runtime.js';
import { validateServerEnv } from '../server/utils/envValidation.js';

const productionAiEnv = {
  CLIENT_ORIGIN: 'https://fitlook.in',
  AI_PROVIDER: 'pruna',
  TRYON_VIDEO_PROVIDER: 'pixverse',
  PRUNA_API_KEY: 'pruna-test-key',
  FAL_KEY: 'fal-test-key',
  FITROOM_API_KEY: 'fitroom-test-key',
  OTP_DELIVERY_PROVIDER: 'disabled',
  PHONEPE_ENABLED: 'false',
  RAZORPAY_ENABLED: 'false'
};

function baseEnv(overrides = {}) {
  return {
    MONGODB_URI: 'mongodb://localhost:27017/fitlook',
    JWT_SECRET: 'secret',
    ...overrides
  };
}

test('Phase 9 Mongo runtime uses explicit conservative defaults', () => {
  assert.deepEqual(mongoConnectOptions({}), {
    dbName: 'fitlook',
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxIdleTimeMS: 30000
  });
});

test('Phase 9 Mongo runtime accepts valid explicit env overrides', () => {
  assert.deepEqual(mongoConnectOptions({
    MONGODB_DB: 'lookmefy-prod',
    MONGODB_MAX_POOL_SIZE: '12',
    MONGODB_MIN_POOL_SIZE: '2',
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '4000',
    MONGODB_CONNECT_TIMEOUT_MS: '4500',
    MONGODB_SOCKET_TIMEOUT_MS: '60000',
    MONGODB_MAX_IDLE_TIME_MS: '20000'
  }), {
    dbName: 'lookmefy-prod',
    maxPoolSize: 12,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4500,
    socketTimeoutMS: 60000,
    maxIdleTimeMS: 20000
  });
});

test('Phase 9 Mongo runtime bounds maxPoolSize safely', () => {
  const low = mongoConnectConfig({ MONGODB_MAX_POOL_SIZE: '0' });
  const high = mongoConnectConfig({ MONGODB_MAX_POOL_SIZE: '101' });

  assert.equal(low.options.maxPoolSize, 1);
  assert.match(low.issues.join(' '), /MONGODB_MAX_POOL_SIZE/);
  assert.equal(high.options.maxPoolSize, 100);
  assert.match(high.issues.join(' '), /MONGODB_MAX_POOL_SIZE/);
});

test('Phase 9 Mongo runtime bounds minPoolSize and keeps it below maxPoolSize', () => {
  const negative = mongoConnectConfig({ MONGODB_MIN_POOL_SIZE: '-1' });
  const tooLargeForMax = mongoConnectConfig({
    MONGODB_MAX_POOL_SIZE: '5',
    MONGODB_MIN_POOL_SIZE: '6'
  });

  assert.equal(negative.options.minPoolSize, 0);
  assert.match(negative.issues.join(' '), /MONGODB_MIN_POOL_SIZE/);
  assert.equal(tooLargeForMax.options.minPoolSize, 5);
  assert.match(tooLargeForMax.issues.join(' '), /must not exceed/);
});

test('Phase 9 Mongo runtime safely defaults invalid numeric values', () => {
  const config = mongoConnectConfig({
    MONGODB_MAX_POOL_SIZE: 'abc',
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: 'not-a-number'
  });

  assert.equal(config.options.maxPoolSize, 10);
  assert.equal(config.options.serverSelectionTimeoutMS, 5000);
  assert.match(config.issues.join(' '), /MONGODB_MAX_POOL_SIZE/);
  assert.match(config.issues.join(' '), /MONGODB_SERVER_SELECTION_TIMEOUT_MS/);
});

test('Phase 9 Mongo runtime configures bounded server selection, connect, socket, and idle timeouts', () => {
  const options = mongoConnectOptions({});

  assert.equal(options.serverSelectionTimeoutMS, 5000);
  assert.equal(options.connectTimeoutMS, 5000);
  assert.equal(options.socketTimeoutMS, 45000);
  assert.equal(options.maxIdleTimeMS, 30000);
});

test('Phase 9 production env validation rejects invalid Mongo runtime config without secrets', () => {
  assert.throws(
    () => validateServerEnv(baseEnv({
      NODE_ENV: 'production',
      ...productionAiEnv,
      MONGODB_URI: 'mongodb://user:secret@example.invalid/fitlook',
      MONGODB_MAX_POOL_SIZE: '1000'
    })),
    (error) => {
      assert.match(error.message, /MongoDB connection configuration is invalid/);
      assert.match(error.message, /MONGODB_MAX_POOL_SIZE/);
      assert.doesNotMatch(error.message, /mongodb:\/\/user:secret/);
      return true;
    }
  );
});

test('Phase 9 non-production env validation warns on invalid Mongo runtime config', () => {
  const report = validateServerEnv(baseEnv({
    NODE_ENV: 'test',
    MONGODB_MIN_POOL_SIZE: 'not-a-number'
  }));

  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /MONGODB_MIN_POOL_SIZE/);
});

test('Phase 9 API and worker both consume the same Mongo helper', async () => {
  const [apiSource, workerSource] = await Promise.all([
    fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/worker.js', import.meta.url), 'utf8')
  ]);

  assert.match(apiSource, /mongoose\.connect\(process\.env\.MONGODB_URI, mongoConnectOptions\(\)\)/);
  assert.match(workerSource, /mongoose\.connect\(process\.env\.MONGODB_URI, mongoConnectOptions\(\)\)/);
});
