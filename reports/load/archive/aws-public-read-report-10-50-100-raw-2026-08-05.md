# FitLook AWS Public-Read Load Test Report

Generated: 2026-08-05T11:03:19.210Z
Base URL: https://fitlook.in
Stage duration: 30s
Targets: 10, 50, 100 VUs
Traffic profile: public GET routes only

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 250 | 32.88 ms | 42.79 ms | 44.31 ms | 58.85 ms | 0 | 1 |
| 50 | 777 | 38.14 ms | 42.77 ms | 44.8 ms | 58.72 ms | 0.02 | 0.99 |
| 100 | 1310 | 31.33 ms | 41.55 ms | 43.36 ms | 58.65 ms | 0.04 | 0.98 |

## Overall

- Requests: 2338
- Request rate: 25.65 req/s
- HTTP failure rate: 0.03
- Check pass rate: 0.99
- p95 latency: 44.16 ms
- p99 latency: 58.77 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/products?q= | 453 | 51.16 ms | 43.77 ms | 49.04 ms | 78.41 ms | 0.02 | 0.99 |
| GET /api/products | 568 | 40.17 ms | 43.34 ms | 48.3 ms | 60.29 ms | 0.03 | 0.99 |
| GET /api/products?category= | 269 | 39.37 ms | 43.42 ms | 47.2 ms | 59.31 ms | 0.05 | 0.98 |
| GET /api/recommendations/similar/:productId | 156 | 22.7 ms | 24.46 ms | 30.03 ms | 52 ms | 0.03 | 0.99 |
| GET /api/products?featured= | 370 | 21.75 ms | 24.56 ms | 26.95 ms | 38.05 ms | 0.03 | 0.99 |
| GET /api/products/:id | 231 | 21.73 ms | 23.49 ms | 24.75 ms | 30.3 ms | 0.03 | 0.98 |
| GET /api/health | 291 | 19.73 ms | 21.65 ms | 22.26 ms | 24.42 ms | 0.02 | 0.99 |

## Notes

- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.
- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.
- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.

## Artifacts

- Raw k6 summary: `reports/load/aws-public-read-summary.json`
- This report: `reports/load/aws-public-read-report.md`
