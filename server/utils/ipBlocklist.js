import net from 'node:net';
import BlockedIp from '../models/BlockedIp.js';
import { emitStructuredLog } from './logging.js';
import { clientIp } from './rateLimit.js';

let cache = { loadedAt: 0, rules: [] };

function normalizeIpRule(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (net.isIP(raw)) return raw;
  const cidr = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/);
  if (!cidr || net.isIP(cidr[1]) !== 4) return '';
  return `${cidr[1]}/${Number(cidr[2])}`;
}

function ipv4ToNumber(address) {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(address, rule) {
  const [base, bitsText] = rule.split('/');
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function ipMatchesRule(ip = '', rule = '') {
  const normalizedIp = normalizeIpRule(ip);
  const normalizedRule = normalizeIpRule(rule);
  if (!normalizedIp || !normalizedRule) return false;
  if (normalizedRule.includes('/')) return net.isIP(normalizedIp) === 4 && inCidr4(normalizedIp, normalizedRule);
  return normalizedIp === normalizedRule;
}

function blocklistEnabled(env = process.env) {
  const raw = String(env.IP_BLOCKLIST_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

async function loadRules() {
  const ttlMs = Math.max(1000, Number(process.env.IP_BLOCKLIST_CACHE_MS || 30_000));
  if (Date.now() - cache.loadedAt < ttlMs) return cache.rules;
  if (BlockedIp.db?.readyState !== 1) return cache.rules;
  const now = new Date();
  const rows = await BlockedIp.find({
    active: true,
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }]
  }).select('value reason source expiresAt').lean();
  cache = {
    loadedAt: Date.now(),
    rules: rows.map((row) => ({ ...row, value: normalizeIpRule(row.value) })).filter((row) => row.value)
  };
  return cache.rules;
}

function clearIpBlocklistCache() {
  cache = { loadedAt: 0, rules: [] };
}

async function createBlockedIp({ value, reason = '', source = 'manual', expiresAt, createdBy } = {}) {
  const normalized = normalizeIpRule(value);
  if (!normalized) throw new Error('Blocked IP must be an IP address or IPv4 CIDR');
  const doc = await BlockedIp.findOneAndUpdate(
    { value: normalized },
    {
      $set: {
        value: normalized,
        reason: String(reason || '').trim().slice(0, 300),
        source: ['manual', 'auto', 'system'].includes(source) ? source : 'manual',
        active: true,
        expiresAt: expiresAt || undefined,
        createdBy: createdBy || undefined
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  clearIpBlocklistCache();
  return doc;
}

function blockedIpToClient(row = {}) {
  return {
    id: row._id?.toString?.(),
    value: row.value,
    reason: row.reason || '',
    source: row.source,
    active: Boolean(row.active),
    expiresAt: row.expiresAt || null,
    matchCount: Number(row.matchCount || 0),
    lastMatchedAt: row.lastMatchedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function ipBlocklistMiddleware() {
  return async function blocklistedIp(req, res, next) {
    if (!blocklistEnabled()) return next();
    try {
      const ip = clientIp(req);
      const rules = await loadRules();
      const match = rules.find((rule) => ipMatchesRule(ip, rule.value));
      if (!match) return next();
      void BlockedIp.updateOne({ _id: match._id }, { $inc: { matchCount: 1 }, $set: { lastMatchedAt: new Date() } }).catch(() => {});
      emitStructuredLog({
        level: 'warn',
        event: 'ip_blocked',
        requestId: req.requestId,
        ip,
        rule: match.value,
        source: match.source,
        path: req.path,
        method: req.method
      });
      return res.status(403).json({ code: 'IP_BLOCKED', message: 'This network is blocked.' });
    } catch (error) {
      emitStructuredLog({ level: 'warn', event: 'ip_blocklist_failed', message: error.message });
      return next();
    }
  };
}

export {
  blockedIpToClient,
  clearIpBlocklistCache,
  createBlockedIp,
  ipBlocklistMiddleware,
  ipMatchesRule,
  normalizeIpRule
};
