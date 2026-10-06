import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import closetRoutes from './routes/closet.js';
import jobRoutes from './routes/jobs.js';
import paymentRoutes from './routes/payments.js';
import productRoutes, { registerProductJobHandlers } from './routes/products.js';
import recommendationRoutes, { registerRecommendationJobHandlers } from './routes/recommendations.js';
import tryOnRoutes, { registerTryOnJobHandlers } from './routes/tryons.js';
import { jobQueueHealth, startJobWorker } from './utils/jobs.js';
import { logger } from './utils/logger.js';
import { createConcurrencyLimiter, createRateLimiter, rateLimitKeys } from './utils/rateLimit.js';
import { errorLogger, requestLogger } from './utils/requestLogger.js';
import { requireAdmin } from './utils/adminAuth.js';
import { aiPreflightSnapshot } from './utils/aiPreflight.js';
import { validateStartupEnvironment } from './utils/env.js';
import { storageHealthSnapshot } from './utils/storage.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 5050;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

process.on('unhandledRejection', (error) => {
  logger.error('process_unhandled_rejection', { error });
});

process.on('uncaughtException', (error) => {
  logger.error('process_uncaught_exception', { error });
  process.exit(1);
});

function allowedOrigins() {
  return [
    process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    process.env.ADMIN_ORIGIN || 'http://localhost:5174',
    ...(process.env.ALLOWED_ORIGINS || '').split(',')
  ]
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isLocalDevOrigin(origin) {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '0.0.0.0' ||
      url.hostname.startsWith('192.168.') ||
      url.hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname)
    );
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin) || isLocalDevOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());
app.use(requestLogger);
if (process.env.NODE_ENV !== 'production') {
  app.use('/uploads', express.static(path.join(rootDir, 'uploads')));
}

const globalApiLimiter = createRateLimiter({
  name: 'api-global',
  windowMs: 5 * 60 * 1000,
  max: (req) => rateLimitKeys.tokenUserId(req) ? Number(process.env.RATE_LIMIT_AUTHENTICATED_MAX || 300) : Number(process.env.RATE_LIMIT_ANONYMOUS_MAX || 120),
  keyGenerator: rateLimitKeys.principal,
  message: 'Too many requests. Please slow down and try again shortly.'
});
const otpPhoneLimiter = createRateLimiter({
  name: 'otp-phone',
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_OTP_PHONE_MAX || 3),
  keyGenerator: rateLimitKeys.phonePrincipal,
  message: 'Too many OTP requests for this number. Please try again later.'
});
const otpIpLimiter = createRateLimiter({
  name: 'otp-ip',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_OTP_IP_MAX || 60),
  keyGenerator: rateLimitKeys.clientIp,
  message: 'Too many OTP requests from this network. Please try again later.'
});
const otpVerifyLimiter = createRateLimiter({
  name: 'otp-verify',
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_OTP_VERIFY_MAX || 5),
  keyGenerator: rateLimitKeys.phonePrincipal,
  message: 'Too many OTP verification attempts. Please request a fresh OTP later.'
});
const authPasswordLimiter = createRateLimiter({
  name: 'auth-password-v2',
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_PASSWORD_MAX || 30),
  keyGenerator: rateLimitKeys.phonePrincipal,
  message: 'Too many password attempts for this number. Please try again later.'
});
const aiSearchLimiter = createRateLimiter({
  name: 'ai-studio-search',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AI_SEARCH_USER_MAX || 10),
  keyGenerator: rateLimitKeys.principal,
  failClosed: true,
  message: 'AI Studio search limit reached. Please try again later.'
});
const aiSearchIpLimiter = createRateLimiter({
  name: 'ai-studio-search-ip',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AI_SEARCH_IP_MAX || 20),
  keyGenerator: rateLimitKeys.clientIp,
  failClosed: true,
  message: 'Too many AI Studio searches from this device. Please try again later.'
});
const aiSearchConcurrency = createConcurrencyLimiter({
  name: 'ai-studio-search',
  ttlMs: Number(process.env.RATE_LIMIT_AI_SEARCH_LOCK_MS || 90_000),
  keyGenerator: rateLimitKeys.principal,
  failClosed: true,
  message: 'AI Studio is already searching for you. Please wait for that result.'
});

function normalizedOriginalPath(req) {
  return String(req.originalUrl || req.path || '')
    .split('?')[0]
    .replace(/\/+$/, '');
}

function isTryOnVideoRequest(req) {
  return /\/api\/tryons\/[^/]+\/video$/i.test(normalizedOriginalPath(req));
}

function tryOnConcurrencyKey(req, action) {
  const forceKey = req.body?.force || req.body?.refresh ? 'force' : 'cached';
  return `${rateLimitKeys.principal(req)}:${action}:${normalizedOriginalPath(req)}:${forceKey}`;
}

const tryOnImageMinuteLimiter = createRateLimiter({
  name: 'tryon-image-minute',
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_TRYON_IMAGE_MINUTE_MAX || process.env.RATE_LIMIT_TRYON_MINUTE_MAX || 15),
  keyGenerator: rateLimitKeys.principal,
  skip: (req) => req.method !== 'POST' || isTryOnVideoRequest(req),
  failClosed: true,
  message: 'Image try-on generation is being requested too quickly. Please wait a moment.'
});
const tryOnVideoMinuteLimiter = createRateLimiter({
  name: 'tryon-video-minute',
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_TRYON_VIDEO_MINUTE_MAX || 10),
  keyGenerator: rateLimitKeys.principal,
  skip: (req) => req.method !== 'POST',
  failClosed: true,
  message: 'Video try-on generation is being requested too quickly. Please wait a moment.'
});
const tryOnImageConcurrency = createConcurrencyLimiter({
  name: 'tryon-image-generation',
  ttlMs: Number(process.env.RATE_LIMIT_TRYON_IMAGE_LOCK_MS || process.env.RATE_LIMIT_TRYON_LOCK_MS || 3 * 60 * 1000),
  keyGenerator: (req) => tryOnConcurrencyKey(req, 'image'),
  skip: (req) => req.method !== 'POST' || isTryOnVideoRequest(req),
  failClosed: true,
  message: 'This image try-on is already generating. Please wait for it to finish.'
});
const tryOnVideoConcurrency = createConcurrencyLimiter({
  name: 'tryon-video-generation',
  ttlMs: Number(process.env.RATE_LIMIT_TRYON_VIDEO_LOCK_MS || 8 * 60 * 1000),
  keyGenerator: (req) => tryOnConcurrencyKey(req, 'video'),
  skip: (req) => req.method !== 'POST',
  failClosed: true,
  message: 'This video try-on is already generating. Please wait for it to finish.'
});
const profileUploadLimiter = createRateLimiter({
  name: 'profile-upload',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PROFILE_UPLOAD_HOUR_MAX || 10),
  keyGenerator: rateLimitKeys.principal,
  message: 'Too many profile photo uploads. Please try again later.'
});
const closetUploadLimiter = createRateLimiter({
  name: 'closet-upload',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CLOSET_UPLOAD_HOUR_MAX || 30),
  keyGenerator: rateLimitKeys.principal,
  skip: (req) => req.method !== 'POST',
  message: 'Too many wardrobe uploads. Please try again later.'
});
const paymentLimiter = createRateLimiter({
  name: 'payment-start',
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PAYMENT_MINUTE_MAX || 5),
  keyGenerator: rateLimitKeys.principal,
  failClosed: true,
  message: 'Too many payment attempts. Please wait a moment.'
});

app.use('/api', globalApiLimiter);
app.use('/api/auth/otp/send', otpIpLimiter, otpPhoneLimiter);
app.use('/api/auth/otp/verify', otpVerifyLimiter);
app.use('/api/auth/login', authPasswordLimiter);
app.use('/api/auth/password/reset', authPasswordLimiter);
app.use('/api/auth/signup/complete', profileUploadLimiter);
app.use('/api/auth/profile', profileUploadLimiter);
app.use('/api/auth/body-photo', profileUploadLimiter);
app.use('/api/recommendations/studio-chat', aiSearchIpLimiter, aiSearchLimiter, aiSearchConcurrency);
app.use('/api/products/amazon-search', aiSearchIpLimiter, aiSearchLimiter, aiSearchConcurrency);
app.use('/api/tryons/:productId/video', tryOnVideoMinuteLimiter, tryOnVideoConcurrency);
app.use('/api/tryons', tryOnImageMinuteLimiter, tryOnImageConcurrency);
app.use('/api/closet/items/analyze', closetUploadLimiter);
app.use('/api/closet/items', closetUploadLimiter);
app.use('/api/payments/phonepe/subscription', paymentLimiter);
app.use('/api/payments/apple/transactions', paymentLimiter);
app.use('/api/payments/apple/restore', paymentLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/closet', closetRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/products', productRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/tryons', tryOnRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1, storage: storageHealthSnapshot(), jobs: jobQueueHealth() });
});

function requireAiPreflightAccess(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  return requireAdmin(req, res, next);
}

app.get('/api/health/ai', requireAiPreflightAccess, (_req, res) => {
  const snapshot = aiPreflightSnapshot();
  res.status(snapshot.ok ? 200 : 503).json(snapshot);
});

app.use(errorLogger);

async function start() {
  validateStartupEnvironment();

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook'
  });

  registerProductJobHandlers();
  registerRecommendationJobHandlers();
  registerTryOnJobHandlers();
  startJobWorker();

  app.listen(port, () => {
    logger.info('api_started', { port, url: `http://localhost:${port}` });
  });
}

start().catch((error) => {
  logger.error('api_start_failed', { error });
  process.exit(1);
});
