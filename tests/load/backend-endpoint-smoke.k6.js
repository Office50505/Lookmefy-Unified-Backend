import http from 'k6/http';
import { check, group } from 'k6';
import { Counter } from 'k6/metrics';

const repoEnv = parseDotEnv(safeOpen('../../.env'));
const baseUrl = env('BASE_URL', repoEnv.PORT ? `http://localhost:${repoEnv.PORT}` : 'http://localhost:5050').replace(/\/$/, '');
const maxResponseBody = Number(env('MAX_RESPONSE_BODY', '1048576'));
const statusCodes = ['0', '200', '201', '202', '204', '301', '302', '304', '400', '401', '403', '404', '409', '413', '422', '429', '500', '502', '503', 'other'];
const statusCounters = statusCodes.reduce((acc, status) => {
  acc[status] = new Counter(`endpoint_status_${status}`);
  return acc;
}, {});

const objectId = '000000000000000000000000';
const endpoints = withUniqueKeys([
  endpoint('GET', '/api/health', [200], 'core'),
  endpoint('GET', '/api/health/live', [200], 'core'),
  endpoint('GET', '/api/health/ready', [200, 503], 'core'),
  endpoint('GET', '/api/admin/metrics', [401], 'admin'),
  endpoint('GET', '/api/metrics/prometheus', [401, 404], 'core'),

  endpoint('POST', '/api/auth/otp/send', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/otp/verify', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/signup/request-otp', [400, 429], 'auth', {}),
  endpoint('GET', '/api/auth/test-otp?purpose=signup', [400, 404], 'auth'),
  endpoint('POST', '/api/auth/signup/verify-otp', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/signup/cancel-otp', [200, 400, 404, 429], 'auth', {}),
  endpoint('POST', '/api/auth/signup/complete', [400, 401], 'auth', {}),
  endpoint('POST', '/api/auth/signup', [400, 401], 'auth', {}),
  endpoint('GET', '/api/auth/username-suggestions?name=Load%20Tester', [200], 'auth'),
  endpoint('POST', '/api/auth/login', [400, 401], 'auth', {}),
  endpoint('POST', '/api/auth/login/request-otp', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/login/verify-otp', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/session/heartbeat', [401], 'auth'),
  endpoint('POST', '/api/auth/logout', [401], 'auth'),
  endpoint('POST', '/api/auth/login/cancel-otp', [200, 400, 404, 429], 'auth', {}),
  endpoint('POST', '/api/auth/password-reset/request-otp', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/password-reset/verify-otp', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/password-reset/cancel-otp', [200, 400, 404, 429], 'auth', {}),
  endpoint('POST', '/api/auth/password-reset', [400, 429], 'auth', {}),
  endpoint('POST', '/api/auth/password/reset', [400, 401, 429], 'auth', {}),
  endpoint('POST', '/api/auth/admin-request-access', [400], 'auth', {}),
  endpoint('POST', '/api/auth/admin-login', [400, 401], 'auth', {}),
  endpoint('GET', '/api/auth/admin-session', [401], 'auth'),
  endpoint('GET', '/api/auth/admin/users?limit=1', [401], 'auth-admin'),
  endpoint('GET', '/api/auth/admin/search?q=test', [401], 'auth-admin'),
  endpoint('GET', `/api/auth/admin/users/${objectId}/insights`, [401], 'auth-admin'),
  endpoint('GET', `/api/auth/admin/users/${objectId}/media`, [401], 'auth-admin'),
  endpoint('GET', '/api/auth/admin/storage', [401], 'auth-admin'),
  endpoint('GET', '/api/auth/admin/storage/reconciliation', [401], 'auth-admin'),
  endpoint('DELETE', '/api/auth/admin/storage/orphans', [401], 'auth-admin'),
  endpoint('GET', '/api/auth/admin/operations', [401], 'auth-admin'),
  endpoint('GET', '/api/auth/admin/orders', [401], 'auth-admin'),
  endpoint('GET', '/api/auth/admin/audit-log', [401], 'auth-admin'),
  endpoint('PATCH', `/api/auth/admin/users/${objectId}/tokens`, [401], 'auth-admin', {}),
  endpoint('PATCH', `/api/auth/admin/users/${objectId}/status`, [401], 'auth-admin', {}),
  endpoint('DELETE', `/api/auth/admin/users/${objectId}`, [401], 'auth-admin'),
  endpoint('GET', '/api/auth/me', [401], 'auth-user'),
  endpoint('GET', '/api/auth/media-token', [401], 'auth-user'),
  endpoint('GET', `/api/auth/media/avatar/${objectId}`, [401], 'auth-media'),
  endpoint('PATCH', '/api/auth/profile', [401], 'auth-user', {}),
  endpoint('PATCH', '/api/auth/avatar-crop', [401], 'auth-user', {}),
  endpoint('DELETE', '/api/auth/me', [401], 'auth-user'),
  endpoint('PATCH', '/api/auth/onboarding', [401], 'auth-user', {}),
  endpoint('GET', '/api/auth/wishlist', [401], 'auth-user'),
  endpoint('POST', '/api/auth/wishlist/sync', [401], 'auth-user', {}),
  endpoint('PUT', `/api/auth/wishlist/${objectId}`, [401], 'auth-user', {}),
  endpoint('DELETE', `/api/auth/wishlist/${objectId}`, [401], 'auth-user'),
  endpoint('PATCH', '/api/auth/dev-mode', [401], 'auth-user', {}),
  endpoint('POST', '/api/auth/body-photo', [401], 'auth-user', {}),
  endpoint('POST', '/api/auth/body-photo/generate-full-body', [401], 'auth-user', {}),

  endpoint('GET', '/api/products?limit=1', [200], 'products'),
  endpoint('GET', '/api/products/admin/catalog?limit=1', [401], 'products-admin'),
  endpoint('POST', '/api/products/amazon-search', [401], 'products-user', {}),
  endpoint('POST', '/api/products/smart-import', [401], 'products-admin', {}),
  endpoint('POST', '/api/products/recategorize', [401], 'products-admin', {}),
  endpoint('GET', `/api/products/${objectId}`, [404], 'products'),
  endpoint('POST', '/api/products/preview-link', [401], 'products-admin', {}),
  endpoint('POST', '/api/products', [401], 'products-admin', {}),
  endpoint('PATCH', '/api/products/admin/inventory', [401], 'products-admin', {}),
  endpoint('PATCH', `/api/products/${objectId}`, [401], 'products-admin', {}),
  endpoint('PATCH', `/api/products/${objectId}/garment-placement`, [401], 'products-admin', {}),
  endpoint('PATCH', `/api/products/${objectId}/tryon-model`, [401], 'products-admin', {}),
  endpoint('DELETE', '/api/products', [401], 'products-admin'),
  endpoint('DELETE', `/api/products/${objectId}/permanent`, [401], 'products-admin'),
  endpoint('DELETE', `/api/products/${objectId}`, [401], 'products-admin'),

  endpoint('POST', '/api/recommendations/events', [401], 'recommendations-user', {}),
  endpoint('POST', '/api/recommendations/events/batch', [401], 'recommendations-user', {}),
  endpoint('GET', '/api/recommendations/recent-searches', [401], 'recommendations-user'),
  endpoint('POST', '/api/recommendations/studio-chat', [401], 'recommendations-user', {}),
  endpoint('POST', '/api/recommendations/stylist-chat', [401], 'recommendations-user', {}),
  endpoint('GET', '/api/recommendations/admin/stats', [401], 'recommendations-admin'),
  endpoint('GET', '/api/recommendations/for-you?limit=1', [401], 'recommendations-user'),
  endpoint('GET', `/api/recommendations/similar/${objectId}?limit=1`, [404], 'recommendations'),

  endpoint('GET', `/api/closet/media/item/${objectId}`, [401], 'closet-media'),
  endpoint('GET', '/api/closet', [401], 'closet-user'),
  endpoint('POST', '/api/closet/items/analyze', [401], 'closet-user', {}),
  endpoint('POST', '/api/closet/items', [401], 'closet-user', {}),
  endpoint('PATCH', `/api/closet/items/${objectId}`, [401], 'closet-user', {}),
  endpoint('DELETE', `/api/closet/items/${objectId}`, [401], 'closet-user'),
  endpoint('POST', '/api/closet/suggest', [401], 'closet-user', {}),
  endpoint('POST', '/api/closet/chat', [401], 'closet-user', {}),
  endpoint('POST', '/api/closet/outfits/generate', [401], 'closet-user', {}),
  endpoint('PATCH', `/api/closet/outfits/${objectId}`, [401], 'closet-user', {}),

  endpoint('GET', '/api/tryons', [401], 'tryons-user'),
  endpoint('GET', '/api/tryons/history', [401], 'tryons-user'),
  endpoint('GET', '/api/tryons/credit-history', [401], 'tryons-user'),
  endpoint('GET', '/api/tryons/custom/latest', [401], 'tryons-user'),
  endpoint('GET', `/api/tryons/image/product/${objectId}`, [401], 'tryons-media'),
  endpoint('GET', `/api/tryons/video/product/${objectId}`, [401], 'tryons-media'),
  endpoint('GET', `/api/tryons/garment/custom/${objectId}`, [401], 'tryons-media'),
  endpoint('GET', `/api/tryons/${objectId}/video/media`, [401], 'tryons-media'),
  endpoint('POST', '/api/tryons/custom', [401], 'tryons-user', {}),
  endpoint('POST', '/api/tryons/external', [401], 'tryons-user', {}),
  endpoint('POST', `/api/tryons/${objectId}/video`, [401], 'tryons-user', {}),
  endpoint('POST', `/api/tryons/${objectId}`, [401], 'tryons-user', {}),

  endpoint('GET', `/api/jobs/${objectId}`, [401], 'jobs-user'),
  endpoint('GET', `/api/jobs/tryon/${objectId}`, [401], 'jobs-user'),

  endpoint('POST', '/api/images/subject-isolation', [401], 'images-user', {}),

  endpoint('GET', '/api/payments/plans', [200], 'payments'),
  endpoint('GET', '/api/payments/credits/history', [401], 'payments-user'),
  endpoint('GET', '/api/payments/apple/config', [401], 'payments-user'),
  endpoint('POST', '/api/payments/apple/transactions', [401], 'payments-user', {}),
  endpoint('POST', '/api/payments/apple/restore', [401], 'payments-user', {}),
  endpoint('GET', '/api/payments/apple/status', [401], 'payments-user'),
  endpoint('POST', '/api/payments/apple/notifications', [400], 'payments-public', {}),
  endpoint('POST', '/api/payments/checkout', [401], 'payments-user', {}),
  endpoint('POST', '/api/payments/phonepe/top-up', [401], 'payments-user', {}),
  endpoint('POST', '/api/payments/phonepe/subscription', [401], 'payments-user', {}),
  endpoint('POST', '/api/payments/razorpay/verify', [401], 'payments-user', {}),
  endpoint('GET', '/api/payments/orders/load-test/status', [401], 'payments-user'),
  endpoint('GET', '/api/payments/subscriptions/current/status', [401], 'payments-user'),
  endpoint('POST', '/api/payments/subscriptions/current/cancel', [401], 'payments-user', {}),
  endpoint('POST', '/api/payments/phonepe/callback', [401, 503], 'payments-public', {}),

  endpoint('GET', '/api/storefront/config', [200], 'storefront'),

  endpoint('GET', '/api/orders/pincode/110001', [200, 400], 'orders-public'),
  endpoint('POST', '/api/orders', [401], 'orders-user', {}),
  endpoint('GET', `/api/orders/${objectId}`, [401], 'orders-user'),
  endpoint('POST', `/api/orders/${objectId}/payment`, [401], 'orders-user', {}),
  endpoint('POST', `/api/orders/${objectId}/demo-success`, [401], 'orders-user', {}),
  endpoint('GET', `/api/orders/${objectId}/payment-status`, [401], 'orders-user'),
  endpoint('POST', '/api/orders/phonepe/callback', [401, 503], 'orders-public', {}),
  endpoint('GET', '/api/orders/admin/list', [401], 'orders-admin'),
  endpoint('PATCH', `/api/orders/admin/${objectId}/status`, [401], 'orders-admin', {}),

  endpoint('GET', '/api/admin/roles', [401], 'admin'),
  endpoint('PATCH', `/api/admin/roles/${objectId}`, [401], 'admin', {}),
  endpoint('POST', `/api/admin/roles/${objectId}/revoke-sessions`, [401], 'admin', {}),
  endpoint('GET', '/api/admin/storefront-settings', [401], 'admin'),
  endpoint('PATCH', '/api/admin/storefront-settings/demo-mode', [401], 'admin', {}),
  endpoint('GET', '/api/admin/system/summary', [401], 'admin'),
  endpoint('GET', '/api/admin/system/incidents', [401], 'admin'),
  endpoint('PATCH', `/api/admin/system/incidents/${objectId}`, [401], 'admin', {}),
  endpoint('GET', '/api/admin/system/generations', [401], 'admin'),
  endpoint('GET', '/api/admin/system/mobile/ios', [401], 'admin'),
  endpoint('GET', '/api/admin/costs/summary', [401], 'admin'),
  endpoint('GET', '/api/admin/costs/pruna', [401], 'admin')
]);

const endpointLookup = endpoints.reduce((acc, item) => {
  acc[item.key] = item;
  return acc;
}, {});

export const options = {
  discardResponseBodies: false,
  scenarios: {
    endpoint_smoke: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: env('SMOKE_WINDOW', '2m')
    }
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.05'],
    ...endpointThresholds(endpoints)
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  userAgent: 'Lookmefy k6 endpoint smoke'
};

export default function () {
  groupedEndpoints().forEach(([family, items]) => {
    group(family, () => {
      items.forEach(requestEndpoint);
    });
  });
}

export function handleSummary(summary) {
  return {
    stdout: textSummary(summary),
    'reports/load/backend-endpoint-smoke-summary.json': JSON.stringify(summary, null, 2),
    'reports/load/backend-endpoint-smoke-report.md': markdownSummary(summary)
  };
}

function endpoint(method, path, statuses, family, body = null) {
  const label = `${method} ${routeLabel(path)}`;
  return {
    method,
    path,
    statuses,
    family,
    body,
    key: endpointKey(label),
    label
  };
}

function withUniqueKeys(items) {
  return items.map((item, index) => ({
    ...item,
    key: `e${String(index + 1).padStart(3, '0')}_${item.key}`
  }));
}

function requestEndpoint(item) {
  const params = {
    tags: { endpoint_key: item.key, family: item.family },
    responseType: 'text',
    timeout: '30s',
    responseCallback: http.expectedStatuses.apply(null, item.statuses)
  };
  if (item.body !== null && item.body !== undefined) {
    params.headers = { 'Content-Type': 'application/json' };
  }

  const url = `${baseUrl}${item.path}`;
  const body = item.body !== null && item.body !== undefined ? JSON.stringify(item.body) : null;
  const res = item.method === 'GET'
    ? http.get(url, params)
    : item.method === 'POST'
      ? http.post(url, body, params)
      : item.method === 'PATCH'
        ? http.patch(url, body, params)
        : item.method === 'PUT'
          ? http.put(url, body, params)
          : http.del(url, body, params);

  const status = String(res.status || '0');
  const counter = statusCounters[status] || statusCounters.other;
  counter.add(1, { endpoint_key: item.key });
  check(res, {
    [`${item.label} returned ${item.statuses.join('/')}`]: (r) => item.statuses.indexOf(r.status) !== -1,
    [`${item.label} body bounded`]: (r) => !r.body || r.body.length <= maxResponseBody,
    [`${item.label} no 5xx`]: (r) => r.status < 500 || item.statuses.indexOf(r.status) !== -1
  }, { endpoint_key: item.key, family: item.family });
}

function groupedEndpoints() {
  const groups = [];
  const seen = {};
  endpoints.forEach((item) => {
    if (!seen[item.family]) {
      seen[item.family] = [];
      groups.push([item.family, seen[item.family]]);
    }
    seen[item.family].push(item);
  });
  return groups;
}

function textSummary(summary) {
  const rows = endpointRows(summary);
  const failed = rows.filter((row) => row.checkRate !== null && row.checkRate < 1);
  const lines = [
    'Lookmefy endpoint smoke summary',
    `Base URL: ${baseUrl}`,
    `Endpoints requested: ${endpoints.length}`,
    `Checks: ${fmt(metricValue(summary, 'checks', 'rate'))}`,
    `HTTP failure rate: ${fmt(metricValue(summary, 'http_req_failed', 'rate'))}`,
    ''
  ];

  if (failed.length) {
    lines.push('Endpoints needing attention:');
    failed.forEach((row) => lines.push(`${row.endpoint}: statuses=${row.statuses || 'n/a'} checks=${fmt(row.checkRate)}`));
  } else {
    lines.push('All endpoint checks passed.');
  }

  lines.push('');
  lines.push('Slowest endpoints by p95:');
  rows.slice(0, 8).forEach((row) => lines.push(`${row.endpoint}: p95=${fmt(row.p95, ' ms')} statuses=${row.statuses || 'n/a'}`));
  return `${lines.join('\n')}\n`;
}

function markdownSummary(summary) {
  const now = new Date().toISOString();
  const rows = endpointRows(summary);
  const failed = rows.filter((row) => row.checkRate !== null && row.checkRate < 1);
  return [
    '# Lookmefy Endpoint Smoke Report',
    '',
    `Generated: ${now}`,
    `Base URL: ${baseUrl}`,
    `Endpoints requested: ${endpoints.length}`,
    '',
    '## Result',
    '',
    `- Check pass rate: ${fmt(metricValue(summary, 'checks', 'rate'))}`,
    `- HTTP failure rate: ${fmt(metricValue(summary, 'http_req_failed', 'rate'))}`,
    `- Failed endpoint checks: ${failed.length}`,
    '',
    '## Endpoint Results',
    '',
    '| Endpoint | Family | Expected | Seen statuses | Requests | Avg latency | p95 latency | Check pass rate |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...rows
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map((row) => `| ${row.endpoint} | ${row.family} | ${row.expected} | ${row.statuses || 'n/a'} | ${fmt(row.requests)} | ${fmt(row.avg, ' ms')} | ${fmt(row.p95, ' ms')} | ${fmt(row.checkRate)} |`),
    '',
    '## Slowest Endpoints',
    '',
    '| Endpoint | Family | Seen statuses | p95 latency | p99 latency |',
    '| --- | --- | --- | ---: | ---: |',
    ...endpointRows(summary)
      .slice(0, 10)
      .map((row) => `| ${row.endpoint} | ${row.family} | ${row.statuses || 'n/a'} | ${fmt(row.p95, ' ms')} | ${fmt(row.p99, ' ms')} |`),
    '',
    '## Notes',
    '',
    '- This smoke intentionally avoids authenticated success paths unless separate tokens are supplied in a future extension.',
    '- Protected routes are considered covered when their auth/admin guard returns the expected `401`.',
    '- Public mutation callbacks use empty payloads and accept the configured guard response only.',
    ''
  ].join('\n');
}

function endpointRows(summary) {
  return endpoints.map((item, sourceIndex) => {
    const statuses = statusesFor(summary, item.key);
    return {
      sourceIndex,
      endpoint: item.label,
      family: item.family,
      expected: item.statuses.join('/'),
      statuses,
      requests: taggedMetric(summary, 'http_reqs', 'endpoint_key', item.key, 'count'),
      avg: taggedMetric(summary, 'http_req_duration', 'endpoint_key', item.key, 'avg'),
      p95: taggedMetric(summary, 'http_req_duration', 'endpoint_key', item.key, 'p(95)'),
      p99: taggedMetric(summary, 'http_req_duration', 'endpoint_key', item.key, 'p(99)'),
      checkRate: taggedMetric(summary, 'checks', 'endpoint_key', item.key, 'rate')
    };
  });
}

function endpointThresholds(items) {
  const thresholds = {};
  items.forEach((item) => {
    thresholds[`http_reqs{endpoint_key:${item.key}}`] = ['count>=0'];
    thresholds[`http_req_duration{endpoint_key:${item.key}}`] = ['p(95)>=0'];
    thresholds[`checks{endpoint_key:${item.key}}`] = ['rate>=0'];
    statusCodes.forEach((status) => {
      thresholds[`endpoint_status_${status}{endpoint_key:${item.key}}`] = ['count>=0'];
    });
  });
  return thresholds;
}

function statusesFor(summary, endpointKeyValue) {
  return Object.keys(summary.metrics)
    .map((name) => {
      const match = name.match(/^endpoint_status_([^{}]+)\{([^}]+)\}$/);
      if (!match) return null;
      const status = match[1];
      const tags = parseMetricTags(match[2]);
      if (tags.endpoint_key !== endpointKeyValue) return null;
      const count = metricValue(summary, name, 'count');
      return count ? `${status} (${fmt(count)})` : null;
    })
    .filter(Boolean)
    .join(', ');
}

function parseMetricTags(text) {
  const tags = {};
  String(text || '').split(',').forEach((part) => {
    const index = part.indexOf(':');
    if (index === -1) return;
    tags[part.slice(0, index)] = part.slice(index + 1);
  });
  return tags;
}

function routeLabel(path) {
  return String(path || '').split('?')[0];
}

function endpointKey(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function metricValue(summary, name, field) {
  const metric = summary.metrics[name];
  if (!metric || metric.values === undefined) return null;
  return metric.values[field] !== undefined ? metric.values[field] : null;
}

function taggedMetric(summary, base, tag, value, field) {
  return metricValue(summary, `${base}{${tag}:${value}}`, field);
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

function fmt(value, suffix = '') {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number') return `${Math.round(value * 100) / 100}${suffix}`;
  return `${value}${suffix}`;
}
