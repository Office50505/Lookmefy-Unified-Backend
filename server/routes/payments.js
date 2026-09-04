import express from 'express';
import mongoose from 'mongoose';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import AppleTransaction from '../models/AppleTransaction.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import CustomTryOn from '../models/CustomTryOn.js';
import TokenOrder from '../models/TokenOrder.js';
import TryOn from '../models/TryOn.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import { creditUser } from '../services/creditLedger.js';
import {
  PAYMENT_PLANS,
  SUBSCRIPTION_PLAN,
  TOP_UP_PLANS,
  planById
} from '../../shared/pricing.js';
import {
  APP_STORE_CREDITS_150_PRODUCT_ID,
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
import { phonePeEnabled, razorpayEnabled } from '../utils/envValidation.js';
import { isProductionEnv, validateConfiguredHttpsUrl } from '../utils/urlValidation.js';

const router = express.Router();
const disableDemoCheckoutRateLimit = () => ['1', 'true', 'yes'].includes(String(process.env.DISABLE_DEMO_CHECKOUT_RATE_LIMIT || '').trim().toLowerCase());
const paymentCreateLimiter = createRateLimiter({
  name: 'payments:create',
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many checkout attempts. Please wait a few minutes before trying again.',
  skip: disableDemoCheckoutRateLimit
});
const paymentStatusLimiter = createRateLimiter({
  name: 'payments:status',
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: rateLimitKeys.user,
  message: 'Payment status checks are temporarily limited. Please try again shortly.'
});

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
      console.warn('[phonepe] PHONEPE_BASE_URL points to production while PHONEPE_ENV is sandbox — using preprod URL instead');
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
      console.warn('[phonepe] PHONEPE_AUTH_URL points to production while PHONEPE_ENV is sandbox — using preprod URL instead');
      return preprod;
    }
    return given;
  }
  return isSandbox() ? preprod : prod;
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
      if (state === 'COMPLETED' || result.order?.creditedAt) {
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
  const configured = process.env.CLIENT_ORIGIN || (!isProductionEnv() ? req.get('origin') || `${req.protocol}://${req.get('host')}` : '');
  return validateConfiguredHttpsUrl(configured, {
    name: 'CLIENT_ORIGIN',
    env: process.env,
    requireHttpsInProduction: true
  }).origin;
}

function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    orderType: plan.orderType,
    amount: plan.amount,
    dueTodayAmount: plan.dueTodayAmount || plan.amount,
    currency: plan.currency,
    tokens: plan.tokens,
    billing: plan.billing,
    cancellation: plan.cancellation || '',
    mandate: plan.mandate || null
  };
}

function checkoutMessage(plan) {
  if (plan.orderType === 'topup') return `Lookmefy ${plan.tokens} token top-up`;
  return `Set up ${plan.currency} ${(Number(plan.mandate?.recurringAmount || 0) / 100).toLocaleString('en-IN')}/month mandate`;
}

function configuredRedirectUrl(req, merchantOrderId, planId) {
  const approvedOrigin = clientOrigin(req);
  const base = process.env.PHONEPE_REDIRECT_URL || `${approvedOrigin}/tokens`;
  const url = validateConfiguredHttpsUrl(base, { name: 'PHONEPE_REDIRECT_URL', env: process.env });
  if (isProductionEnv() && url.origin !== approvedOrigin) {
    throw new Error('PHONEPE_REDIRECT_URL must use the approved CLIENT_ORIGIN in production');
  }
  url.searchParams.set('merchantOrderId', merchantOrderId);
  url.searchParams.set('plan', planId);
  return url.toString();
}

function addMonths(date, count) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + count);
  return next;
}

function requirePhonePeConfig() {
  if (!phonePeEnabled()) {
    const error = new Error('PhonePe payments are temporarily unavailable');
    error.statusCode = 503;
    throw error;
  }
  const missing = ['PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET', 'PHONEPE_CLIENT_VERSION']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    const error = new Error(`${missing.join(', ')} missing on the server`);
    error.statusCode = 503;
    throw error;
  }
}

function requirePhonePeCallbackConfig() {
  if (!phonePeEnabled()) {
    const error = new Error('PhonePe payments are temporarily unavailable');
    error.statusCode = 503;
    throw error;
  }
  const missing = ['PHONEPE_CALLBACK_USERNAME', 'PHONEPE_CALLBACK_PASSWORD']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    const error = new Error(`${missing.join(', ')} missing on the server`);
    error.statusCode = 503;
    throw error;
  }
}

function safeCompareHex(left, right) {
  const a = Buffer.from(String(left || '').trim().toLowerCase(), 'hex');
  const b = Buffer.from(String(right || '').trim().toLowerCase(), 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function calculatePhonePeCallbackAuthorization(username, password) {
  return createHash('sha256').update(`${username}:${password}`).digest('hex');
}

function validatePhonePeCallbackAuth(authorization, env = process.env) {
  const username = String(env.PHONEPE_CALLBACK_USERNAME || '');
  const password = String(env.PHONEPE_CALLBACK_PASSWORD || '');
  if (!username || !password) return false;
  return safeCompareHex(authorization, calculatePhonePeCallbackAuthorization(username, password));
}

function readablePhonePeError(value, fallback = 'PhonePe request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') return value.message || value.code || value.error || fallback;
  return String(value);
}

function readableRazorpayError(value, fallback = 'Razorpay request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') return value.error?.description || value.description || value.message || value.code || value.error || fallback;
  return String(value);
}

function requireRazorpayConfig() {
  if (!razorpayEnabled()) {
    const error = new Error('Razorpay payments are temporarily unavailable');
    error.statusCode = 503;
    throw error;
  }
  const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'].filter((key) => !process.env[key]);
  if (missing.length) {
    const error = new Error(`${missing.join(', ')} missing on the server`);
    error.statusCode = 503;
    throw error;
  }
}

function razorpayBaseUrl() {
  return String(process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
}

async function razorpayFetch(path, options = {}) {
  requireRazorpayConfig();
  const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`${razorpayBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
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
    console.error('[razorpay:fetch] failed', { path, status: response.status, body: data });
    throw new Error(readableRazorpayError(data, 'Razorpay request failed'));
  }
  return data;
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

function amountForPlan(plan) {
  return Number(plan.dueTodayAmount || plan.amount);
}

function recurringAmountForPlan(plan) {
  return Number(plan.mandate?.recurringAmount || 0) || null;
}

function billingFrequencyForPlan(plan) {
  return plan.mandate?.frequency || plan.billing || '';
}

function statusFromPhonePeState(state) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'COMPLETED') return 'completed';
  if (['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'TIMEOUT', 'TIMED_OUT'].includes(normalized)) return 'failed';
  if (normalized === 'PENDING') return 'pending';
  return '';
}

function createMerchantOrderId(userId) {
  const userPart = userId.toString().slice(-8);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FL_${Date.now()}_${userPart}_${random}`.slice(0, 63);
}

async function createPhonePePayment({ req, user, plan = SUBSCRIPTION_PLAN }) {
  requirePhonePeConfig();
  const idempotencyKey = checkoutIdempotencyKey(req);
  if (idempotencyKey) {
    const existingOrder = await TokenOrder.findOne({ user: user._id, idempotencyKey });
    if (existingOrder) {
      if (existingOrder.status === 'failed') {
        const error = new Error('Previous checkout attempt failed. Please start checkout again.');
        error.statusCode = 409;
        throw error;
      }
      return existingOrder;
    }
  }

  const merchantOrderId = createMerchantOrderId(user._id);
  const redirectUrl = configuredRedirectUrl(req, merchantOrderId, plan.id);
  const orderPayload = {
    user: user._id,
    merchantOrderId,
    planId: plan.id,
    planName: plan.name,
    orderType: plan.orderType,
    amount: amountForPlan(plan),
    dueTodayAmount: amountForPlan(plan),
    recurringAmount: recurringAmountForPlan(plan),
    billingFrequency: billingFrequencyForPlan(plan),
    currency: plan.currency,
    tokens: plan.tokens,
    redirectUrl,
    idempotencyKey
  };
  let order;
  try {
    order = await TokenOrder.create(orderPayload);
  } catch (error) {
    if (error.code === 11000 && idempotencyKey) {
      const existingOrder = await TokenOrder.findOne({ user: user._id, idempotencyKey });
      if (existingOrder) {
        if (existingOrder.status === 'failed') {
          const conflict = new Error('Previous checkout attempt failed. Please start checkout again.');
          conflict.statusCode = 409;
          throw conflict;
        }
        return existingOrder;
      }
    }
    throw error;
  }

  try {
    const payload = {
      merchantOrderId,
      amount: amountForPlan(plan),
      expireAfter: Number(process.env.PHONEPE_ORDER_EXPIRE_SECONDS || 1200),
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: checkoutMessage(plan),
        merchantUrls: { redirectUrl }
      },
      metaInfo: {
        udf1: user._id.toString(),
        udf2: plan.id,
        udf3: String(plan.tokens),
        udf4: 'Lookmefy',
        udf5: plan.orderType
      }
    };

    const data = await phonePeFetch('/checkout/v2/pay', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    order.status = 'pending';
    order.providerState = data.state || 'PENDING';
    order.phonePeOrderId = data.orderId;
    order.redirectUrl = data.redirectUrl || redirectUrl;
    order.providerResponse = data;
    await order.save();
    // Start a short-polling fallback in case callbacks are delayed/missed
    try {
      startShortPolling(merchantOrderId);
    } catch (e) {
      console.error('[phonepe] failed to start short polling', readablePhonePeError(e));
    }
    return order;
  } catch (error) {
    order.status = 'failed';
    order.providerState = 'CREATE_FAILED';
    order.providerResponse = { message: readablePhonePeError(error) };
    await order.save();
    throw error;
  }
}

function createRazorpayReceipt(userId) {
  const userPart = userId.toString().slice(-8);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FLRZP_${Date.now()}_${userPart}_${random}`.slice(0, 40);
}

function razorpayCheckoutPayload({ req, user, order, plan }) {
  return {
    key: process.env.RAZORPAY_KEY_ID,
    orderId: order.razorpayOrderId,
    amount: order.dueTodayAmount || order.amount,
    currency: order.currency || 'INR',
    name: 'Lookmefy',
    description: checkoutMessage(plan),
    prefill: {
      name: user.name || user.username || '',
      email: user.email || '',
      contact: user.phone || ''
    },
    notes: {
      merchantOrderId: order.merchantOrderId,
      planId: order.planId
    },
    verifyPath: '/payments/razorpay/verify',
    statusPath: `/payments/orders/${encodeURIComponent(order.merchantOrderId)}/status`,
    returnUrl: `${clientOrigin(req)}/tokens?merchantOrderId=${encodeURIComponent(order.merchantOrderId)}&plan=${encodeURIComponent(plan.id)}`
  };
}

async function createRazorpayPayment({ req, user, plan = SUBSCRIPTION_PLAN }) {
  requireRazorpayConfig();
  const idempotencyKey = checkoutIdempotencyKey(req);
  if (idempotencyKey) {
    const existingOrder = await TokenOrder.findOne({ user: user._id, idempotencyKey });
    if (existingOrder) {
      if (existingOrder.status === 'failed') {
        const error = new Error('Previous checkout attempt failed. Please start checkout again.');
        error.statusCode = 409;
        throw error;
      }
      return existingOrder;
    }
  }

  const merchantOrderId = createRazorpayReceipt(user._id);
  const orderPayload = {
    user: user._id,
    merchantOrderId,
    provider: 'razorpay',
    planId: plan.id,
    planName: plan.name,
    orderType: plan.orderType,
    amount: amountForPlan(plan),
    dueTodayAmount: amountForPlan(plan),
    recurringAmount: recurringAmountForPlan(plan),
    billingFrequency: billingFrequencyForPlan(plan),
    currency: plan.currency || 'INR',
    tokens: plan.tokens,
    redirectUrl: '',
    idempotencyKey
  };
  let order;
  try {
    order = await TokenOrder.create(orderPayload);
  } catch (error) {
    if (error.code === 11000 && idempotencyKey) {
      const existingOrder = await TokenOrder.findOne({ user: user._id, idempotencyKey });
      if (existingOrder) {
        if (existingOrder.status === 'failed') {
          const conflict = new Error('Previous checkout attempt failed. Please start checkout again.');
          conflict.statusCode = 409;
          throw conflict;
        }
        return existingOrder;
      }
    }
    throw error;
  }

  try {
    const data = await razorpayFetch('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: amountForPlan(plan),
        currency: plan.currency || 'INR',
        receipt: merchantOrderId,
        notes: {
          userId: user._id.toString(),
          planId: plan.id,
          tokens: String(plan.tokens),
          orderType: plan.orderType,
          brand: 'Lookmefy'
        }
      })
    });

    order.status = 'pending';
    order.provider = 'razorpay';
    order.providerState = String(data.status || 'created').toUpperCase();
    order.razorpayOrderId = data.id;
    order.providerResponse = data;
    await order.save();
    return order;
  } catch (error) {
    order.status = 'failed';
    order.provider = 'razorpay';
    order.providerState = 'CREATE_FAILED';
    order.providerResponse = { message: readableRazorpayError(error) };
    await order.save();
    throw error;
  }
}

function verifyRazorpaySignature({ orderId, paymentId, signature, secret = process.env.RAZORPAY_KEY_SECRET }) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const generated = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeCompareHex(generated, signature);
}

async function completeRazorpayPayment({ user, merchantOrderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  requireRazorpayConfig();
  const candidates = [
    String(merchantOrderId || '').trim() ? { merchantOrderId: String(merchantOrderId || '').trim() } : null,
    String(razorpayOrderId || '').trim() ? { razorpayOrderId: String(razorpayOrderId || '').trim() } : null
  ].filter(Boolean);
  if (!candidates.length) {
    const error = new Error('Razorpay order id is required');
    error.statusCode = 400;
    throw error;
  }
  const order = await TokenOrder.findOne({
    user: user._id,
    $or: candidates
  });
  if (!order) {
    const error = new Error('Token order not found');
    error.statusCode = 404;
    throw error;
  }
  if (order.creditedAt) return { order, user: await User.findById(order.user), alreadyCredited: true };
  if (!order.razorpayOrderId || order.razorpayOrderId !== razorpayOrderId) {
    const error = new Error('Razorpay order does not match this checkout');
    error.statusCode = 400;
    throw error;
  }
  if (!verifyRazorpaySignature({ orderId: order.razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature })) {
    const error = new Error('Razorpay payment signature verification failed');
    error.statusCode = 400;
    throw error;
  }

  const payment = await razorpayFetch(`/payments/${encodeURIComponent(razorpayPaymentId)}`);
  if (payment.order_id && payment.order_id !== order.razorpayOrderId) {
    const error = new Error('Razorpay payment belongs to a different order');
    error.statusCode = 400;
    throw error;
  }
  if (Number(payment.amount || 0) && Number(payment.amount || 0) !== Number(order.dueTodayAmount || order.amount || 0)) {
    const error = new Error('Razorpay payment amount does not match this checkout');
    error.statusCode = 400;
    throw error;
  }
  if (['failed', 'cancelled'].includes(String(payment.status || '').toLowerCase())) {
    const error = new Error('Razorpay payment was not successful');
    error.statusCode = 400;
    throw error;
  }

  const providerResponse = {
    provider: 'razorpay',
    verifiedBy: 'checkout_signature',
    payment
  };
  await TokenOrder.findByIdAndUpdate(order._id, {
    $set: {
      provider: 'razorpay',
      razorpayPaymentId,
      razorpaySignature,
      providerState: String(payment.status || 'verified').toUpperCase(),
      providerResponse
    }
  });
  const updatedOrder = await TokenOrder.findById(order._id);
  const creditedUser = await grantPaidTokens(updatedOrder || order, providerResponse);
  return {
    order: await TokenOrder.findById(order._id),
    user: creditedUser,
    alreadyCredited: false
  };
}

function statusFromRazorpayOrderStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'paid') return 'completed';
  if (['created', 'attempted'].includes(normalized)) return 'pending';
  return '';
}

async function reconcileRazorpayOrder(order) {
  if (!order) return { order: null, user: null };
  if (order.creditedAt) return { order, user: await User.findById(order.user) };
  if (!order.razorpayOrderId) return { order, user: await User.findById(order.user) };

  const razorpayOrder = await razorpayFetch(`/orders/${encodeURIComponent(order.razorpayOrderId)}`);
  const providerState = String(razorpayOrder.status || '').toUpperCase();
  if (String(razorpayOrder.status || '').toLowerCase() === 'paid') {
    const payments = await razorpayFetch(`/orders/${encodeURIComponent(order.razorpayOrderId)}/payments`);
    const payment = (payments.items || []).find((item) => ['captured', 'authorized'].includes(String(item.status || '').toLowerCase()));
    const providerResponse = {
      provider: 'razorpay',
      verifiedBy: 'order_status',
      order: razorpayOrder,
      payment: payment || null
    };
    await TokenOrder.findByIdAndUpdate(order._id, {
      $set: {
        provider: 'razorpay',
        razorpayPaymentId: payment?.id || order.razorpayPaymentId || '',
        providerState,
        providerResponse
      }
    });
    const updatedOrder = await TokenOrder.findById(order._id);
    const user = await grantPaidTokens(updatedOrder || order, providerResponse);
    const completedOrder = await TokenOrder.findById(order._id);
    return { order: completedOrder, user };
  }

  order.provider = 'razorpay';
  order.providerState = providerState || order.providerState;
  order.providerResponse = razorpayOrder;
  order.status = statusFromRazorpayOrderStatus(razorpayOrder.status) || order.status;
  await order.save();
  return { order, user: await User.findById(order.user) };
}

async function createDemoCreditPayment({ req, user, plan = SUBSCRIPTION_PLAN }) {
  const idempotencyKey = checkoutIdempotencyKey(req);
  if (idempotencyKey) {
    const existingOrder = await TokenOrder.findOne({ user: user._id, idempotencyKey });
    if (existingOrder) {
      return completeDemoCreditOrder(existingOrder, user);
    }
  }

  const merchantOrderId = createMerchantOrderId(user._id).replace(/^FL_/, 'FLDEMO_').slice(0, 63);
  let order;
  try {
    order = await TokenOrder.create({
      user: user._id,
      merchantOrderId,
      planId: plan.id,
      planName: plan.name,
      orderType: plan.orderType,
      amount: amountForPlan(plan),
      dueTodayAmount: amountForPlan(plan),
      recurringAmount: recurringAmountForPlan(plan),
      billingFrequency: billingFrequencyForPlan(plan),
      currency: plan.currency,
      tokens: plan.tokens,
      idempotencyKey,
      provider: 'demo',
      redirectUrl: '',
      status: 'created',
      providerState: 'DEMO_CREATED',
      providerResponse: {
        mode: 'demo',
        message: 'Demo credit checkout created without external payment gateway'
      }
    });
  } catch (error) {
    if (error.code === 11000 && idempotencyKey) {
      const existingOrder = await TokenOrder.findOne({ user: user._id, idempotencyKey });
      if (existingOrder) {
        return completeDemoCreditOrder(existingOrder, user);
      }
    }
    throw error;
  }

  return completeDemoCreditOrder(order, user);
}

async function completeDemoCreditOrder(order, fallbackUser) {
  const alreadyCredited = Boolean(order.creditedAt);
  const creditedUser = await grantPaidTokens(order, {
    mode: 'demo',
    message: 'Demo credits credited without external payment gateway'
  });
  const creditedOrder = await TokenOrder.findOneAndUpdate(
    { _id: order._id },
    { $set: { providerState: 'DEMO_COMPLETED' } },
    { new: true }
  );
  return {
    order: creditedOrder || order,
    user: creditedUser || fallbackUser,
    alreadyCredited
  };
}

async function grantPaidTokens(order, providerResponse) {
  if (order.creditedAt) return User.findById(order.user);

  const now = new Date();
  const isSubscription = order.orderType === 'subscription' || order.planId === SUBSCRIPTION_PLAN.id;
  const currentPeriodEnd = isSubscription ? addMonths(now, 1) : null;
  const orderSet = {
    status: 'completed',
    providerState: 'COMPLETED',
    providerResponse,
    creditedAt: now
  };
  if (isSubscription) {
    orderSet.currentPeriodStart = now;
    orderSet.currentPeriodEnd = currentPeriodEnd;
  }
  const creditedOrder = await TokenOrder.findOneAndUpdate(
    { _id: order._id, creditedAt: null },
    { $set: orderSet },
    { new: true }
  );
  if (!creditedOrder) return User.findById(order.user);

  const ledgerOrder = {
    user: creditedOrder.user || order.user,
    tokens: creditedOrder.tokens ?? order.tokens,
    planId: creditedOrder.planId || order.planId,
    orderType: creditedOrder.orderType || order.orderType,
    merchantOrderId: creditedOrder.merchantOrderId || order.merchantOrderId,
    provider: creditedOrder.provider || order.provider,
    providerState: creditedOrder.providerState || order.providerState,
    razorpayPaymentId: creditedOrder.razorpayPaymentId || order.razorpayPaymentId,
    phonePeOrderId: creditedOrder.phonePeOrderId || order.phonePeOrderId
  };
  const userSet = {};
  if (isSubscription) {
    userSet.subscription = {
      planId: ledgerOrder.planId,
      status: 'active',
      tokensPerMonth: ledgerOrder.tokens,
      currentPeriodStart: now,
      currentPeriodEnd,
      lastOrderId: ledgerOrder.merchantOrderId
    };
  }

  const ledgerResult = await creditUser({
    userId: ledgerOrder.user,
    action: isSubscription ? 'subscription_tokens_purchased' : 'topup_tokens_purchased',
    tokens: ledgerOrder.tokens,
    source: ledgerOrder.provider || 'payment',
    sourceId: ledgerOrder.razorpayPaymentId || ledgerOrder.phonePeOrderId || ledgerOrder.merchantOrderId,
    fulfillmentKey: `token_order:${creditedOrder._id}`,
    userSet,
    metadata: {
      orderId: creditedOrder._id,
      merchantOrderId: ledgerOrder.merchantOrderId,
      planId: ledgerOrder.planId,
      orderType: ledgerOrder.orderType,
      providerState: ledgerOrder.providerState,
      providerResponse
    }
  });
  return ledgerResult.user;
}

async function reconcileOrder(order) {
  if (!order) return { order: null, user: null };
  if (order.creditedAt) return { order, user: await User.findById(order.user) };
  if (order.provider === 'razorpay' || order.razorpayOrderId) return reconcileRazorpayOrder(order);

  const status = await phonePeFetch(`/checkout/v2/order/${encodeURIComponent(order.merchantOrderId)}/status?details=true&errorContext=true`);
  const state = String(status.state || '').toUpperCase();

  if (state === 'COMPLETED') {
    const user = await grantPaidTokens(order, status);
    const completedOrder = await TokenOrder.findById(order._id);
    return { order: completedOrder, user };
  }

  order.providerState = state || order.providerState;
  order.providerResponse = status;
  order.status = statusFromPhonePeState(state) || order.status;
  await order.save();
  return { order, user: await User.findById(order.user) };
}

function orderIdFromCallback(req) {
  const payload = req.callbackPayload || req.body || {};
  const candidates = [
    req.query?.merchantOrderId,
    payload?.merchantOrderId,
    payload?.merchantOrderID,
    payload?.orderId,
    payload?.eventPayload?.merchantOrderId,
    payload?.eventPayload?.orderId,
    payload?.payload?.merchantOrderId,
    payload?.payload?.orderId,
    payload?.data?.merchantOrderId,
    payload?.data?.orderId
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function checkoutIdempotencyKey(req) {
  const value = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9._:-]{12,120}$/.test(value)) {
    const error = new Error('Invalid checkout idempotency key');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function callbackAuthorizationHeader(req) {
  return String(req.get('authorization') || req.get('x-phonepe-authorization') || '').trim();
}

async function findOrderFromCallback(req) {
  const id = orderIdFromCallback(req);
  if (!id) return null;
  return TokenOrder.findOne({
    $or: [
      { merchantOrderId: id },
      { phonePeOrderId: id },
      { razorpayOrderId: id },
      { razorpayPaymentId: id }
    ]
  });
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
    amount: Number(transaction.price) || SUBSCRIPTION_PLAN.mandate?.recurringAmount || SUBSCRIPTION_PLAN.amount,
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
      if (!lockedRecord || Number(lockedRecord.creditsGranted || 0) > 0) {
        updatedUser = await User.findById(user._id).session(session);
        return;
      }

      const userSet = {};
      if (productConfig.kind === 'subscription') {
        userSet.subscription = appleSubscriptionUpdateForTransaction(transaction, renewalInfo, subscriptionStatus, record.environment);
      }

      const ledgerResult = await creditUser({
        userId: user._id,
        action: productConfig.kind === 'subscription' ? 'apple_subscription_tokens_purchased' : 'apple_topup_tokens_purchased',
        tokens: productConfig.credits,
        source: 'apple',
        sourceId: transaction.transactionId,
        fulfillmentKey: lockedRecord.fulfillmentKey,
        productTitle: productConfig.name,
        userSet,
        metadata: {
          provider: 'apple',
          productId: transaction.productId,
          transactionId: transaction.transactionId,
          originalTransactionId: transaction.originalTransactionId || transaction.transactionId,
          fulfillmentKey: lockedRecord.fulfillmentKey,
          purchaseType: productConfig.kind,
          planId: productConfig.planId
        },
        session
      });
      updatedUser = ledgerResult.user;

      lockedRecord.creditsGranted = productConfig.credits;
      lockedRecord.status = 'granted';
      lockedRecord.processedAt = now;
      await lockedRecord.save({ session });
      grantedCredits = ledgerResult.alreadyRecorded ? 0 : productConfig.credits;
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
  res.json({
    plans: PAYMENT_PLANS.map(publicPlan),
    subscription: publicPlan(SUBSCRIPTION_PLAN),
    topUps: TOP_UP_PLANS.map(publicPlan),
    appStoreProductIds: {
      monthlySubscription: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
      credits150: APP_STORE_CREDITS_150_PRODUCT_ID
    },
    costs: {
      imageTokens: Number(process.env.TRYON_TOKEN_COST || 1),
      videoTokens: Number(process.env.TRYON_VIDEO_TOKEN_COST || 3)
    }
  });
});

router.get('/credits/history', requireUser, async (req, res) => {
  const userId = req.user._id;
  const [orders, tryOns, customTryOns, closetOutfits] = await Promise.all([
    TokenOrder.find({ user: userId, status: 'completed' }).sort({ creditedAt: -1, createdAt: -1 }).limit(30).lean(),
    TryOn.find({ user: userId }).sort({ createdAt: -1 }).limit(40).populate('product', 'name').lean(),
    CustomTryOn.find({ user: userId }).sort({ createdAt: -1 }).limit(30).lean(),
    ClosetOutfit.find({ user: userId }).sort({ createdAt: -1 }).limit(30).lean()
  ]);

  const purchaseItems = orders.map((order) => ({
    id: `order-${order._id}`,
    type: 'purchase',
    title: order.orderType === 'topup' ? (order.planName || 'Token top-up') : (order.planName || 'Credit purchase'),
    detail: order.amount ? `${order.currency || 'INR'} ${(Number(order.amount || 0) / 100).toLocaleString('en-IN')}` : 'Payment verified',
    credits: Number(order.tokens || 0),
    date: order.creditedAt || order.createdAt,
    status: order.status
  }));

  const productTryOnItems = tryOns.flatMap((tryOn) => {
    const items = [];
    const tokenCost = Number(tryOn.tokenCost || 0);
    if (tokenCost > 0) {
      items.push({
        id: `tryon-${tryOn._id}`,
        type: 'usage',
        title: 'AI try-on image',
        detail: tryOn.product?.name || 'Product preview',
        credits: -tokenCost,
        date: tryOn.createdAt,
        status: 'used'
      });
    }
    const videoCost = Number(tryOn.video?.tokenCost || 0);
    if (videoCost > 0 && tryOn.video?.generatedAt) {
      items.push({
        id: `tryon-video-${tryOn._id}`,
        type: 'usage',
        title: 'Generated video',
        detail: tryOn.product?.name || 'Product video preview',
        credits: -videoCost,
        date: tryOn.video.generatedAt,
        status: 'used'
      });
    }
    return items;
  });

  const customTryOnItems = customTryOns
    .filter((tryOn) => Number(tryOn.tokenCost || 0) > 0)
    .map((tryOn) => ({
      id: `custom-${tryOn._id}`,
      type: 'usage',
      title: 'Custom try-on',
      detail: 'Uploaded garment render',
      credits: -Number(tryOn.tokenCost || 0),
      date: tryOn.createdAt,
      status: 'used'
    }));

  const closetItems = closetOutfits
    .filter((outfit) => Number(outfit.tokenCost || 0) > 0)
    .map((outfit) => ({
      id: `closet-${outfit._id}`,
      type: 'usage',
      title: 'Wardrobe look',
      detail: outfit.title || 'Generated outfit',
      credits: -Number(outfit.tokenCost || 0),
      date: outfit.createdAt,
      status: 'used'
    }));

  const items = [...purchaseItems, ...productTryOnItems, ...customTryOnItems, ...closetItems]
    .filter((item) => item.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 50);

  const totalPurchased = purchaseItems.reduce((sum, item) => sum + Math.max(0, Number(item.credits || 0)), 0);
  const totalUsed = [...productTryOnItems, ...customTryOnItems, ...closetItems]
    .reduce((sum, item) => sum + Math.abs(Math.min(0, Number(item.credits || 0))), 0);

  res.json({
    balance: Number(req.user.tokens || 0),
    totalPurchased,
    totalUsed,
    items
  });
});

router.get('/apple/config', requireUser, (req, res) => {
  const status = appleStoreConfigStatus();
  res.json({
    products: {
      monthlySubscription: APP_STORE_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
      credits150: APP_STORE_CREDITS_150_PRODUCT_ID
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

router.post('/checkout', requireUser, paymentCreateLimiter, async (req, res) => {
  try {
    const requestedPlanId = String(req.body?.planId || '').trim();
    const plan = requestedPlanId ? planById(requestedPlanId) : SUBSCRIPTION_PLAN;
    if (!plan) return res.status(400).json({ message: 'Selected credit plan is not available.' });
    const order = await createRazorpayPayment({ req, user: req.user, plan });
    res.status(201).json({
      order: order.toClient(),
      provider: 'razorpay',
      razorpay: razorpayCheckoutPayload({ req, user: req.user, order, plan })
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableRazorpayError(error, 'Could not start Razorpay checkout') });
  }
});

router.post('/phonepe/top-up', requireUser, paymentCreateLimiter, async (req, res) => {
  try {
    const requestedPlanId = String(req.body?.planId || '').trim();
    const plan = requestedPlanId ? planById(requestedPlanId) : null;
    if (!plan || plan.orderType !== 'topup') return res.status(400).json({ message: 'Selected top-up pack is not available.' });
    const order = await createRazorpayPayment({ req, user: req.user, plan });
    res.status(201).json({
      order: order.toClient(),
      provider: 'razorpay',
      redirectUrl: '',
      paymentUrl: '',
      razorpay: razorpayCheckoutPayload({ req, user: req.user, order, plan })
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableRazorpayError(error, 'Could not start Razorpay checkout') });
  }
});

router.post('/phonepe/subscription', requireUser, paymentCreateLimiter, async (req, res) => {
  try {
    const requestedPlanId = String(req.body?.planId || SUBSCRIPTION_PLAN.id).trim();
    const plan = planById(requestedPlanId) || SUBSCRIPTION_PLAN;
    if (plan.orderType !== 'subscription') return res.status(400).json({ message: 'Selected monthly credit plan is not available.' });
    const order = await createRazorpayPayment({ req, user: req.user, plan });
    res.status(201).json({
      order: order.toClient(),
      provider: 'razorpay',
      redirectUrl: '',
      paymentUrl: '',
      razorpay: razorpayCheckoutPayload({ req, user: req.user, order, plan })
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableRazorpayError(error, 'Could not start Razorpay checkout') });
  }
});

router.post('/razorpay/verify', requireUser, paymentStatusLimiter, async (req, res) => {
  try {
    const result = await completeRazorpayPayment({
      user: req.user,
      merchantOrderId: String(req.body?.merchantOrderId || '').trim(),
      razorpayOrderId: String(req.body?.razorpay_order_id || req.body?.razorpayOrderId || '').trim(),
      razorpayPaymentId: String(req.body?.razorpay_payment_id || req.body?.razorpayPaymentId || '').trim(),
      razorpaySignature: String(req.body?.razorpay_signature || req.body?.razorpaySignature || '').trim()
    });
    res.json({
      order: result.order.toClient(),
      user: result.user?.toClient?.() || req.user.toClient(),
      alreadyCredited: result.alreadyCredited,
      message: 'Payment verified. Credits credited.'
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableRazorpayError(error, 'Could not verify Razorpay payment') });
  }
});

router.get('/orders/:merchantOrderId/status', requireUser, paymentStatusLimiter, async (req, res) => {
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
    res.status(error.statusCode || 400).json({ message: readableRazorpayError(error, 'Could not verify payment') });
  }
});

router.get('/subscriptions/current/status', requireUser, async (req, res) => {
  res.json({ subscription: req.user.toClient().subscription });
});

router.post('/subscriptions/current/cancel', requireUser, async (req, res) => {
  const current = req.user.subscription || {};
  if (!current.status || !['active', 'trialing', 'billing_retry'].includes(String(current.status))) {
    return res.status(400).json({ message: 'No active subscription found' });
  }
  const currentSubscription = current.toObject?.() || current;
  req.user.subscription = {
    ...currentSubscription,
    status: 'cancelled',
    cancelledAt: new Date(),
    willAutoRenew: false
  };
  await req.user.save();
  res.json({ subscription: req.user.toClient().subscription, user: req.user.toClient() });
});

router.post('/phonepe/callback', async (req, res) => {
  try {
    requirePhonePeCallbackConfig();
    if (!validatePhonePeCallbackAuth(callbackAuthorizationHeader(req))) {
      return res.status(401).json({ ok: false });
    }
  } catch (error) {
    return res.status(503).json({ ok: false, message: readablePhonePeError(error, 'PhonePe callback verification is not configured') });
  }

  const order = await findOrderFromCallback(req);
  if (!order) return res.status(202).json({ ok: true });

  // Acknowledge quickly and reconcile asynchronously to keep callback latency low
  res.status(202).json({ ok: true });
  setImmediate(async () => {
    try {
      await reconcileOrder(order);
    } catch (error) {
      console.error('[phonepe:callback:bg]', readablePhonePeError(error));
    }
  });
});

export {
  amountForPlan,
  billingFrequencyForPlan,
  calculatePhonePeCallbackAuthorization,
  callbackAuthorizationHeader,
  checkoutIdempotencyKey,
  completeRazorpayPayment,
  configuredRedirectUrl,
  appleFulfillmentKey,
  appleGrantableTransaction,
  appleStatusForTransaction,
  appleSubscriptionUpdateForTransaction,
  createDemoCreditPayment,
  createMerchantOrderId,
  createRazorpayPayment,
  findOrderFromCallback,
  grantPaidTokens,
  orderIdFromCallback,
  phonePeFetch,
  razorpayCheckoutPayload,
  razorpayFetch,
  readableRazorpayError,
  reconcileOrder,
  reconcileRazorpayOrder,
  readablePhonePeError,
  recurringAmountForPlan,
  requirePhonePeCallbackConfig,
  requirePhonePeConfig,
  requireRazorpayConfig,
  statusFromRazorpayOrderStatus,
  statusFromPhonePeState,
  validatePhonePeCallbackAuth,
  verifyRazorpaySignature
};

export default router;
