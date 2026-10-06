# FitLook Backend k6 Load Test Report

Generated: 2026-08-21T10:29:27.752Z
Base URL: http://localhost:5050

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
| Total requests | 46604.00 |
| Request rate/sec | 173.88 |
| Failed request rate | 0.00% |
| Check pass rate | 100.00% |
| Max VUs reached | 1000.00 |
| Avg duration ms | 2517.64 |
| Median duration ms | 0.77 |
| p90 duration ms | 8019.98 |
| p95 duration ms | 13017.06 |
| p99 duration ms | 13998.61 |
| Max duration ms | 14942.93 |
| Avg waiting/TTFB ms | 2517.60 |
| p95 waiting/TTFB ms | 13017.02 |
| Avg blocked ms | 0.01 |
| Data received bytes | 290734338.00 |
| Data sent bytes | 10711854.00 |

## Endpoint Latency

| Endpoint | Avg ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| GET /api/health | 0.77 | 1.24 | 7.90 | 28.48 |
| GET /api/products | 763.71 | 5917.02 | 6402.19 | 7012.81 |
| GET /api/products?q=shirt | 989.13 | 6684.66 | 7064.19 | 7370.66 |
| GET /api/products?category=shirts | 1593.82 | 6885.46 | 7063.10 | 7675.96 |
| GET /api/products regex-character filters | 1145.14 | 6822.08 | 6877.11 | 6930.77 |
| GET /api/products/:id | 1300.13 | 6993.26 | 7009.79 | 7019.96 |
| GET /api/auth/me | 3177.30 | 6993.80 | 7010.90 | 7675.39 |
| GET /api/tryons | 6738.75 | 13981.53 | 14010.92 | 14037.76 |
| GET /api/tryons/credit-history | 7023.92 | 14003.67 | 14024.58 | 14942.93 |

## Thresholds

- http_req_failed < 5%
- http_req_duration p95 < 2000 ms
- checks > 95%

## Notes

- The regex-character filter request is included specifically to verify the product-filter fix under load.
- OTP auth is exercised once during setup to avoid creating thousands of persistent users.
- The try-on generation endpoints were intentionally excluded from high-concurrency load because they can call FAL image-generation services and write generated media.
