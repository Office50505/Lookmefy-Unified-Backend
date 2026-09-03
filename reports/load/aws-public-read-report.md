# FitLook AWS Public-Read Load Test Report

Generated: 2026-08-06T10:23:47.167Z
Base URL: https://fitlook.in
Stage duration: 30s
Targets: 10, 50, 100 VUs
Traffic profile: public GET routes only

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 238 | 39.12 ms | 51.1 ms | 54.92 ms | 71.34 ms | 0 | 1 |
| 50 | 599 | 50.78 ms | 50.83 ms | 56.84 ms | 120.84 ms | 0.04 | 0.98 |
| 100 | 1135 | 38.5 ms | 51.23 ms | 59 ms | 95.11 ms | 0.05 | 0.98 |

## Overall

- Requests: 1973
- Request rate: 21.6 req/s
- HTTP failure rate: 0.04
- Check pass rate: 0.98
- p95 latency: 58.24 ms
- p99 latency: 96.29 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/products?category= | 236 | 77.32 ms | 58.7 ms | 71.41 ms | 122.51 ms | 0.04 | 0.98 |
| GET /api/products | 430 | 50 ms | 55.65 ms | 70.89 ms | 110.92 ms | 0.04 | 0.98 |
| GET /api/products?q= | 407 | 48.92 ms | 53.69 ms | 69.29 ms | 76.2 ms | 0.04 | 0.98 |
| GET /api/recommendations/similar/:productId | 155 | 26.15 ms | 28.71 ms | 35.16 ms | 54.83 ms | 0.05 | 0.98 |
| GET /api/products?featured= | 303 | 26.49 ms | 28.75 ms | 33.83 ms | 46.5 ms | 0.03 | 0.99 |
| GET /api/products/:id | 203 | 28.03 ms | 28.55 ms | 29.81 ms | 34.19 ms | 0.06 | 0.97 |
| GET /api/health | 239 | 25.25 ms | 25.65 ms | 26.49 ms | 34.62 ms | 0.04 | 0.98 |

## Notes

- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.
- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.
- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.

## Artifacts

- Raw k6 summary: `reports/load/aws-public-read-summary.json`
- This report: `reports/load/aws-public-read-report.md`
