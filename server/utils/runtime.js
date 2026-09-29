import os from 'node:os';

const MONGO_OPTION_RULES = {
  MONGODB_MAX_POOL_SIZE: {
    option: 'maxPoolSize',
    defaultValue: 10,
    min: 1,
    max: 100
  },
  MONGODB_MIN_POOL_SIZE: {
    option: 'minPoolSize',
    defaultValue: 0,
    min: 0,
    max: 100
  },
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: {
    option: 'serverSelectionTimeoutMS',
    defaultValue: 5000,
    min: 500,
    max: 60000
  },
  MONGODB_CONNECT_TIMEOUT_MS: {
    option: 'connectTimeoutMS',
    defaultValue: 5000,
    min: 500,
    max: 60000
  },
  MONGODB_SOCKET_TIMEOUT_MS: {
    option: 'socketTimeoutMS',
    defaultValue: 45000,
    min: 1000,
    max: 300000
  },
  MONGODB_MAX_IDLE_TIME_MS: {
    option: 'maxIdleTimeMS',
    defaultValue: 30000,
    min: 0,
    max: 300000
  }
};

function appRole(defaultRole = 'api') {
  return String(process.env.APP_ROLE || defaultRole).trim().toLowerCase();
}

function instanceId() {
  return process.env.INSTANCE_ID || process.env.EC2_INSTANCE_ID || process.env.HOSTNAME || os.hostname();
}

function serviceMetadata(defaultRole = 'api') {
  return {
    role: appRole(defaultRole),
    hostname: os.hostname(),
    instanceId: instanceId()
  };
}

function parseMongoInteger(env, key) {
  const rule = MONGO_OPTION_RULES[key];
  const raw = String(env[key] ?? '').trim();
  if (!raw) return { key, value: rule.defaultValue, defaulted: true, valid: true };
  if (!/^-?\d+$/.test(raw)) {
    return { key, value: rule.defaultValue, defaulted: true, valid: false, reason: `${key} must be an integer.` };
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    return { key, value: rule.defaultValue, defaulted: true, valid: false, reason: `${key} must be a safe integer.` };
  }
  if (parsed < rule.min || parsed > rule.max) {
    return {
      key,
      value: Math.min(rule.max, Math.max(rule.min, parsed)),
      defaulted: false,
      valid: false,
      reason: `${key} must be between ${rule.min} and ${rule.max}.`
    };
  }
  return { key, value: parsed, defaulted: false, valid: true };
}

function mongoConnectConfig(env = process.env) {
  const parsed = Object.fromEntries(
    Object.keys(MONGO_OPTION_RULES).map((key) => [key, parseMongoInteger(env, key)])
  );
  const maxPool = parsed.MONGODB_MAX_POOL_SIZE.value;
  if (parsed.MONGODB_MIN_POOL_SIZE.value > maxPool) {
    parsed.MONGODB_MIN_POOL_SIZE = {
      ...parsed.MONGODB_MIN_POOL_SIZE,
      value: maxPool,
      valid: false,
      reason: 'MONGODB_MIN_POOL_SIZE must not exceed MONGODB_MAX_POOL_SIZE.'
    };
  }

  const options = {
    dbName: env.MONGODB_DB || 'fitlook'
  };
  for (const [key, result] of Object.entries(parsed)) {
    options[MONGO_OPTION_RULES[key].option] = result.value;
  }
  return {
    options,
    issues: Object.values(parsed).filter((result) => !result.valid).map((result) => result.reason)
  };
}

function mongoConnectOptions(env = process.env) {
  return mongoConnectConfig(env).options;
}

export {
  MONGO_OPTION_RULES,
  appRole,
  instanceId,
  mongoConnectConfig,
  mongoConnectOptions,
  serviceMetadata
};
