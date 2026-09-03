import mongoose from 'mongoose';
import GenerationMetric from '../models/GenerationMetric.js';
import OtpDeliveryMetric from '../models/OtpDeliveryMetric.js';
import SystemIncident from '../models/SystemIncident.js';
import TokenOrder from '../models/TokenOrder.js';
import UserSession from '../models/UserSession.js';
import { configurationReadiness } from '../utils/envValidation.js';
import { queueEnabled } from '../utils/jobQueue.js';
import { observabilitySnapshot } from '../utils/observability.js';
import { recordSystemIncident, resolveSystemIncident } from '../utils/systemIncidents.js';
import { adminMediaUsage } from './adminMediaUsage.js';
import {
  atlasBilling,
  awsCostExplorer,
  bunnyProbe,
  bunnyStatistics,
  falProbe,
  falUsage,
  prunaProbe
} from './providerIntegrations.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COST_PROVIDERS = [
  { id: 'pruna', label: 'Pruna', category: 'AI API', currency: 'USD' },
  { id: 'fal-pixverse', label: 'FAL / PixVerse', category: 'AI API', currency: 'USD' },
  { id: 'fitroom', label: 'FitRoom', category: 'AI API', currency: 'USD' },
  { id: 'bunny', label: 'Bunny CDN', category: 'Storage and delivery', currency: 'USD' },
  { id: 'mongodb', label: 'MongoDB Atlas', category: 'Database', currency: 'USD' },
  { id: 'otp', label: 'OTP', category: 'Messaging', currency: 'USD' },
  { id: 'aws', label: 'AWS', category: 'Infrastructure', currency: 'USD' },
  { id: 'razorpay', label: 'Razorpay Fees', category: 'Payments', currency: 'INR' }
];

function rounded(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function percent(value, total) {
  return total > 0 ? rounded((Number(value || 0) / Number(total)) * 100, 1) : 0;
}

function envNumber(name) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function configured(keys) {
  return keys.every((key) => Boolean(String(process.env[key] || '').trim()));
}

function periodFromDays(days = 30) {
  const normalized = Math.min(Math.max(Number(days) || 30, 1), 90);
  const to = new Date();
  return { days: normalized, from: new Date(to.getTime() - (normalized * DAY_MS)), to };
}

function currentMonthPeriod() {
  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  return { from, to };
}

function normalizeGenerationProvider(value = '') {
  const provider = String(value || '').trim().toLowerCase();
  if (provider.includes('pruna')) return 'pruna';
  if (provider.includes('pixverse') || provider.includes('fal')) return 'fal-pixverse';
  if (provider.includes('fitroom')) return 'fitroom';
  return provider || 'unknown';
}

async function generationReport(days = 30) {
  const period = periodFromDays(days);
  const [result] = await GenerationMetric.aggregate([
    { $match: { createdAt: { $gte: period.from, $lt: period.to } } },
    {
      $facet: {
        totals: [{
          $group: {
            _id: null,
            total: { $sum: 1 },
            succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            reused: { $sum: { $cond: [{ $eq: ['$status', 'reused'] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
            durationMs: { $sum: { $cond: [{ $in: ['$status', ['succeeded', 'failed']] }, '$durationMs', 0] } },
            tokensCharged: { $sum: '$tokensCharged' },
            tokensRefunded: { $sum: '$tokensRefunded' },
            providerCostUsd: { $sum: '$providerCostUsd' }
          }
        }],
        providers: [
          { $group: { _id: '$provider', total: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, costUsd: { $sum: '$providerCostUsd' }, durationMs: { $sum: '$durationMs' } } },
          { $sort: { total: -1 } }
        ],
        types: [
          { $group: { _id: '$type', total: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, costUsd: { $sum: '$providerCostUsd' } } },
          { $sort: { total: -1 } }
        ],
        errors: [
          { $match: { status: 'failed' } },
          { $group: { _id: { $ifNull: ['$errorCategory', 'unknown'] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 12 }
        ],
        daily: [
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, total: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, costUsd: { $sum: '$providerCostUsd' } } },
          { $sort: { _id: 1 } }
        ],
        recentFailures: [
          { $match: { status: 'failed' } },
          { $sort: { createdAt: -1 } },
          { $limit: 20 },
          { $project: { type: 1, provider: 1, model: 1, errorCategory: 1, durationMs: 1, tokensRefunded: 1, createdAt: 1 } }
        ]
      }
    }
  ]);
  const totals = result?.totals?.[0] || {};
  const attempted = Number(totals.succeeded || 0) + Number(totals.failed || 0);
  return {
    period,
    totals: {
      total: Number(totals.total || 0),
      attempted,
      succeeded: Number(totals.succeeded || 0),
      failed: Number(totals.failed || 0),
      reused: Number(totals.reused || 0),
      rejected: Number(totals.rejected || 0),
      successRate: percent(totals.succeeded, attempted),
      averageDurationMs: attempted ? Math.round(Number(totals.durationMs || 0) / attempted) : 0,
      tokensCharged: Number(totals.tokensCharged || 0),
      tokensRefunded: Number(totals.tokensRefunded || 0),
      providerCostUsd: rounded(totals.providerCostUsd, 4)
    },
    providers: (result?.providers || []).map((row) => ({
      provider: row._id || 'unknown',
      total: Number(row.total || 0),
      succeeded: Number(row.succeeded || 0),
      failed: Number(row.failed || 0),
      successRate: percent(row.succeeded, Number(row.succeeded || 0) + Number(row.failed || 0)),
      averageDurationMs: row.total ? Math.round(Number(row.durationMs || 0) / Number(row.total)) : 0,
      costUsd: rounded(row.costUsd, 4)
    })),
    types: (result?.types || []).map((row) => ({ type: row._id || 'unknown', total: Number(row.total || 0), succeeded: Number(row.succeeded || 0), failed: Number(row.failed || 0), costUsd: rounded(row.costUsd, 4) })),
    errors: (result?.errors || []).map((row) => ({ category: row._id || 'unknown', count: Number(row.count || 0) })),
    daily: (result?.daily || []).map((row) => ({ date: row._id, total: Number(row.total || 0), succeeded: Number(row.succeeded || 0), failed: Number(row.failed || 0), costUsd: rounded(row.costUsd, 4) })),
    recentFailures: (result?.recentFailures || []).map((row) => ({ id: String(row._id), type: row.type, provider: row.provider, model: row.model, errorCategory: row.errorCategory || 'unknown', durationMs: Number(row.durationMs || 0), tokensRefunded: Number(row.tokensRefunded || 0), createdAt: row.createdAt }))
  };
}

function serviceStatus({ id, label, status, detail, group = 'core' }) {
  return { id, label, status, detail, group, checkedAt: new Date() };
}

async function reconcileServiceIncident(service) {
  const incident = {
    service: service.id,
    kind: 'health_check',
    title: `${service.label} health check failed`
  };
  if (service.status === 'down') {
    await recordSystemIncident({ ...incident, severity: service.group === 'core' ? 'critical' : 'warning', message: service.detail });
  } else if (service.status === 'healthy') {
    await resolveSystemIncident(incident);
  }
}

async function systemSummary() {
  const [metrics, generation, bunnyHealth, falHealth, prunaHealth, mongoPing] = await Promise.all([
    observabilitySnapshot({ mongoose }),
    generationReport(1),
    bunnyProbe(),
    falProbe(),
    prunaProbe(),
    mongoose.connection.db?.admin().ping().then(() => true).catch(() => false) || false
  ]);
  const readiness = configurationReadiness();
  const mongoReady = Boolean(metrics.mongo?.ok && mongoPing);
  const redisConfigured = Boolean(process.env.REDIS_URL);
  const redisTarget = metrics.redis?.target ? ` at ${metrics.redis.target}` : '';
  const redisError = metrics.redis?.error ? `: ${metrics.redis.error}` : '';
  const services = [
    serviceStatus({ id: 'api', label: 'API server', status: 'healthy', detail: `Process ${metrics.system?.process?.pid || '-'} is responding.` }),
    serviceStatus({ id: 'mongodb', label: 'MongoDB', status: mongoReady ? 'healthy' : 'down', detail: mongoReady ? `Connected to ${metrics.mongo?.name || 'database'}.` : 'Database connection is unavailable.' }),
    serviceStatus({ id: 'redis', label: 'Redis', status: !redisConfigured ? 'not_configured' : metrics.redis?.ok ? 'healthy' : 'down', detail: !redisConfigured ? 'Redis is not configured.' : metrics.redis?.ok ? `${metrics.redis.connected_clients || 0} clients connected.` : `Redis${redisTarget} did not respond${redisError}.` }),
    serviceStatus({ id: 'queue', label: 'Job queue', status: queueEnabled() ? 'healthy' : 'disabled', detail: queueEnabled() ? 'Queue workers are enabled.' : 'Queue mode is disabled.' }),
    serviceStatus({ id: 'nginx', label: 'Nginx', status: metrics.nginx?.ok ? 'healthy' : 'unknown', detail: metrics.nginx?.ok ? `${metrics.nginx.active || 0} active connections.` : 'Nginx status endpoint is not connected.' }),
    serviceStatus({ id: 'storage', label: 'Bunny storage', status: !bunnyHealth.configured ? 'not_configured' : bunnyHealth.healthy ? 'healthy' : 'down', detail: bunnyHealth.detail, group: 'provider' }),
    serviceStatus({ id: 'pruna', label: 'Pruna image API', status: !prunaHealth.configured ? 'not_configured' : prunaHealth.healthy === true ? 'healthy' : prunaHealth.healthy === false ? 'down' : 'configured', detail: prunaHealth.detail, group: 'provider' }),
    serviceStatus({ id: 'pixverse', label: 'FAL / PixVerse video API', status: !falHealth.configured ? 'not_configured' : falHealth.healthy ? 'healthy' : 'down', detail: falHealth.detail, group: 'provider' }),
    serviceStatus({ id: 'otp', label: 'OTP delivery', status: readiness.otpProvider === 'configured' ? 'configured' : 'not_configured', detail: `${readiness.otpProviderType} provider is ${readiness.otpProvider.replace('_', ' ')}.`, group: 'provider' }),
    serviceStatus({ id: 'razorpay', label: 'Razorpay', status: readiness.razorpay === 'configured' ? 'configured' : 'not_configured', detail: `Payment configuration is ${readiness.razorpay.replace('_', ' ')}.`, group: 'provider' })
  ];
  await Promise.all(services.map(reconcileServiceIncident));
  const activeIncidents = await SystemIncident.find({ status: { $ne: 'resolved' } }).sort({ lastSeenAt: -1 }).limit(20).lean();
  return {
    generatedAt: new Date(),
    overall: services.some((service) => service.status === 'down') ? 'degraded' : 'healthy',
    services,
    metrics,
    generation24h: generation.totals,
    activeIncidents: activeIncidents.map(incidentToClient)
  };
}

function incidentToClient(incident) {
  return {
    id: String(incident._id),
    service: incident.service,
    kind: incident.kind,
    severity: incident.severity,
    status: incident.status,
    title: incident.title,
    message: incident.message || '',
    occurrences: Number(incident.occurrences || 0),
    firstSeenAt: incident.firstSeenAt,
    lastSeenAt: incident.lastSeenAt,
    acknowledgedAt: incident.acknowledgedAt || null,
    resolvedAt: incident.resolvedAt || null,
    note: incident.note || ''
  };
}

async function incidentReport({ status = '', service = '', limit = 100 } = {}) {
  const filter = {};
  if (['open', 'acknowledged', 'resolved'].includes(status)) filter.status = status;
  if (service) filter.service = String(service).slice(0, 80);
  const incidents = await SystemIncident.find(filter).sort({ lastSeenAt: -1 }).limit(Math.min(Math.max(Number(limit) || 100, 1), 250)).lean();
  return {
    items: incidents.map(incidentToClient),
    counts: incidents.reduce((totals, item) => ({ ...totals, [item.status]: (totals[item.status] || 0) + 1 }), { open: 0, acknowledged: 0, resolved: 0 })
  };
}

async function mobileReport(platform, days = 30) {
  const normalizedPlatform = platform === 'ios' ? 'ios' : 'android';
  const period = periodFromDays(days);
  const [result] = await UserSession.aggregate([
    { $match: { platform: normalizedPlatform, loginAt: { $gte: period.from, $lt: period.to } } },
    {
      $facet: {
        totals: [{ $group: { _id: null, sessions: { $sum: 1 }, users: { $addToSet: '$user' }, activeDurationMs: { $sum: '$activeDurationMs' }, pageViews: { $sum: '$pageViewCount' }, events: { $sum: '$eventCount' } } }],
        browsers: [{ $group: { _id: '$browser', sessions: { $sum: 1 } } }, { $sort: { sessions: -1 } }],
        statuses: [{ $group: { _id: '$status', sessions: { $sum: 1 } } }, { $sort: { sessions: -1 } }],
        daily: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$loginAt', timezone: 'UTC' } }, sessions: { $sum: 1 }, users: { $addToSet: '$user' } } }, { $sort: { _id: 1 } }]
      }
    }
  ]);
  const totals = result?.totals?.[0] || {};
  return {
    generatedAt: new Date(),
    platform: normalizedPlatform,
    nativeReporting: { connected: false, source: 'not_connected' },
    webTelemetry: {
      connected: true,
      source: 'user_sessions',
      sessions: Number(totals.sessions || 0),
      users: Number(totals.users?.length || 0),
      activeDurationMs: Number(totals.activeDurationMs || 0),
      pageViews: Number(totals.pageViews || 0),
      events: Number(totals.events || 0),
      browsers: (result?.browsers || []).map((row) => ({ label: row._id || 'Unknown', value: Number(row.sessions || 0) })),
      statuses: (result?.statuses || []).map((row) => ({ label: row._id || 'unknown', value: Number(row.sessions || 0) })),
      daily: (result?.daily || []).map((row) => ({ date: row._id, sessions: Number(row.sessions || 0), users: Number(row.users?.length || 0) }))
    },
    unavailable: ['Native crashes', 'ANRs', 'release adoption', 'store reviews', 'device models']
  };
}

async function generationCostData() {
  const period = currentMonthPeriod();
  const [result] = await GenerationMetric.aggregate([
    { $match: { createdAt: { $gte: period.from, $lt: period.to } } },
    {
      $facet: {
        providers: [{ $group: { _id: '$provider', requests: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, costUsd: { $sum: '$providerCostUsd' }, tokens: { $sum: '$tokensCharged' } } }],
        daily: [{ $group: { _id: { provider: '$provider', date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } } }, requests: { $sum: 1 }, costUsd: { $sum: '$providerCostUsd' } } }, { $sort: { '_id.date': 1 } }],
        models: [{ $group: { _id: { provider: '$provider', model: '$model' }, requests: { $sum: 1 }, costUsd: { $sum: '$providerCostUsd' } } }, { $sort: { requests: -1 } }]
      }
    }
  ]);
  const buckets = new Map();
  const bucketFor = (provider) => {
    const id = normalizeGenerationProvider(provider);
    if (!buckets.has(id)) buckets.set(id, { requests: 0, succeeded: 0, failed: 0, costUsd: 0, tokens: 0, daily: [], models: [] });
    return buckets.get(id);
  };
  (result?.providers || []).forEach((row) => {
    const bucket = bucketFor(row._id);
    bucket.requests += Number(row.requests || 0);
    bucket.succeeded += Number(row.succeeded || 0);
    bucket.failed += Number(row.failed || 0);
    bucket.costUsd += Number(row.costUsd || 0);
    bucket.tokens += Number(row.tokens || 0);
  });
  (result?.daily || []).forEach((row) => {
    const bucket = bucketFor(row._id?.provider);
    const existing = bucket.daily.find((item) => item.date === row._id?.date);
    if (existing) {
      existing.requests += Number(row.requests || 0);
      existing.cost += Number(row.costUsd || 0);
    } else {
      bucket.daily.push({ date: row._id?.date, requests: Number(row.requests || 0), cost: Number(row.costUsd || 0) });
    }
  });
  (result?.models || []).forEach((row) => {
    bucketFor(row._id?.provider).models.push({ label: row._id?.model || 'unknown', requests: Number(row.requests || 0), cost: rounded(row.costUsd, 4) });
  });
  buckets.forEach((bucket) => {
    bucket.costUsd = rounded(bucket.costUsd, 4);
    bucket.daily = bucket.daily.map((item) => ({ ...item, cost: rounded(item.cost, 4) })).sort((left, right) => left.date.localeCompare(right.date));
  });
  return { period, buckets };
}

function baseProvider(id) {
  const provider = COST_PROVIDERS.find((item) => item.id === id);
  if (!provider) throw Object.assign(new Error('Unknown cost provider'), { statusCode: 404 });
  return {
    ...provider,
    generatedAt: new Date(),
    balance: null,
    spend: null,
    budget: null,
    source: 'unavailable',
    sourceLabel: 'Provider billing not connected',
    connection: 'not_connected',
    metrics: [],
    breakdown: [],
    daily: [],
    requirements: []
  };
}

async function aiCostDetail(id, generationData) {
  const detail = baseProvider(id);
  const bucket = generationData.buckets.get(id) || { requests: 0, succeeded: 0, failed: 0, costUsd: 0, tokens: 0, daily: [], models: [] };
  const configuration = id === 'pruna'
    ? configured(['PRUNA_API_KEY'])
    : id === 'fal-pixverse'
      ? configured(['FAL_KEY'])
      : configured(['FITROOM_API_KEY']);
  detail.connection = configuration ? 'usage_connected' : 'not_configured';
  detail.spend = bucket.costUsd;
  detail.source = bucket.costUsd > 0 ? 'estimated' : 'unavailable';
  detail.sourceLabel = bucket.costUsd > 0 ? 'Estimated from recorded generation prices' : 'Usage is tracked, but provider billing is not connected';
  detail.metrics = [
    { label: 'Requests', value: bucket.requests, format: 'number' },
    { label: 'Succeeded', value: bucket.succeeded, format: 'number' },
    { label: 'Failed', value: bucket.failed, format: 'number' },
    { label: 'Success rate', value: percent(bucket.succeeded, bucket.succeeded + bucket.failed), format: 'percent' },
    { label: 'Credits charged', value: bucket.tokens, format: 'number' }
  ];
  detail.breakdown = bucket.models;
  detail.daily = bucket.daily;
  detail.requirements = ['Provider billing or wallet API access', 'Verified per-model pricing'];
  if (id === 'fal-pixverse') {
    try {
      const live = await falUsage();
      if (live.configured) {
        detail.connection = 'live';
        detail.spend = rounded(live.spend, 4);
        detail.source = 'live';
        detail.sourceLabel = 'Live month-to-date usage from the FAL platform API';
        detail.breakdown = live.breakdown.length ? live.breakdown : detail.breakdown;
        detail.requirements = [];
      } else {
        detail.requirements = ['FAL_ADMIN_KEY with platform usage scope', 'FAL account billing access for wallet balance'];
      }
    } catch (error) {
      detail.connection = 'error';
      detail.integrationError = error.message;
      detail.sourceLabel = `FAL billing connection failed; showing recorded usage${bucket.costUsd > 0 ? ' estimate' : ''}`;
    }
  } else if (id === 'pruna') {
    detail.requirements = ['Pruna account billing endpoint or export', 'Verified provider invoice reconciliation'];
  }
  return detail;
}

async function bunnyCostDetail() {
  const detail = baseProvider('bunny');
  const media = await adminMediaUsage();
  const bytes = Number(media.usage?.bunnyBytes?.all || 0);
  const gibibytes = bytes / (1024 ** 3);
  const rate = envNumber('BUNNY_STORAGE_COST_PER_GB_USD');
  const manualBalance = envNumber('BUNNY_ACCOUNT_BALANCE_USD');
  detail.connection = configured(['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_API_KEY', 'BUNNY_CDN_BASE_URL']) ? 'usage_connected' : 'not_configured';
  detail.balance = manualBalance;
  detail.spend = rate === null ? null : rounded(gibibytes * rate, 4);
  detail.source = rate === null ? 'unavailable' : 'estimated';
  detail.sourceLabel = rate === null ? 'Storage usage is tracked; billing and bandwidth are not connected' : 'Estimated from database file sizes and configured storage rate';
  detail.metrics = [
    { label: 'Tracked storage', value: bytes, format: 'bytes' },
    { label: 'Bunny files', value: Number(media.usage?.bunnyCounts?.all || 0), format: 'number' },
    { label: 'Unknown file sizes', value: Number(media.usage?.unknownSize?.all || 0), format: 'number' },
    { label: 'Bandwidth', value: null, format: 'bytes' }
  ];
  detail.breakdown = ['profile', 'tryon', 'video', 'closet', 'product'].map((group) => ({ label: group, bytes: Number(media.usage?.bunnyBytes?.[group] || 0), files: Number(media.usage?.bunnyCounts?.[group] || 0) }));
  detail.requirements = ['Bunny account billing API key', 'Pull-zone bandwidth statistics access'];
  try {
    const live = await bunnyStatistics();
    if (live.configured) {
      detail.connection = 'live';
      detail.balance = live.balance ?? detail.balance;
      detail.source = rate === null ? 'live_usage' : 'estimated';
      detail.sourceLabel = rate === null
        ? 'Live Bunny bandwidth and request usage; invoiced cost is not exposed by this endpoint'
        : 'Live Bunny usage with a configured storage-rate estimate';
      detail.metrics[3].value = live.bandwidthBytes;
      detail.metrics.push({ label: 'CDN requests', value: live.requests, format: 'number' });
      detail.metrics.push({ label: 'Cache hit rate', value: live.cacheHitRate, format: 'percent' });
      detail.requirements = rate === null ? ['BUNNY_STORAGE_COST_PER_GB_USD for a storage estimate', 'Bunny invoice export for actual cost'] : ['Bunny invoice export for actual cost'];
    }
  } catch (error) {
    detail.connection = 'error';
    detail.integrationError = error.message;
    detail.sourceLabel = 'Bunny account API connection failed; showing database-tracked storage only';
  }
  return detail;
}

async function mongodbCostDetail() {
  const detail = baseProvider('mongodb');
  let stats = null;
  try {
    stats = mongoose.connection.db ? await mongoose.connection.db.command({ dbStats: 1, scale: 1 }) : null;
  } catch {
    stats = null;
  }
  const manualCost = envNumber('MONGODB_MONTHLY_COST_USD');
  detail.connection = mongoose.connection.readyState === 1 ? 'usage_connected' : 'not_connected';
  detail.spend = manualCost;
  detail.source = manualCost === null ? 'unavailable' : 'manual';
  detail.sourceLabel = manualCost === null ? 'Database usage is live; Atlas billing is not connected' : 'Manual monthly amount from server configuration';
  detail.metrics = [
    { label: 'Data size', value: Number(stats?.dataSize || 0), format: 'bytes' },
    { label: 'Storage size', value: Number(stats?.storageSize || 0), format: 'bytes' },
    { label: 'Index size', value: Number(stats?.indexSize || 0), format: 'bytes' },
    { label: 'Collections', value: Number(stats?.collections || 0), format: 'number' }
  ];
  detail.requirements = ['MongoDB Atlas organization billing access', 'Atlas project or organization API credentials'];
  try {
    const live = await atlasBilling();
    if (live.configured) {
      detail.connection = 'live';
      detail.spend = rounded(live.spend, 2);
      detail.currency = live.currency || detail.currency;
      detail.source = 'live';
      detail.sourceLabel = 'Live pending invoice total from the MongoDB Atlas Admin API';
      detail.breakdown = live.invoices;
      detail.requirements = [];
    }
  } catch (error) {
    detail.connection = 'error';
    detail.integrationError = error.message;
    detail.sourceLabel = 'Atlas billing API connection failed; database usage remains live';
  }
  return detail;
}

async function otpCostDetail() {
  const detail = baseProvider('otp');
  const period = currentMonthPeriod();
  const [totals = {}] = await OtpDeliveryMetric.aggregate([
    { $match: { createdAt: { $gte: period.from, $lt: period.to } } },
    { $group: { _id: null, total: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, durationMs: { $sum: '$durationMs' }, costUsd: { $sum: '$estimatedCostUsd' } } }
  ]);
  const configuredProvider = configurationReadiness().otpProvider === 'configured';
  const unitCost = envNumber('OTP_COST_PER_MESSAGE_USD');
  const hasCostEstimate = unitCost !== null;
  detail.connection = configuredProvider ? 'usage_connected' : 'not_configured';
  detail.spend = hasCostEstimate ? rounded(totals.costUsd, 4) : null;
  detail.source = hasCostEstimate ? 'estimated' : 'unavailable';
  detail.sourceLabel = hasCostEstimate
    ? 'Estimated from delivery count and configured unit rate'
    : 'Delivery outcomes are tracked; provider wallet is not connected';
  detail.metrics = [
    { label: 'Delivery requests', value: Number(totals.total || 0), format: 'number' },
    { label: 'Succeeded', value: Number(totals.succeeded || 0), format: 'number' },
    { label: 'Failed', value: Number(totals.failed || 0), format: 'number' },
    { label: 'Average latency', value: totals.total ? Math.round(Number(totals.durationMs || 0) / Number(totals.total)) : 0, format: 'duration' }
  ];
  detail.requirements = ['OTP provider balance API access', 'Delivery receipt callback', 'OTP_COST_PER_MESSAGE_USD for estimates'];
  return detail;
}

async function awsCostDetail() {
  const detail = baseProvider('aws');
  const manualCost = envNumber('AWS_MONTHLY_COST_USD');
  const budget = envNumber('AWS_MONTHLY_BUDGET_USD');
  detail.connection = manualCost === null ? 'not_connected' : 'manual';
  detail.spend = manualCost;
  detail.budget = budget;
  detail.source = manualCost === null ? 'unavailable' : 'manual';
  detail.sourceLabel = manualCost === null ? 'AWS Cost Explorer is not connected' : 'Manual month-to-date amount from server configuration';
  detail.metrics = [
    { label: 'Budget used', value: manualCost !== null && budget ? percent(manualCost, budget) : null, format: 'percent' },
    { label: 'Forecast', value: null, format: 'money' },
    { label: 'Services', value: null, format: 'number' }
  ];
  detail.requirements = ['Read-only AWS Cost Explorer IAM permissions', 'Cost allocation tags for Lookmefy resources'];
  try {
    const live = await awsCostExplorer();
    if (live.configured) {
      detail.connection = 'live';
      detail.spend = rounded(live.spend, 4);
      detail.source = live.estimated ? 'live_estimate' : 'live';
      detail.sourceLabel = live.estimated ? 'Live month-to-date estimate from AWS Cost Explorer' : 'Live month-to-date cost from AWS Cost Explorer';
      detail.breakdown = live.breakdown;
      detail.metrics[0].value = detail.budget ? percent(detail.spend, detail.budget) : null;
      detail.metrics[2].value = live.breakdown.length;
      detail.requirements = [];
    }
  } catch (error) {
    detail.connection = 'error';
    detail.integrationError = error.message;
    detail.sourceLabel = 'AWS Cost Explorer connection failed';
  }
  return detail;
}

async function razorpayCostDetail() {
  const detail = baseProvider('razorpay');
  const period = currentMonthPeriod();
  const [totals = {}] = await TokenOrder.aggregate([
    { $match: { status: 'completed', createdAt: { $gte: period.from, $lt: period.to } } },
    { $group: { _id: null, payments: { $sum: 1 }, grossInr: { $sum: '$amount' } } }
  ]);
  const feePercent = envNumber('RAZORPAY_FEE_PERCENT');
  const fixedFee = envNumber('RAZORPAY_FEE_FIXED_INR') || 0;
  const estimatedFee = feePercent === null ? null : rounded((Number(totals.grossInr || 0) * feePercent / 100) + (Number(totals.payments || 0) * fixedFee), 2);
  detail.connection = configurationReadiness().razorpay === 'configured' ? 'usage_connected' : 'not_configured';
  detail.spend = estimatedFee;
  detail.source = estimatedFee === null ? 'unavailable' : 'estimated';
  detail.sourceLabel = estimatedFee === null ? 'Payment totals are tracked; settlement fees are not connected' : 'Estimated from completed payments and configured fee rate';
  detail.metrics = [
    { label: 'Completed payments', value: Number(totals.payments || 0), format: 'number' },
    { label: 'Gross payments', value: Number(totals.grossInr || 0), format: 'money' },
    { label: 'Settlement balance', value: null, format: 'money' }
  ];
  detail.requirements = ['Razorpay settlement or reconciliation report access', 'RAZORPAY_FEE_PERCENT for estimates'];
  return detail;
}

async function providerCostDetail(id, generationData = null) {
  if (['pruna', 'fal-pixverse', 'fitroom'].includes(id)) {
    const data = generationData || await generationCostData();
    return aiCostDetail(id, data);
  }
  if (id === 'bunny') return bunnyCostDetail();
  if (id === 'mongodb') return mongodbCostDetail();
  if (id === 'otp') return otpCostDetail();
  if (id === 'aws') return awsCostDetail();
  if (id === 'razorpay') return razorpayCostDetail();
  return baseProvider(id);
}

async function costOverview() {
  const generationData = await generationCostData();
  const providers = await Promise.all(COST_PROVIDERS.map((provider) => providerCostDetail(provider.id, generationData)));
  const totals = providers.reduce((result, provider) => {
    if (provider.spend === null) result.unavailable += 1;
    else if (provider.currency === 'INR') result.inr += Number(provider.spend || 0);
    else result.usd += Number(provider.spend || 0);
    if (provider.source === 'estimated') result.estimated += 1;
    if (provider.source === 'manual') result.manual += 1;
    if (String(provider.source).startsWith('live')) result.live += 1;
    return result;
  }, { usd: 0, inr: 0, unavailable: 0, estimated: 0, manual: 0, live: 0 });
  return {
    generatedAt: new Date(),
    period: generationData.period,
    totals: { ...totals, usd: rounded(totals.usd, 4), inr: rounded(totals.inr, 2) },
    providers: providers.map(({ requirements, breakdown, daily, metrics, ...provider }) => provider)
  };
}

export {
  COST_PROVIDERS,
  costOverview,
  generationReport,
  incidentReport,
  incidentToClient,
  mobileReport,
  normalizeGenerationProvider,
  providerCostDetail,
  systemSummary
};
