import fs from 'node:fs';
import path from 'node:path';
import {
  AppStoreServerAPIClient,
  Environment,
  GetTransactionHistoryVersion,
  Order,
  ProductType,
  SignedDataVerifier,
  Status
} from '@apple/app-store-server-library';

export const APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID = 'com.lookmefy.premium.monthly';
export const APP_STORE_CREDITS_150_PRODUCT_ID = 'com.lookmefy.credits150';

const APPLE_PRODUCT_CONFIG = Object.freeze({
  [APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID]: {
    kind: 'subscription',
    planId: 'monthly_150_credits',
    name: 'FitLook Monthly',
    credits: 150
  },
  [APP_STORE_CREDITS_150_PRODUCT_ID]: {
    kind: 'consumable',
    planId: 'apple_credits_150',
    name: '150 credit top-up',
    credits: 150
  }
});

const contextCache = new Map();

export function appleProductConfig(productId) {
  return APPLE_PRODUCT_CONFIG[String(productId || '').trim()] || null;
}

export function appleAppAccountTokenForUserId(userId) {
  const hex = String(userId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(hex)) return '';
  return `00000000-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 24)}`;
}

export function userIdFromAppleAppAccountToken(token) {
  const compact = String(token || '').trim().toLowerCase().replace(/-/g, '');
  if (!/^0{8}[a-f0-9]{24}$/.test(compact)) return '';
  return compact.slice(8);
}

export function normalizeAppleEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return Environment.PRODUCTION;
  if (normalized === 'sandbox' || normalized === 'test') return Environment.SANDBOX;
  if (normalized === 'xcode') return Environment.XCODE;
  if (normalized === 'localtesting' || normalized === 'local_testing') return Environment.LOCAL_TESTING;
  return '';
}

export function appleStoreConfigStatus() {
  const missing = [];
  const environment = appleConfiguredEnvironment();
  const hasPrivateKey = Boolean(readApplePrivateKey(false));
  const hasRootCertificates = loadAppleRootCertificates(false).length > 0;

  if (!process.env.APPLE_IAP_KEY_ID) missing.push('APPLE_IAP_KEY_ID');
  if (!process.env.APPLE_IAP_ISSUER_ID) missing.push('APPLE_IAP_ISSUER_ID');
  if (!process.env.APPLE_BUNDLE_ID) missing.push('APPLE_BUNDLE_ID');
  if (!hasPrivateKey) missing.push('APPLE_IAP_PRIVATE_KEY or APPLE_IAP_PRIVATE_KEY_PATH');
  if (!hasRootCertificates) missing.push('APPLE_ROOT_CA_CERTS_BASE64, APPLE_ROOT_CA_CERT_PATHS, or APPLE_ROOT_CA_CERTS_DIR');
  if (environment === Environment.PRODUCTION && !Number(process.env.APPLE_APP_APPLE_ID)) {
    missing.push('APPLE_APP_APPLE_ID');
  }

  return {
    configured: missing.length === 0,
    environment,
    missing
  };
}

export async function fetchAndVerifyAppleTransaction({ transactionId, signedTransactionInfo, expectedProductId, environmentHint }) {
  const errors = [];
  const environments = appleVerificationEnvironments(environmentHint);

  for (const environment of environments) {
    try {
      const context = appleContext(environment);
      let signed = signedTransactionInfo;
      let serverResponse = null;
      if (transactionId && context.client) {
        serverResponse = await context.client.getTransactionInfo(transactionId);
        signed = serverResponse?.signedTransactionInfo || signed;
      }
      if (!signed) throw new Error('Apple signed transaction info was not available');

      const transaction = await context.verifier.verifyAndDecodeTransaction(signed);
      validateAppleTransaction(transaction, { expectedProductId });
      return {
        environment,
        transaction,
        signedTransactionInfo: signed,
        serverResponse
      };
    } catch (error) {
      errors.push(`${environment}: ${readableAppleError(error)}`);
    }
  }

  throw new Error(`Apple transaction verification failed. ${errors.join(' | ')}`);
}

export async function verifyAppleSignedTransaction(signedTransactionInfo, environmentHint) {
  const errors = [];
  for (const environment of appleVerificationEnvironments(environmentHint)) {
    try {
      const context = appleContext(environment);
      const transaction = await context.verifier.verifyAndDecodeTransaction(signedTransactionInfo);
      validateAppleTransaction(transaction);
      return { environment, transaction, signedTransactionInfo };
    } catch (error) {
      errors.push(`${environment}: ${readableAppleError(error)}`);
    }
  }
  throw new Error(`Apple signed transaction verification failed. ${errors.join(' | ')}`);
}

export async function verifyAppleSignedRenewalInfo(signedRenewalInfo, environmentHint) {
  const errors = [];
  for (const environment of appleVerificationEnvironments(environmentHint)) {
    try {
      const context = appleContext(environment);
      const renewalInfo = await context.verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo);
      return { environment, renewalInfo, signedRenewalInfo };
    } catch (error) {
      errors.push(`${environment}: ${readableAppleError(error)}`);
    }
  }
  throw new Error(`Apple signed renewal info verification failed. ${errors.join(' | ')}`);
}

export async function verifyAppleNotification(signedPayload) {
  const errors = [];
  for (const environment of appleVerificationEnvironments()) {
    try {
      const context = appleContext(environment);
      const notification = await context.verifier.verifyAndDecodeNotification(signedPayload);
      return { environment, notification };
    } catch (error) {
      errors.push(`${environment}: ${readableAppleError(error)}`);
    }
  }
  throw new Error(`Apple notification verification failed. ${errors.join(' | ')}`);
}

export async function fetchAppleSubscriptionHistory(originalTransactionId, environment) {
  if (!originalTransactionId) return [];
  const targetEnvironment = normalizeAppleEnvironment(environment) || appleConfiguredEnvironment();
  const context = appleContext(targetEnvironment);
  if (!context.client) return [];

  const request = {
    productIds: [APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID],
    productTypes: [ProductType.AUTO_RENEWABLE],
    sort: Order.ASCENDING
  };
  let revision = null;
  const verified = [];

  do {
    const response = await context.client.getTransactionHistory(
      originalTransactionId,
      revision,
      request,
      GetTransactionHistoryVersion.V2
    );
    const signedTransactions = Array.isArray(response?.signedTransactions) ? response.signedTransactions : [];
    for (const signed of signedTransactions) {
      const transaction = await context.verifier.verifyAndDecodeTransaction(signed);
      validateAppleTransaction(transaction, { expectedProductId: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID });
      verified.push({ environment: targetEnvironment, transaction, signedTransactionInfo: signed });
    }
    revision = response?.revision || null;
    if (!response?.hasMore) break;
  } while (revision);

  return verified;
}

export async function fetchAppleSubscriptionStatuses(originalTransactionId, environment) {
  if (!originalTransactionId) return [];
  const targetEnvironment = normalizeAppleEnvironment(environment) || appleConfiguredEnvironment();
  const context = appleContext(targetEnvironment);
  if (!context.client) return [];
  const response = await context.client.getAllSubscriptionStatuses(originalTransactionId);
  const statuses = [];

  for (const group of response?.data || []) {
    for (const item of group?.lastTransactions || []) {
      const status = normalizeAppleSubscriptionStatus(item.status);
      let transaction = null;
      let renewalInfo = null;
      if (item.signedTransactionInfo) {
        transaction = await context.verifier.verifyAndDecodeTransaction(item.signedTransactionInfo);
        validateAppleTransaction(transaction);
      }
      if (item.signedRenewalInfo) {
        renewalInfo = await context.verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
      }
      statuses.push({
        environment: targetEnvironment,
        status,
        transaction,
        renewalInfo,
        signedTransactionInfo: item.signedTransactionInfo || '',
        signedRenewalInfo: item.signedRenewalInfo || ''
      });
    }
  }

  return statuses;
}

export function normalizeAppleSubscriptionStatus(value) {
  const numeric = Number(value);
  if (numeric === Status.ACTIVE) return 'active';
  if (numeric === Status.EXPIRED) return 'expired';
  if (numeric === Status.BILLING_RETRY) return 'billing_retry';
  if (numeric === Status.BILLING_GRACE_PERIOD) return 'billing_grace';
  if (numeric === Status.REVOKED) return 'revoked';
  return '';
}

export function readableAppleError(value, fallback = 'Apple StoreKit request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') return value.message || value.errorMessage || value.errorCode || value.name || fallback;
  return String(value);
}

function appleConfiguredEnvironment() {
  const configured = normalizeAppleEnvironment(process.env.APPLE_IAP_ENVIRONMENT);
  if (configured) return configured;
  return process.env.NODE_ENV === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
}

function appleVerificationEnvironments(environmentHint) {
  const configured = String(process.env.APPLE_IAP_ENVIRONMENT || '').trim().toLowerCase();
  if (configured && configured !== 'auto') {
    const only = normalizeAppleEnvironment(configured);
    if (only) return [only];
  }

  const hinted = normalizeAppleEnvironment(environmentHint);
  const preferred = hinted || appleConfiguredEnvironment();
  const fallback = preferred === Environment.SANDBOX ? Environment.PRODUCTION : Environment.SANDBOX;
  return [preferred, fallback].filter((item, index, values) => item && values.indexOf(item) === index);
}

function appleContext(environment) {
  const cacheKey = String(environment);
  if (contextCache.has(cacheKey)) return contextCache.get(cacheKey);

  const signingKey = readApplePrivateKey(true);
  const keyId = requiredEnv('APPLE_IAP_KEY_ID');
  const issuerId = requiredEnv('APPLE_IAP_ISSUER_ID');
  const bundleId = requiredEnv('APPLE_BUNDLE_ID');
  const rootCertificates = loadAppleRootCertificates(true);
  const appAppleId = environment === Environment.PRODUCTION ? Number(requiredEnv('APPLE_APP_APPLE_ID')) : Number(process.env.APPLE_APP_APPLE_ID || 0) || undefined;
  const verifier = new SignedDataVerifier(rootCertificates, true, environment, bundleId, appAppleId);
  const client = [Environment.PRODUCTION, Environment.SANDBOX].includes(environment)
    ? new AppStoreServerAPIClient(signingKey, keyId, issuerId, bundleId, environment)
    : null;
  const context = { client, verifier };
  contextCache.set(cacheKey, context);
  return context;
}

function validateAppleTransaction(transaction, { expectedProductId } = {}) {
  const expectedBundleId = requiredEnv('APPLE_BUNDLE_ID');
  if (transaction.bundleId !== expectedBundleId) {
    throw new Error(`Apple transaction bundle mismatch: ${transaction.bundleId || 'unknown'}`);
  }
  if (!appleProductConfig(transaction.productId)) {
    throw new Error(`Unsupported Apple product id: ${transaction.productId || 'unknown'}`);
  }
  if (expectedProductId && transaction.productId !== expectedProductId) {
    throw new Error(`Apple transaction product mismatch: ${transaction.productId || 'unknown'}`);
  }
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} missing on the server`);
  return value;
}

function readApplePrivateKey(required) {
  const inline = String(process.env.APPLE_IAP_PRIVATE_KEY || '').trim();
  if (inline) return inline.replace(/\\n/g, '\n');

  const filePath = String(process.env.APPLE_IAP_PRIVATE_KEY_PATH || '').trim();
  if (filePath && fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  if (required) throw new Error('APPLE_IAP_PRIVATE_KEY or APPLE_IAP_PRIVATE_KEY_PATH missing on the server');
  return '';
}

function loadAppleRootCertificates(required) {
  const certs = [];
  const inline = String(process.env.APPLE_ROOT_CA_CERTS_BASE64 || '').trim();
  if (inline) {
    for (const item of inline.split(',').map((value) => value.trim()).filter(Boolean)) {
      certs.push(Buffer.from(item, 'base64'));
    }
  }

  const paths = String(process.env.APPLE_ROOT_CA_CERT_PATHS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const dir = String(process.env.APPLE_ROOT_CA_CERTS_DIR || '').trim();
  if (dir && fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir).sort()) {
      if (/\.(cer|crt|pem)$/i.test(entry)) paths.push(path.join(dir, entry));
    }
  }
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) certs.push(fs.readFileSync(filePath));
  }

  if (required && !certs.length) {
    throw new Error('Apple root certificates missing on the server');
  }
  return certs;
}
