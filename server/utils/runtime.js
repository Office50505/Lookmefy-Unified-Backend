import os from 'node:os';

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

function mongoConnectOptions() {
  const maxPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE || 10);
  const minPoolSize = Number(process.env.MONGODB_MIN_POOL_SIZE || 0);
  return {
    dbName: process.env.MONGODB_DB || 'fitlook',
    maxPoolSize: Number.isFinite(maxPoolSize) && maxPoolSize > 0 ? maxPoolSize : 10,
    minPoolSize: Number.isFinite(minPoolSize) && minPoolSize >= 0 ? minPoolSize : 0
  };
}

export { appRole, instanceId, mongoConnectOptions, serviceMetadata };
