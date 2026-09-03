import exec from 'k6/execution';
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const repoEnv = parseDotEnv(safeOpen('../../.env'));
const baseUrl = env('BASE_URL', repoEnv.PORT ? `http://localhost:${repoEnv.PORT}` : 'http://localhost:5050').replace(/\/$/, '');
const adminEmail = env('ADMIN_EMAIL', repoEnv.ADMIN_EMAIL || '');
const adminPassword = env('ADMIN_PASSWORD', repoEnv.ADMIN_PASSWORD || '');
const stageDuration = env('STAGE_DURATION', '30s');
const smokeWindow = env('SMOKE_WINDOW', '2m');
const includeExternal = envBool('INCLUDE_EXTERNAL', false);
const includeDestructiveAll = envBool('INCLUDE_DELETE_ALL_PRODUCTS', false);
const maxResponseBody = Number(env('MAX_RESPONSE_BODY', '1048576'));
const password = env('LOAD_TEST_PASSWORD', 'LoadTest!2345');
const bodyPhoto = open('../../public/assets/search-shirt-1.jpg', 'b');
const garmentPhoto = open('../../public/assets/search-shirt-2.jpg', 'b');
const loadProfile = env('LOAD_PROFILE', 'mixed').toLowerCase();

const stageTargets = parseTargets(env('TARGETS', '10,100,1000,10000'));
const stageNames = stageTargets.map((target) => `stage_${target}`);
const endpointLabels = [
  'GET /api/health',
  'GET /api/auth/username-suggestions',
  'POST /api/auth/signup/request-otp',
  'POST /api/auth/signup/verify-otp',
  'POST /api/auth/signup',
  'POST /api/auth/login',
  'POST /api/auth/admin-login',
  'GET /api/auth/me',
  'POST /api/auth/body-photo',
  'GET /api/products',
  'GET /api/products setup lookup',
  'GET /api/products?q=',
  'GET /api/products?category=',
  'GET /api/products?featured=',
  'GET /api/products/:id',
  'GET /api/products/:id missing',
  'POST /api/products',
  'POST /api/products/preview-link validation',
  'POST /api/products/recategorize',
  'PATCH /api/products/:id/tryon-model',
  'DELETE /api/products/:id cleanup',
  'DELETE /api/products all active',
  'GET /api/recommendations/similar/:productId',
  'GET /api/recommendations/similar/:productId missing',
  'GET /api/recommendations/for-you',
  'GET /api/recommendations/for-you setup lookup',
  'POST /api/recommendations/events',
  'POST /api/recommendations/events invalid',
  'GET /api/recommendations/admin/stats',
  'GET /api/tryons',
  'POST /api/tryons/:productId missing',
  'POST /api/tryons/custom validation',
  'POST /api/tryons/custom generation',
  'POST /api/tryons/external validation',
  'POST /api/tryons/external generation',
  'POST /api/tryons/:productId generation'
];
const endpointLookup = endpointLabels.reduce((acc, label) => {
  acc[endpointKey(label)] = label;
  return acc;
}, {});

export const options = {
  discardResponseBodies: false,
  maxRedirects: 2,
  thresholds: thresholdsFor(stageTargets, endpointLabels),
  scenarios: scenariosFor(stageTargets),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  userAgent: 'FitLook k6 backend load test'
};

export function setup() {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = `+919${String(Date.now()).slice(-9)}`;
  const created = { runId, phone, productId: '', userToken: '', userId: '', adminToken: '' };

  group('setup: create admin session', () => {
    if (!adminEmail || !adminPassword) return;
    const res = post('/api/auth/admin-login', { email: adminEmail, password: adminPassword }, 'POST /api/auth/admin-login', [200]);
    created.adminToken = parseJson(res).token || '';
  });

  group('setup: create reusable user', () => {
    const otpRequest = post('/api/auth/signup/request-otp', { phone }, 'POST /api/auth/signup/request-otp', [200]);
    const otpData = parseJson(otpRequest);
    const otpSession = otpData.otpSession || '';
    const otp = __ENV.LOAD_TEST_OTP || '';
    if (!otp) throw new Error('LOAD_TEST_OTP is required for load-test signup. The API no longer returns OTP values.');
    post('/api/auth/signup/verify-otp', { phone, otpSession, otp }, 'POST /api/auth/signup/verify-otp', [200]);

    const res = http.post(`${baseUrl}/api/auth/signup`, {
      name: `Load Tester ${runId}`,
      username: `load_${runId}`.replace(/[^a-z0-9_]/g, '_').slice(0, 30),
      email: `load-${runId}@fitlook.test`,
      phone,
      otpSession,
      genderPreference: 'other',
      profilePhotoMode: 'exact',
      password,
      bodyPhoto: http.file(bodyPhoto, 'body.jpg', 'image/jpeg')
    }, {
      tags: { endpoint: 'POST /api/auth/signup', endpoint_key: endpointKey('POST /api/auth/signup'), load_profile: loadProfile },
      responseType: 'text',
      timeout: '30s',
      responseCallback: expectedStatuses([201])
    });
    check(res, { 'setup signup created user': (r) => r.status === 201 }, endpointTags('POST /api/auth/signup'));
    const data = parseJson(res);
    created.userToken = data.token || '';
    created.userId = data.user && data.user.id ? data.user.id : '';
  });

  group('setup: create disposable product', () => {
    if (!created.adminToken) return;
    const payload = {
      name: `Load Test Product ${runId}`,
      brand: 'FitLook Load',
      category: 'shirts',
      gender: 'unisex',
      price: '49',
      currency: 'USD',
      rating: '4.2',
      tags: 'load,test,shirt',
      colors: 'blue',
      remoteImageUrl: 'https://example.com/load-test-shirt.jpg',
      affiliateLink: 'https://example.com/load-test-shirt',
      sourceUrl: 'https://example.com/load-test-shirt',
      isFeatured: 'true',
      isNewArrival: 'true'
    };
    const res = http.post(
      `${baseUrl}/api/products`,
      JSON.stringify(payload),
      jsonParams('POST /api/products', [201], { headers: { Authorization: `Bearer ${created.adminToken}` } })
    );
    check(res, { 'setup product created': (r) => r.status === 201 }, endpointTags('POST /api/products'));
    const data = parseJson(res);
    created.productId = data.product && data.product.id ? data.product.id : '';
  });

  return created;
}

export function smokeAllEndpoints(data) {
  const token = data.userToken;
  const productId = data.productId || firstProductId(token);
  const disposableProductId = data.productId;
  const missingId = '000000000000000000000000';

  group('public endpoints', () => {
    get('/api/health', 'GET /api/health', [200]);
    get('/api/auth/username-suggestions?name=Load%20Tester', 'GET /api/auth/username-suggestions', [200]);
    get('/api/products?limit=12', 'GET /api/products', [200]);
    get('/api/products?limit=12&q=shirt', 'GET /api/products?q=', [200]);
    get('/api/products?limit=12&category=shirts', 'GET /api/products?category=', [200]);
    if (productId) get(`/api/products/${productId}`, 'GET /api/products/:id', [200]);
    get(`/api/products/${missingId}`, 'GET /api/products/:id missing', [404]);
    if (productId) get(`/api/recommendations/similar/${productId}?limit=4`, 'GET /api/recommendations/similar/:productId', [200]);
    get(`/api/recommendations/similar/${missingId}?limit=4`, 'GET /api/recommendations/similar/:productId missing', [404]);
  });

  group('auth endpoints', () => {
    post('/api/auth/login', { email: `load-${data.runId}@fitlook.test`, password }, 'POST /api/auth/login', [200]);
    authGet('/api/auth/me', token, 'GET /api/auth/me', [200]);
    authPostMultipart('/api/auth/body-photo', token, { bodyPhoto: http.file(bodyPhoto, 'body.jpg', 'image/jpeg') }, 'POST /api/auth/body-photo', [200]);
  });

  group('recommendation endpoints', () => {
    authGet('/api/recommendations/for-you?limit=8', token, 'GET /api/recommendations/for-you', [200]);
    authPost('/api/recommendations/events', token, {
      type: 'search',
      query: 'blue shirt',
      metadata: { category: 'shirts', gender: 'unisex' }
    }, 'POST /api/recommendations/events', [201]);
    authPost('/api/recommendations/events', token, { type: 'bad_event' }, 'POST /api/recommendations/events invalid', [400]);
    if (data.adminToken) get('/api/recommendations/admin/stats', 'GET /api/recommendations/admin/stats', [200], { headers: { Authorization: `Bearer ${data.adminToken}` } });
  });

  group('try-on endpoints', () => {
    authGet('/api/tryons', token, 'GET /api/tryons', [200]);
    if (productId) authPost(`/api/tryons/${missingId}`, token, {}, 'POST /api/tryons/:productId missing', [404]);
    authPostMultipart('/api/tryons/custom', token, {}, 'POST /api/tryons/custom validation', [400]);
    authPost('/api/tryons/external', token, { product: {} }, 'POST /api/tryons/external validation', [400]);
    if (includeExternal && productId) authPost(`/api/tryons/${productId}`, token, {}, 'POST /api/tryons/:productId generation', [200, 201, 400, 402]);
    if (includeExternal) {
      authPostMultipart('/api/tryons/custom', token, {
        garment: http.file(garmentPhoto, 'garment.jpg', 'image/jpeg')
      }, 'POST /api/tryons/custom generation', [200, 201, 400, 402]);
      authPost('/api/tryons/external', token, {
        product: {
          sourceUrl: 'https://example.com/external-shirt',
          affiliateLink: 'https://example.com/external-shirt',
          imageUrl: 'https://example.com/external-shirt.jpg',
          name: 'External load test shirt',
          brand: 'FitLook Load',
          category: 'shirts',
          tags: ['shirt', 'load']
        }
      }, 'POST /api/tryons/external generation', [200, 201, 400, 402]);
    }
  });

  group('admin product endpoints', () => {
    if (!data.adminToken) return;
    post('/api/products/preview-link', { affiliateLink: '' }, 'POST /api/products/preview-link validation', [400], { headers: { Authorization: `Bearer ${data.adminToken}` } });
    post('/api/products/recategorize', {}, 'POST /api/products/recategorize', [200], { headers: { Authorization: `Bearer ${data.adminToken}` }, timeout: '60s' });
    if (disposableProductId) {
      patch(`/api/products/${disposableProductId}/tryon-model`, { tryOnModel: 'gpt-image-2' }, 'PATCH /api/products/:id/tryon-model', [200], { headers: { Authorization: `Bearer ${data.adminToken}` } });
    }
    if (includeDestructiveAll) {
      del('/api/products', 'DELETE /api/products all active', [200], { headers: { Authorization: `Bearer ${data.adminToken}` }, timeout: '60s' });
    }
  });
}

export function loadJourney(data) {
  if (loadProfile === 'read' || loadProfile === 'read-only' || loadProfile === 'catalog') {
    readJourney(data);
  } else if (loadProfile === 'auth' || loadProfile === 'authenticated') {
    authenticatedJourney(data);
  } else if (loadProfile === 'write' || loadProfile === 'events') {
    writeJourney(data);
  } else {
    mixedJourney(data);
  }

  sleep(Number(env('THINK_TIME_SECONDS', '1')));
}

function mixedJourney(data) {
  const token = data.userToken;
  const productId = data.productId;
  const roll = Math.random();

  if (roll < 0.12) {
    get('/api/health', 'GET /api/health', [200]);
  } else if (roll < 0.30) {
    get('/api/products?limit=24', 'GET /api/products', [200]);
  } else if (roll < 0.43) {
    get('/api/products?limit=24&q=shirt', 'GET /api/products?q=', [200]);
  } else if (roll < 0.54) {
    get('/api/products?limit=24&featured=true', 'GET /api/products?featured=', [200]);
  } else if (roll < 0.64 && productId) {
    get(`/api/products/${productId}`, 'GET /api/products/:id', [200]);
  } else if (roll < 0.73 && productId) {
    get(`/api/recommendations/similar/${productId}?limit=4`, 'GET /api/recommendations/similar/:productId', [200]);
  } else if (roll < 0.82) {
    authGet('/api/auth/me', token, 'GET /api/auth/me', [200]);
  } else if (roll < 0.89) {
    authGet('/api/recommendations/for-you?limit=8', token, 'GET /api/recommendations/for-you', [200]);
  } else if (roll < 0.95) {
    authGet(productId ? `/api/tryons?productIds=${productId}` : '/api/tryons', token, 'GET /api/tryons', [200]);
  } else {
    authPost('/api/recommendations/events', token, {
      type: productId ? 'product_view' : 'search',
      productId,
      query: productId ? '' : 'summer shirt',
      metadata: { source: 'k6', vu: exec.vu.idInTest }
    }, 'POST /api/recommendations/events', [201]);
  }
}

function readJourney(data) {
  const productId = data.productId;
  const roll = Math.random();

  if (roll < 0.15) {
    get('/api/health', 'GET /api/health', [200]);
  } else if (roll < 0.40) {
    get('/api/products?limit=24', 'GET /api/products', [200]);
  } else if (roll < 0.60) {
    get('/api/products?limit=24&q=shirt', 'GET /api/products?q=', [200]);
  } else if (roll < 0.75) {
    get('/api/products?limit=24&featured=true', 'GET /api/products?featured=', [200]);
  } else if (roll < 0.90 && productId) {
    get(`/api/products/${productId}`, 'GET /api/products/:id', [200]);
  } else if (productId) {
    get(`/api/recommendations/similar/${productId}?limit=4`, 'GET /api/recommendations/similar/:productId', [200]);
  } else {
    get('/api/products?limit=24', 'GET /api/products', [200]);
  }
}

function authenticatedJourney(data) {
  const token = data.userToken;
  const productId = data.productId;
  const roll = Math.random();

  if (roll < 0.20) {
    authGet('/api/auth/me', token, 'GET /api/auth/me', [200]);
  } else if (roll < 0.40) {
    authGet('/api/recommendations/for-you?limit=8', token, 'GET /api/recommendations/for-you', [200]);
  } else if (roll < 0.58) {
    authGet(productId ? `/api/tryons?productIds=${productId}` : '/api/tryons', token, 'GET /api/tryons', [200]);
  } else if (roll < 0.76) {
    get('/api/products?limit=24', 'GET /api/products', [200]);
  } else if (productId) {
    get(`/api/products/${productId}`, 'GET /api/products/:id', [200]);
  } else {
    get('/api/health', 'GET /api/health', [200]);
  }
}

function writeJourney(data) {
  const token = data.userToken;
  const productId = data.productId;
  const roll = Math.random();

  if (roll < 0.75) {
    authPost('/api/recommendations/events', token, {
      type: productId ? 'product_view' : 'search',
      productId,
      query: productId ? '' : 'summer shirt',
      metadata: { source: 'k6', profile: loadProfile, vu: exec.vu.idInTest }
    }, 'POST /api/recommendations/events', [201]);
  } else if (roll < 0.90) {
    authGet('/api/recommendations/for-you?limit=8', token, 'GET /api/recommendations/for-you', [200]);
  } else {
    authGet('/api/auth/me', token, 'GET /api/auth/me', [200]);
  }
}

export function teardown(data) {
  if (!data || !data.adminToken || !data.productId) return;
  del(`/api/products/${data.productId}`, 'DELETE /api/products/:id cleanup', [200, 404], { headers: { Authorization: `Bearer ${data.adminToken}` } });
}

export function handleSummary(summary) {
  return {
    stdout: textSummary(summary),
    'reports/load/backend-load-summary.json': JSON.stringify(summary, null, 2),
    'reports/load/backend-load-report.md': markdownSummary(summary)
  };
}

function get(path, endpoint, statuses, extra = {}) {
  const res = http.get(`${baseUrl}${path}`, requestParams(endpoint, statuses, extra));
  assertStatus(res, endpoint, statuses);
  return res;
}

function post(path, body, endpoint, statuses, extra = {}) {
  const res = http.post(`${baseUrl}${path}`, JSON.stringify(body), jsonParams(endpoint, statuses, extra));
  assertStatus(res, endpoint, statuses);
  return res;
}

function patch(path, body, endpoint, statuses, extra = {}) {
  const res = http.patch(`${baseUrl}${path}`, JSON.stringify(body), jsonParams(endpoint, statuses, extra));
  assertStatus(res, endpoint, statuses);
  return res;
}

function del(path, endpoint, statuses, extra = {}) {
  const res = http.del(`${baseUrl}${path}`, null, requestParams(endpoint, statuses, extra));
  assertStatus(res, endpoint, statuses);
  return res;
}

function authGet(path, token, endpoint, statuses, extra = {}) {
  const res = http.get(`${baseUrl}${path}`, authParams(token, endpoint, statuses, extra));
  assertStatus(res, endpoint, statuses);
  return res;
}

function authPost(path, token, body, endpoint, statuses, extra = {}) {
  const params = authParams(token, endpoint, statuses, extra);
  params.headers = Object.assign({}, params.headers, { 'Content-Type': 'application/json' });
  const res = http.post(`${baseUrl}${path}`, JSON.stringify(body), params);
  assertStatus(res, endpoint, statuses);
  return res;
}

function authPostMultipart(path, token, body, endpoint, statuses, extra = {}) {
  const res = http.post(`${baseUrl}${path}`, body, authParams(token, endpoint, statuses, extra));
  assertStatus(res, endpoint, statuses);
  return res;
}

function requestParams(endpoint, statuses, extra = {}) {
  return Object.assign(
    {
      tags: endpointTags(endpoint),
      responseType: 'text',
      timeout: '30s',
      responseCallback: expectedStatuses(statuses)
    },
    extra
  );
}

function jsonParams(endpoint, statuses, extra = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra.headers || {});
  return Object.assign(requestParams(endpoint, statuses, extra), { headers });
}

function authParams(token, endpoint, statuses, extra = {}) {
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, extra.headers || {});
  return Object.assign(requestParams(endpoint, statuses, extra), { headers });
}

function expectedStatuses(statuses) {
  return http.expectedStatuses.apply(null, statuses);
}

function assertStatus(res, endpoint, statuses) {
  check(res, {
    [`${endpoint} returned ${statuses.join('/')}`]: (r) => statuses.indexOf(r.status) !== -1,
    [`${endpoint} body bounded`]: (r) => !r.body || r.body.length <= maxResponseBody
  }, endpointTags(endpoint));
}

function firstProductId(token) {
  const res = get('/api/products?limit=1', 'GET /api/products setup lookup', [200]);
  const body = parseJson(res);
  if (body.products && body.products[0] && body.products[0].id) return body.products[0].id;
  if (token) {
    const fallback = authGet('/api/recommendations/for-you?limit=1', token, 'GET /api/recommendations/for-you setup lookup', [200]);
    const data = parseJson(fallback);
    if (data.products && data.products[0] && data.products[0].id) return data.products[0].id;
  }
  return '';
}

function parseJson(res) {
  try {
    return JSON.parse(res.body || '{}');
  } catch (_error) {
    return {};
  }
}

function safeOpen(path) {
  try {
    return open(path);
  } catch (_error) {
    return '';
  }
}

function parseDotEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    out[key] = value;
  });
  return out;
}

function env(name, fallback) {
  return __ENV[name] !== undefined && __ENV[name] !== '' ? __ENV[name] : fallback;
}

function envBool(name, fallback) {
  const value = env(name, fallback ? 'true' : 'false');
  return ['1', 'true', 'yes', 'on'].indexOf(String(value).toLowerCase()) !== -1;
}

function parseTargets(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function thresholdsFor(targets, endpoints) {
  const thresholds = {
    checks: ['rate>0.95'],
    http_req_failed: ['rate<0.10']
  };
  targets.forEach((target) => {
    const limit = target <= 10 ? 1500 : target <= 100 ? 2500 : target <= 1000 ? 5000 : 10000;
    thresholds[`http_req_duration{scenario:stage_${target}}`] = [`p(95)<${limit}`];
    thresholds[`http_reqs{scenario:stage_${target}}`] = ['count>=0'];
    thresholds[`http_req_failed{scenario:stage_${target}}`] = ['rate>=0'];
    thresholds[`checks{scenario:stage_${target}}`] = ['rate>=0'];
  });
  endpoints.forEach((endpoint) => {
    const key = endpointKey(endpoint);
    thresholds[`http_req_duration{endpoint_key:${key}}`] = ['p(95)>=0'];
    thresholds[`http_reqs{endpoint_key:${key}}`] = ['count>=0'];
    thresholds[`http_req_failed{endpoint_key:${key}}`] = ['rate>=0'];
    thresholds[`checks{endpoint_key:${key}}`] = ['rate>=0'];
  });
  return thresholds;
}

function scenariosFor(targets) {
  const scenarios = {
    smoke_all_endpoints: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: smokeWindow,
      exec: 'smokeAllEndpoints',
      tags: { test_type: 'endpoint_coverage' }
    }
  };
  targets.forEach((target, index) => {
    const elapsedStages = [];
    for (let i = 0; i < index; i += 1) elapsedStages.push(stageDuration);
    scenarios[`stage_${target}`] = {
      executor: 'constant-vus',
      vus: target,
      duration: stageDuration,
      startTime: addDurations(smokeWindow, ...elapsedStages),
      exec: 'loadJourney',
      tags: { user_stage: String(target) }
    };
  });
  return scenarios;
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === 'ms') return n / 1000;
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  return 0;
}

function formatDuration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function addDurations() {
  let seconds = 0;
  for (let i = 0; i < arguments.length; i += 1) seconds += parseDuration(arguments[i]);
  return formatDuration(seconds);
}

function metricValue(summary, name, field) {
  const metric = summary.metrics[name];
  if (!metric || metric.values === undefined) return null;
  return metric.values[field] !== undefined ? metric.values[field] : null;
}

function subMetric(summary, base, tagValue, field) {
  const key = `${base}{scenario:${tagValue}}`;
  return metricValue(summary, key, field);
}

function taggedMetric(summary, base, tag, value, field) {
  const key = `${base}{${tag}:${value}}`;
  return metricValue(summary, key, field);
}

function endpointKey(endpoint) {
  return String(endpoint || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function endpointTags(endpoint) {
  return { endpoint, endpoint_key: endpointKey(endpoint), load_profile: loadProfile };
}

function fmt(value, suffix = '') {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number') return `${Math.round(value * 100) / 100}${suffix}`;
  return `${value}${suffix}`;
}

function textSummary(summary) {
  const lines = ['FitLook backend load test summary', `Base URL: ${baseUrl}`, ''];
  lines.push(`Load profile: ${loadProfile}`);
  lines.push('');
  stageNames.forEach((stage) => {
    lines.push(`${stage.replace('stage_', '')} VUs: p95=${fmt(subMetric(summary, 'http_req_duration', stage, 'p(95)'), 'ms')} failed=${fmt(subMetric(summary, 'http_req_failed', stage, 'rate'))}`);
  });
  lines.push('');
  lines.push('Slowest endpoints by p95:');
  endpointRows(summary)
    .slice(0, 5)
    .forEach((row) => lines.push(`${row.endpoint}: p95=${fmt(row.p95, 'ms')} failed=${fmt(row.failureRate)} requests=${fmt(row.requests)}`));
  lines.push('');
  lines.push(`Overall checks: ${fmt(metricValue(summary, 'checks', 'rate'))}`);
  lines.push(`Overall request failure rate: ${fmt(metricValue(summary, 'http_req_failed', 'rate'))}`);
  return `${lines.join('\n')}\n`;
}

function markdownSummary(summary) {
  const now = new Date().toISOString();
  const rows = stageNames.map((stage) => {
    const users = stage.replace('stage_', '');
    return [
      users,
      fmt(subMetric(summary, 'http_reqs', stage, 'count')),
      fmt(subMetric(summary, 'http_req_duration', stage, 'avg'), ' ms'),
      fmt(subMetric(summary, 'http_req_duration', stage, 'p(90)'), ' ms'),
      fmt(subMetric(summary, 'http_req_duration', stage, 'p(95)'), ' ms'),
      fmt(subMetric(summary, 'http_req_duration', stage, 'p(99)'), ' ms'),
      fmt(subMetric(summary, 'http_req_failed', stage, 'rate')),
      fmt(subMetric(summary, 'checks', stage, 'rate'))
    ];
  });
  const endpointsByLatency = endpointRows(summary);
  const endpointsByFailure = endpointRows(summary)
    .filter((row) => row.failureRate !== null && row.failureRate > 0)
    .sort((a, b) => b.failureRate - a.failureRate || b.requests - a.requests);
  return [
    '# FitLook Backend Load Test Report',
    '',
    `Generated: ${now}`,
    `Base URL: ${baseUrl}`,
    `Load profile: ${loadProfile}`,
    `Stage duration: ${stageDuration}`,
    `External/paid generation enabled: ${includeExternal}`,
    `Global product delete enabled: ${includeDestructiveAll}`,
    '',
    '## Stage Results',
    '',
    '| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Overall',
    '',
    `- Requests: ${fmt(metricValue(summary, 'http_reqs', 'count'))}`,
    `- Request rate: ${fmt(metricValue(summary, 'http_reqs', 'rate'), ' req/s')}`,
    `- HTTP failure rate: ${fmt(metricValue(summary, 'http_req_failed', 'rate'))}`,
    `- Check pass rate: ${fmt(metricValue(summary, 'checks', 'rate'))}`,
    `- p95 latency: ${fmt(metricValue(summary, 'http_req_duration', 'p(95)'), ' ms')}`,
    '',
    '## Slowest Endpoints',
    '',
    '| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...endpointsByLatency.slice(0, 15).map(endpointTableRow),
    '',
    '## Highest Failure Endpoints',
    '',
    '| Endpoint | Requests | Avg latency | p95 latency | Failure rate | Check pass rate |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...(endpointsByFailure.length ? endpointsByFailure.slice(0, 15).map(failureTableRow) : ['| None recorded | n/a | n/a | n/a | n/a | n/a |']),
    '',
    '## Endpoint Coverage Notes',
    '',
    '- Smoke coverage runs before the staged load and exercises public, authenticated, recommendation, try-on, and admin product routes.',
    '- `LOAD_PROFILE=mixed` keeps the existing blended user journey. Use `LOAD_PROFILE=read`, `LOAD_PROFILE=auth`, or `LOAD_PROFILE=write` to isolate catalog reads, authenticated browsing, or event-write pressure.',
    '- Endpoint tables are emitted from the `endpoint_key` k6 tag, so failures can be traced to route families instead of only scenario stages.',
    '- By default, paid/external AI generation endpoints are validation-tested to avoid spending FAL credits or hammering remote services.',
    '- `DELETE /api/products` is disabled by default because it soft-deletes the active catalog. Enable it only with `INCLUDE_DELETE_ALL_PRODUCTS=true` in an isolated database.',
    '',
    '## Artifacts',
    '',
    '- Raw k6 summary: `reports/load/backend-load-summary.json`',
    '- This report: `reports/load/backend-load-report.md`',
    ''
  ].join('\n');
}

function endpointRows(summary) {
  return Object.keys(endpointLookup).map((key) => {
    const requests = taggedMetric(summary, 'http_reqs', 'endpoint_key', key, 'count');
    return {
      key,
      endpoint: endpointLookup[key],
      requests,
      avg: taggedMetric(summary, 'http_req_duration', 'endpoint_key', key, 'avg'),
      p90: taggedMetric(summary, 'http_req_duration', 'endpoint_key', key, 'p(90)'),
      p95: taggedMetric(summary, 'http_req_duration', 'endpoint_key', key, 'p(95)'),
      p99: taggedMetric(summary, 'http_req_duration', 'endpoint_key', key, 'p(99)'),
      failureRate: taggedMetric(summary, 'http_req_failed', 'endpoint_key', key, 'rate'),
      checkRate: taggedMetric(summary, 'checks', 'endpoint_key', key, 'rate')
    };
  })
    .filter((row) => row.requests !== null && row.requests > 0)
    .sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
}

function endpointTableRow(row) {
  return `| ${row.endpoint} | ${fmt(row.requests)} | ${fmt(row.avg, ' ms')} | ${fmt(row.p90, ' ms')} | ${fmt(row.p95, ' ms')} | ${fmt(row.p99, ' ms')} | ${fmt(row.failureRate)} | ${fmt(row.checkRate)} |`;
}

function failureTableRow(row) {
  return `| ${row.endpoint} | ${fmt(row.requests)} | ${fmt(row.avg, ' ms')} | ${fmt(row.p95, ' ms')} | ${fmt(row.failureRate)} | ${fmt(row.checkRate)} |`;
}
