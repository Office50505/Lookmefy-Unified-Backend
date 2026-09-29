import { randomUUID } from 'node:crypto';
import {
  cleanRedisError,
  getRedisClient,
  keyPrefix,
  sharedStateRequiresRedis,
  sharedStateUnavailableError,
  ttlSeconds,
  withTimeout
} from './cache.js';
import { emitStructuredLog } from './logging.js';

const localStores = new Map();
let lastWarningAt = 0;

function warnOnce(message) {
  const now = Date.now();
  if (now - lastWarningAt < 30_000) return;
  lastWarningAt = now;
  emitStructuredLog({ level: 'warn', event: 'temp_session_warning', message });
}

function localStore(name) {
  if (!localStores.has(name)) localStores.set(name, new Map());
  return localStores.get(name);
}

function cleanExpiredLocalEntries(store) {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (!entry || entry.expiresAt <= now) store.delete(id);
  }
}

function createTempSessionStore(name, options = {}) {
  const configuredTtlMs = Number(options.ttlMs || 5 * 60 * 1000);
  const ttlMs = Number.isFinite(configuredTtlMs) && configuredTtlMs > 0 ? configuredTtlMs : 5 * 60 * 1000;
  const redisClientProvider = options.getRedisClient || getRedisClient;
  const store = localStore(name);

  function redisRequired() {
    return sharedStateRequiresRedis(process.env, options.requireRedis);
  }

  function redisKey(id) {
    return `${keyPrefix()}:temp:${name}:${id}`;
  }

  function handleRedisFailure(error, operation) {
    warnOnce(`${name} ${operation} failed: ${cleanRedisError(error)}`);
    if (redisRequired()) throw sharedStateUnavailableError();
    cleanExpiredLocalEntries(store);
  }

  async function redisOrFallback() {
    try {
      const redis = await redisClientProvider();
      if (redis) return redis;
      handleRedisFailure(new Error('Redis is unavailable'), 'access');
    } catch (error) {
      if (error?.code === 'SHARED_STATE_UNAVAILABLE') throw error;
      handleRedisFailure(error, 'access');
    }
    warnOnce(`${name} using local fallback; multiple workers will not share these sessions`);
    return null;
  }

  async function runRedis(operation, action) {
    const redis = await redisOrFallback();
    if (!redis) return { usedRedis: false, value: undefined };
    try {
      return { usedRedis: true, value: await withTimeout(action(redis)) };
    } catch (error) {
      handleRedisFailure(error, operation);
      return { usedRedis: false, value: undefined };
    }
  }

  async function create(value, id = randomUUID()) {
    const expiresAt = Date.now() + ttlMs;
    const payload = { ...value, expiresAt };
    const result = await runRedis('create', (redis) => redis.setEx(redisKey(id), ttlSeconds(ttlMs), JSON.stringify(payload)));
    if (result.usedRedis) store.delete(id);
    else store.set(id, payload);
    return { id, session: payload };
  }

  async function get(id) {
    if (!id) return null;
    const result = await runRedis('read', (redis) => redis.get(redisKey(id)));
    if (result.usedRedis) {
      if (!result.value) return null;
      try {
        const session = JSON.parse(result.value);
        if (session?.expiresAt > Date.now()) return session;
        await runRedis('delete expired session', (redis) => redis.del(redisKey(id)));
        return null;
      } catch (error) {
        handleRedisFailure(error, 'decode');
      }
    }
    const session = store.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      store.delete(id);
      return null;
    }
    return session;
  }

  async function set(id, value) {
    if (!id) return null;
    const expiresAt = value.expiresAt || Date.now() + ttlMs;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      await remove(id);
      return null;
    }
    const payload = { ...value, expiresAt };
    const result = await runRedis('write', (redis) => redis.setEx(redisKey(id), ttlSeconds(remainingMs), JSON.stringify(payload)));
    if (result.usedRedis) store.delete(id);
    else store.set(id, payload);
    return payload;
  }

  async function update(id, updater) {
    const current = await get(id);
    if (!current) return null;
    const next = await updater(current);
    if (!next) return null;
    return set(id, next);
  }

  async function remove(id) {
    if (!id) return;
    await runRedis('delete', (redis) => redis.del(redisKey(id)));
    store.delete(id);
  }

  async function consume(id) {
    if (!id) return null;
    const result = await runRedis('consume', (redis) => redis.getDel(redisKey(id)));
    if (result.usedRedis) {
      store.delete(id);
      if (!result.value) return null;
      try {
        const session = JSON.parse(result.value);
        return session?.expiresAt > Date.now() ? session : null;
      } catch (error) {
        handleRedisFailure(error, 'decode');
      }
    }
    const session = store.get(id);
    store.delete(id);
    return session?.expiresAt > Date.now() ? session : null;
  }

  return { create, get, set, update, remove, consume };
}

export { createTempSessionStore };
