import express from 'express';
import mongoose from 'mongoose';
import CreditEvent from '../models/CreditEvent.js';
import AppleTransaction from '../models/AppleTransaction.js';
import TokenOrder from '../models/TokenOrder.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { requireAdmin } from '../utils/adminAuth.js';
import {
  APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID,
  APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
  appleAppAccountTokenForUserId,
  appleProductConfig,
  appleStoreConfigStatus,
  fetchAndVerifyAppleTransaction,
  fetchAppleSubscriptionHistory,
  fetchAppleSubscriptionStatuses,
  normalizeAppleSubscriptionStatus,
  readableAppleError,
  userIdFromAppleAppAccountToken,
  verifyAppleNotification,
  verifyAppleSignedRenewalInfo,
  verifyAppleSignedTransaction
} from '../utils/appleStoreKit.js';

const router = express.Router();

function ratePerCredit(amount, credits) {
  const value = Number(amount) / 100 / Math.max(1, Number(credits) || 1);
  return Number(value.toFixed(2));
}

function plan(config) {
  return {
    currency: 'INR',
    ...config,
    ratePerCredit: ratePerCredit(config.amount, config.tokens)
  };
}

const SUBSCRIPTION_PLAN = plan({
  id: 'monthly_150_credits',
  legacyIds: ['monthly_100_tokens'],
  type: 'subscription',
  purchaseType: 'subscription_setup',
  name: 'FitLook Monthly',
  headline: '150 credits every month',
  amount: 49900,
  tokens: 150,
  billingFrequency: 'monthly',
  cadence: 'Monthly',
  description: '150 credits every month for AI try-on images, videos, and styling work.',
  appStoreProductId: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
  summary: 'Cancel future monthly billing before the next renewal from your account or by contacting support.'
});

const TOP_UP_PLANS = [
  plan({
    id: 'top_up_50_credits',
    type: 'top_up',
    purchaseType: 'top_up',
    name: 'Top-up',
    headline: '50 credits',
    amount: 19900,
    tokens: 50,
    billingFrequency: 'one_time',
    cadence: 'One-time',
    appStoreProductId: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID.top_up_50_credits,
    description: 'One-time refill for extra image try-ons and videos.'
  }),
  plan({
    id: 'top_up_75_credits',
    type: 'top_up',
    purchaseType: 'top_up',
    name: 'Top-up',
    headline: '75 credits',
    amount: 29900,
    tokens: 75,
    billingFrequency: 'one_time',
    cadence: 'One-time',
    appStoreProductId: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID.top_up_75_credits,
    description: 'One-time refill for extra image try-ons and videos.'
  }),
  plan({
    id: 'top_up_110_credits',
    type: 'top_up',
    purchaseType: 'top_up',
    name: 'Top-up',
    headline: '110 credits',
    amount: 39900,
    tokens: 110,
    billingFrequency: 'one_time',
    cadence: 'One-time',
    appStoreProductId: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID.top_up_110_credits,
    description: 'Better value for product batches and style exploration.'
  }),
  plan({
    id: 'top_up_135_credits',
    type: 'top_up',
    purchaseType: 'top_up',
    name: 'Top-up',
    headline: '135 credits',
    amount: 49900,
    tokens: 135,
    billingFrequency: 'one_time',
    cadence: 'One-time',
    appStoreProductId: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID.top_up_135_credits,
    description: 'Better value for product batches and style exploration.'
  }),
  plan({
    id: 'top_up_400_credits',
    type: 'top_up',
    purchaseType: 'top_up',
    name: 'Top-up',
    headline: '400 credits',
    amount: 99900,
    tokens: 400,
    billingFrequency: 'one_time',
    cadence: 'One-time',
    appStoreProductId: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID.top_up_400_credits,
    badge: 'Best value',
    description: 'Best value for bulk catalog work and repeated video trials.'
  })
];

const ALL_PLANS = [SUBSCRIPTION_PLAN, ...TOP_UP_PLANS];
const PLAN_BY_ID = new Map();
for (const item of ALL_PLANS) {
  PLAN_BY_ID.set(item.id, item);
  for (const legacyId of item.legacyIds || []) PLAN_BY_ID.set(legacyId, item);
}

let cachedAuth = null;

function phonePeEnv() {
  return String(process.env.PHONEPE_ENV || process.env.NODE_ENV || 'production').toLowerCase();
}

function isSandbox() {
  return ['sandbox', 'uat', 'preprod', 'development', 'dev', 'test'].includes(phonePeEnv());
}

function phonePePgBaseUrl() {
  const prod = 'https://api.phonepe.com/apis/pg';
  const preprod = 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  if (process.env.PHONEPE_BASE_URL) {
    const given = process.env.PHONEPE_BASE_URL.replace(/\/+$/, '');
    if (isSandbox() && given === prod) {
      console.warn('[phonepe] PHONEPE_BASE_URL points to production while PHONEPE_ENV is sandbox - using preprod URL instead');
      return preprod;
    }
    return given;
  }
  return isSandbox() ? preprod : prod;
}

function phonePeAuthUrl() {
  const prod = 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';
  const preprod = 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';
  if (process.env.PHONEPE_AUTH_URL) {
    const given = process.env.PHONEPE_AUTH_URL;
    if (isSandbox() && given === prod) {
      console.warn('[phonepe] PHONEPE_AUTH_URL points to production while PHONEPE_ENV is sandbox - using preprod URL instead');
      return preprod;
    }
    return given;
  }
  return isSandbox() ? preprod : prod;
}

function planToClient(item) {
  return {
    id: item.id,
    type: item.type,
    purchaseType: item.purchaseType,
    name: item.name,
    headline: item.headline,
    amount: item.amount,
    currency: item.currency,
    tokens: item.tokens,
    credits: item.tokens,
    billingFrequency: item.billingFrequency,
    cadence: item.cadence,
    ratePerCredit: item.ratePerCredit,
    appStoreProductId: item.appStoreProductId || '',
    badge: item.badge || '',
    description: item.description,
    summary: item.summary || ''
  };
}

function availablePlansPayload() {
  const subscription = planToClient(SUBSCRIPTION_PLAN);
  const topUps = TOP_UP_PLANS.map(planToClient);
  return {
    subscription,
    topUps,
    plans: [subscription, ...topUps],
    appStoreProductIds: {
      monthlySubscription: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
      creditTopUps: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID
    },
    creditCosts: {
      starterCredits: Number(process.env.SIGNUP_FREE_TOKENS || 8),
      image: Number(process.env.TRYON_TOKEN_COST || 1),
      customTryOn: Number(process.env.TRYON_TOKEN_COST || 1),
      video: Number(process.env.TRYON_VIDEO_TOKEN_COST || 3)
    }
  };
}

function planForId(planId, expectedType) {
  const item = PLAN_BY_ID.get(String(planId || '').trim());
  if (!item) return null;
  if (expectedType && item.type !== expectedType) return null;
  return item;
}

function startShortPolling(merchantOrderId) {
  const attempts = Number(process.env.PHONEPE_SHORT_POLL_ATTEMPTS || 6);
  const intervalMs = Number(process.env.PHONEPE_SHORT_POLL_MS || 5000);
  let tries = 0;
  const id = setInterval(async () => {
    tries += 1;
    try {
      const order = await TokenOrder.findOne({ merchantOrderId });
      if (!order) {
        if (tries >= attempts) clearInterval(id);
        return;
      }
      const result = await reconcileOrder(order);
      const state = String(result.order?.providerState || '').toUpperCase();
      if (isCompletedState(state) || result.order?.creditedAt) {
        clearInterval(id);
        return;
      }
      if (tries >= attempts) clearInterval(id);
    } catch (err) {
      console.error('[phonepe:shortpoll]', merchantOrderId, readablePhonePeError(err));
      if (tries >= attempts) clearInterval(id);
    }
  }, intervalMs);
}

function clientOrigin(req) {
  return process.env.CLIENT_ORIGIN || req.get('origin') || `${req.protocol}://${req.get('host')}`;
}

function originFor(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function isLocalHttpUrl(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
}

function allowedRedirectSchemes() {
  return new Set(
    String(process.env.PHONEPE_ALLOWED_REDIRECT_SCHEMES || 'lookmefy,com.kratikdhote.lookmefy')
      .split(',')
      .map((item) => item.trim().replace(/:$/, ''))
      .filter(Boolean)
  );
}

function safeRequestedReturnUrl(req) {
  const raw = String(req.body?.redirectUrl || req.get('x-lookmefy-return-url') || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, clientOrigin(req));
    const scheme = url.protocol.replace(/:$/, '');
    if (allowedRedirectSchemes().has(scheme)) return url.toString();

    const allowedOrigins = new Set([
      originFor(clientOrigin(req)),
      originFor(process.env.CLIENT_ORIGIN || ''),
      originFor(process.env.PHONEPE_REDIRECT_URL || '')
    ].filter(Boolean));
    if ((url.protocol === 'https:' || (isSandbox() && isLocalHttpUrl(url))) && allowedOrigins.has(url.origin)) {
      return url.toString();
    }
  } catch {
    return '';
  }
  return '';
}

function configuredReturnUrl(req, merchantOrderId, selectedPlan) {
  const base = safeRequestedReturnUrl(req) || process.env.PHONEPE_REDIRECT_URL || `${clientOrigin(req)}/tokens`;
  const url = new URL(base, clientOrigin(req));
  url.searchParams.set('merchantOrderId', merchantOrderId);
  url.searchParams.set('plan', selectedPlan.id);
  url.searchParams.set('purchaseType', selectedPlan.purchaseType);
  return url.toString();
}

function addMonths(date, count) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + count);
  return next;
}

function millisFromNow(seconds) {
  return Date.now() + Math.max(1, Number(seconds) || 1) * 1000;
}

function requirePhonePeConfig() {
  const missing = ['PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION']
    .filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`${missing.join(', ')} missing on the server`);
}

function readablePhonePeError(value, fallback = 'PhonePe request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') return value.message || value.code || value.error || fallback;
  return String(value);
}

async function phonePeAuthToken() {
  requirePhonePeConfig();
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (cachedAuth?.accessToken && cachedAuth.expiresAt - 60 > nowSeconds) return cachedAuth;

  const body = new URLSearchParams();
  body.set('client_id', process.env.PHONEPE_CLIENT_ID);
  body.set('client_version', process.env.PHONEPE_CLIENT_VERSION || '1');
  body.set('client_secret', process.env.PHONEPE_CLIENT_SECRET);
  body.set('grant_type', 'client_credentials');

  const response = await fetch(phonePeAuthUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await response.text().catch(() => '');
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }
  if (!response.ok || !data.access_token) {
    console.error('[phonepe:auth] failed', { status: response.status, body: data });
    throw new Error(readablePhonePeError(data, 'Could not authorize PhonePe'));
  }

  cachedAuth = {
    accessToken: data.access_token,
    tokenType: data.token_type || 'O-Bearer',
    expiresAt: Number(data.expires_at || nowSeconds + 300)
  };
  return cachedAuth;
}

async function phonePeFetch(path, options = {}) {
  const auth = await phonePeAuthToken();
  const response = await fetch(`${phonePePgBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `${auth.tokenType} ${auth.accessToken}`,
      ...options.headers
    }
  });
  const text = await response.text().catch(() => '');
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }
  if (!response.ok) {
    console.error('[phonepe:fetch] failed', { path, status: response.status, body: data });
    throw new Error(readablePhonePeError(data, 'PhonePe request failed'));
  }
  return data;
}

function createMerchantOrderId(userId, prefix = 'FL') {
  const userPart = userId.toString().slice(-8);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${Date.now()}_${userPart}_${random}`.slice(0, 63);
}

function createMerchantSubscriptionId(userId) {
  const userPart = userId.toString().slice(-8);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FLSUB_${Date.now()}_${userPart}_${random}`.slice(0, 63);
}

function phonePePaymentUrl(data) {
  return data?.redirectUrl
    || data?.data?.redirectUrl
    || data?.instrumentResponse?.intentUrl
    || data?.instrumentResponse?.redirectInfo?.url
    || data?.data?.instrumentResponse?.intentUrl
    || data?.data?.instrumentResponse?.redirectInfo?.url
    || '';
}

function platformFromRequest(req) {
  return String(req.body?.platform || req.get('x-lookmefy-platform') || '').toLowerCase();
}

function subscriptionPaymentMode(req) {
  const vpa = String(req.body?.vpa || '').trim();
  if (vpa) {
    return {
      type: 'UPI_COLLECT',
      details: { type: 'VPA', vpa }
    };
  }

  const mode = { type: 'UPI_INTENT' };
  if (platformFromRequest(req) === 'android') {
    mode.targetApp = process.env.PHONEPE_UPI_TARGET_APP || 'com.phonepe.app';
  }
  return mode;
}

function deviceContext(req) {
  const platform = platformFromRequest(req);
  if (platform === 'android') return { deviceOS: 'ANDROID' };
  if (platform === 'ios') return { deviceOS: 'IOS' };
  return undefined;
}

function metaInfoForOrder(user, selectedPlan, purchaseType) {
  return {
    udf1: user._id.toString(),
    udf2: selectedPlan.id,
    udf3: String(selectedPlan.tokens),
    udf4: 'Lookmefy',
    udf5: purchaseType
  };
}

function isSubscriptionOrder(order) {
  return ['subscription_setup', 'subscription_renewal'].includes(order.purchaseType);
}

function isCompletedState(state) {
  return ['COMPLETED', 'SUCCESS', 'EXECUTED'].includes(String(state || '').toUpperCase());
}

function isFailedState(state) {
  return ['FAILED', 'CANCELLED', 'EXPIRED'].includes(String(state || '').toUpperCase());
}

function orderStatusPath(order) {
  const encoded = encodeURIComponent(order.merchantOrderId);
  return isSubscriptionOrder(order)
    ? `/subscriptions/v2/order/${encoded}/status?details=true`
    : `/checkout/v2/order/${encoded}/status?details=true&errorContext=true`;
}

async function createTopUpPayment({ req, user, selectedPlan }) {
  const merchantOrderId = createMerchantOrderId(user._id, 'FLTU');
  const returnUrl = configuredReturnUrl(req, merchantOrderId, selectedPlan);
  const order = await TokenOrder.create({
    user: user._id,
    merchantOrderId,
    planId: selectedPlan.id,
    planName: selectedPlan.name,
    purchaseType: 'top_up',
    billingFrequency: selectedPlan.billingFrequency,
    ratePerCredit: selectedPlan.ratePerCredit,
    amount: selectedPlan.amount,
    currency: selectedPlan.currency,
    tokens: selectedPlan.tokens,
    redirectUrl: returnUrl
  });

  try {
    const payload = {
      merchantOrderId,
      amount: selectedPlan.amount,
      expireAfter: Number(process.env.PHONEPE_ORDER_EXPIRE_SECONDS || 1200),
      metaInfo: metaInfoForOrder(user, selectedPlan, 'top_up'),
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: `${selectedPlan.headline} Lookmefy top-up`,
        merchantUrls: { redirectUrl: returnUrl }
      }
    };

    const data = await phonePeFetch('/checkout/v2/pay', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    order.status = 'pending';
    order.providerState = data.state || 'PENDING';
    order.phonePeOrderId = data.orderId || data?.data?.orderId;
    order.redirectUrl = phonePePaymentUrl(data) || returnUrl;
    order.providerResponse = data;
    await order.save();
    startShortPolling(merchantOrderId);
    return order;
  } catch (error) {
    order.status = 'failed';
    order.providerState = 'CREATE_FAILED';
    order.providerResponse = { message: readablePhonePeError(error) };
    await order.save();
    throw error;
  }
}

async function createSubscriptionSetup({ req, user, selectedPlan }) {
  const merchantOrderId = createMerchantOrderId(user._id, 'FLSU');
  const merchantSubscriptionId = createMerchantSubscriptionId(user._id);
  const returnUrl = configuredReturnUrl(req, merchantOrderId, selectedPlan);
  const periodStart = new Date();
  const periodEnd = addMonths(periodStart, 1);
  const order = await TokenOrder.create({
    user: user._id,
    merchantOrderId,
    merchantSubscriptionId,
    planId: selectedPlan.id,
    planName: selectedPlan.name,
    purchaseType: 'subscription_setup',
    billingFrequency: selectedPlan.billingFrequency,
    ratePerCredit: selectedPlan.ratePerCredit,
    amount: selectedPlan.amount,
    currency: selectedPlan.currency,
    tokens: selectedPlan.tokens,
    redirectUrl: returnUrl,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd
  });

  try {
    const payload = {
      merchantOrderId,
      amount: selectedPlan.amount,
      expireAt: millisFromNow(process.env.PHONEPE_ORDER_EXPIRE_SECONDS || 1200),
      metaInfo: metaInfoForOrder(user, selectedPlan, 'subscription_setup'),
      paymentFlow: {
        type: 'SUBSCRIPTION_SETUP',
        merchantSubscriptionId,
        authWorkflowType: 'TRANSACTION',
        amountType: 'FIXED',
        maxAmount: selectedPlan.amount,
        frequency: process.env.PHONEPE_SUBSCRIPTION_FREQUENCY || 'ON_DEMAND',
        expireAt: millisFromNow(process.env.PHONEPE_SUBSCRIPTION_EXPIRE_SECONDS || 365 * 24 * 60 * 60),
        paymentMode: subscriptionPaymentMode(req)
      },
      deviceContext: deviceContext(req)
    };
    if (!payload.deviceContext) delete payload.deviceContext;

    const data = await phonePeFetch('/subscriptions/v2/setup', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    order.status = 'pending';
    order.providerState = data.state || 'PENDING';
    order.subscriptionState = data.subscriptionState || data.state || '';
    order.phonePeOrderId = data.orderId || data?.data?.orderId;
    order.redirectUrl = phonePePaymentUrl(data) || returnUrl;
    order.providerResponse = data;
    await order.save();
    startShortPolling(merchantOrderId);
    return order;
  } catch (error) {
    order.status = 'failed';
    order.providerState = 'CREATE_FAILED';
    order.providerResponse = { message: readablePhonePeError(error) };
    await order.save();
    throw error;
  }
}

function creditActionForOrder(order) {
  if (order.purchaseType === 'top_up') return 'Top-up purchase';
  if (order.purchaseType === 'subscription_renewal') return 'Monthly renewal credits';
  return 'Monthly credits';
}

async function recordPaymentCreditEvent({ session, user, order }) {
  await CreditEvent.create([{
    user: user._id,
    action: creditActionForOrder(order),
    productTitle: order.planName,
    tokens: order.tokens,
    balanceAfter: user.tokens,
    metadata: {
      direction: 'credit',
      merchantOrderId: order.merchantOrderId,
      merchantSubscriptionId: order.merchantSubscriptionId || '',
      purchaseType: order.purchaseType,
      planId: order.planId
    }
  }], { session });
}

function subscriptionUpdateForOrder(order, now) {
  const currentPeriodStart = order.currentPeriodStart || now;
  const currentPeriodEnd = order.currentPeriodEnd || addMonths(currentPeriodStart, 1);
  return {
    planId: order.planId,
    status: 'active',
    merchantSubscriptionId: order.merchantSubscriptionId,
    amount: order.amount,
    currency: order.currency,
    tokensPerMonth: order.tokens,
    currentPeriodStart,
    currentPeriodEnd,
    nextBillingAt: currentPeriodEnd,
    cancelledAt: null,
    lastOrderId: order.merchantOrderId
  };
}

async function grantPaidTokens(order, providerResponse) {
  if (order.creditedAt) return User.findById(order.user);

  const now = new Date();
  const session = await mongoose.startSession();
  let user = null;

  try {
    await session.withTransaction(async () => {
      const creditedOrder = await TokenOrder.findOneAndUpdate(
        { _id: order._id, creditedAt: null },
        {
          $set: {
            status: 'completed',
            providerState: 'COMPLETED',
            providerResponse,
            creditedAt: now
          }
        },
        { new: true, session }
      );
      if (!creditedOrder) {
        user = await User.findById(order.user).session(session);
        return;
      }

      const update = { $inc: { tokens: creditedOrder.tokens } };
      if (isSubscriptionOrder(creditedOrder)) {
        update.$set = { subscription: subscriptionUpdateForOrder(creditedOrder, now) };
      }

      user = await User.findByIdAndUpdate(order.user, update, { new: true, session });
      if (!user) throw new Error('Could not credit tokens because the user account was not found.');
      await recordPaymentCreditEvent({ session, user, order: creditedOrder });
    });
    return user || User.findById(order.user);
  } finally {
    await session.endSession();
  }
}

async function reconcileOrder(order) {
  if (!order) return { order: null, user: null };
  if (order.creditedAt) return { order, user: await User.findById(order.user) };

  const status = await phonePeFetch(orderStatusPath(order));
  const state = String(status.state || status.providerState || '').toUpperCase();

  if (isCompletedState(state)) {
    const user = await grantPaidTokens(order, status);
    const completedOrder = await TokenOrder.findById(order._id);
    return { order: completedOrder, user };
  }

  order.providerState = state || order.providerState;
  order.subscriptionState = status.subscriptionState || order.subscriptionState;
  order.providerResponse = status;
  if (isFailedState(state)) order.status = 'failed';
  else if (state === 'PENDING') order.status = 'pending';
  await order.save();
  return { order, user: await User.findById(order.user) };
}

function deepFindString(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return '';
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && item) return String(item).trim();
    if (item && typeof item === 'object') {
      const found = deepFindString(item, keys, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function orderIdFromCallback(req) {
  const candidates = [
    req.query?.merchantOrderId,
    req.body?.merchantOrderId,
    req.body?.merchantOrderID,
    req.body?.eventPayload?.merchantOrderId,
    req.body?.payload?.merchantOrderId,
    req.body?.data?.merchantOrderId,
    deepFindString(req.body, new Set(['merchantOrderId', 'merchantOrderID']))
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function subscriptionIdFromCallback(req) {
  const candidates = [
    req.query?.merchantSubscriptionId,
    req.body?.merchantSubscriptionId,
    req.body?.eventPayload?.merchantSubscriptionId,
    req.body?.payload?.merchantSubscriptionId,
    req.body?.data?.merchantSubscriptionId,
    deepFindString(req.body, new Set(['merchantSubscriptionId']))
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
}

async function orderFromCallback(req) {
  const merchantOrderId = orderIdFromCallback(req);
  if (merchantOrderId) return TokenOrder.findOne({ merchantOrderId });

  const merchantSubscriptionId = subscriptionIdFromCallback(req);
  if (!merchantSubscriptionId) return null;
  return TokenOrder.findOne({ merchantSubscriptionId, status: 'pending' }).sort({ createdAt: -1 });
}

async function createSubscriptionRenewal({ user, redeem = true }) {
  const selectedPlan = SUBSCRIPTION_PLAN;
  const merchantSubscriptionId = user.subscription?.merchantSubscriptionId;
  if (!merchantSubscriptionId) throw new Error('User does not have a PhonePe subscription mandate');

  const merchantOrderId = createMerchantOrderId(user._id, 'FLRN');
  const periodStart = new Date();
  const periodEnd = addMonths(periodStart, 1);
  const order = await TokenOrder.create({
    user: user._id,
    merchantOrderId,
    merchantSubscriptionId,
    planId: selectedPlan.id,
    planName: selectedPlan.name,
    purchaseType: 'subscription_renewal',
    billingFrequency: selectedPlan.billingFrequency,
    ratePerCredit: selectedPlan.ratePerCredit,
    amount: selectedPlan.amount,
    currency: selectedPlan.currency,
    tokens: selectedPlan.tokens,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd
  });

  try {
    const notifyPayload = {
      merchantOrderId,
      amount: selectedPlan.amount,
      expireAt: millisFromNow(process.env.PHONEPE_RENEWAL_EXPIRE_SECONDS || 24 * 60 * 60),
      metaInfo: metaInfoForOrder(user, selectedPlan, 'subscription_renewal'),
      paymentFlow: {
        type: 'SUBSCRIPTION_REDEMPTION',
        merchantSubscriptionId,
        redemptionRetryStrategy: process.env.PHONEPE_REDEMPTION_RETRY_STRATEGY || 'STANDARD',
        autoDebit: true
      }
    };

    const notifyResponse = await phonePeFetch('/subscriptions/v2/notify', {
      method: 'POST',
      body: JSON.stringify(notifyPayload)
    });
    let redeemResponse = null;
    if (redeem) {
      redeemResponse = await phonePeFetch('/subscriptions/v2/redeem', {
        method: 'POST',
        body: JSON.stringify({ merchantOrderId })
      });
    }

    order.status = 'pending';
    order.providerState = redeemResponse?.state || notifyResponse?.state || 'PENDING';
    order.providerResponse = { notify: notifyResponse, redeem: redeemResponse };
    await order.save();
    startShortPolling(merchantOrderId);
    return order;
  } catch (error) {
    order.status = 'failed';
    order.providerState = 'CREATE_FAILED';
    order.providerResponse = { message: readablePhonePeError(error) };
    await order.save();
    throw error;
  }
}

function appleDate(value) {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis) : undefined;
}

function compactAppleStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isJws(value) {
  return typeof value === 'string' && value.split('.').length === 3;
}

function appleSignedTransactionFromPurchase(purchase = {}) {
  return [
    purchase.signedTransactionInfo,
    purchase.purchaseToken,
    purchase.transactionReceipt,
    purchase.receipt
  ].find(isJws) || '';
}

function appleTransactionIdFromPurchase(purchase = {}) {
  return String(purchase.transactionId || purchase.id || '').trim();
}

function appleEnvironmentHintFromPurchase(purchase = {}) {
  return purchase.environmentIOS || purchase.environmentIos || purchase.environment || '';
}

function appleFulfillmentKey(transaction, productConfig) {
  const transactionId = String(transaction.transactionId || '').trim();
  if (productConfig.kind === 'consumable') return `apple:consumable:${transactionId}`;

  const original = transaction.originalTransactionId || transactionId;
  const period = transaction.webOrderLineItemId || transaction.expiresDate || transaction.purchaseDate || transactionId;
  return `apple:subscription:${original}:${period}`;
}

function appleGrantableSubscription(transaction) {
  return !transaction.revocationDate && !transaction.isUpgraded;
}

function appleGrantableTransaction(transaction, productConfig) {
  if (!transaction?.transactionId || transaction.revocationDate) return false;
  if (productConfig.kind === 'subscription') return appleGrantableSubscription(transaction);
  return productConfig.kind === 'consumable';
}

function appleStatusForTransaction(transaction, productConfig, subscriptionStatus = '') {
  const status = compactAppleStatus(subscriptionStatus);
  if (transaction.revocationDate) return 'revoked';
  if (productConfig.kind === 'subscription') {
    if (status === 'billing_retry' || status === 'billing_grace' || status === 'revoked') return status;
    if (status === 'expired') return 'expired';
    if (transaction.expiresDate && Number(transaction.expiresDate) <= Date.now()) return 'expired';
  }
  return 'verified';
}

function appleSubscriptionStatusForUser(transaction, renewalInfo, subscriptionStatus = '') {
  if (transaction.revocationDate) return 'revoked';
  const status = compactAppleStatus(subscriptionStatus);
  if (status === 'billing_retry' || status === 'billing_grace' || status === 'expired' || status === 'revoked') return status;
  if (transaction.expiresDate && Number(transaction.expiresDate) <= Date.now()) return 'expired';
  return 'active';
}

function appleAutoRenewStatus(renewalInfo) {
  if (!renewalInfo || renewalInfo.autoRenewStatus === undefined || renewalInfo.autoRenewStatus === null) return '';
  return String(renewalInfo.autoRenewStatus);
}

async function appleTransactionBelongsToUser({ user, transaction }) {
  if (!user) return false;
  const expectedToken = appleAppAccountTokenForUserId(user._id);
  const receivedToken = String(transaction.appAccountToken || '').trim().toLowerCase();
  if (receivedToken) return expectedToken && receivedToken === expectedToken;

  const linked = await AppleTransaction.findOne({
    $or: [
      { transactionId: transaction.transactionId },
      { originalTransactionId: transaction.originalTransactionId || transaction.transactionId }
    ],
    user: { $exists: true, $ne: null }
  }).select('user');
  if (!linked) return true;
  return linked.user?.toString?.() === user._id.toString();
}

async function resolveAppleTransactionUser({ user, transaction }) {
  if (user) {
    if (await appleTransactionBelongsToUser({ user, transaction })) return user;
    throw new Error('This Apple transaction is not linked to the signed-in Lookmefy account.');
  }

  const existing = await AppleTransaction.findOne({
    $or: [
      { transactionId: transaction.transactionId },
      { originalTransactionId: transaction.originalTransactionId || transaction.transactionId }
    ],
    user: { $exists: true, $ne: null }
  }).sort({ createdAt: -1 });
  if (existing?.user) return User.findById(existing.user);

  const userId = userIdFromAppleAppAccountToken(transaction.appAccountToken);
  if (userId && mongoose.Types.ObjectId.isValid(userId)) return User.findById(userId);
  return null;
}

function appleTransactionFields({
  user,
  productConfig,
  transaction,
  signedTransactionInfo,
  renewalInfo,
  signedRenewalInfo,
  environment,
  source,
  subscriptionStatus,
  notificationType,
  notificationSubtype,
  rawPurchase
}) {
  const status = appleStatusForTransaction(transaction, productConfig, subscriptionStatus);
  return {
    ...(user ? { user: user._id } : {}),
    productId: transaction.productId,
    productKind: productConfig.kind,
    originalTransactionId: transaction.originalTransactionId || transaction.transactionId,
    webOrderLineItemId: transaction.webOrderLineItemId || '',
    fulfillmentKey: appleFulfillmentKey(transaction, productConfig),
    appAccountToken: String(transaction.appAccountToken || '').trim().toLowerCase(),
    environment: environment || transaction.environment || '',
    bundleId: transaction.bundleId || '',
    productType: transaction.type || '',
    status,
    purchaseDate: appleDate(transaction.purchaseDate),
    originalPurchaseDate: appleDate(transaction.originalPurchaseDate),
    expiresDate: appleDate(transaction.expiresDate),
    revocationDate: appleDate(transaction.revocationDate),
    revocationReason: transaction.revocationReason === undefined ? '' : String(transaction.revocationReason),
    isUpgraded: Boolean(transaction.isUpgraded),
    autoRenewStatus: appleAutoRenewStatus(renewalInfo),
    renewalProductId: renewalInfo?.autoRenewProductId || renewalInfo?.productId || '',
    renewalDate: appleDate(renewalInfo?.renewalDate),
    expirationIntent: renewalInfo?.expirationIntent === undefined ? '' : String(renewalInfo.expirationIntent),
    isInBillingRetryPeriod: Boolean(renewalInfo?.isInBillingRetryPeriod),
    source,
    notificationType: notificationType || '',
    notificationSubtype: notificationSubtype || '',
    signedTransactionInfo,
    signedRenewalInfo: signedRenewalInfo || '',
    rawTransaction: transaction,
    rawRenewal: renewalInfo || null,
    rawPurchase: rawPurchase || null,
    lastVerifiedAt: new Date()
  };
}

async function upsertAppleTransactionRecord(fields) {
  try {
    return await AppleTransaction.findOneAndUpdate(
      { transactionId: fields.rawTransaction.transactionId },
      {
        $set: fields,
        $setOnInsert: {
          transactionId: fields.rawTransaction.transactionId,
          creditsGranted: 0
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000 || !fields.fulfillmentKey) throw error;
    const existing = await AppleTransaction.findOne({ fulfillmentKey: fields.fulfillmentKey });
    if (!existing) throw error;
    await AppleTransaction.updateOne({ _id: existing._id }, { $set: fields });
    return AppleTransaction.findById(existing._id);
  }
}

function appleSubscriptionUpdateForTransaction(transaction, renewalInfo, subscriptionStatus, environment = '') {
  const status = appleSubscriptionStatusForUser(transaction, renewalInfo, subscriptionStatus);
  const currentPeriodStart = appleDate(transaction.purchaseDate);
  const currentPeriodEnd = appleDate(transaction.expiresDate);
  const autoRenewStatus = Number(renewalInfo?.autoRenewStatus);
  const willAutoRenew = Number.isFinite(autoRenewStatus) ? autoRenewStatus === 1 : status === 'active';
  return {
    planId: SUBSCRIPTION_PLAN.id,
    status,
    provider: 'apple',
    appleProductId: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
    appleOriginalTransactionId: transaction.originalTransactionId || transaction.transactionId,
    appleTransactionId: transaction.transactionId,
    appleEnvironment: environment || transaction.environment || '',
    amount: Number(transaction.price) || SUBSCRIPTION_PLAN.amount,
    currency: transaction.currency || SUBSCRIPTION_PLAN.currency,
    tokensPerMonth: SUBSCRIPTION_PLAN.tokens,
    currentPeriodStart,
    currentPeriodEnd,
    nextBillingAt: appleDate(renewalInfo?.renewalDate) || currentPeriodEnd,
    cancelledAt: willAutoRenew ? null : new Date(),
    revokedAt: appleDate(transaction.revocationDate),
    willAutoRenew,
    billingRetry: status === 'billing_retry' || Boolean(renewalInfo?.isInBillingRetryPeriod),
    lastOrderId: transaction.transactionId
  };
}

async function grantAppleCreditsOnce({ record, user, productConfig, transaction, renewalInfo, subscriptionStatus }) {
  if (!user || !appleGrantableTransaction(transaction, productConfig)) return { grantedCredits: 0, user: user || null };

  const session = await mongoose.startSession();
  let updatedUser = null;
  let grantedCredits = 0;
  const now = new Date();

  try {
    await session.withTransaction(async () => {
      const lockedRecord = await AppleTransaction.findOne({ _id: record._id }).session(session);
      if (!lockedRecord || lockedRecord.creditsGranted > 0) {
        updatedUser = await User.findById(user._id).session(session);
        return;
      }

      const update = { $inc: { tokens: productConfig.credits } };
      if (productConfig.kind === 'subscription') {
        update.$set = { subscription: appleSubscriptionUpdateForTransaction(transaction, renewalInfo, subscriptionStatus, record.environment) };
      }

      updatedUser = await User.findByIdAndUpdate(user._id, update, { new: true, session });
      if (!updatedUser) throw new Error('Could not credit Apple purchase because the user account was not found.');

      lockedRecord.creditsGranted = productConfig.credits;
      lockedRecord.status = 'granted';
      lockedRecord.processedAt = now;
      await lockedRecord.save({ session });

      await CreditEvent.create([{
        user: updatedUser._id,
        action: productConfig.kind === 'subscription' ? 'Apple monthly credits' : 'Apple credit top-up',
        productTitle: productConfig.name,
        tokens: productConfig.credits,
        balanceAfter: updatedUser.tokens,
        metadata: {
          direction: 'credit',
          provider: 'apple',
          productId: transaction.productId,
          transactionId: transaction.transactionId,
          originalTransactionId: transaction.originalTransactionId || transaction.transactionId,
          fulfillmentKey: lockedRecord.fulfillmentKey,
          purchaseType: productConfig.kind,
          planId: productConfig.planId
        }
      }], { session });
      grantedCredits = productConfig.credits;
    });
    return { grantedCredits, user: updatedUser || await User.findById(user._id) };
  } finally {
    await session.endSession();
  }
}

async function updateAppleSubscriptionSnapshot({ user, transaction, renewalInfo, subscriptionStatus, environment }) {
  if (!user || transaction.productId !== APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID) return user || null;
  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    { $set: { subscription: appleSubscriptionUpdateForTransaction(transaction, renewalInfo, subscriptionStatus, environment) } },
    { new: true }
  );
  return updatedUser || user;
}

async function persistVerifiedAppleTransaction({
  user,
  verified,
  renewalInfo,
  signedRenewalInfo = '',
  source = 'purchase',
  subscriptionStatus = '',
  notificationType = '',
  notificationSubtype = '',
  rawPurchase = null
}) {
  const productConfig = appleProductConfig(verified.transaction.productId);
  if (!productConfig) {
    return { accepted: false, grantedCredits: 0, user, reason: 'Unsupported Apple product id' };
  }

  const linkedUser = await resolveAppleTransactionUser({ user, transaction: verified.transaction });
  const fields = appleTransactionFields({
    user: linkedUser,
    productConfig,
    transaction: verified.transaction,
    signedTransactionInfo: verified.signedTransactionInfo,
    renewalInfo,
    signedRenewalInfo,
    environment: verified.environment,
    source,
    subscriptionStatus,
    notificationType,
    notificationSubtype,
    rawPurchase
  });
  const record = await upsertAppleTransactionRecord(fields);
  let currentUser = linkedUser;

  if (productConfig.kind === 'subscription') {
    currentUser = await updateAppleSubscriptionSnapshot({
      user: linkedUser,
      transaction: verified.transaction,
      renewalInfo,
      subscriptionStatus,
      environment: verified.environment
    });
  }

  const grantResult = await grantAppleCreditsOnce({
    record,
    user: currentUser,
    productConfig,
    transaction: verified.transaction,
    renewalInfo,
    subscriptionStatus
  });

  return {
    accepted: Boolean(record),
    record,
    grantedCredits: grantResult.grantedCredits,
    user: grantResult.user || currentUser
  };
}

async function processVerifiedAppleSubscriptionHistory({ user, transaction, environment }) {
  const originalTransactionId = transaction.originalTransactionId || transaction.transactionId;
  if (!originalTransactionId || transaction.productId !== APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID) {
    return { grantedCredits: 0, records: [] };
  }

  const [history, statuses] = await Promise.all([
    fetchAppleSubscriptionHistory(originalTransactionId, environment).catch((error) => {
      console.error('[apple:history]', readableAppleError(error));
      return [];
    }),
    fetchAppleSubscriptionStatuses(originalTransactionId, environment).catch((error) => {
      console.error('[apple:status]', readableAppleError(error));
      return [];
    })
  ]);
  const statusByTransactionId = new Map(
    statuses
      .filter((item) => item.transaction?.transactionId)
      .map((item) => [item.transaction.transactionId, item])
  );
  const results = [];

  for (const item of history) {
    const statusItem = statusByTransactionId.get(item.transaction.transactionId);
    const result = await persistVerifiedAppleTransaction({
      user,
      verified: item,
      renewalInfo: statusItem?.renewalInfo || null,
      signedRenewalInfo: statusItem?.signedRenewalInfo || '',
      source: 'history',
      subscriptionStatus: statusItem?.status || ''
    });
    results.push(result);
  }

  for (const item of statuses) {
    if (!item.transaction || item.transaction.productId !== APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID) continue;
    if (history.some((historyItem) => historyItem.transaction.transactionId === item.transaction.transactionId)) continue;
    const result = await persistVerifiedAppleTransaction({
      user,
      verified: item,
      renewalInfo: item.renewalInfo || null,
      signedRenewalInfo: item.signedRenewalInfo || '',
      source: 'sync',
      subscriptionStatus: item.status || ''
    });
    results.push(result);
  }

  return {
    grantedCredits: results.reduce((sum, item) => sum + (Number(item.grantedCredits) || 0), 0),
    records: results.map((item) => item.record).filter(Boolean)
  };
}

async function processApplePurchase({ user, purchase, source = 'purchase' }) {
  const productId = String(purchase?.productId || purchase?.id || '').trim();
  const productConfig = appleProductConfig(productId);
  if (!productConfig) throw new Error('Selected Apple product is not available');

  const verified = await fetchAndVerifyAppleTransaction({
    transactionId: appleTransactionIdFromPurchase(purchase),
    signedTransactionInfo: appleSignedTransactionFromPurchase(purchase),
    expectedProductId: productId,
    environmentHint: appleEnvironmentHintFromPurchase(purchase)
  });
  const primary = await persistVerifiedAppleTransaction({
    user,
    verified,
    source,
    rawPurchase: purchase
  });
  let grantedCredits = primary.grantedCredits;
  let latestUser = primary.user || user;

  if (productConfig.kind === 'subscription') {
    const history = await processVerifiedAppleSubscriptionHistory({
      user: latestUser,
      transaction: verified.transaction,
      environment: verified.environment
    });
    grantedCredits += history.grantedCredits;
    latestUser = await User.findById(latestUser._id);
  }

  return {
    accepted: primary.accepted,
    transaction: primary.record,
    grantedCredits,
    user: latestUser
  };
}

async function syncAppleSubscriptionForUser(user) {
  const originalTransactionId = user.subscription?.appleOriginalTransactionId
    || (await AppleTransaction.findOne({ user: user._id, productId: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID })
      .sort({ purchaseDate: -1, createdAt: -1 })
      .select('originalTransactionId transactionId environment'))?.originalTransactionId;
  if (!originalTransactionId) return { user, records: [], grantedCredits: 0 };

  const latestRecord = await AppleTransaction.findOne({
    user: user._id,
    originalTransactionId
  }).sort({ purchaseDate: -1, createdAt: -1 });
  const environment = latestRecord?.environment || user.subscription?.appleEnvironment || '';
  const statuses = await fetchAppleSubscriptionStatuses(originalTransactionId, environment);
  let latestUser = user;
  let grantedCredits = 0;
  const records = [];

  for (const item of statuses) {
    if (!item.transaction || item.transaction.productId !== APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID) continue;
    const result = await persistVerifiedAppleTransaction({
      user: latestUser,
      verified: item,
      renewalInfo: item.renewalInfo || null,
      signedRenewalInfo: item.signedRenewalInfo || '',
      source: 'sync',
      subscriptionStatus: item.status || ''
    });
    grantedCredits += result.grantedCredits;
    latestUser = result.user || latestUser;
    if (result.record) records.push(result.record);
  }

  const history = await processVerifiedAppleSubscriptionHistory({
    user: latestUser,
    transaction: { productId: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID, originalTransactionId, transactionId: originalTransactionId },
    environment
  });
  grantedCredits += history.grantedCredits;
  latestUser = await User.findById(user._id);
  return { user: latestUser || user, records: [...records, ...history.records], grantedCredits };
}

async function processAppleNotificationPayload(signedPayload) {
  const { environment, notification } = await verifyAppleNotification(signedPayload);
  const data = notification?.data || {};
  const notificationType = notification?.notificationType || '';
  const notificationSubtype = notification?.subtype || '';
  let transactionResult = null;
  let renewalInfo = null;
  let signedRenewalInfo = data.signedRenewalInfo || '';

  if (signedRenewalInfo) {
    try {
      const verifiedRenewal = await verifyAppleSignedRenewalInfo(signedRenewalInfo, environment);
      renewalInfo = verifiedRenewal.renewalInfo;
    } catch (error) {
      console.error('[apple:notification:renewal]', readableAppleError(error));
    }
  }

  if (data.signedTransactionInfo) {
    const verifiedTransaction = await verifyAppleSignedTransaction(data.signedTransactionInfo, environment);
    const subscriptionStatus = normalizeAppleSubscriptionStatus(data.status);
    transactionResult = await persistVerifiedAppleTransaction({
      user: null,
      verified: verifiedTransaction,
      renewalInfo,
      signedRenewalInfo,
      source: 'notification',
      subscriptionStatus,
      notificationType,
      notificationSubtype
    });

    if (verifiedTransaction.transaction.productId === APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID) {
      await processVerifiedAppleSubscriptionHistory({
        user: transactionResult.user,
        transaction: verifiedTransaction.transaction,
        environment: verifiedTransaction.environment
      });
    }
  }

  return { notification, transactionResult };
}

router.get('/plans', (_req, res) => {
  res.json(availablePlansPayload());
});

router.get('/apple/config', requireUser, (req, res) => {
  const status = appleStoreConfigStatus();
  res.json({
    products: {
      monthlySubscription: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
      creditTopUps: APP_STORE_CREDIT_TOP_UP_PRODUCT_ID_BY_PLAN_ID
    },
    appAccountToken: appleAppAccountTokenForUserId(req.user._id),
    configured: status.configured,
    missing: status.configured ? [] : status.missing
  });
});

router.post('/apple/transactions', requireUser, async (req, res) => {
  try {
    const purchase = req.body?.purchase || {};
    const result = await processApplePurchase({
      user: req.user,
      purchase,
      source: req.body?.source === 'restore' ? 'restore' : 'purchase'
    });
    res.json({
      accepted: result.accepted,
      grantedCredits: result.grantedCredits,
      transaction: result.transaction?.toClient?.() || null,
      user: result.user?.toClient?.() || req.user.toClient()
    });
  } catch (error) {
    const message = readableAppleError(error, 'Could not verify Apple purchase');
    const code = /missing|certificate|private key|APPLE_/i.test(message) ? 503 : 400;
    res.status(code).json({ message });
  }
});

router.post('/apple/restore', requireUser, async (req, res) => {
  const purchases = Array.isArray(req.body?.purchases) ? req.body.purchases : [];
  if (!purchases.length) return res.json({ restored: 0, grantedCredits: 0, user: req.user.toClient(), transactions: [] });

  let user = req.user;
  let grantedCredits = 0;
  const transactions = [];
  const errors = [];

  for (const purchase of purchases) {
    try {
      const result = await processApplePurchase({ user, purchase, source: 'restore' });
      grantedCredits += Number(result.grantedCredits) || 0;
      user = result.user || user;
      if (result.transaction) transactions.push(result.transaction.toClient());
    } catch (error) {
      errors.push(readableAppleError(error));
    }
  }

  res.json({
    restored: transactions.length,
    grantedCredits,
    user: user?.toClient?.() || req.user.toClient(),
    transactions,
    errors
  });
});

router.get('/apple/status', requireUser, async (req, res) => {
  try {
    const result = await syncAppleSubscriptionForUser(req.user);
    res.json({
      grantedCredits: result.grantedCredits,
      transactions: result.records.map((record) => record.toClient()),
      user: result.user?.toClient?.() || req.user.toClient()
    });
  } catch (error) {
    const message = readableAppleError(error, 'Could not sync Apple subscription status');
    const code = /missing|certificate|private key|APPLE_/i.test(message) ? 503 : 400;
    res.status(code).json({ message });
  }
});

router.post('/apple/notifications', async (req, res) => {
  const signedPayload = String(req.body?.signedPayload || '').trim();
  if (!signedPayload) return res.status(400).json({ message: 'signedPayload is required' });

  try {
    await processAppleNotificationPayload(signedPayload);
    res.status(204).send();
  } catch (error) {
    console.error('[apple:notification]', readableAppleError(error));
    res.status(400).json({ message: readableAppleError(error, 'Could not verify Apple notification') });
  }
});

router.post('/phonepe/subscription', requireUser, async (req, res) => {
  try {
    const planId = String(req.body?.planId || SUBSCRIPTION_PLAN.id);
    const selectedPlan = planForId(planId, 'subscription');
    if (!selectedPlan) return res.status(400).json({ message: 'Selected monthly credit plan is not available' });
    const order = await createSubscriptionSetup({ req, user: req.user, selectedPlan });
    res.status(201).json({ order: order.toClient(), redirectUrl: order.redirectUrl, paymentUrl: order.redirectUrl });
  } catch (error) {
    res.status(400).json({ message: readablePhonePeError(error, 'Could not start PhonePe mandate setup') });
  }
});

router.post('/phonepe/top-up', requireUser, async (req, res) => {
  try {
    const planId = String(req.body?.planId || '');
    const selectedPlan = planForId(planId, 'top_up');
    if (!selectedPlan) return res.status(400).json({ message: 'Selected top-up pack is not available' });
    const order = await createTopUpPayment({ req, user: req.user, selectedPlan });
    res.status(201).json({ order: order.toClient(), redirectUrl: order.redirectUrl, paymentUrl: order.redirectUrl });
  } catch (error) {
    res.status(400).json({ message: readablePhonePeError(error, 'Could not start PhonePe checkout') });
  }
});

router.get('/orders/:merchantOrderId/status', requireUser, async (req, res) => {
  const order = await TokenOrder.findOne({
    merchantOrderId: req.params.merchantOrderId,
    user: req.user._id
  });
  if (!order) return res.status(404).json({ message: 'Token order not found' });

  try {
    const result = await reconcileOrder(order);
    res.json({
      order: result.order.toClient(),
      user: result.user?.toClient?.() || req.user.toClient()
    });
  } catch (error) {
    res.status(400).json({ message: readablePhonePeError(error, 'Could not verify PhonePe payment') });
  }
});

router.get('/subscriptions/current/status', requireUser, async (req, res) => {
  const merchantSubscriptionId = req.user.subscription?.merchantSubscriptionId;
  if (!merchantSubscriptionId) return res.json({ subscription: req.user.toClient().subscription });

  try {
    const status = await phonePeFetch(`/subscriptions/v2/${encodeURIComponent(merchantSubscriptionId)}/status?details=true`);
    const state = String(status.state || status.subscriptionState || '').toLowerCase();
    if (['cancelled', 'revoked', 'paused', 'expired', 'failed'].includes(state)) {
      req.user.subscription.status = state === 'cancelled' ? 'cancelled' : 'inactive';
      await req.user.save();
    }
    res.json({ subscription: req.user.toClient().subscription, phonePe: status });
  } catch (error) {
    res.status(400).json({ message: readablePhonePeError(error, 'Could not check PhonePe mandate status') });
  }
});

router.post('/subscriptions/current/cancel', requireUser, async (req, res) => {
  const merchantSubscriptionId = req.user.subscription?.merchantSubscriptionId;
  if (!merchantSubscriptionId || req.user.subscription?.status !== 'active') {
    return res.status(400).json({ message: 'No active monthly mandate found' });
  }

  try {
    const response = await phonePeFetch(`/subscriptions/v2/${encodeURIComponent(merchantSubscriptionId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    req.user.subscription.status = 'cancelled';
    req.user.subscription.cancelledAt = new Date();
    await req.user.save();
    res.json({ user: req.user.toClient(), phonePe: response || { ok: true } });
  } catch (error) {
    res.status(400).json({ message: readablePhonePeError(error, 'Could not cancel PhonePe mandate') });
  }
});

router.post('/subscriptions/:merchantSubscriptionId/renewals', requireAdmin, async (req, res) => {
  try {
    const user = await User.findOne({
      'subscription.merchantSubscriptionId': req.params.merchantSubscriptionId,
      'subscription.status': 'active'
    });
    if (!user) return res.status(404).json({ message: 'Active subscription not found' });

    const order = await createSubscriptionRenewal({ user, redeem: req.body?.redeem !== false });
    res.status(201).json({ order: order.toClient() });
  } catch (error) {
    res.status(400).json({ message: readablePhonePeError(error, 'Could not create renewal debit') });
  }
});

router.post('/phonepe/callback', async (req, res) => {
  const order = await orderFromCallback(req);
  if (!order) return res.status(202).json({ ok: true });

  res.status(202).json({ ok: true });
  setImmediate(async () => {
    try {
      await reconcileOrder(order);
    } catch (error) {
      console.error('[phonepe:callback:bg]', readablePhonePeError(error));
    }
  });
});

export default router;
