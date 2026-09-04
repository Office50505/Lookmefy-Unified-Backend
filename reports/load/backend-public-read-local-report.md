# FitLook Local Public-Read Load Test Report

Generated: 2026-09-04T05:33:39.293Z
Base URL: http://localhost:5050
Stage duration: 10s
Targets: 10, 50, 100 VUs
Split client IPs: yes
Traffic profile: public GET routes only

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 500 | 2.42 ms | 4.46 ms | 5.71 ms | 9.79 ms | 0 | 1 |
| 50 | 2257 | 24.42 ms | 6.49 ms | 13.01 ms | 1007.09 ms | 0 | 1 |
| 100 | 4520 | 23.88 ms | 11.7 ms | 19.4 ms | 971.9 ms | 0 | 1 |

## Overall

- Requests: 7278
- Request rate: 233.49 req/s
- HTTP failure rate: 0
- Check pass rate: 1
- p95 latency: 15.57 ms
- p99 latency: 983.47 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/products?q= | 1478 | 28.45 ms | 10.44 ms | 18.13 ms | 970.82 ms | 0 | 1 |
| GET /api/products/:id | 752 | 32.68 ms | 9.88 ms | 17.38 ms | 992.46 ms | 0 | 1 |
| GET /api/recommendations/similar/:productId | 586 | 22.56 ms | 8.08 ms | 15.86 ms | 987.12 ms | 0 | 1 |
| GET /api/products?category= | 810 | 33.31 ms | 9.16 ms | 15.85 ms | 1003.67 ms | 0 | 1 |
| GET /api/products?featured= | 1126 | 22.24 ms | 7.99 ms | 15.14 ms | 982.57 ms | 0 | 1 |
| GET /api/products | 1616 | 19.11 ms | 7.78 ms | 14.43 ms | 969.6 ms | 0 | 1 |
| GET /api/health | 910 | 2.74 ms | 6.55 ms | 13.19 ms | 23.51 ms | 0 | 1 |

## Notes

- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.
- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.
- `SPLIT_CLIENT_IPS=true` is intended for local/staging tests where one k6 process should model multiple client IPs behind a trusted proxy.
- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.

## Artifacts

- Raw k6 summary: `reports/load/backend-public-read-local-summary.json`
- This report: `reports/load/backend-public-read-local-report.md`
