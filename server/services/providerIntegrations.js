import crypto from 'node:crypto';
import { listBunnyDirectory } from '../utils/storage.js';

const responseCache = new Map();
let atlasTokenCache = null;
let awsCredentialCache = null;

function configured(keys) {
  return keys.every((key) => Boolean(String(process.env[key] || '').trim()));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function monthPeriod() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { start, end };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.message || body?.error || text.slice(0, 200) || `HTTP ${response.status}`;
    throw Object.assign(new Error(String(message)), { statusCode: response.status });
  }
  return body;
}

async function cached(key, ttlMs, loader) {
  const current = responseCache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = await loader();
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectUsageRows(value, rows = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUsageRows(item, rows));
    return rows;
  }
  if (!value || typeof value !== 'object') return rows;
  if ('cost' in value && ('endpoint_id' in value || 'model' in value || 'quantity' in value)) rows.push(value);
  Object.values(value).forEach((item) => collectUsageRows(item, rows));
  return rows;
}

function collectPricingRows(value, rows = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPricingRows(item, rows));
    return rows;
  }
  if (!value || typeof value !== 'object') return rows;
  if (['price', 'unit_price', 'cost'].some((field) => Number.isFinite(Number(value[field])))) rows.push(value);
  Object.values(value).forEach((item) => collectPricingRows(item, rows));
  return rows;
}

async function falModelCostEstimate({ endpointId, duration = 1 } = {}) {
  const manual = Number(process.env.PIXVERSE_VIDEO_COST_USD);
  const fallback = Number.isFinite(manual) && manual >= 0 ? manual : 0;
  if (!configured(['FAL_KEY']) || !endpointId) return { cost: fallback, source: fallback ? 'manual' : 'unavailable' };
  try {
    const body = await cached(`fal-pricing:${endpointId}`, 6 * 60 * 60_000, () => fetchJson(
      `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpointId)}`,
      { headers: { Authorization: `Key ${String(process.env.FAL_KEY).trim()}` } },
      Number(process.env.PROVIDER_API_TIMEOUT_MS || 8000)
    ));
    const row = collectPricingRows(body).find((item) => !item.endpoint_id || item.endpoint_id === endpointId);
    if (!row) return { cost: fallback, source: fallback ? 'manual' : 'unavailable' };
    const unitPrice = numeric(row.price ?? row.unit_price ?? row.cost);
    const unit = String(row.unit || row.billing_unit || row.metric || '').toLowerCase();
    const quantity = unit.includes('second') ? Math.max(1, numeric(duration)) : 1;
    return { cost: unitPrice * quantity, source: 'fal_pricing', unit, unitPrice, quantity };
  } catch {
    return { cost: fallback, source: fallback ? 'manual' : 'unavailable' };
  }
}

async function falUsage() {
  if (!configured(['FAL_ADMIN_KEY'])) return { configured: false, reason: 'FAL_ADMIN_KEY is missing' };
  return cached('fal-usage', 5 * 60_000, async () => {
    const period = monthPeriod();
    const params = new URLSearchParams({
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      timeframe: 'day'
    });
    params.append('expand', 'time_series');
    params.append('expand', 'summary');
    const body = await fetchJson(`https://api.fal.ai/v1/models/usage?${params.toString()}`, {
      headers: { Authorization: `Key ${String(process.env.FAL_ADMIN_KEY).trim()}` }
    }, Number(process.env.PROVIDER_API_TIMEOUT_MS || 8000));
    const unique = new Map();
    collectUsageRows(body).forEach((row) => {
      const key = JSON.stringify([row.endpoint_id, row.model, row.date, row.timestamp, row.quantity, row.cost]);
      unique.set(key, row);
    });
    const rows = [...unique.values()];
    const byModel = new Map();
    rows.forEach((row) => {
      const model = String(row.endpoint_id || row.model || 'unknown');
      const current = byModel.get(model) || { label: model, requests: 0, cost: 0 };
      current.requests += numeric(row.quantity || row.requests || row.count);
      current.cost += numeric(row.cost || row.amount);
      byModel.set(model, current);
    });
    const spend = [...byModel.values()].reduce((sum, row) => sum + row.cost, 0);
    return {
      configured: true,
      spend,
      currency: rows.find((row) => row.currency)?.currency || 'USD',
      breakdown: [...byModel.values()].sort((left, right) => right.cost - left.cost),
      rawSummary: body?.summary || null,
      period
    };
  });
}

async function falProbe() {
  if (!configured(['FAL_KEY'])) return { configured: false, healthy: false, detail: 'FAL_KEY is missing.' };
  const endpointId = String(process.env.FAL_TRYON_VIDEO_MODEL || '').trim();
  if (!endpointId) return { configured: true, healthy: false, detail: 'FAL_TRYON_VIDEO_MODEL is missing.' };
  try {
    await cached(`fal-probe:${endpointId}`, 2 * 60_000, () => fetchJson(
      `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpointId)}`,
      { headers: { Authorization: `Key ${String(process.env.FAL_KEY).trim()}` } },
      Number(process.env.PROVIDER_HEALTH_TIMEOUT_MS || 5000)
    ));
    return { configured: true, healthy: true, detail: `${endpointId} pricing endpoint responded.` };
  } catch (error) {
    return { configured: true, healthy: false, detail: `FAL probe failed: ${error.message}` };
  }
}

async function bunnyStatistics() {
  if (!configured(['BUNNY_ACCOUNT_API_KEY'])) return { configured: false, reason: 'BUNNY_ACCOUNT_API_KEY is missing' };
  return cached('bunny-statistics', 5 * 60_000, async () => {
    const period = monthPeriod();
    const params = new URLSearchParams({
      dateFrom: isoDate(period.start),
      dateTo: isoDate(period.end),
      loadBandwidthUsed: 'true',
      loadRequestsServed: 'true',
      loadCacheHitRate: 'true',
      loadUserBalanceHistory: 'true'
    });
    const body = await fetchJson(`https://api.bunny.net/statistics?${params.toString()}`, {
      headers: { AccessKey: String(process.env.BUNNY_ACCOUNT_API_KEY).trim(), accept: 'application/json' }
    }, Number(process.env.PROVIDER_API_TIMEOUT_MS || 8000));
    const balanceHistory = body?.UserBalanceHistoryChart || body?.userBalanceHistoryChart || {};
    const balanceValues = Array.isArray(balanceHistory)
      ? balanceHistory.map((item) => numeric(item?.Value ?? item?.value))
      : Object.values(balanceHistory || {}).map(numeric);
    return {
      configured: true,
      bandwidthBytes: numeric(body?.TotalBandwidthUsed ?? body?.totalBandwidthUsed),
      requests: numeric(body?.TotalRequestsServed ?? body?.totalRequestsServed),
      cacheHitRate: numeric(body?.CacheHitRate ?? body?.cacheHitRate),
      balance: balanceValues.length ? balanceValues[balanceValues.length - 1] : null,
      period
    };
  });
}

async function bunnyProbe() {
  if (!configured(['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_API_KEY'])) {
    return { configured: false, healthy: false, detail: 'Bunny storage credentials are incomplete.' };
  }
  try {
    await cached('bunny-probe', 2 * 60_000, () => listBunnyDirectory(''));
    return { configured: true, healthy: true, detail: 'Bunny Storage API responded.' };
  } catch (error) {
    return { configured: true, healthy: false, detail: `Bunny probe failed: ${error.message}` };
  }
}

async function atlasAccessToken() {
  if (atlasTokenCache && atlasTokenCache.expiresAt > Date.now() + 60_000) return atlasTokenCache.token;
  const clientId = String(process.env.MONGODB_ATLAS_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.MONGODB_ATLAS_CLIENT_SECRET || '').trim();
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const response = await fetchJson('https://cloud.mongodb.com/api/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  }, Number(process.env.PROVIDER_API_TIMEOUT_MS || 8000));
  atlasTokenCache = {
    token: response.access_token,
    expiresAt: Date.now() + Math.max(60, numeric(response.expires_in || 3600)) * 1000
  };
  return atlasTokenCache.token;
}

async function atlasBilling() {
  if (!configured(['MONGODB_ATLAS_CLIENT_ID', 'MONGODB_ATLAS_CLIENT_SECRET', 'MONGODB_ATLAS_ORG_ID'])) {
    return { configured: false, reason: 'MongoDB Atlas billing credentials are incomplete' };
  }
  return cached('atlas-billing', 10 * 60_000, async () => {
    const token = await atlasAccessToken();
    const orgId = String(process.env.MONGODB_ATLAS_ORG_ID).trim();
    const body = await fetchJson(`https://cloud.mongodb.com/api/atlas/v2/orgs/${encodeURIComponent(orgId)}/invoices/pending`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/vnd.atlas.2025-03-12+json' }
    }, Number(process.env.PROVIDER_API_TIMEOUT_MS || 8000));
    const invoices = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
    const totalCents = invoices.reduce((sum, invoice) => sum + numeric(
      invoice.totalBilledCents ?? invoice.subtotalCents ?? invoice.amountBilledCents
    ), 0);
    return {
      configured: true,
      spend: totalCents / 100,
      currency: invoices[0]?.currency || 'USD',
      invoices: invoices.map((invoice) => ({
        label: invoice.id || invoice.invoiceId || 'Pending invoice',
        status: invoice.status || 'pending',
        cost: numeric(invoice.totalBilledCents ?? invoice.subtotalCents ?? invoice.amountBilledCents) / 100
      }))
    };
  });
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

async function ec2Credentials() {
  const tokenResponse = await fetchWithTimeout('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' }
  }, 1000);
  if (!tokenResponse.ok) throw new Error('EC2 metadata token was unavailable');
  const token = await tokenResponse.text();
  const headers = { 'X-aws-ec2-metadata-token': token };
  const roleResponse = await fetchWithTimeout('http://169.254.169.254/latest/meta-data/iam/security-credentials/', { headers }, 1000);
  if (!roleResponse.ok) throw new Error('No EC2 instance role is attached');
  const role = (await roleResponse.text()).trim();
  if (!role) throw new Error('EC2 instance role name was unavailable');
  const credentials = await fetchJson(`http://169.254.169.254/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers }, 1000);
  if (!credentials?.AccessKeyId || !credentials?.SecretAccessKey || !credentials?.Token || !credentials?.Expiration) {
    throw new Error('EC2 instance role credentials were incomplete');
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.Token,
    expiresAt: new Date(credentials.Expiration).getTime()
  };
}

async function awsCredentials() {
  if (awsCredentialCache && awsCredentialCache.expiresAt > Date.now() + 5 * 60_000) return awsCredentialCache;
  try {
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const profile = String(process.env.AWS_PROFILE || '').trim();
    const credentials = await defaultProvider(profile ? { profile } : {})();
    awsCredentialCache = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken || '',
      expiresAt: credentials.expiration?.getTime?.() || Date.now() + 60 * 60_000
    };
    return awsCredentialCache;
  } catch (error) {
    if (process.env.AWS_PROFILE) {
      throw new Error(`AWS profile credentials were unavailable: ${error.message}`);
    }
  }
  awsCredentialCache = await ec2Credentials();
  return awsCredentialCache;
}

function awsCostCacheMs(env = process.env) {
  const fallback = 6 * 60 * 60_000;
  const requested = Number(env.AWS_COST_CACHE_MS);
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(Math.max(Math.round(requested), 15 * 60_000), 24 * 60 * 60_000);
}

async function collectAwsCostPages(loadPage, period, maxPages = 100) {
  const services = new Map();
  const seenTokens = new Set();
  let spend = 0;
  let estimated = false;
  let nextPageToken = '';

  for (let page = 0; page < maxPages; page += 1) {
    const body = await loadPage(nextPageToken);
    (body?.ResultsByTime || []).forEach((result) => {
      estimated ||= Boolean(result.Estimated);
      (result.Groups || []).forEach((group) => {
        const amount = numeric(group.Metrics?.UnblendedCost?.Amount);
        const label = group.Keys?.[0] || 'Other';
        spend += amount;
        services.set(label, (services.get(label) || 0) + amount);
      });
    });

    const token = String(body?.NextPageToken || '').trim();
    if (!token) {
      return {
        configured: true,
        spend,
        estimated,
        breakdown: [...services.entries()]
          .map(([label, cost]) => ({ label, cost }))
          .sort((left, right) => right.cost - left.cost),
        period
      };
    }
    if (seenTokens.has(token)) throw new Error('AWS Cost Explorer returned a repeated page token');
    seenTokens.add(token);
    nextPageToken = token;
  }

  throw new Error(`AWS Cost Explorer exceeded ${maxPages} response pages`);
}

async function awsCostExplorer() {
  if (!['1', 'true', 'yes', 'on'].includes(String(process.env.AWS_COST_EXPLORER_ENABLED || '').toLowerCase())) {
    return { configured: false, reason: 'AWS_COST_EXPLORER_ENABLED is not enabled' };
  }
  return cached('aws-cost-explorer', awsCostCacheMs(), async () => {
    const credentials = await awsCredentials();
    const period = monthPeriod();
    const region = 'us-east-1';
    const host = 'ce.us-east-1.amazonaws.com';
    const target = 'AWSInsightsIndexService.GetCostAndUsage';

    return collectAwsCostPages(async (nextPageToken) => {
      const request = {
        TimePeriod: { Start: isoDate(period.start), End: isoDate(period.end) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
      };
      if (nextPageToken) request.NextPageToken = nextPageToken;
      const payload = JSON.stringify(request);
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const headers = {
        'content-type': 'application/x-amz-json-1.1',
        host,
        'x-amz-date': amzDate,
        'x-amz-target': target
      };
      if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
      const signedHeaderNames = Object.keys(headers).sort();
      const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
      const signedHeaders = signedHeaderNames.join(';');
      const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n');
      const scope = `${dateStamp}/${region}/ce/aws4_request`;
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
      const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
      const regionKey = hmac(dateKey, region);
      const serviceKey = hmac(regionKey, 'ce');
      const signingKey = hmac(serviceKey, 'aws4_request');
      const signature = hmac(signingKey, stringToSign, 'hex');
      headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      return fetchJson(`https://${host}/`, { method: 'POST', headers, body: payload }, Number(process.env.PROVIDER_API_TIMEOUT_MS || 8000));
    }, period);
  });
}

async function prunaProbe() {
  if (!configured(['PRUNA_API_KEY'])) return { configured: false, healthy: false, detail: 'PRUNA_API_KEY is missing.' };
  const explicitUrl = String(process.env.PRUNA_HEALTH_URL || '').trim();
  if (!explicitUrl) return { configured: true, healthy: null, detail: 'Pruna is configured; set PRUNA_HEALTH_URL for an active probe.' };
  try {
    await cached('pruna-probe', 2 * 60_000, async () => {
      const response = await fetchWithTimeout(explicitUrl, {
        method: 'GET',
        headers: { apikey: String(process.env.PRUNA_API_KEY).trim() }
      }, Number(process.env.PROVIDER_HEALTH_TIMEOUT_MS || 5000));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    });
    return { configured: true, healthy: true, detail: 'Pruna health endpoint responded.' };
  } catch (error) {
    return { configured: true, healthy: false, detail: `Pruna probe failed: ${error.message}` };
  }
}

export {
  atlasBilling,
  awsCostCacheMs,
  awsCostExplorer,
  bunnyProbe,
  bunnyStatistics,
  collectAwsCostPages,
  falProbe,
  falModelCostEstimate,
  falUsage,
  prunaProbe
};
