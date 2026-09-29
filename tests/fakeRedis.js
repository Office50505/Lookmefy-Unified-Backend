function createFakeRedisServer(startedAt = Date.now()) {
  const values = new Map();
  const expirations = new Map();
  let now = startedAt;

  function expireIfNeeded(key) {
    const expiresAt = expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= now) {
      values.delete(key);
      expirations.delete(key);
    }
  }

  function createClient() {
    return {
      isOpen: true,
      async get(key) {
        expireIfNeeded(key);
        return values.has(key) ? values.get(key) : null;
      },
      async setEx(key, seconds, value) {
        values.set(key, String(value));
        expirations.set(key, now + (Number(seconds) * 1000));
        return 'OK';
      },
      async del(key) {
        const existed = values.delete(key);
        expirations.delete(key);
        return existed ? 1 : 0;
      },
      async getDel(key) {
        expireIfNeeded(key);
        const value = values.has(key) ? values.get(key) : null;
        values.delete(key);
        expirations.delete(key);
        return value;
      },
      async incr(key) {
        expireIfNeeded(key);
        const value = Number(values.get(key) || 0) + 1;
        values.set(key, String(value));
        return value;
      },
      async expire(key, seconds) {
        expireIfNeeded(key);
        if (!values.has(key)) return 0;
        expirations.set(key, now + (Number(seconds) * 1000));
        return 1;
      },
      async ttl(key) {
        expireIfNeeded(key);
        if (!values.has(key)) return -2;
        if (!expirations.has(key)) return -1;
        return Math.max(0, Math.ceil((expirations.get(key) - now) / 1000));
      }
    };
  }

  return {
    createClient,
    advanceBy(milliseconds) {
      now += Number(milliseconds);
    },
    keys() {
      for (const key of values.keys()) expireIfNeeded(key);
      return [...values.keys()];
    }
  };
}

export { createFakeRedisServer };
