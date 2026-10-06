import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:5050').replace(/\/$/, '');
const TEST_PHONE = __ENV.TEST_USER_PHONE || `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const TEST_OTP = __ENV.TEST_USER_OTP || '';
const USER_AGENT = 'FitLook k6 load test';

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));
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

export const options = {
  stages: [
    { duration: '20s', target: 10 },
    { duration: '30s', target: 10 },
    { duration: '30s', target: 100 },
    { duration: '45s', target: 100 },
    { duration: '45s', target: 1000 },
    { duration: '60s', target: 1000 },
    { duration: '30s', target: 0 }
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
    checks: ['rate>0.95']
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
};

function jsonHeaders(token) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return { headers };
}

function tagged(endpoint, token) {
  return {
    headers: jsonHeaders(token).headers,
    tags: { endpoint }
  };
}

function record(endpoint, response) {
  endpointTrends[endpoint]?.add(response.timings.duration);
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
  check(health, { 'setup health ok': (res) => res.status === 200 });

  const otpSend = sendOtp();
  const otpSendData = safeJson(otpSend);
  check(otpSend, {
    'setup otp send ok': (res) => res.status === 200
  });

  const otp = TEST_OTP || otpSendData?.devOtp || '123456';
  const otpVerify = verifyOtp(TEST_PHONE, otp);
  const otpVerifyData = safeJson(otpVerify);
  check(otpVerify, {
    'setup otp verify ok': (res) => res.status === 200 && Boolean(otpVerifyData?.token)
  });

  const products = http.get(`${BASE_URL}/api/products?limit=1`, tagged('GET /api/products setup'));
  const productData = safeJson(products);
  const firstProduct = productData?.products?.[0];

  return {
    token: otpVerifyData?.token || '',
    productId: firstProduct?.id || '',
    productCountVisible: productData?.total || 0,
    baseUrl: BASE_URL,
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

  sleep(Math.random() * 1.5 + 0.5);
}

function metric(data, name) {
  return data.metrics[name]?.values || {};
}

function endpointRows(data) {
  const rows = endpointTrendDefinitions.map(([endpoint, metricName]) => {
    const v = metric(data, metricName);
    return `| ${endpoint} | ${round(v.avg)} | ${round(v['p(95)'])} | ${round(v['p(99)'])} | ${round(v.max)} |`;
  });
  return rows.length ? rows.join('\n') : '| Endpoint submetrics unavailable | - | - | - | - |';
}

function round(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '-';
}

function handleSummaryReport(data) {
  const reqs = metric(data, 'http_reqs');
  const failures = metric(data, 'http_req_failed');
  const duration = metric(data, 'http_req_duration');
  const blocked = metric(data, 'http_req_blocked');
  const waiting = metric(data, 'http_req_waiting');
  const checksMetric = metric(data, 'checks');
  const vusMax = metric(data, 'vus_max');
  const bytesReceived = metric(data, 'data_received');
  const bytesSent = metric(data, 'data_sent');
  const now = new Date().toISOString();

  return `# FitLook Backend k6 Load Test Report

Generated: ${now}
Base URL: ${BASE_URL}

## Scope

Executed staged load profile: 10 concurrent users, then 100, then 1000.

Covered endpoints:
- GET /api/health
- GET /api/products
- GET /api/products?q=shirt
- GET /api/products?category=shirts
- GET /api/products with regex-character brand/gender filters
- GET /api/products/:id when at least one product exists
- GET /api/auth/me
- GET /api/tryons
- GET /api/tryons/credit-history

Setup-only endpoints:
- POST /api/auth/otp/send
- POST /api/auth/otp/verify

Not load-tested at 1000 VUs because they create persistent data or call paid/external services:
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
| Failed request rate | ${round((failures.rate || 0) * 100)}% |
| Check pass rate | ${round((checksMetric.rate || 0) * 100)}% |
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

## Endpoint Latency

| Endpoint | Avg ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
${endpointRows(data)}

## Thresholds

- http_req_failed < 5%
- http_req_duration p95 < 2000 ms
- checks > 95%

## Notes

- The regex-character filter request is included specifically to verify the product-filter fix under load.
- OTP auth is exercised once during setup to avoid creating thousands of persistent users.
- The try-on generation endpoints were intentionally excluded from high-concurrency load because they can call FAL image-generation services and write generated media.
`;
}

export function handleSummary(data) {
  return {
    'load-tests/results/fitlook-load-summary.json': JSON.stringify(data, null, 2),
    'load-tests/results/fitlook-load-report.md': handleSummaryReport(data),
    stdout: `${handleSummaryReport(data)}\n`
  };
}
