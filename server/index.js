import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import closetRoutes from './routes/closet.js';
import orderRoutes from './routes/orders.js';
import paymentRoutes from './routes/payments.js';
import productRoutes from './routes/products.js';
import recommendationRoutes from './routes/recommendations.js';
import storefrontRoutes from './routes/storefront.js';
import tryOnRoutes from './routes/tryons.js';
import imageRoutes from './routes/images.js';
import jobRoutes from './routes/jobs.js';
import adminRoutes from './routes/admin.js';
import { requireAdmin, requireAdminSection } from './utils/adminAccess.js';
import { ADMIN_SECTIONS } from './utils/adminPermissions.js';
import { closeRedisClient, getRedisClient } from './utils/cache.js';
import { closeJobQueues, queueEnabled } from './utils/jobQueue.js';
import { configureMongoSlowQueryLogging, flushRequestMetrics, observabilitySnapshot, prometheusMetrics, requestLogger, startRequestMetricFlush } from './utils/observability.js';
import { createRateLimiter, rateLimitKeys } from './utils/rateLimit.js';
import { redactSensitiveText, requestPath } from './utils/logSanitization.js';
import { appRole, mongoConnectOptions, serviceMetadata } from './utils/runtime.js';
import { configurationReadiness, validateServerEnv } from './utils/envValidation.js';
import { securityHeaders, serveUploadedMedia } from './utils/security.js';
import { recordSystemIncident } from './utils/systemIncidents.js';

dotenv.config();

if (!['api', 'all'].includes(appRole('api'))) {
  throw new Error(`APP_ROLE=${appRole('api')} cannot start the API server`);
}

const app = express();
const port = process.env.PORT || 5050;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const service = serviceMetadata('api');
let server = null;
let shuttingDown = false;

function trustProxySetting() {
  const value = String(process.env.TRUST_PROXY || 'true').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

const globalApiLimiter = createRateLimiter({
  name: 'api:global',
  windowMs: Number(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS || 5 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 300),
  keyGenerator: rateLimitKeys.clientIp,
  message: 'Too many requests from this network. Please pause for a few minutes and try again.',
  skip: (req) => req.path.startsWith('/health')
});
const adminMetricsLimiter = createRateLimiter({
  name: 'admin:metrics',
  windowMs: 5 * 60 * 1000,
  max: 60,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Admin metrics are temporarily limited. Please try again shortly.'
});
const requireSystemAdmin = requireAdminSection(ADMIN_SECTIONS.SYSTEM_MANAGEMENT);

function safeTokenMatch(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireMetricsToken(req, res, next) {
  const expected = String(process.env.METRICS_BEARER_TOKEN || '').trim();
  if (!expected) return res.status(404).end();
  const provided = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeTokenMatch(provided, expected)) return res.status(401).set('WWW-Authenticate', 'Bearer').end();
  return next();
}

function allowedOrigins() {
  return [
    process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    process.env.ADMIN_ORIGIN || 'http://localhost:5174',
    ...(process.env.ALLOWED_ORIGINS || '').split(',')
  ]
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function shouldAllowLocalDevOrigins() {
  const value = String(process.env.ALLOW_LOCAL_ORIGINS || '').toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  return process.env.NODE_ENV !== 'production';
}

function isLocalDevOrigin(origin) {
  if (!shouldAllowLocalDevOrigins()) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    if (!['5173', '5174', '5175'].includes(url.port)) return false;
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

app.set('trust proxy', trustProxySetting());
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin) || isLocalDevOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());
app.use(requestLogger);
app.use('/uploads', serveUploadedMedia());
app.use('/api', globalApiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/closet', closetRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/products', productRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/storefront', storefrontRoutes);
app.use('/api/tryons', tryOnRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health/live', (_req, res) => {
  res.json({ ok: true, live: true, shuttingDown, ...service });
});

app.get('/api/health/ready', async (_req, res) => {
  const mongo = mongoose.connection.readyState === 1;
  let redis = true;
  if (process.env.REDIS_URL && ['1', 'true', 'yes', 'on'].includes(String(process.env.TEMP_SESSION_REQUIRE_REDIS || '').toLowerCase())) {
    redis = Boolean(await getRedisClient());
  }
  const ready = !shuttingDown && mongo && redis;
  const config = configurationReadiness();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    ready,
    database: mongo ? 'ready' : 'not_ready',
    redis: redis ? 'ready' : 'not_ready',
    queue: queueEnabled() ? 'ready' : 'disabled',
    otpProvider: config.otpProvider,
    otpProviderType: config.otpProviderType,
    phonePe: config.phonePe,
    razorpay: config.razorpay,
    appleIap: config.appleIap,
    shuttingDown,
    ...service
  });
});

app.get('/api/admin/metrics', requireAdmin, requireSystemAdmin, adminMetricsLimiter, async (_req, res, next) => {
  try {
    res.json(await observabilitySnapshot({ mongoose }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/metrics/prometheus', requireMetricsToken, async (_req, res, next) => {
  try {
    res.type('text/plain; version=0.0.4').send(await prometheusMetrics({ mongoose }));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, _next) => {
  const isFileSizeError = error?.code === 'LIMIT_FILE_SIZE';
  const isUploadError = typeof error?.code === 'string' && error.code.startsWith('LIMIT_');
  const status = error?.statusCode || error?.status || (isFileSizeError ? 413 : isUploadError ? 400 : 500);
  const message = isFileSizeError
    ? 'Profile photo must be smaller than 8 MB.'
    : isUploadError
      ? 'Could not process the profile photo. Please choose a different image and try again.'
      : error?.message || 'Request failed.';

  const errorDetail = process.env.NODE_ENV === 'production' ? error?.message : error?.stack || error?.message;
  console.error(`[api] ${req.method} ${requestPath(req)} failed: ${redactSensitiveText(errorDetail || 'Unknown error')}`);
  if (status >= 500) {
    void recordSystemIncident({
      service: 'api',
      kind: 'http_5xx',
      severity: 'critical',
      title: `${req.method} ${req.route?.path || req.path} failed`,
      message,
      metadata: { method: req.method, path: req.path, status }
    });
  }
  res.status(status).json({ message });
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'api_shutdown_started', signal, ...service }));

  const timeout = setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', event: 'api_shutdown_timeout', signal, ...service }));
    process.exit(1);
  }, Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 25_000));
  timeout.unref?.();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await flushRequestMetrics();
    await closeJobQueues();
    await closeRedisClient();
    await mongoose.disconnect();
    clearTimeout(timeout);
    console.log(JSON.stringify({ level: 'info', event: 'api_shutdown_complete', signal, ...service }));
    process.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error(JSON.stringify({ level: 'error', event: 'api_shutdown_failed', signal, error: error.message, ...service }));
    process.exit(1);
  }
}

async function start() {
  const envReport = validateServerEnv();
  envReport.warnings.forEach((warning) => console.warn(`[env] ${warning}`));

  configureMongoSlowQueryLogging(mongoose);
  await mongoose.connect(process.env.MONGODB_URI, mongoConnectOptions());
  startRequestMetricFlush();

  server = app.listen(port, () => {
    console.log(JSON.stringify({ level: 'info', event: 'api_started', port: Number(port), ...service }));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
