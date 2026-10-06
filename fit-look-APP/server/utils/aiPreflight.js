import { envFlag, isProductionRuntime } from './devMode.js';
import { jobQueueHealth } from './jobs.js';
import { storageHealthSnapshot } from './storage.js';

function envValue(name) {
  return String(process.env[name] || '').trim();
}

function hasEnv(name) {
  return Boolean(envValue(name));
}

function hasAnyEnv(names) {
  return names.some(hasEnv);
}

function configuredState(name) {
  return hasEnv(name) ? 'set' : 'missing';
}

function configuredAnyState(names) {
  return hasAnyEnv(names) ? 'set' : 'missing';
}

function normalizedHttpsUrl(name, fallback = '') {
  const value = envValue(name) || fallback;
  if (!value) return { name, configured: false, value: '', valid: false, https: false };
  try {
    const parsed = new URL(value);
    const supportedProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return {
      name,
      configured: hasEnv(name),
      value: parsed.toString().replace(/\/+$/, ''),
      valid: supportedProtocol,
      https: parsed.protocol === 'https:'
    };
  } catch {
    return { name, configured: hasEnv(name), value, valid: false, https: false };
  }
}

function originChecks() {
  return ['CLIENT_ORIGIN', 'ADMIN_ORIGIN']
    .map((name) => normalizedHttpsUrl(name))
    .concat(
      envValue('ALLOWED_ORIGINS')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) => {
          try {
            const parsed = new URL(origin);
            const supportedProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';
            return {
              name: 'ALLOWED_ORIGINS',
              configured: true,
              value: parsed.toString().replace(/\/+$/, ''),
              valid: supportedProtocol,
              https: parsed.protocol === 'https:'
            };
          } catch {
            return { name: 'ALLOWED_ORIGINS', configured: true, value: origin, valid: false, https: false };
          }
        })
    );
}

function addIssue(issues, condition, message, severity = 'error') {
  if (!condition) return;
  issues.push({ severity, message });
}

function service(name, ready, degraded = false, notes = '') {
  return {
    name,
    status: ready ? 'ready' : degraded ? 'degraded' : 'blocked',
    notes
  };
}

function aiPreflightSnapshot({ targetProduction = false } = {}) {
  const runtimeProduction = isProductionRuntime();
  const production = targetProduction || runtimeProduction;
  const storage = storageHealthSnapshot();
  const jobs = jobQueueHealth();
  const origins = originChecks();
  const prunaConfigured = hasAnyEnv(['PRUNA_API_KEY', 'PRUNA_KEY', 'PRUNA_TOKEN']);
  const falConfigured = hasEnv('FAL_KEY');
  const fitRoomConfigured = hasEnv('FITROOM_API_KEY');
  const openAiConfigured = hasEnv('OPENAI_API_KEY');
  const asyncJobsConfigured = !jobs.asyncJobsEnabled || jobs.workerEnabled;
  const issues = [];

  addIssue(issues, targetProduction && !runtimeProduction, 'NODE_ENV must be production for AWS production.');
  addIssue(issues, production && envFlag(process.env.AUTH_OTP_EXPOSE, false), 'AUTH_OTP_EXPOSE must be disabled in production.');
  addIssue(issues, production && envFlag(process.env.ENABLE_DEV_MODE_BYPASS, false), 'ENABLE_DEV_MODE_BYPASS must be disabled in production.');
  addIssue(issues, production && envFlag(process.env.SIGNUP_DEV_MODE_DEFAULT, false), 'SIGNUP_DEV_MODE_DEFAULT must be disabled in production.');
  addIssue(issues, production && envFlag(process.env.ALLOW_USER_DEV_MODE_TOGGLE, false), 'ALLOW_USER_DEV_MODE_TOGGLE must be disabled in production.');
  addIssue(issues, production && !hasEnv('MONGODB_URI'), 'MONGODB_URI is required in production.');
  addIssue(issues, production && !hasEnv('JWT_SECRET'), 'JWT_SECRET is required in production.');
  addIssue(issues, production && !hasEnv('ADMIN_KEY'), 'ADMIN_KEY is required to protect admin and AI preflight endpoints.');
  addIssue(issues, production && !hasEnv('REDIS_URL'), 'REDIS_URL is required for production rate limits and AI job coordination.');
  addIssue(issues, production && !hasEnv('CLIENT_ORIGIN'), 'CLIENT_ORIGIN is required in production.');
  addIssue(issues, !storage.configured, production
    ? 'Remote storage is not configured; generated AI media may not persist.'
    : 'Generated media storage is not configured; AI outputs may not persist locally.');
  addIssue(issues, production && storage.provider === 'local', 'Production storage must not use local uploads.');
  addIssue(issues, !falConfigured, 'FAL_KEY is required for AI Studio model replies and wardrobe item detection.');
  addIssue(issues, !fitRoomConfigured, 'FITROOM_API_KEY is required for closet outfit generation.');
  addIssue(issues, !prunaConfigured, 'PRUNA_API_KEY, PRUNA_KEY, or PRUNA_TOKEN is required for try-on images and videos.');
  addIssue(issues, jobs.asyncJobsEnabled && !jobs.workerEnabled, 'ASYNC_JOBS_ENABLED is on, but JOB_WORKER_ENABLED is off; AI jobs may stay queued.');

  for (const origin of origins) {
    addIssue(issues, production && origin.configured && !origin.valid, `${origin.name} contains an invalid URL: ${origin.value}`);
    addIssue(issues, production && origin.configured && origin.valid && !origin.https, `${origin.name} must use HTTPS in production: ${origin.value}`);
  }

  const prunaBase = normalizedHttpsUrl('PRUNA_BASE_URL', 'https://api.pruna.ai/v1');
  const fitRoomBase = normalizedHttpsUrl('FITROOM_BASE_URL', 'https://platform.fitroom.app');
  addIssue(issues, production && (!prunaBase.valid || !prunaBase.https), 'PRUNA_BASE_URL must be a valid HTTPS URL in production.');
  addIssue(issues, production && (!fitRoomBase.valid || !fitRoomBase.https), 'FITROOM_BASE_URL must be a valid HTTPS URL in production.');
  addIssue(issues, !openAiConfigured, 'OPENAI_API_KEY is not set; closet stylist chat will use the local fallback reply.', 'warning');
  addIssue(issues, !production, 'NODE_ENV is not production; this is fine locally but not for AWS production.', 'warning');

  const services = [
    service(
      'AI Studio chat and fashion search',
      falConfigured,
      true,
      falConfigured
        ? 'FAL/OpenRouter reply model is configured; Amazon/catalog search fallback remains available.'
        : 'Fashion search can still fall back locally, but model-generated replies are disabled.'
    ),
    service('Product, custom, and external image try-on', prunaConfigured, false, 'Default generation path uses Pruna.'),
    service('Video try-on', prunaConfigured, false, 'Video generation uses Pruna p-video.'),
    service('Wardrobe item AI detection', falConfigured && envFlag(process.env.CLOSET_VISION_ANALYSIS, true), false, 'Uses FAL/OpenRouter vision.'),
    service('Closet outfit generation', fitRoomConfigured, false, 'Uses FitRoom try-on.'),
    service('Closet stylist chat', openAiConfigured, true, openAiConfigured ? 'OpenAI stylist is configured.' : 'Falls back to deterministic closet suggestions.'),
    service('AI job queue', asyncJobsConfigured, false, jobs.asyncJobsEnabled ? 'Async AI jobs are enabled.' : 'Async jobs disabled; requests run inline.'),
    service('Generated media storage', storage.configured, false, `${storage.provider} storage provider.`)
  ];

  const blockingIssues = issues.filter((issue) => issue.severity === 'error');
  return {
    ok: blockingIssues.length === 0,
    checkedAt: new Date().toISOString(),
    runtime: {
      nodeEnv: process.env.NODE_ENV || 'development',
      production: runtimeProduction,
      targetProduction: production
    },
    providers: {
      falKey: configuredState('FAL_KEY'),
      prunaKey: configuredAnyState(['PRUNA_API_KEY', 'PRUNA_KEY', 'PRUNA_TOKEN']),
      fitRoomKey: configuredState('FITROOM_API_KEY'),
      openAiKey: openAiConfigured ? 'set' : 'optional-missing',
      prunaBaseUrl: prunaBase.value,
      fitRoomBaseUrl: fitRoomBase.value,
      aiStudioEndpoint: envValue('FAL_AI_STUDIO_ENDPOINT') || envValue('FAL_CLOSET_VISION_ENDPOINT') || 'openrouter/router/vision',
      aiStudioModel: envValue('FAL_AI_STUDIO_MODEL') || envValue('FAL_CLOSET_VISION_MODEL') || 'google/gemini-2.5-flash-lite',
      tryOnModel: envValue('PRUNA_TRYON_MODEL') || 'p-image-try-on',
      videoModel: envValue('PRUNA_VIDEO_MODEL') || envValue('PRUNA_TRYON_VIDEO_MODEL') || 'p-video'
    },
    backend: {
      mongodb: configuredState('MONGODB_URI'),
      redis: configuredState('REDIS_URL'),
      jwtSecret: configuredState('JWT_SECRET'),
      adminKey: configuredState('ADMIN_KEY'),
      storage,
      jobs
    },
    origins,
    services,
    issues
  };
}

export { aiPreflightSnapshot };
