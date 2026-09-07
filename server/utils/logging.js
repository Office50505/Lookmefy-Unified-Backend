import { redactSensitiveText } from './logSanitization.js';
import { serviceMetadata } from './runtime.js';

const service = serviceMetadata('api');
const pendingLokiLogs = [];
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|passcode|secret|api[_-]?key|media[_-]?token|access[_-]?token|refresh[_-]?token|token|otp|code)/i;
let lokiFlushTimer = null;
let lokiFlushPromise = null;

function enabled(value, fallback = false) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function isProduction(env = process.env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function minConsoleStatus(env = process.env) {
  const configured = Number(env.CONSOLE_LOG_MIN_STATUS || 500);
  return Number.isFinite(configured) ? configured : 500;
}

function shouldWriteConsole(log = {}, env = process.env) {
  if (!isProduction(env)) return true;
  if (log.forceConsole) return true;
  if (log.event === 'http_request') return Number(log.status || 0) >= minConsoleStatus(env);
  return ['error', 'fatal'].includes(String(log.level || '').toLowerCase());
}

function lokiEnabled(env = process.env) {
  return enabled(env.LOKI_ENABLED, false) && Boolean(String(env.LOKI_URL || '').trim());
}

function lokiUrl(env = process.env) {
  const base = String(env.LOKI_URL || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base.endsWith('/loki/api/v1/push') ? base : `${base}/loki/api/v1/push`;
}

function lokiLabels(log = {}, env = process.env) {
  return {
    app: String(env.LOKI_LABEL_APP || 'lookmefy-api'),
    service: String(log.service || service.service || 'api'),
    role: String(log.role || service.role || 'api'),
    level: String(log.level || 'info'),
    event: String(log.event || 'log')
  };
}

function cleanLogValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => cleanLogValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : cleanLogValue(item)
    ]));
  }
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return redactSensitiveText(String(value));
  }
}

function sanitizeLog(log = {}) {
  const output = {
    timestamp: new Date().toISOString(),
    ...service,
    ...log
  };
  Object.keys(output).forEach((key) => {
    output[key] = cleanLogValue(output[key]);
    if (output[key] === undefined) delete output[key];
  });
  delete output.forceConsole;
  return output;
}

function pushLokiLog(log) {
  if (!lokiEnabled()) return;
  pendingLokiLogs.push(log);
  const maxBatch = Math.max(1, Number(process.env.LOKI_BATCH_SIZE || 50));
  if (pendingLokiLogs.length >= maxBatch) {
    void flushLokiLogs();
    return;
  }
  if (!lokiFlushTimer) {
    const delay = Math.max(250, Number(process.env.LOKI_BATCH_MS || 1000));
    lokiFlushTimer = setTimeout(() => void flushLokiLogs(), delay);
    lokiFlushTimer.unref?.();
  }
}

async function flushLokiLogs() {
  if (lokiFlushPromise) return lokiFlushPromise;
  if (lokiFlushTimer) {
    clearTimeout(lokiFlushTimer);
    lokiFlushTimer = null;
  }
  if (!pendingLokiLogs.length || !lokiEnabled()) return undefined;
  const batch = pendingLokiLogs.splice(0, pendingLokiLogs.length);
  lokiFlushPromise = (async () => {
    try {
      const streams = new Map();
      batch.forEach((log) => {
        const labels = lokiLabels(log);
        const key = JSON.stringify(labels);
        const stream = streams.get(key) || { stream: labels, values: [] };
        stream.values.push([String(BigInt(Date.now()) * 1_000_000n), JSON.stringify(log)]);
        streams.set(key, stream);
      });
      const headers = { 'Content-Type': 'application/json' };
      const username = String(process.env.LOKI_USERNAME || '').trim();
      const password = String(process.env.LOKI_PASSWORD || '').trim();
      if (username || password) {
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      }
      const response = await fetch(lokiUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ streams: [...streams.values()] }),
        signal: AbortSignal.timeout(Math.max(500, Number(process.env.LOKI_TIMEOUT_MS || 1500)))
      });
      if (!response.ok && !isProduction()) {
        console.warn(JSON.stringify({ level: 'warn', event: 'loki_push_failed', status: response.status }));
      }
    } catch (error) {
      if (!isProduction()) {
        console.warn(JSON.stringify({ level: 'warn', event: 'loki_push_failed', message: error.message }));
      }
    } finally {
      lokiFlushPromise = null;
    }
  })();
  return lokiFlushPromise;
}

function emitStructuredLog(entry = {}) {
  const log = sanitizeLog(entry);
  pushLokiLog(log);
  if (shouldWriteConsole(entry)) {
    const method = ['error', 'fatal'].includes(String(log.level || '').toLowerCase()) ? 'error' : 'log';
    console[method](JSON.stringify(log));
  }
  return log;
}

export {
  emitStructuredLog,
  flushLokiLogs,
  lokiEnabled,
  sanitizeLog,
  shouldWriteConsole
};
