import { randomUUID } from 'node:crypto';

const serviceName = process.env.SERVICE_NAME || 'lookmefy-api';
const sensitiveKeyPattern = /password|token|secret|authorization|cookie|otp|signature|signed|client[_-]?secret/i;
const sensitiveQueryPattern = /([?&](?:mediaToken|token|access_token|refresh_token|otp|code|password|client_secret|authorization|sig|signature)=)[^&#\s"']+/gi;
const sensitiveHeaderPattern = /\b(Bearer|Key)\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(sensitiveQueryPattern, '$1[redacted]')
    .replace(sensitiveHeaderPattern, '$1 [redacted]');
}

function clean(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: process.env.NODE_ENV === 'production' ? undefined : redactString(value.stack)
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
  if (!value || typeof value !== 'object') return redactString(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (sensitiveKeyPattern.test(key)) return [key, '[redacted]'];
    return [key, clean(entry, depth + 1)];
  }));
}

function log(level, event, meta = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    env: process.env.NODE_ENV || 'development',
    event,
    ...clean(meta)
  };
  const output = JSON.stringify(line);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

const logger = {
  child(defaults = {}) {
    return {
      info(event, meta = {}) {
        log('info', event, { ...defaults, ...meta });
      },
      warn(event, meta = {}) {
        log('warn', event, { ...defaults, ...meta });
      },
      error(event, meta = {}) {
        log('error', event, { ...defaults, ...meta });
      }
    };
  },
  info(event, meta = {}) {
    log('info', event, meta);
  },
  warn(event, meta = {}) {
    log('warn', event, meta);
  },
  error(event, meta = {}) {
    log('error', event, meta);
  }
};

function requestId() {
  return randomUUID();
}

export { logger, redactString, requestId };
