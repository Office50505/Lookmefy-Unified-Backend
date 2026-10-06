import { createHash } from 'node:crypto';
import { createClient } from 'redis';

let redisClient = null;
let redisClientUrl = null;
let redisConnectPromise = null;
let redisDisabledUntil = 0;
let lastRedisWarningAt = 0;

function envFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function warnRedis(message) {
  const now = Date.now();
  if (now - lastRedisWarningAt < 30_000) return;
  lastRedisWarningAt = now;
  console.warn(`[cache] ${message}`);
}

function redisTimeoutMs() {
  return Number(process.env.REDIS_TIMEOUT_MS || 250);
}

function redisBackoffMs() {
  const value = Number(process.env.REDIS_BACKOFF_MS || 60_000);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

function redisEnabled() {
  if (!process.env.REDIS_URL) return false;
  const explicit = envFlag(process.env.CACHE_REDIS_ENABLED ?? process.env.REDIS_ENABLED);
  if (explicit !== null) return explicit;
  return process.env.NODE_ENV === 'production';
}

function keyPrefix() {
  return process.env.REDIS_KEY_PREFIX || 'fitlook';
}

function withTimeout(promise, timeoutMs = redisTimeoutMs()) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Redis cache timeout')), timeoutMs);
    })
  ]);
}

async function getRedisClient() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisEnabled() || Date.now() < redisDisabledUntil) return null;
  if (redisClient?.isOpen && redisClientUrl === redisUrl) return redisClient;
  if (redisConnectPromise) return redisConnectPromise;

  redisClient = createClient({ url: redisUrl });
  redisClientUrl = redisUrl;
  redisClient.on('error', (error) => {
    redisDisabledUntil = Date.now() + redisBackoffMs();
    warnRedis(`${error.message || 'Redis cache error'}; using in-memory cache`);
    redisClient?.destroy?.();
    redisClient = null;
    redisClientUrl = null;
  });

  redisConnectPromise = withTimeout(redisClient.connect(), 1000)
    .then(() => redisClient)
    .catch((error) => {
      redisDisabledUntil = Date.now() + redisBackoffMs();
      warnRedis(`${error.message || 'Redis cache unavailable'}; using in-memory cache`);
      redisClient?.destroy?.();
      redisClient = null;
      redisClientUrl = null;
      return null;
    })
    .finally(() => {
      redisConnectPromise = null;
    });

  return redisConnectPromise;
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

  async function get(key) {
    const redisKey = await redisKeyFor(key);
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

  async function set(key, value) {
    const redisKey = await redisKeyFor(key);
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

  async function remember(key, loader) {
    const cached = await get(key);
    if (cached) return cached;
    const value = await loader();
    await set(key, value);
    return value;
  }

  async function clear() {
    localCache.clear();
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

export { createHybridCache, getRedisClient, keyPrefix, ttlSeconds, withTimeout };
