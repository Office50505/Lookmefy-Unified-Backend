# FitLook AWS Public-Read Load Test Report

Generated: 2026-09-04T05:30:01.847Z
Base URL: http://localhost:5050
Stage duration: 10s
Targets: 5, 20 VUs
Traffic profile: public GET routes only

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 245 | 3.72 ms | 2.77 ms | 3.26 ms | 73.82 ms | 0 | 1 |
| 20 | 903 | 24 ms | 5.01 ms | 7.36 ms | 1009.04 ms | 0.33 | 0.84 |

## Overall

- Requests: 1149
- Request rate: 54.31 req/s
- HTTP failure rate: 0.26
- Check pass rate: 0.87
- p95 latency: 6.43 ms
- p99 latency: 1008.69 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/recommendations/similar/:productId | 93 | 25.5 ms | 5.37 ms | 8.49 ms | 1007.71 ms | 0 | 1 |
| GET /api/products?featured= | 156 | 27.14 ms | 5.04 ms | 7.67 ms | 1009.66 ms | 0.38 | 0.81 |
| GET /api/products?q= | 212 | 29.28 ms | 4.67 ms | 6.91 ms | 1007.59 ms | 0.31 | 0.84 |
| GET /api/products?category= | 149 | 23.37 ms | 4.58 ms | 6.86 ms | 1010 ms | 0.27 | 0.87 |
| GET /api/products | 263 | 18 ms | 4.61 ms | 5.91 ms | 1005.42 ms | 0.32 | 0.84 |
| GET /api/health | 149 | 1.75 ms | 3.74 ms | 5.08 ms | 9.38 ms | 0 | 1 |
| GET /api/products/:id | 127 | 18.11 ms | 3.87 ms | 4.66 ms | 758.95 ms | 0.35 | 0.83 |

## Notes

- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.
- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.
- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.

## Artifacts

- Raw k6 summary: `reports/load/aws-public-read-summary.json`
- This report: `reports/load/aws-public-read-report.md`
