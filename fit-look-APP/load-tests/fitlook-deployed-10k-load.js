import http from 'k6/http';
import { check, group, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'https://api.lookmefy.in').replace(/\/$/, '');
const TEST_PHONE = __ENV.TEST_USER_PHONE || `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const TEST_OTP = __ENV.TEST_USER_OTP || '';
const USER_AGENT = 'FitLook deployed k6 10k load test';
const THINK_TIME_MIN = Number(__ENV.THINK_TIME_MIN || 5);
const THINK_TIME_MAX = Number(__ENV.THINK_TIME_MAX || 15);
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || '30s';

const profiles = [
  { name: 'users_10', label: '10 users', startTime: '0s', ramp: '20s', hold: '30s', down: '10s', target: 10 },
  { name: 'users_100', label: '100 users', startTime: '1m10s', ramp: '30s', hold: '45s', down: '15s', target: 100 },
  { name: 'users_1000', label: '1,000 users', startTime: '2m55s', ramp: '45s', hold: '60s', down: '20s', target: 1000 },
  { name: 'users_10000', label: '10,000 users', startTime: '5m20s', ramp: '90s', hold: '90s', down: '45s', target: 10000 }
];

const endpointTrendDefinitions = [
  ['GET /api/health', 'endpoint_get_health_ms'],
  ['GET /api/products', 'endpoint_get_products_ms'],
  ['GET /api/products?q=shirt', 'endpoint_get_products_search_ms'],
  ['GET /api/products?category=shirts', 'endpoint_get_products_category_ms'],
  ['GET /api/products regex-character filters', 'endpoint_get_products_regex_filters_ms'],
  ['GET /api/products/:id', 'endpoint_get_product_detail_ms'],
  ['GET /api/auth/me', 'endpoint_get_auth_me_ms'],
  ['GET /api/tryons', 'endpoint_get_tryons_ms'],
  ['GET /api/tryons/credit-history', 'endpoint_get_credit_history_ms']
];

const endpointTrends = Object.fromEntries(
  endpointTrendDefinitions.map(([endpoint, metricName]) => [endpoint, new Trend(metricName, true)])
);
const endpointFailureRates = Object.fromEntries(
  endpointTrendDefinitions.map(([endpoint, metricName]) => [endpoint, new Rate(metricName.replace(/_ms$/, '_failed'))])
);

const statusCounters = {
  status2xx: new Counter('status_2xx'),
  status3xx: new Counter('status_3xx'),
  status4xx: new Counter('status_4xx'),
  status5xx: new Counter('status_5xx'),
  status0: new Counter('status_0_network_error'),
  status200: new Counter('status_200'),
  status201: new Counter('status_201'),
  status204: new Counter('status_204'),
  status400: new Counter('status_400'),
  status401: new Counter('status_401'),
  status404: new Counter('status_404'),
  status409: new Counter('status_409'),
  status429: new Counter('status_429'),
  status500: new Counter('status_500'),
  statusOther: new Counter('status_other')
};

const scenarioStatusCounters = Object.fromEntries(
  profiles.map((profile) => [
    profile.name,
    {
      status2xx: new Counter(`${profile.name}_status_2xx`),
      status3xx: new Counter(`${profile.name}_status_3xx`),
      status4xx: new Counter(`${profile.name}_status_4xx`),
      status5xx: new Counter(`${profile.name}_status_5xx`),
      status0: new Counter(`${profile.name}_status_0_network_error`),
      status429: new Counter(`${profile.name}_status_429`)
    }
  ])
);

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

function scenarioOptions(profile) {
  return {
    executor: 'ramping-vus',
    startTime: profile.startTime,
    stages: [
      { duration: profile.ramp, target: profile.target },
      { duration: profile.hold, target: profile.target },
      { duration: profile.down, target: 0 }
    ],
    gracefulRampDown: '30s',
    gracefulStop: '30s',
    tags: { user_level: profile.label }
  };
}

function thresholds() {
  const entries = {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
    checks: ['rate>0.95']
  };

  for (const profile of profiles) {
    entries[`http_req_duration{scenario:${profile.name}}`] = ['p(95)<2000'];
    entries[`http_req_failed{scenario:${profile.name}}`] = ['rate<0.05'];
    entries[`checks{scenario:${profile.name}}`] = ['rate>0.95'];
    entries[`http_reqs{scenario:${profile.name}}`] = ['count>=0'];
    entries[`iterations{scenario:${profile.name}}`] = ['count>=0'];
  }

  return entries;
}

export const options = {
  scenarios: Object.fromEntries(profiles.map((profile) => [profile.name, scenarioOptions(profile)])),
  thresholds: thresholds(),
  setupTimeout: '60s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
};

function jsonHeaders(token) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function tagged(endpoint, token) {
  return {
    headers: jsonHeaders(token),
    tags: { endpoint },
    timeout: REQUEST_TIMEOUT
  };
}

function statusBucket(response) {
  const status = Number(response.status || 0);
  if (status === 0) return 'status0';
  if (status >= 200 && status < 300) return 'status2xx';
  if (status >= 300 && status < 400) return 'status3xx';
  if (status >= 400 && status < 500) return 'status4xx';
  if (status >= 500) return 'status5xx';
  return 'statusOther';
}

function recordStatus(response) {
  const bucket = statusBucket(response);
  statusCounters[bucket]?.add(1);

  const status = Number(response.status || 0);
  if (status > 0) {
    const exact = `status${status}`;
    statusCounters[exact]?.add(1);
    if (!statusCounters[exact] && bucket !== 'statusOther') statusCounters.statusOther.add(1);
  }

  let scenarioName = '';
  try {
    scenarioName = exec.scenario.name;
  } catch {
    scenarioName = '';
  }
  const scenarioCounters = scenarioStatusCounters[scenarioName];
  scenarioCounters?.[bucket]?.add(1);
  if (response.status === 429) scenarioCounters?.status429.add(1);
}

function record(endpoint, response) {
  recordStatus(response);
  endpointTrends[endpoint]?.add(response.timings.duration);
  endpointFailureRates[endpoint]?.add(response.status >= 400 || response.status === 0);
  return response;
}

function getEndpoint(endpoint, url, token) {
  return record(endpoint, http.get(url, tagged(endpoint, token)));
}

function postJsonEndpoint(endpoint, url, body, token) {
  return record(endpoint, http.post(url, JSON.stringify(body), tagged(endpoint, token)));
}

function safeJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function sendOtp(phone = TEST_PHONE) {
  return postJsonEndpoint('POST /api/auth/otp/send setup-only', `${BASE_URL}/api/auth/otp/send`, { phone });
}

function verifyOtp(phone = TEST_PHONE, otp = TEST_OTP) {
  return postJsonEndpoint('POST /api/auth/otp/verify setup-only', `${BASE_URL}/api/auth/otp/verify`, { phone, otp });
}

export function setup() {
  const health = http.get(`${BASE_URL}/api/health`, tagged('GET /api/health setup'));
  const healthOk = check(health, { 'setup health ok': (res) => res.status === 200 });

  let token = '';
  const otpSend = sendOtp();
  const otpSendData = safeJson(otpSend);
  const otpSendOk = check(otpSend, {
    'setup otp send ok': (res) => res.status === 200
  });

  if (otpSendOk) {
    const otp = TEST_OTP || otpSendData?.devOtp || '123456';
    const otpVerify = verifyOtp(TEST_PHONE, otp);
    const otpVerifyData = safeJson(otpVerify);
    check(otpVerify, {
      'setup otp verify ok': (res) => res.status === 200 && Boolean(otpVerifyData?.token)
    });
    token = otpVerifyData?.token || '';
  }

  const products = http.get(`${BASE_URL}/api/products?limit=1`, tagged('GET /api/products setup'));
  const productData = safeJson(products);
  const firstProduct = productData?.products?.[0];

  return {
    token,
    productId: firstProduct?.id || '',
    productCountVisible: productData?.total || 0,
    baseUrl: BASE_URL,
    setupHealthOk: healthOk,
    setupOtpOk: otpSendOk,
    testPhone: TEST_PHONE
  };
}

export default function (data) {
  const token = data.token;
  const productId = data.productId;

  group('public health and catalog', () => {
    check(getEndpoint('GET /api/health', `${BASE_URL}/api/health`), {
      'health status 200': (res) => res.status === 200
    });

    check(getEndpoint('GET /api/products', `${BASE_URL}/api/products?limit=20`), {
      'products status 200': (res) => res.status === 200
    });

    check(getEndpoint('GET /api/products?q=shirt', `${BASE_URL}/api/products?q=shirt&limit=20`), {
      'text search status 200': (res) => res.status === 200
    });

    check(getEndpoint('GET /api/products?category=shirts', `${BASE_URL}/api/products?category=${encodeURIComponent('shirts')}&limit=20`), {
      'category filter status 200': (res) => res.status === 200
    });

    check(getEndpoint('GET /api/products regex-character filters', `${BASE_URL}/api/products?brand=${encodeURIComponent('Zara [test] (load)')}&gender=${encodeURIComponent('men|women')}&limit=20`), {
      'regex character filters do not throw': (res) => res.status === 200
    });

    if (productId) {
      check(getEndpoint('GET /api/products/:id', `${BASE_URL}/api/products/${encodeURIComponent(productId)}`), {
        'product detail status 200': (res) => res.status === 200
      });
    }
  });

  if (token) {
    group('auth and user reads', () => {
      check(getEndpoint('GET /api/auth/me', `${BASE_URL}/api/auth/me`, token), {
        'me status 200': (res) => res.status === 200
      });
    });

    group('try-on cache reads', () => {
      const ids = productId ? `?productIds=${encodeURIComponent(productId)}` : '';
      check(getEndpoint('GET /api/tryons', `${BASE_URL}/api/tryons${ids}`, token), {
        'tryons cache status 200': (res) => res.status === 200
      });

      check(getEndpoint('GET /api/tryons/credit-history', `${BASE_URL}/api/tryons/credit-history`, token), {
        'credit history status 200': (res) => res.status === 200
      });
    });
  }

  const minThink = Math.max(0, THINK_TIME_MIN);
  const maxThink = Math.max(minThink, THINK_TIME_MAX);
  sleep(Math.random() * (maxThink - minThink) + minThink);
}

function metric(data, name) {
  return data.metrics[name]?.values || {};
}

function count(data, name) {
  return metric(data, name).count || 0;
}

function rate(data, name) {
  return metric(data, name).rate || 0;
}

function round(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '-';
}

function percent(value) {
  return `${round((Number(value) || 0) * 100)}%`;
}

function passFail(ok) {
  return ok ? 'PASS' : 'FAIL';
}

function profileRows() {
  return profiles.map((profile) => (
    `| ${profile.label} | ${profile.startTime} | ${profile.ramp} | ${profile.hold} | ${profile.down} | ${profile.target} |`
  )).join('\n');
}

function scenarioRows(data) {
  return profiles.map((profile) => {
    const scenario = profile.name;
    const reqs = metric(data, `http_reqs{scenario:${scenario}}`);
    const iterations = metric(data, `iterations{scenario:${scenario}}`);
    const failures = metric(data, `http_req_failed{scenario:${scenario}}`);
    const checksMetric = metric(data, `checks{scenario:${scenario}}`);
    const duration = metric(data, `http_req_duration{scenario:${scenario}}`);
    const status2xx = count(data, `${scenario}_status_2xx`);
    const status4xx = count(data, `${scenario}_status_4xx`);
    const status5xx = count(data, `${scenario}_status_5xx`);
    const status0 = count(data, `${scenario}_status_0_network_error`);
    const status429 = count(data, `${scenario}_status_429`);
    return `| ${profile.label} | ${round(reqs.count)} | ${round(reqs.rate)} | ${round(iterations.count)} | ${percent(failures.rate)} | ${percent(checksMetric.rate)} | ${round(duration['p(95)'])} | ${round(duration.max)} | ${round(status2xx)} | ${round(status4xx)} | ${round(status429)} | ${round(status5xx)} | ${round(status0)} |`;
  }).join('\n');
}

function endpointRows(data) {
  return endpointTrendDefinitions.map(([endpoint, metricName]) => {
    const values = metric(data, metricName);
    const failureValues = metric(data, metricName.replace(/_ms$/, '_failed'));
    return `| ${endpoint} | ${round(values.avg)} | ${round(values['p(95)'])} | ${round(values['p(99)'])} | ${round(values.max)} | ${percent(failureValues.rate)} |`;
  }).join('\n');
}

function statusRows(data) {
  const rows = [
    ['2xx', 'status_2xx'],
    ['3xx', 'status_3xx'],
    ['4xx', 'status_4xx'],
    ['5xx', 'status_5xx'],
    ['network/0', 'status_0_network_error'],
    ['200', 'status_200'],
    ['201', 'status_201'],
    ['204', 'status_204'],
    ['400', 'status_400'],
    ['401', 'status_401'],
    ['404', 'status_404'],
    ['409', 'status_409'],
    ['429', 'status_429'],
    ['500', 'status_500'],
    ['other', 'status_other']
  ];
  return rows.map(([label, name]) => `| ${label} | ${round(count(data, name))} |`).join('\n');
}

function thresholdSummary(data) {
  const failures = rate(data, 'http_req_failed');
  const duration = metric(data, 'http_req_duration');
  const checksMetric = rate(data, 'checks');
  return [
    ['Failed request rate < 5%', failures < 0.05, percent(failures)],
    ['p95 request duration < 2000 ms', (duration['p(95)'] || Infinity) < 2000, `${round(duration['p(95)'])} ms`],
    ['Check pass rate > 95%', checksMetric > 0.95, percent(checksMetric)]
  ].map(([threshold, ok, observed]) => `| ${threshold} | ${observed} | ${passFail(ok)} |`).join('\n');
}

function handleSummaryReport(data) {
  const reqs = metric(data, 'http_reqs');
  const failures = metric(data, 'http_req_failed');
  const duration = metric(data, 'http_req_duration');
  const blocked = metric(data, 'http_req_blocked');
  const waiting = metric(data, 'http_req_waiting');
  const checksMetric = metric(data, 'checks');
  const vusMax = metric(data, 'vus_max');
  const iterations = metric(data, 'iterations');
  const bytesReceived = metric(data, 'data_received');
  const bytesSent = metric(data, 'data_sent');
  const now = new Date().toISOString();

  return `# FitLook Deployed k6 Load Test Report

Generated: ${now}
Base URL: ${BASE_URL}
Profile: gradual deployed endpoint test to 10, 100, 1,000, and 10,000 simultaneous VUs

## Load Profile

| Step | Start | Ramp up | Hold | Ramp down | Target VUs |
| --- | ---: | ---: | ---: | ---: | ---: |
${profileRows()}

## Scope

Covered read-only endpoints:
- GET /api/health
- GET /api/products
- GET /api/products?q=shirt
- GET /api/products?category=shirts
- GET /api/products with regex-character brand/gender filters
- GET /api/products/:id when at least one product exists
- GET /api/auth/me when setup auth succeeds
- GET /api/tryons when setup auth succeeds
- GET /api/tryons/credit-history when setup auth succeeds

Setup-only endpoints:
- POST /api/auth/otp/send
- POST /api/auth/otp/verify

Excluded from high-concurrency load because they write persistent data or can call paid/external services:
- POST /api/tryons/:productId
- POST /api/tryons/custom
- POST /api/tryons/external
- POST /api/products/amazon-search
- POST /api/products/preview-link
- POST /api/products
- POST /api/products/recategorize
- PATCH /api/products/:id/tryon-model
- DELETE /api/products/:id

## Overall Metrics

| Metric | Value |
| --- | ---: |
| Total requests | ${round(reqs.count)} |
| Request rate/sec | ${round(reqs.rate)} |
| Iterations | ${round(iterations.count)} |
| Iteration rate/sec | ${round(iterations.rate)} |
| Failed request rate | ${percent(failures.rate)} |
| Check pass rate | ${percent(checksMetric.rate)} |
| Max VUs reached | ${round(vusMax.max)} |
| Avg duration ms | ${round(duration.avg)} |
| Median duration ms | ${round(duration.med)} |
| p90 duration ms | ${round(duration['p(90)'])} |
| p95 duration ms | ${round(duration['p(95)'])} |
| p99 duration ms | ${round(duration['p(99)'])} |
| Max duration ms | ${round(duration.max)} |
| Avg waiting/TTFB ms | ${round(waiting.avg)} |
| p95 waiting/TTFB ms | ${round(waiting['p(95)'])} |
| Avg blocked ms | ${round(blocked.avg)} |
| Data received bytes | ${round(bytesReceived.count)} |
| Data sent bytes | ${round(bytesSent.count)} |

## Results by Step

| Step | Requests | Req/sec | Iterations | Failed req rate | Check pass rate | p95 ms | Max ms | 2xx | 4xx | 429 | 5xx | Network/0 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${scenarioRows(data)}

## Status Code Profile

| Status bucket/code | Count |
| --- | ---: |
${statusRows(data)}

## Endpoint Latency

| Endpoint | Avg ms | p95 ms | p99 ms | Max ms | Failed rate |
| --- | ---: | ---: | ---: | ---: | ---: |
${endpointRows(data)}

## Thresholds

| Threshold | Observed | Result |
| --- | ---: | :---: |
${thresholdSummary(data)}

## Notes

- The deployed health endpoint advertised RateLimit-Limit: 120 during preflight, so 429s are expected if deployed rate limits remain enabled during high-VU testing.
- OTP auth is exercised once during setup to avoid creating thousands of persistent users.
- Authenticated read endpoints use the single setup user token, so per-user rate limits can dominate those endpoint results.
- Think time between journeys defaults to ${THINK_TIME_MIN}-${THINK_TIME_MAX}s via THINK_TIME_MIN/THINK_TIME_MAX.
`;
}

export function handleSummary(data) {
  return {
    'load-tests/results/fitlook-deployed-10k-summary.json': JSON.stringify(data, null, 2),
    'load-tests/results/fitlook-deployed-10k-report.md': handleSummaryReport(data),
    stdout: `${handleSummaryReport(data)}\n`
  };
}
