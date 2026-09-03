import { createHash } from 'node:crypto';
import { createClient } from 'redis';

let redisClient = null;
let redisClientUrl = null;
let redisConnectPromise = null;
let redisDisabledUntil = 0;
let lastRedisWarningAt = 0;
let lastRedisStatus = {
  configured: false,
  ok: false,
  target: '',
  error: '',
  checkedAt: null,
  disabledUntil: null
};

function warnRedis(message) {
  const now = Date.now();
  if (now - lastRedisWarningAt < 30_000) return;
  lastRedisWarningAt = now;
  console.warn(`[cache] ${message}`);
}

function redisTimeoutMs() {
  return Number(process.env.REDIS_TIMEOUT_MS || 250);
}

function redisConnectTimeoutMs() {
  const configured = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 1000);
  return Number.isFinite(configured) && configured > 0 ? configured : 1000;
}

function keyPrefix() {
  return process.env.REDIS_KEY_PREFIX || 'fitlook';
}

function redisTargetLabel(redisUrl = process.env.REDIS_URL) {
  const raw = String(redisUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const port = url.port || (url.protocol === 'rediss:' ? '6380' : '6379');
    const database = url.pathname && url.pathname !== '/' ? url.pathname : '';
    return `${url.protocol}//${url.hostname}:${port}${database}`;
  } catch {
    return '[invalid REDIS_URL]';
  }
}

function cleanRedisError(error) {
  const raw = String(error?.message || error || 'Redis cache unavailable');
  const configuredUrl = String(process.env.REDIS_URL || '');
  const withoutInlineCredentials = raw
    .replace(/rediss?:\/\/[^@\s]+@/gi, (match) => `${match.split('://')[0]}://[redacted]@`)
    .replace(/\s+/g, ' ')
    .trim();
  return (configuredUrl ? withoutInlineCredentials.replace(configuredUrl, '[redacted REDIS_URL]') : withoutInlineCredentials)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function rememberRedisStatus(status = {}) {
  lastRedisStatus = {
    configured: Boolean(process.env.REDIS_URL),
    ok: false,
    target: redisTargetLabel(),
    error: '',
    checkedAt: new Date().toISOString(),
    disabledUntil: redisDisabledUntil > Date.now() ? new Date(redisDisabledUntil).toISOString() : null,
    ...status
  };
  return lastRedisStatus;
}

function redisConnectionStatus() {
  return {
    ...lastRedisStatus,
    configured: Boolean(process.env.REDIS_URL),
    target: redisTargetLabel(),
    disabledForMs: Math.max(0, redisDisabledUntil - Date.now())
  };
}

function withTimeout(promise, timeoutMs = redisTimeoutMs()) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Redis cache timeout')), timeoutMs);
    })
  ]);
}

function destroyRedisClientQuietly(client) {
  try {
    client?.destroy?.();
  } catch {
    // The Redis client can already be closed after a failed connect attempt.
  }
}

async function getRedisClient() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    rememberRedisStatus({ configured: false, ok: false, target: '', error: 'REDIS_URL is not configured' });
    return null;
  }
  if (Date.now() < redisDisabledUntil) {
    rememberRedisStatus({
      ok: false,
      error: lastRedisStatus.error || 'Redis reconnect cooldown is active',
      disabledUntil: new Date(redisDisabledUntil).toISOString()
    });
    return null;
  }
  if (redisClient?.isOpen && redisClientUrl === redisUrl) {
    rememberRedisStatus({ ok: true, error: '', disabledUntil: null });
    return redisClient;
  }
  if (redisConnectPromise) return redisConnectPromise;

  rememberRedisStatus({ ok: false, error: 'Connecting to Redis' });
  redisClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: redisConnectTimeoutMs(),
      reconnectStrategy: false
    }
  });
  redisClientUrl = redisUrl;
  redisClient.on('error', (error) => {
    const message = cleanRedisError(error);
    rememberRedisStatus({ ok: false, error: message });
    warnRedis(message || 'Redis cache error');
  });

  redisConnectPromise = withTimeout(redisClient.connect(), redisConnectTimeoutMs() + 250)
    .then(() => {
      rememberRedisStatus({ ok: true, error: '', disabledUntil: null });
      return redisClient;
    })
    .catch((error) => {
      redisDisabledUntil = Date.now() + 10_000;
      const message = cleanRedisError(error);
      rememberRedisStatus({
        ok: false,
        error: message,
        disabledUntil: new Date(redisDisabledUntil).toISOString()
      });
      warnRedis(message || 'Redis cache unavailable');
      destroyRedisClientQuietly(redisClient);
      redisClient = null;
      redisClientUrl = null;
      return null;
    })
    .finally(() => {
      redisConnectPromise = null;
    });

  return redisConnectPromise;
}

async function closeRedisClient() {
  const client = redisClient;
  redisConnectPromise = null;
  redisDisabledUntil = 0;
  redisClient = null;
  redisClientUrl = null;
  if (!client) return;
  try {
    if (client.isOpen) await client.quit();
    else destroyRedisClientQuietly(client);
  } catch {
    destroyRedisClientQuietly(client);
  }
}

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function ttlSeconds(ttlMs) {
  const parsed = Number(ttlMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.max(1, Math.ceil(parsed / 1000));
}

function getLocalCacheEntry(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setLocalCacheEntry(cache, key, value, ttlMs, maxItems) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > maxItems) cache.delete(cache.keys().next().value);
  return value;
}

function createHybridCache(name, options = {}) {
  const localCache = new Map();
  const inFlightLoads = new Map();
  const ttlMs = Number(options.ttlMs || 30_000);
  const maxItems = Number(options.maxItems || 150);
  let localVersion = 0;

  function namespace() {
    return `${keyPrefix()}:${name}`;
  }

  function versionKey() {
    return `${namespace()}:version`;
  }

  async function currentVersion() {
    const redis = await getRedisClient();
    if (!redis) return localVersion;
    try {
      return (await withTimeout(redis.get(versionKey()))) || '0';
    } catch (error) {
      warnRedis(error.message || 'Redis cache version unavailable');
      return localVersion;
    }
  }

  async function redisKeyFor(key) {
    return `${namespace()}:v${await currentVersion()}:${stableHash(key)}`;
  }

  async function getByRedisKey(redisKey) {
    const redis = await getRedisClient();
    if (redis) {
      try {
        const cached = await withTimeout(redis.get(redisKey));
        if (cached) return JSON.parse(cached);
      } catch (error) {
        warnRedis(error.message || 'Redis cache read failed');
      }
    }
    return getLocalCacheEntry(localCache, redisKey);
  }

  async function setByRedisKey(redisKey, value) {
    setLocalCacheEntry(localCache, redisKey, value, ttlMs, maxItems);
    const redis = await getRedisClient();
    if (redis) {
      try {
        await withTimeout(redis.setEx(redisKey, ttlSeconds(ttlMs), JSON.stringify(value)));
      } catch (error) {
        warnRedis(error.message || 'Redis cache write failed');
      }
    }
    return value;
  }

  async function get(key) {
    return getByRedisKey(await redisKeyFor(key));
  }

  async function set(key, value) {
    return setByRedisKey(await redisKeyFor(key), value);
  }

  async function remember(key, loader) {
    const redisKey = await redisKeyFor(key);
    const cached = await getByRedisKey(redisKey);
    if (cached !== null) return cached;
    if (inFlightLoads.has(redisKey)) return inFlightLoads.get(redisKey);

    const loadPromise = Promise.resolve()
      .then(loader)
      .then(async (value) => setByRedisKey(redisKey, value))
      .finally(() => {
        inFlightLoads.delete(redisKey);
      });
    inFlightLoads.set(redisKey, loadPromise);
    return loadPromise;
  }

  async function clear() {
    localCache.clear();
    inFlightLoads.clear();
    localVersion += 1;
    const redis = await getRedisClient();
    if (redis) {
      try {
        await withTimeout(redis.incr(versionKey()));
      } catch (error) {
        warnRedis(error.message || 'Redis cache invalidation failed');
      }
    }
  }

  return { get, set, remember, clear };
}

export {
  cleanRedisError,
  closeRedisClient,
  createHybridCache,
  getRedisClient,
  keyPrefix,
  redisConnectionStatus,
  redisTargetLabel,
  ttlSeconds,
  withTimeout
};
