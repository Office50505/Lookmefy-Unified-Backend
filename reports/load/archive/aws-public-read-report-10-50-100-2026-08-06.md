# FitLook AWS Public-Read Load Test Report

Generated: 2026-08-06T09:55:53.948Z
Base URL: https://fitlook.in
Stage duration: 30s
Targets: 10, 50, 100 VUs
Traffic profile: public GET routes only

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 248 | 42.16 ms | 54.8 ms | 62.97 ms | 94.88 ms | 0 | 1 |
| 50 | 609 | 38.84 ms | 51.52 ms | 57.69 ms | 74.85 ms | 0.04 | 0.98 |
| 100 | 1120 | 37.18 ms | 49.98 ms | 52.8 ms | 71 ms | 0.05 | 0.97 |

## Overall

- Requests: 1978
- Request rate: 21.63 req/s
- HTTP failure rate: 0.04
- Check pass rate: 0.98
- p95 latency: 56.71 ms
- p99 latency: 75.23 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/products?q= | 395 | 49.27 ms | 57.96 ms | 69.13 ms | 91.93 ms | 0.04 | 0.98 |
| GET /api/products | 453 | 48.77 ms | 52.7 ms | 68.16 ms | 84.48 ms | 0.03 | 0.99 |
| GET /api/products?category= | 242 | 48.68 ms | 53.77 ms | 61.25 ms | 72.99 ms | 0.04 | 0.98 |
| GET /api/recommendations/similar/:productId | 138 | 27.04 ms | 29.85 ms | 46.47 ms | 77.92 ms | 0.06 | 0.97 |
| GET /api/products?featured= | 285 | 25.74 ms | 29.05 ms | 31.72 ms | 47.46 ms | 0.06 | 0.97 |
| GET /api/products/:id | 217 | 26.6 ms | 28.41 ms | 29.86 ms | 34.42 ms | 0.03 | 0.99 |
| GET /api/health | 248 | 22.59 ms | 25.57 ms | 26.13 ms | 31.3 ms | 0.06 | 0.97 |

## Notes

- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.
- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.
- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.

## Artifacts

- Raw k6 summary: `reports/load/aws-public-read-summary.json`
- This report: `reports/load/aws-public-read-report.md`
