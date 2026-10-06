# FitLook Deployed k6 Load Test Report

Generated: 2026-08-21T11:53:43.425Z
Base URL: http://15.206.207.210
Profile: gradual deployed endpoint test to 10, 100, 1,000, and 10,000 simultaneous VUs

## Load Profile

| Step | Start | Ramp up | Hold | Ramp down | Target VUs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 users | 0s | 20s | 30s | 10s | 10 |
| 100 users | 1m10s | 30s | 45s | 15s | 100 |
| 1,000 users | 2m55s | 45s | 60s | 20s | 1000 |
| 10,000 users | 5m20s | 90s | 90s | 45s | 10000 |

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
- POST /api/tryons/vto-trial
- POST /api/products/amazon-search
- POST /api/products/preview-link
- POST /api/products
- POST /api/products/recategorize
- PATCH /api/products/:id/tryon-model
- DELETE /api/products/:id

## Overall Metrics

| Metric | Value |
| --- | ---: |
| Total requests | 319285.00 |
| Request rate/sec | 555.21 |
| Iterations | 30429.00 |
| Iteration rate/sec | 52.91 |
| Failed request rate | 99.70% |
| Check pass rate | 0.30% |
| Max VUs reached | 10000.00 |
| Avg duration ms | 7.37 |
| Median duration ms | 0.00 |
| p90 duration ms | 15.82 |
| p95 duration ms | 18.62 |
| p99 duration ms | 33.13 |
| Max duration ms | 2053.21 |
| Avg waiting/TTFB ms | 7.34 |
| p95 waiting/TTFB ms | 18.53 |
| Avg blocked ms | 0.08 |
| Data received bytes | 62832310.00 |
| Data sent bytes | 28264197.00 |

## Execution Outcome

- k6 completed the scheduled profile and exited with code 99 because failure thresholds were crossed.
- Runtime was 575.07 seconds.
- A post-run health check to `http://15.206.207.210/api/health` failed to connect within 10 seconds immediately after the test.

## Results by Step

| Step | Requests | Req/sec | Iterations | Failed req rate | Check pass rate | p95 ms | Max ms | 2xx | 4xx | 429 | 5xx | Network/0 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 users | 450.00 | 0.78 | 50.00 | 41.11% | 58.89% | 28.91 | 929.59 | 265.00 | 185.00 | 185.00 | 0.00 | 0.00 |
| 100 users | 6480.00 | 11.27 | 720.00 | 95.83% | 4.17% | 18.47 | 483.68 | 270.00 | 6210.00 | 6210.00 | 0.00 | 0.00 |
| 1,000 users | 86436.00 | 150.30 | 9604.00 | 100.00% | 0.00% | 23.73 | 1887.13 | 0.00 | 86436.00 | 86436.00 | 0.00 | 0.00 |
| 10,000 users | 225915.00 | 392.85 | 20055.00 | 99.81% | 0.19% | 14.16 | 2053.21 | 420.00 | 22791.00 | 22791.00 | 0.00 | 202704.00 |

## Status Code Profile

| Status bucket/code | Count |
| --- | ---: |
| 2xx | 957.00 |
| 3xx | 0.00 |
| 4xx | 115622.00 |
| 5xx | 0.00 |
| network/0 | 202704.00 |
| 200 | 957.00 |
| 201 | 0.00 |
| 204 | 0.00 |
| 400 | 0.00 |
| 401 | 0.00 |
| 404 | 0.00 |
| 409 | 0.00 |
| 429 | 115622.00 |
| 500 | 0.00 |
| other | 0.00 |

## Endpoint Latency

| Endpoint | Avg ms | p95 ms | p99 ms | Max ms | Failed rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| GET /api/health | 6.85 | 18.47 | 38.83 | 501.68 | 99.84% |
| GET /api/products | 6.62 | 18.47 | 31.87 | 1887.13 | 99.84% |
| GET /api/products?q=shirt | 6.51 | 18.17 | 32.00 | 921.35 | 99.84% |
| GET /api/products?category=shirts | 6.65 | 18.18 | 32.77 | 939.71 | 99.84% |
| GET /api/products regex-character filters | 6.50 | 18.19 | 29.66 | 1626.36 | 99.84% |
| GET /api/products/:id | 6.84 | 18.27 | 31.44 | 930.91 | 99.84% |
| GET /api/auth/me | 7.61 | 19.12 | 31.78 | 1285.03 | 99.37% |
| GET /api/tryons | 10.25 | 19.36 | 36.68 | 2053.21 | 99.35% |
| GET /api/tryons/credit-history | 9.05 | 19.49 | 35.46 | 1912.93 | 99.46% |

## Thresholds

| Threshold | Observed | Result |
| --- | ---: | :---: |
| Failed request rate < 5% | 99.70% | FAIL |
| p95 request duration < 2000 ms | 18.62 ms | PASS |
| Check pass rate > 95% | 0.30% | FAIL |

## Notes

- The deployed health endpoint advertised RateLimit-Limit: 120 during preflight, so 429s are expected if deployed rate limits remain enabled during high-VU testing.
- OTP auth is exercised once during setup to avoid creating thousands of persistent users.
- Authenticated read endpoints use the single setup user token, so per-user rate limits can dominate those endpoint results.
- Think time between journeys defaults to 5-15s via THINK_TIME_MIN/THINK_TIME_MAX.
