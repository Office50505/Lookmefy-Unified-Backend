import { randomUUID } from 'node:crypto';
import { getRedisClient, keyPrefix, ttlSeconds, withTimeout } from './cache.js';

const localStores = new Map();
let lastWarningAt = 0;

function warnOnce(message) {
  const now = Date.now();
  if (now - lastWarningAt < 30_000) return;
  lastWarningAt = now;
  console.warn(`[temp-session] ${message}`);
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

function shouldRequireRedis() {
  const explicit = String(process.env.TEMP_SESSION_REQUIRE_REDIS || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  if (['0', 'false', 'no', 'off'].includes(explicit)) return false;
  return false;
}

function createTempSessionStore(name, options = {}) {
  const ttlMs = Number(options.ttlMs || 5 * 60 * 1000);
  const store = localStore(name);

  function redisKey(id) {
    return `${keyPrefix()}:temp:${name}:${id}`;
  }

  async function redisOrFallback() {
    const redis = await getRedisClient();
    if (redis) return redis;
    if (shouldRequireRedis()) {
      throw new Error('Redis is required for temporary sessions');
    }
    warnOnce(`${name} using local fallback; multiple workers will not share these sessions`);
    cleanExpiredLocalEntries(store);
    return null;
  }

  async function create(value, id = randomUUID()) {
    const expiresAt = Date.now() + ttlMs;
    const payload = { ...value, expiresAt };
    const redis = await redisOrFallback();
    if (redis) {
      await withTimeout(redis.setEx(redisKey(id), ttlSeconds(ttlMs), JSON.stringify(payload)));
    } else {
      store.set(id, payload);
    }
    return { id, session: payload };
  }

  async function get(id) {
    if (!id) return null;
    const redis = await redisOrFallback();
    if (redis) {
      const raw = await withTimeout(redis.get(redisKey(id)));
      return raw ? JSON.parse(raw) : null;
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
    const redis = await redisOrFallback();
    if (redis) {
      await withTimeout(redis.setEx(redisKey(id), ttlSeconds(remainingMs), JSON.stringify(payload)));
    } else {
      store.set(id, payload);
    }
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
    const redis = await getRedisClient();
    if (redis) {
      await withTimeout(redis.del(redisKey(id))).catch((error) => warnOnce(error.message || `${name} delete failed`));
      return;
    }
    store.delete(id);
  }

  async function consume(id) {
    if (!id) return null;
    const redis = await redisOrFallback();
    if (redis) {
      const raw = await withTimeout(redis.getDel(redisKey(id)));
      if (!raw) return null;
      const session = JSON.parse(raw);
      return session?.expiresAt > Date.now() ? session : null;
    }
    const session = store.get(id);
    store.delete(id);
    return session?.expiresAt > Date.now() ? session : null;
  }

  return { create, get, set, update, remove, consume };
}

export { createTempSessionStore };
