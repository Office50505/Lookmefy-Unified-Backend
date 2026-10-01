import assert from 'node:assert/strict';
import test from 'node:test';
import BlockedIp from '../server/models/BlockedIp.js';
import { ipBlocklistMiddleware } from '../server/utils/ipBlocklist.js';
import { recordViolation, securityFilterMiddleware } from '../server/utils/securityFilters.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('two logical API instances see block and unblock without a local allow window', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  const previousDb = BlockedIp.db;
  const previousFind = BlockedIp.find;
  const previousUpdate = BlockedIp.updateOne;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    BlockedIp.db = previousDb;
    BlockedIp.find = previousFind;
    BlockedIp.updateOne = previousUpdate;
  });
  process.env.NODE_ENV = 'production';
  BlockedIp.db = { readyState: 1 };
  BlockedIp.updateOne = async () => ({});
  let rows = [];
  BlockedIp.find = () => ({ select: () => ({ lean: async () => rows }) });
  const instanceA = ipBlocklistMiddleware();
  const instanceB = ipBlocklistMiddleware();
  const req = { ip: '203.0.113.12', path: '/api/products', method: 'GET', get: () => '' };
  async function call(instance) {
    const res = response();
    let allowed = false;
    await instance(req, res, () => { allowed = true; });
    return { allowed, statusCode: res.statusCode };
  }
  assert.equal((await call(instanceA)).allowed, true);
  rows = [{ _id: 'block-1', value: '203.0.113.12', active: true }];
  assert.equal((await call(instanceB)).statusCode, 403);
  assert.equal((await call(instanceA)).statusCode, 403);
  rows = [];
  assert.equal((await call(instanceB)).allowed, true);
  BlockedIp.db.readyState = 0;
  assert.equal((await call(instanceA)).statusCode, 503);
});

test('automatic scanner threshold is shared across two logical instances', async () => {
  const counts = new Map();
  const sharedRedis = {
    async eval(_script, { keys }) {
      const next = (counts.get(keys[0]) || 0) + 1;
      counts.set(keys[0], next);
      return next;
    }
  };
  const env = { NODE_ENV: 'production', SECURITY_AUTO_BLOCK_THRESHOLD: '3' };
  const instanceA = (ip) => recordViolation(ip, { code: 'SCANNER_PATH' }, { env, redisClientProvider: async () => sharedRedis });
  const instanceB = (ip) => recordViolation(ip, { code: 'SCANNER_PATH' }, { env, redisClientProvider: async () => sharedRedis });
  assert.equal((await instanceA('203.0.113.15')).shouldAutoBlock, false);
  assert.equal((await instanceB('203.0.113.15')).shouldAutoBlock, false);
  assert.deepEqual(
    { count: (await instanceA('203.0.113.15')).count, blocked: (await instanceB('203.0.113.15')).shouldAutoBlock },
    { count: 3, blocked: true }
  );
  assert.equal((await instanceB('203.0.113.16')).count, 1);
  await assert.rejects(recordViolation('203.0.113.15', {}, { env, redisClientProvider: async () => null }), { code: 'SHARED_STATE_UNAVAILABLE' });
});

test('automatic block response waits until the shared IP rule is saved', async (t) => {
  const previousEnv = new Map(['NODE_ENV', 'SECURITY_AUTO_BLOCK_THRESHOLD'].map((key) => [key, process.env[key]]));
  const previousDb = BlockedIp.db;
  const previousUpdate = BlockedIp.findOneAndUpdate;
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    BlockedIp.db = previousDb;
    BlockedIp.findOneAndUpdate = previousUpdate;
  });
  process.env.NODE_ENV = 'test';
  process.env.SECURITY_AUTO_BLOCK_THRESHOLD = '2';
  BlockedIp.db = { readyState: 1 };
  let releaseSave;
  const saved = new Promise((resolve) => { releaseSave = resolve; });
  BlockedIp.findOneAndUpdate = async () => {
    await saved;
    return { _id: 'saved-block' };
  };
  const middleware = securityFilterMiddleware();
  const req = { ip: '203.0.113.217', originalUrl: '/.env', method: 'GET', path: '/.env', get: () => '' };
  await middleware(req, response(), () => {});
  const res = response();
  let finished = false;
  const pending = middleware(req, res, () => {}).then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  releaseSave();
  await pending;
  assert.equal(res.statusCode, 403);
});
