import { isProductionEnv, validateConfiguredHttpsUrl } from './urlValidation.js';
import { passwordHashingConfig } from './passwordHashing.js';

const REQUIRED_SERVER_ENV = ['MONGODB_URI', 'JWT_SECRET'];

const FEATURE_ENV_GROUPS = [
  {
    name: 'PhonePe payments',
    keys: ['PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION', 'PHONEPE_CALLBACK_USERNAME', 'PHONEPE_CALLBACK_PASSWORD']
  },
  {
    name: 'Razorpay payments',
    keys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']
  },
  {
    name: 'Apple in-app purchases',
    keys: ['APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID', 'APPLE_BUNDLE_ID', 'APPLE_IAP_PRIVATE_KEY']
  },
  {
    name: 'FAL AI generation',
    keys: ['FAL_KEY']
  },
  {
    name: 'FitRoom try-on',
    keys: ['FITROOM_API_KEY']
  }
];

const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

function featureEnabled(env, key, defaultValue = true) {
  const value = String(env[key] ?? '').trim().toLowerCase();
  if (!value) return defaultValue;
  return !FALSE_ENV_VALUES.has(value);
}

function localOriginConfigured(value = '') {
  if (!String(value || '').trim()) return false;
  try {
    const url = new URL(String(value).trim());
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)
      || url.hostname.startsWith('192.168.')
      || url.hostname.startsWith('10.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname);
  } catch {
    return false;
  }
}

function validateProductionOriginList(env, errors) {
  const origins = [
    ['CLIENT_ORIGIN', env.CLIENT_ORIGIN],
    ['ADMIN_ORIGIN', env.ADMIN_ORIGIN],
    ...String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin, index) => [`ALLOWED_ORIGINS[${index}]`, origin])
  ].filter(([, value]) => String(value || '').trim());
  origins.forEach(([name, value]) => {
    if (localOriginConfigured(value)) errors.push(`${name} cannot point to localhost or private network addresses in production.`);
  });
}

function validateProductionAiConfiguration(env, errors) {
  if (!isProductionEnv(env) || !featureEnabled(env, 'AI_FEATURES_ENABLED', true)) return;
  const imageProvider = String(env.AI_PROVIDER || 'pruna').trim().toLowerCase();
  const videoProvider = String(env.TRYON_VIDEO_PROVIDER || 'pixverse').trim().toLowerCase();
  const required = new Map();
  const requireKey = (key, feature) => {
    if (!required.has(key)) required.set(key, []);
    required.get(key).push(feature);
  };

  if (!['pruna', 'fitroom'].includes(imageProvider)) {
    errors.push(`Unsupported AI_PROVIDER "${imageProvider}" in production.`);
  } else if (imageProvider === 'pruna') requireKey('PRUNA_API_KEY', 'Pruna image try-on');
  else requireKey('FITROOM_API_KEY', 'FitRoom image try-on');

  if (!['pruna', 'pixverse', 'fal'].includes(videoProvider)) {
    errors.push(`Unsupported TRYON_VIDEO_PROVIDER "${videoProvider}" in production.`);
  } else if (videoProvider === 'pruna') requireKey('PRUNA_API_KEY', 'Pruna video generation');
  else requireKey('FAL_KEY', 'PixVerse video generation');

  if (featureEnabled(env, 'PROFILE_FULL_BODY_GENERATION', true)) {
    requireKey('FAL_KEY', 'full-body profile generation');
  }
  if (featureEnabled(env, 'CLOSET_GENERATION_ENABLED', true)) {
    requireKey('FITROOM_API_KEY', 'closet outfit generation');
  }

  for (const [key, features] of required) {
    if (!String(env[key] || '').trim()) {
      errors.push(`${key} is required in production for ${features.join(' and ')}.`);
    }
  }
}

export function phonePeEnabled(env = process.env) {
  const value = String(env.PHONEPE_ENABLED || '').trim().toLowerCase();
  return value ? !FALSE_ENV_VALUES.has(value) : true;
}

export function razorpayEnabled(env = process.env) {
  const value = String(env.RAZORPAY_ENABLED || '').trim().toLowerCase();
  return value ? !FALSE_ENV_VALUES.has(value) : true;
}

function razorpayPairStatus(env = process.env, mode = '') {
  const upper = String(mode || '').trim().toUpperCase();
  const prefix = upper ? `RAZORPAY_${upper}_` : 'RAZORPAY_';
  const keyId = String(env[`${prefix}KEY_ID`] || '').trim();
  const keySecret = String(env[`${prefix}KEY_SECRET`] || '').trim();
  return {
    keyId,
    keySecret,
    configured: Boolean(keyId && keySecret),
    partial: Boolean(keyId || keySecret) && !(keyId && keySecret)
  };
}

function razorpayAnyPairConfigured(env = process.env) {
  return ['TEST', 'LIVE', ''].some((mode) => razorpayPairStatus(env, mode).configured);
}

function fixedOtpAllowedInProduction(env = process.env) {
  return TRUE_ENV_VALUES.has(String(env.ALLOW_FIXED_OTP_IN_PRODUCTION || '').trim().toLowerCase());
}

export function validateServerEnv(env = process.env) {
  const errors = [];
  const missing = REQUIRED_SERVER_ENV.filter((key) => !String(env[key] || '').trim());
  if (missing.length) errors.push(`Missing required server environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);

  const production = isProductionEnv(env);
  validateProductionAiConfiguration(env, errors);
  if (production) {
    if (!String(env.CLIENT_ORIGIN || '').trim()) errors.push('CLIENT_ORIGIN is required in production.');
    if (TRUE_ENV_VALUES.has(String(env.ALLOW_LOCAL_ORIGINS || '').trim().toLowerCase())) {
      errors.push('ALLOW_LOCAL_ORIGINS cannot be enabled in production.');
    }
    if (TRUE_ENV_VALUES.has(String(env.ENABLE_DEV_MODE || '').trim().toLowerCase())) {
      errors.push('ENABLE_DEV_MODE cannot be enabled in production.');
    }
    validateProductionOriginList(env, errors);
  }
  const catalogSearchProvider = String(env.CATALOG_SEARCH_PROVIDER || '').trim().toLowerCase();
  if (catalogSearchProvider && !['amazon', 'amazon-html', 'serpapi'].includes(catalogSearchProvider)) {
    errors.push(`Unsupported CATALOG_SEARCH_PROVIDER "${catalogSearchProvider}".`);
  }
  if (production && catalogSearchProvider === 'serpapi' && !String(env.SERPAPI_API_KEY || '').trim()) {
    errors.push('SERPAPI_API_KEY is required in production when CATALOG_SEARCH_PROVIDER=serpapi.');
  }
  try {
    passwordHashingConfig(env);
  } catch (error) {
    errors.push(error.message);
  }
  const assertUrl = (key, options = {}) => {
    const value = String(env[key] || '').trim();
    if (!value) return;
    try {
      validateConfiguredHttpsUrl(value, { name: key, env, ...options });
    } catch (error) {
      errors.push(error.message);
    }
  };

  const otpProvider = String(env.OTP_DELIVERY_PROVIDER || '').trim().toLowerCase();
  const allowProductionFixedOtp = fixedOtpAllowedInProduction(env);
  const paymentsEnabled = phonePeEnabled(env);
  const razorpayPaymentsEnabled = razorpayEnabled(env);
  const appleIapEnabled = featureEnabled(env, 'APPLE_IAP_ENABLED', false);
  if (production && !['msg91', 'webhook', 'disabled'].includes(otpProvider)) {
    errors.push('Production requires OTP_DELIVERY_PROVIDER=msg91, webhook, or disabled.');
  }

  const warnings = FEATURE_ENV_GROUPS.flatMap((group) => {
    if (group.name === 'PhonePe payments' && !paymentsEnabled) return [];
    if (group.name === 'Razorpay payments' && !razorpayPaymentsEnabled) return [];
    if (group.name === 'Apple in-app purchases' && !appleIapEnabled) return [];
    const present = group.keys.filter((key) => String(env[key] || '').trim());
    if (!present.length || present.length === group.keys.length) return [];
    const missingFeatureKeys = group.keys.filter((key) => !String(env[key] || '').trim());
    return [`${group.name} is partially configured. Missing: ${missingFeatureKeys.join(', ')}`];
  });
  if (otpProvider && !['disabled', 'mock', 'msg91', 'webhook'].includes(otpProvider)) {
    warnings.push(`OTP delivery provider "${otpProvider}" is unsupported.`);
  }
  if (otpProvider === 'msg91') {
    const missingMsg91Keys = ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'].filter((key) => !String(env[key] || '').trim());
    if (missingMsg91Keys.length) {
      const message = `MSG91 OTP delivery is partially configured. Missing: ${missingMsg91Keys.join(', ')}`;
      if (production) errors.push(message);
      else warnings.push(message);
    }
    if (String(env.MSG91_BASE_URL || '').trim()) assertUrl('MSG91_BASE_URL');
  }
  if (otpProvider === 'webhook' && !String(env.OTP_DELIVERY_WEBHOOK_URL || '').trim()) {
    const message = 'OTP delivery webhook is configured but OTP_DELIVERY_WEBHOOK_URL is missing.';
    if (production) errors.push(message);
    else warnings.push(message);
  }
  if (otpProvider === 'webhook') {
    assertUrl('OTP_DELIVERY_WEBHOOK_URL');
  }
  if (otpProvider === 'mock' && String(env.NODE_ENV || '').toLowerCase() === 'production') {
    const message = 'Mock OTP delivery is not allowed in production.';
    if (production) errors.push(message);
    else warnings.push(message);
  }
  if (String(env.OTP_FIXED_CODE || '').trim()) {
    const validFixedCode = /^\d{6}$/.test(String(env.OTP_FIXED_CODE || '').trim());
    if (!validFixedCode) {
      errors.push('OTP_FIXED_CODE must be exactly 6 digits.');
    } else if (production && !allowProductionFixedOtp) {
      errors.push('OTP_FIXED_CODE is not allowed in production.');
    } else if (otpProvider && otpProvider !== 'mock' && otpProvider !== 'disabled') {
      warnings.push('OTP_FIXED_CODE only applies when OTP_DELIVERY_PROVIDER=mock or disabled.');
    }
  }
  if (otpProvider === 'mock' && !String(env.OTP_MOCK_STORE_PATH || '').trim()) {
    warnings.push('Mock OTP delivery is configured but OTP_MOCK_STORE_PATH is missing.');
  }

  if (paymentsEnabled) assertUrl('PHONEPE_REDIRECT_URL');
  assertUrl('CLIENT_ORIGIN');
  assertUrl('ADMIN_ORIGIN');
  String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean).forEach((origin, index) => {
    try {
      validateConfiguredHttpsUrl(origin, { name: `ALLOWED_ORIGINS[${index}]`, env });
    } catch (error) {
      errors.push(error.message);
    }
  });
  if (TRUE_ENV_VALUES.has(String(env.LOKI_ENABLED || '').trim().toLowerCase())) {
    if (!String(env.LOKI_URL || '').trim()) errors.push('LOKI_URL is required when LOKI_ENABLED=true.');
    else assertUrl('LOKI_URL');
  }
  const phonePeKeys = FEATURE_ENV_GROUPS.find((group) => group.name === 'PhonePe payments').keys;
  const presentPhonePeKeys = phonePeKeys.filter((key) => String(env[key] || '').trim());
  if (production && paymentsEnabled && presentPhonePeKeys.length && presentPhonePeKeys.length !== phonePeKeys.length) {
    const missingPhonePeKeys = phonePeKeys.filter((key) => !String(env[key] || '').trim());
    errors.push(`PhonePe payments are partially configured. Missing: ${missingPhonePeKeys.join(', ')}`);
  }
  const razorpayKeys = FEATURE_ENV_GROUPS.find((group) => group.name === 'Razorpay payments').keys;
  const presentRazorpayKeys = razorpayKeys.filter((key) => String(env[key] || '').trim());
  if (production && razorpayPaymentsEnabled && presentRazorpayKeys.length && presentRazorpayKeys.length !== razorpayKeys.length) {
    const missingRazorpayKeys = razorpayKeys.filter((key) => !String(env[key] || '').trim());
    errors.push(`Razorpay payments are partially configured. Missing: ${missingRazorpayKeys.join(', ')}`);
  }
  for (const mode of ['TEST', 'LIVE']) {
    const status = razorpayPairStatus(env, mode);
    if (production && razorpayPaymentsEnabled && status.partial) {
      const missing = [
        !status.keyId ? `RAZORPAY_${mode}_KEY_ID` : '',
        !status.keySecret ? `RAZORPAY_${mode}_KEY_SECRET` : ''
      ].filter(Boolean);
      errors.push(`Razorpay ${mode.toLowerCase()} payments are partially configured. Missing: ${missing.join(', ')}`);
    }
  }
  const appleKeys = FEATURE_ENV_GROUPS.find((group) => group.name === 'Apple in-app purchases').keys;
  const presentAppleKeys = appleKeys.filter((key) => String(env[key] || '').trim());
  if (production && appleIapEnabled && presentAppleKeys.length !== appleKeys.length) {
    const missingAppleKeys = appleKeys.filter((key) => !String(env[key] || '').trim());
    errors.push(`Apple in-app purchases are partially configured. Missing: ${missingAppleKeys.join(', ')}`);
  }
  if (production && appleIapEnabled) {
    const hasApplePrivateKey = Boolean(String(env.APPLE_IAP_PRIVATE_KEY || '').trim()) || Boolean(String(env.APPLE_IAP_PRIVATE_KEY_PATH || '').trim());
    const hasAppleRootCertificates = Boolean(String(env.APPLE_ROOT_CA_CERTS_BASE64 || '').trim())
      || Boolean(String(env.APPLE_ROOT_CA_CERT_PATHS || '').trim())
      || Boolean(String(env.APPLE_ROOT_CA_CERTS_DIR || '').trim());
    if (!hasApplePrivateKey) {
      errors.push('APPLE_IAP_PRIVATE_KEY or APPLE_IAP_PRIVATE_KEY_PATH is required when APPLE_IAP_ENABLED=true.');
    }
    if (!hasAppleRootCertificates) {
      errors.push('Apple root certificates are required when APPLE_IAP_ENABLED=true.');
    }
    const appleEnvironment = String(env.APPLE_IAP_ENVIRONMENT || '').trim().toLowerCase();
    if (appleEnvironment === 'production' && !Number(env.APPLE_APP_APPLE_ID || 0)) {
      errors.push('APPLE_APP_APPLE_ID is required for production Apple IAP verification.');
    }
  }

  if (errors.length) throw new Error(errors.join(' '));
  return { warnings };
}

export function configurationReadiness(env = process.env) {
  const otpProvider = String(env.OTP_DELIVERY_PROVIDER || '').trim().toLowerCase();
  const paymentsEnabled = phonePeEnabled(env);
  const razorpayPaymentsEnabled = razorpayEnabled(env);
  const appleIapEnabled = featureEnabled(env, 'APPLE_IAP_ENABLED', false);
  const phonePeKeys = ['PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION', 'PHONEPE_CALLBACK_USERNAME', 'PHONEPE_CALLBACK_PASSWORD'];
  const phonePeConfigured = phonePeKeys.every((key) => Boolean(String(env[key] || '').trim()));
  const razorpayConfigured = razorpayAnyPairConfigured(env);
  const appleKeys = ['APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID', 'APPLE_BUNDLE_ID'];
  const appleConfigured = appleKeys.every((key) => Boolean(String(env[key] || '').trim()))
    && (Boolean(String(env.APPLE_IAP_PRIVATE_KEY || '').trim()) || Boolean(String(env.APPLE_IAP_PRIVATE_KEY_PATH || '').trim()))
    && (
      Boolean(String(env.APPLE_ROOT_CA_CERTS_BASE64 || '').trim())
      || Boolean(String(env.APPLE_ROOT_CA_CERT_PATHS || '').trim())
      || Boolean(String(env.APPLE_ROOT_CA_CERTS_DIR || '').trim())
    );
  const fixedOtpConfigured = isProductionEnv(env)
    && fixedOtpAllowedInProduction(env)
    && /^\d{6}$/.test(String(env.OTP_FIXED_CODE || '').trim())
    && (!otpProvider || otpProvider === 'disabled' || otpProvider === 'mock');
  const msg91Configured = ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID']
    .every((key) => Boolean(String(env[key] || '').trim()));
  const otpConfigured = otpProvider === 'msg91'
    ? msg91Configured
    : otpProvider === 'webhook'
    ? Boolean(String(env.OTP_DELIVERY_WEBHOOK_URL || '').trim())
    : otpProvider === 'mock'
      ? !isProductionEnv(env) && Boolean(String(env.OTP_MOCK_STORE_PATH || '').trim())
      : fixedOtpConfigured;

  return {
    otpProvider: fixedOtpConfigured ? 'configured' : otpProvider === 'disabled' ? 'disabled' : otpConfigured ? 'configured' : 'not_configured',
    otpProviderType: fixedOtpConfigured ? 'fixed' : otpProvider || 'disabled',
    phonePe: !paymentsEnabled ? 'disabled' : phonePeConfigured ? 'configured' : 'not_configured',
    razorpay: !razorpayPaymentsEnabled ? 'disabled' : razorpayConfigured ? 'configured' : 'not_configured',
    appleIap: !appleIapEnabled ? 'disabled' : appleConfigured ? 'configured' : 'not_configured'
  };
}
