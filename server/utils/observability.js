import os from 'node:os';
import fs from 'node:fs/promises';
import RequestMetric from '../models/RequestMetric.js';
import { cleanRedisError, getRedisClient, redisConnectionStatus, withTimeout } from './cache.js';
import { requestPath } from './logSanitization.js';
import { serviceMetadata } from './runtime.js';

const startedAt = Date.now();
const endpointStats = new Map();
const pendingMetricBuckets = new Map();
const slowRequestMs = Number(process.env.SLOW_REQUEST_MS || 1000);
const maxEndpoints = Number(process.env.REQUEST_METRICS_MAX_ENDPOINTS || 250);
const metricRetentionDays = Math.max(1, Number(process.env.REQUEST_METRICS_RETENTION_DAYS || 30));
const service = serviceMetadata('api');
let metricFlushPromise = null;
let metricFlushTimer = null;

const HISTOGRAM_BUCKETS = [100, 250, 500, 1000, 2500, 5000];

function enabled(value, defaultValue = true) {
  const raw = String(value ?? '').toLowerCase();
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function routeKey(req) {
  const routePath = req.route?.path;
  const baseUrl = req.baseUrl || '';
  if (routePath) return `${req.method} ${baseUrl}${routePath}`.replace(/\/+/g, '/').replace(':/', '://');
  return `${req.method} ${req.path}`;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function statsFor(key) {
  if (!endpointStats.has(key)) {
    endpointStats.set(key, {
      key,
      count: 0,
      errors: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      samples: []
    });
  }
  while (endpointStats.size > maxEndpoints) endpointStats.delete(endpointStats.keys().next().value);
  return endpointStats.get(key);
}

function minuteBucket(value = Date.now()) {
  return new Date(Math.floor(value / 60_000) * 60_000);
}

function histogramDelta(durationMs) {
  const delta = { le100: 0, le250: 0, le500: 0, le1000: 0, le2500: 0, le5000: 0, inf: 1 };
  HISTOGRAM_BUCKETS.forEach((boundary) => {
    if (durationMs <= boundary) delta[`le${boundary}`] = 1;
  });
  return delta;
}

function queuePersistentMetric({ key, statusCode, durationMs }) {
  if (!enabled(process.env.PERSIST_REQUEST_METRICS, process.env.NODE_ENV === 'production')) return;
  const bucketStart = minuteBucket();
  const bucketKey = `${bucketStart.toISOString()}\u0000${service.instanceId}\u0000${key}`;
  const current = pendingMetricBuckets.get(bucketKey) || {
    bucketStart,
    instanceId: service.instanceId,
    endpoint: key,
    requests: 0,
    errors: 0,
    clientErrors: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
    histogram: { le100: 0, le250: 0, le500: 0, le1000: 0, le2500: 0, le5000: 0, inf: 0 }
  };
  current.requests += 1;
  if (statusCode >= 500) current.errors += 1;
  else if (statusCode >= 400) current.clientErrors += 1;
  current.totalMs += durationMs;
  current.minMs = Math.min(current.minMs, durationMs);
  current.maxMs = Math.max(current.maxMs, durationMs);
  const histogram = histogramDelta(durationMs);
  Object.keys(current.histogram).forEach((field) => {
    current.histogram[field] += histogram[field];
  });
  pendingMetricBuckets.set(bucketKey, current);
}

function recordRequest({ key, statusCode, durationMs }) {
  const stats = statsFor(key);
  stats.count += 1;
  if (statusCode >= 500) stats.errors += 1;
  stats.totalMs += durationMs;
  stats.minMs = Math.min(stats.minMs, durationMs);
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  stats.samples.push(durationMs);
  if (stats.samples.length > 256) stats.samples.shift();
  queuePersistentMetric({ key, statusCode, durationMs });
}

function mergePendingMetric(metric) {
  const bucketKey = `${metric.bucketStart.toISOString()}\u0000${metric.instanceId}\u0000${metric.endpoint}`;
  const current = pendingMetricBuckets.get(bucketKey);
  if (!current) {
    pendingMetricBuckets.set(bucketKey, metric);
    return;
  }
  current.requests += metric.requests;
  current.errors += metric.errors;
  current.clientErrors += metric.clientErrors;
  current.totalMs += metric.totalMs;
  current.minMs = Math.min(current.minMs, metric.minMs);
  current.maxMs = Math.max(current.maxMs, metric.maxMs);
  Object.keys(current.histogram).forEach((field) => {
    current.histogram[field] += metric.histogram[field];
  });
}

async function flushRequestMetrics() {
  if (metricFlushPromise) return metricFlushPromise;
  if (!pendingMetricBuckets.size) return undefined;
  const batch = [...pendingMetricBuckets.values()];
  pendingMetricBuckets.clear();
  metricFlushPromise = (async () => {
    try {
      const expiresAt = new Date(Date.now() + metricRetentionDays * 24 * 60 * 60 * 1000);
      await RequestMetric.bulkWrite(batch.map((metric) => ({
        updateOne: {
          filter: { bucketStart: metric.bucketStart, instanceId: metric.instanceId, endpoint: metric.endpoint },
          update: {
            $inc: {
              requests: metric.requests,
              errors: metric.errors,
              clientErrors: metric.clientErrors,
              totalMs: metric.totalMs,
              'histogram.le100': metric.histogram.le100,
              'histogram.le250': metric.histogram.le250,
              'histogram.le500': metric.histogram.le500,
              'histogram.le1000': metric.histogram.le1000,
              'histogram.le2500': metric.histogram.le2500,
              'histogram.le5000': metric.histogram.le5000,
              'histogram.inf': metric.histogram.inf
            },
            $min: { minMs: Number.isFinite(metric.minMs) ? metric.minMs : 0 },
            $max: { maxMs: metric.maxMs },
            $set: { expiresAt }
          },
          upsert: true
        }
      })), { ordered: false });
    } catch (error) {
      batch.forEach(mergePendingMetric);
      if (process.env.NODE_ENV !== 'test') {
        console.warn(JSON.stringify({ level: 'warn', event: 'request_metrics_flush_failed', message: error.message, ...service }));
      }
    } finally {
      metricFlushPromise = null;
    }
  })();
  return metricFlushPromise;
}

function startRequestMetricFlush() {
  if (metricFlushTimer || !enabled(process.env.PERSIST_REQUEST_METRICS, process.env.NODE_ENV === 'production')) return;
  const intervalMs = Math.max(5_000, Number(process.env.REQUEST_METRICS_FLUSH_MS || 10_000));
  metricFlushTimer = setInterval(() => void flushRequestMetrics(), intervalMs);
  metricFlushTimer.unref?.();
}

function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const key = routeKey(req);
    recordRequest({ key, statusCode: res.statusCode, durationMs });

    if (!enabled(process.env.STRUCTURED_REQUEST_LOGS, true)) return;
    const level = res.statusCode >= 500 ? 'error' : durationMs >= slowRequestMs ? 'warn' : 'info';
    const log = {
      level,
      event: 'http_request',
      ...service,
      method: req.method,
      path: requestPath(req),
      route: key,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      contentLength: Number(res.getHeader('content-length') || 0) || undefined,
      ip: req.ip,
      userAgent: req.get('user-agent')
    };
    console.log(JSON.stringify(log));
  });
  next();
}

function requestMetrics() {
  return [...endpointStats.values()]
    .map((stats) => ({
      endpoint: stats.key,
      requests: stats.count,
      errors: stats.errors,
      errorRate: stats.count ? Math.round((stats.errors / stats.count) * 10000) / 10000 : 0,
      avgMs: stats.count ? Math.round((stats.totalMs / stats.count) * 100) / 100 : 0,
      minMs: Number.isFinite(stats.minMs) ? Math.round(stats.minMs * 100) / 100 : 0,
      maxMs: Math.round(stats.maxMs * 100) / 100,
      p50Ms: percentile(stats.samples, 50),
      p95Ms: percentile(stats.samples, 95),
      p99Ms: percentile(stats.samples, 99)
    }))
    .sort((a, b) => b.requests - a.requests);
}

function estimateHistogramPercentile(histogram, requests, percentileValue) {
  if (!requests) return 0;
  const target = requests * percentileValue;
  const boundaries = [
    ['le100', 100], ['le250', 250], ['le500', 500], ['le1000', 1000],
    ['le2500', 2500], ['le5000', 5000], ['inf', 5000]
  ];
  const match = boundaries.find(([field]) => Number(histogram?.[field] || 0) >= target);
  return match?.[1] || 0;
}

async function persistentRequestMetrics(hours = 24) {
  const safeHours = Math.min(Math.max(Number(hours) || 24, 1), 30 * 24);
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000);
  const rows = await RequestMetric.aggregate([
    { $match: { bucketStart: { $gte: since } } },
    {
      $group: {
        _id: '$endpoint',
        requests: { $sum: '$requests' },
        errors: { $sum: '$errors' },
        clientErrors: { $sum: '$clientErrors' },
        totalMs: { $sum: '$totalMs' },
        minMs: { $min: '$minMs' },
        maxMs: { $max: '$maxMs' },
        instances: { $addToSet: '$instanceId' },
        le100: { $sum: '$histogram.le100' },
        le250: { $sum: '$histogram.le250' },
        le500: { $sum: '$histogram.le500' },
        le1000: { $sum: '$histogram.le1000' },
        le2500: { $sum: '$histogram.le2500' },
        le5000: { $sum: '$histogram.le5000' },
        inf: { $sum: '$histogram.inf' }
      }
    },
    { $sort: { requests: -1 } },
    { $limit: maxEndpoints }
  ]);
  const endpoints = rows.map((row) => {
    const histogram = { le100: row.le100, le250: row.le250, le500: row.le500, le1000: row.le1000, le2500: row.le2500, le5000: row.le5000, inf: row.inf };
    return {
      endpoint: row._id,
      requests: row.requests,
      errors: row.errors,
      clientErrors: row.clientErrors,
      errorRate: row.requests ? Math.round((row.errors / row.requests) * 10000) / 10000 : 0,
      avgMs: row.requests ? Math.round((row.totalMs / row.requests) * 100) / 100 : 0,
      minMs: Math.round(Number(row.minMs || 0) * 100) / 100,
      maxMs: Math.round(Number(row.maxMs || 0) * 100) / 100,
      p50Ms: estimateHistogramPercentile(histogram, row.requests, 0.5),
      p95Ms: estimateHistogramPercentile(histogram, row.requests, 0.95),
      p99Ms: estimateHistogramPercentile(histogram, row.requests, 0.99),
      instances: row.instances
    };
  });
  return {
    hours: safeHours,
    instances: [...new Set(endpoints.flatMap((endpoint) => endpoint.instances))],
    requests: endpoints.reduce((sum, endpoint) => sum + endpoint.requests, 0),
    errors: endpoints.reduce((sum, endpoint) => sum + endpoint.errors, 0),
    endpoints
  };
}

async function redisMetrics() {
  const redis = await getRedisClient();
  const status = redisConnectionStatus();
  if (!redis) return { ...status, ok: false };
  let info = '';
  try {
    info = await withTimeout(redis.info());
  } catch (error) {
    return { ...redisConnectionStatus(), ok: false, error: cleanRedisError(error) };
  }
  const metrics = { ...status, ok: true, error: '' };
  for (const line of info.split('\n')) {
    const [key, value] = line.trim().split(':');
    if (!key || value === undefined) continue;
    if ([
      'redis_version',
      'connected_clients',
      'used_memory_human',
      'used_memory_peak_human',
      'total_commands_processed',
      'instantaneous_ops_per_sec',
      'keyspace_hits',
      'keyspace_misses',
      'expired_keys',
      'evicted_keys',
      'uptime_in_seconds'
    ].includes(key)) {
      metrics[key] = value;
    }
  }
  return metrics;
}

async function nginxMetrics() {
  const url = process.env.NGINX_STATUS_URL || 'http://127.0.0.1/nginx_status';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.NGINX_STATUS_TIMEOUT_MS || 500));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status };
    const text = await response.text();
    const active = Number(text.match(/Active connections:\s*(\d+)/i)?.[1] || 0);
    const accepts = text.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/m);
    const reading = Number(text.match(/Reading:\s*(\d+)/i)?.[1] || 0);
    const writing = Number(text.match(/Writing:\s*(\d+)/i)?.[1] || 0);
    const waiting = Number(text.match(/Waiting:\s*(\d+)/i)?.[1] || 0);
    return {
      ok: true,
      active,
      accepts: accepts ? Number(accepts[1]) : undefined,
      handled: accepts ? Number(accepts[2]) : undefined,
      requests: accepts ? Number(accepts[3]) : undefined,
      reading,
      writing,
      waiting
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function systemMetrics() {
  const memory = process.memoryUsage();
  const loadAverage = os.loadavg();
  const uptime = os.uptime();
  let network = null;
  try {
    const raw = await fs.readFile('/proc/net/dev', 'utf8');
    network = raw
      .split('\n')
      .slice(2)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [iface, rest = ''] = line.split(':');
        const fields = rest.trim().split(/\s+/).map(Number);
        return {
          interface: iface.trim(),
          rxBytes: fields[0],
          rxPackets: fields[1],
          txBytes: fields[8],
          txPackets: fields[9]
        };
      });
  } catch {
    network = null;
  }

  return {
    hostname: os.hostname(),
    role: service.role,
    instanceId: service.instanceId,
    uptimeSeconds: Math.round(uptime),
    loadAverage,
    cpuCount: os.cpus().length,
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
      processRss: memory.rss,
      processHeapUsed: memory.heapUsed,
      processHeapTotal: memory.heapTotal
    },
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      startedAt: new Date(startedAt).toISOString()
    },
    network
  };
}

function configureMongoSlowQueryLogging(mongoose) {
  const thresholdMs = Number(process.env.MONGO_SLOW_QUERY_MS || 250);
  if (!enabled(process.env.MONGO_SLOW_QUERY_LOGS, true)) return;
  if (mongoose.__fitlookSlowQueryLoggingInstalled) return;
  mongoose.__fitlookSlowQueryLoggingInstalled = true;

  const originalQueryExec = mongoose.Query.prototype.exec;
  mongoose.Query.prototype.exec = async function timedQueryExec(...args) {
    const started = process.hrtime.bigint();
    try {
      return await originalQueryExec.apply(this, args);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (durationMs >= thresholdMs) {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'mongo_slow_query',
          ...service,
          collection: this.mongooseCollection?.name,
          op: this.op,
          durationMs: Math.round(durationMs * 100) / 100,
          filter: this.getFilter?.(),
          options: this.getOptions?.()
        }));
      }
    }
  };

  const originalAggregateExec = mongoose.Aggregate.prototype.exec;
  mongoose.Aggregate.prototype.exec = async function timedAggregateExec(...args) {
    const started = process.hrtime.bigint();
    try {
      return await originalAggregateExec.apply(this, args);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (durationMs >= thresholdMs) {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'mongo_slow_aggregate',
          ...service,
          collection: this._model?.collection?.name,
          durationMs: Math.round(durationMs * 100) / 100,
          pipeline: this.pipeline?.()
        }));
      }
    }
  };
}

async function observabilitySnapshot({ mongoose } = {}) {
  const persistent = mongoose?.connection?.readyState === 1
    ? await persistentRequestMetrics(Number(process.env.ADMIN_METRICS_WINDOW_HOURS || 24)).catch(() => null)
    : null;
  return {
    generatedAt: new Date().toISOString(),
    requests: requestMetrics(),
    requestHistory: persistent,
    system: await systemMetrics(),
    redis: await redisMetrics(),
    nginx: await nginxMetrics(),
    mongo: {
      ok: mongoose?.connection?.readyState === 1,
      readyState: mongoose?.connection?.readyState,
      host: mongoose?.connection?.host,
      name: mongoose?.connection?.name
    }
  };
}

function prometheusEscape(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

async function prometheusMetrics({ mongoose } = {}) {
  const snapshot = await observabilitySnapshot({ mongoose });
  const lines = [
    '# HELP lookmefy_api_up Whether this API process is ready to serve requests.',
    '# TYPE lookmefy_api_up gauge',
    `lookmefy_api_up{instance="${prometheusEscape(service.instanceId)}"} ${mongoose?.connection?.readyState === 1 ? 1 : 0}`,
    '# HELP lookmefy_process_uptime_seconds Node process uptime.',
    '# TYPE lookmefy_process_uptime_seconds gauge',
    `lookmefy_process_uptime_seconds{instance="${prometheusEscape(service.instanceId)}"} ${Math.round(process.uptime())}`,
    '# HELP lookmefy_process_resident_memory_bytes Node resident memory.',
    '# TYPE lookmefy_process_resident_memory_bytes gauge',
    `lookmefy_process_resident_memory_bytes{instance="${prometheusEscape(service.instanceId)}"} ${snapshot.system.memory.processRss}`,
    '# HELP lookmefy_http_requests_total Persisted HTTP requests across API instances.',
    '# TYPE lookmefy_http_requests_total gauge'
  ];
  (snapshot.requestHistory?.endpoints || snapshot.requests).forEach((endpoint) => {
    const label = `endpoint="${prometheusEscape(endpoint.endpoint)}"`;
    lines.push(`lookmefy_http_requests_total{${label}} ${endpoint.requests}`);
    lines.push(`lookmefy_http_errors_total{${label}} ${endpoint.errors}`);
    lines.push(`lookmefy_http_request_duration_ms_avg{${label}} ${endpoint.avgMs}`);
    lines.push(`lookmefy_http_request_duration_ms_p95{${label}} ${endpoint.p95Ms}`);
  });
  if (snapshot.nginx.ok) {
    lines.push(`lookmefy_nginx_active_connections ${snapshot.nginx.active || 0}`);
    lines.push(`lookmefy_nginx_requests_total ${snapshot.nginx.requests || 0}`);
  }
  return `${lines.join('\n')}\n`;
}

export {
  configureMongoSlowQueryLogging,
  flushRequestMetrics,
  observabilitySnapshot,
  persistentRequestMetrics,
  prometheusMetrics,
  requestLogger,
  requestMetrics,
  startRequestMetricFlush
};
