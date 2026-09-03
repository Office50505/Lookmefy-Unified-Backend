import http from 'k6/http';
import { check, group, sleep } from 'k6';

const baseUrl = env('BASE_URL', 'https://fitlook.in').replace(/\/$/, '');
const stageDuration = env('STAGE_DURATION', '30s');
const thinkTimeSeconds = Number(env('THINK_TIME_SECONDS', '1'));
const maxResponseBody = Number(env('MAX_RESPONSE_BODY', '1048576'));
const stageTargets = parseTargets(env('TARGETS', '10,50,100'));
const stageNames = stageTargets.map((target) => `stage_${target}`);
const endpointLabels = [
  'GET /api/health',
  'GET /api/products',
  'GET /api/products?q=',
  'GET /api/products?featured=',
  'GET /api/products?category=',
  'GET /api/products/:id',
  'GET /api/recommendations/similar/:productId'
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
  userAgent: 'FitLook k6 safe public-read load test'
};

export function setup() {
  const data = { productId: '' };
  group('setup: public product lookup', () => {
    const res = get('/api/products?limit=1', 'GET /api/products', [200]);
    const body = parseJson(res);
    data.productId = body.products && body.products[0] && body.products[0].id ? body.products[0].id : '';
  });
  return data;
}

export function publicReadJourney(data) {
  const productId = data.productId;
  const roll = Math.random();

  if (roll < 0.12) {
    get('/api/health', 'GET /api/health', [200]);
  } else if (roll < 0.35) {
    get('/api/products?limit=24', 'GET /api/products', [200]);
  } else if (roll < 0.55) {
    get('/api/products?limit=24&q=shirt', 'GET /api/products?q=', [200]);
  } else if (roll < 0.70) {
    get('/api/products?limit=24&featured=true', 'GET /api/products?featured=', [200]);
  } else if (roll < 0.82) {
    get('/api/products?limit=24&category=shirts', 'GET /api/products?category=', [200]);
  } else if (roll < 0.92 && productId) {
    get(`/api/products/${productId}`, 'GET /api/products/:id', [200]);
  } else if (productId) {
    get(`/api/recommendations/similar/${productId}?limit=4`, 'GET /api/recommendations/similar/:productId', [200]);
  } else {
    get('/api/products?limit=24', 'GET /api/products', [200]);
  }

  sleep(thinkTimeSeconds);
}

export function handleSummary(summary) {
  return {
    stdout: textSummary(summary),
    'reports/load/aws-public-read-summary.json': JSON.stringify(summary, null, 2),
    'reports/load/aws-public-read-report.md': markdownSummary(summary)
  };
}

function get(path, endpoint, statuses) {
  const res = http.get(`${baseUrl}${path}`, {
    tags: endpointTags(endpoint),
    responseType: 'text',
    timeout: '30s',
    responseCallback: http.expectedStatuses.apply(null, statuses)
  });
  check(res, {
    [`${endpoint} returned ${statuses.join('/')}`]: (r) => statuses.indexOf(r.status) !== -1,
    [`${endpoint} body bounded`]: (r) => !r.body || r.body.length <= maxResponseBody
  }, endpointTags(endpoint));
  return res;
}

function thresholdsFor(targets, endpoints) {
  const thresholds = {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01']
  };
  targets.forEach((target) => {
    const limit = target <= 10 ? 1000 : target <= 100 ? 1500 : target <= 1000 ? 3000 : 8000;
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
  const scenarios = {};
  targets.forEach((target, index) => {
    const elapsedStages = [];
    for (let i = 0; i < index; i += 1) elapsedStages.push(stageDuration);
    scenarios[`stage_${target}`] = {
      executor: 'constant-vus',
      vus: target,
      duration: stageDuration,
      startTime: addDurations(...elapsedStages),
      exec: 'publicReadJourney',
      tags: { user_stage: String(target), load_profile: 'public-read' }
    };
  });
  return scenarios;
}

function textSummary(summary) {
  const lines = ['FitLook AWS public-read load test summary', `Base URL: ${baseUrl}`, ''];
  stageNames.forEach((stage) => {
    lines.push(`${stage.replace('stage_', '')} VUs: p95=${fmt(subMetric(summary, 'http_req_duration', stage, 'p(95)'), 'ms')} failed=${fmt(subMetric(summary, 'http_req_failed', stage, 'rate'))}`);
  });
  lines.push('');
  lines.push('Slowest endpoints by p95:');
  endpointRows(summary).slice(0, 7).forEach((row) => {
    lines.push(`${row.endpoint}: p95=${fmt(row.p95, 'ms')} failed=${fmt(row.failureRate)} requests=${fmt(row.requests)}`);
  });
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
  const endpointData = endpointRows(summary);
  return [
    '# FitLook AWS Public-Read Load Test Report',
    '',
    `Generated: ${now}`,
    `Base URL: ${baseUrl}`,
    `Stage duration: ${stageDuration}`,
    `Targets: ${stageTargets.join(', ')} VUs`,
    'Traffic profile: public GET routes only',
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
    `- p99 latency: ${fmt(metricValue(summary, 'http_req_duration', 'p(99)'), ' ms')}`,
    '',
    '## Slowest Endpoints',
    '',
    '| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...endpointData.map(endpointTableRow),
    '',
    '## Notes',
    '',
    '- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.',
    '- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.',
    '- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.',
    '',
    '## Artifacts',
    '',
    '- Raw k6 summary: `reports/load/aws-public-read-summary.json`',
    '- This report: `reports/load/aws-public-read-report.md`',
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
  }).filter((row) => row.requests !== null && row.requests > 0)
    .sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
}

function endpointTableRow(row) {
  return `| ${row.endpoint} | ${fmt(row.requests)} | ${fmt(row.avg, ' ms')} | ${fmt(row.p90, ' ms')} | ${fmt(row.p95, ' ms')} | ${fmt(row.p99, ' ms')} | ${fmt(row.failureRate)} | ${fmt(row.checkRate)} |`;
}

function metricValue(summary, name, field) {
  const metric = summary.metrics[name];
  if (!metric || metric.values === undefined) return null;
  return metric.values[field] !== undefined ? metric.values[field] : null;
}

function subMetric(summary, base, tagValue, field) {
  return metricValue(summary, `${base}{scenario:${tagValue}}`, field);
}

function taggedMetric(summary, base, tag, value, field) {
  return metricValue(summary, `${base}{${tag}:${value}}`, field);
}

function endpointTags(endpoint) {
  return { endpoint, endpoint_key: endpointKey(endpoint), load_profile: 'public-read' };
}

function endpointKey(endpoint) {
  return String(endpoint || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function parseJson(res) {
  try {
    return JSON.parse(res.body || '{}');
  } catch (_error) {
    return {};
  }
}

function parseTargets(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function parseDuration(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
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
  if (!seconds) return '0s';
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function addDurations() {
  let seconds = 0;
  for (let i = 0; i < arguments.length; i += 1) seconds += parseDuration(arguments[i]);
  return formatDuration(seconds);
}

function env(name, fallback) {
  return __ENV[name] !== undefined && __ENV[name] !== '' ? __ENV[name] : fallback;
}

function fmt(value, suffix = '') {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number') return `${Math.round(value * 100) / 100}${suffix}`;
  return `${value}${suffix}`;
}
