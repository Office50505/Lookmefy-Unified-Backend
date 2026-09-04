# FitLook Local Public-Read Load Test Report

Generated: 2026-09-04T05:57:03.260Z
Base URL: http://localhost:5050
Stage duration: 30s
Targets: 1000, 5000, 10000, 20000 VUs
Split client IPs: yes
Traffic profile: public GET routes only

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 26922 | 82.57 ms | 152.91 ms | 765.37 ms | 994.33 ms | 0 | 1 |
| 5000 | 46100 | 2026.37 ms | 4112.83 ms | 4329.93 ms | 4797.11 ms | 0.03 | 0.98 |
| 10000 | 43389 | 1616.69 ms | 5363.68 ms | 6038.89 ms | 6871.18 ms | 0.51 | 0.74 |
| 20000 | 20000 | 937.34 ms | 2674.84 ms | 3659.85 ms | 5136 ms | 0.39 | 0.81 |

## Overall

- Requests: 136412
- Request rate: 1047.55 req/s
- HTTP failure rate: 0.23
- Check pass rate: 0.88
- p95 latency: 4758.49 ms
- p99 latency: 6470.98 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/products?q= | 27090 | 1421.4 ms | 4135.95 ms | 4870.02 ms | 6551.82 ms | 0.23 | 0.89 |
| GET /api/products/:id | 13607 | 1432.21 ms | 4135.36 ms | 4863.61 ms | 6405.86 ms | 0.23 | 0.89 |
| GET /api/products | 31534 | 1406.94 ms | 4137.97 ms | 4858.86 ms | 6533.02 ms | 0.23 | 0.88 |
| GET /api/products?category= | 16586 | 1426.82 ms | 4122.23 ms | 4858.72 ms | 6602.11 ms | 0.24 | 0.88 |
| GET /api/recommendations/similar/:productId | 11068 | 1367.48 ms | 4114.86 ms | 4817.15 ms | 6358.16 ms | 0.23 | 0.88 |
| GET /api/products?featured= | 20288 | 1399.35 ms | 4110.82 ms | 4793.33 ms | 6427.03 ms | 0.23 | 0.89 |
| GET /api/health | 16239 | 922.62 ms | 2692.95 ms | 3902.51 ms | 5080.36 ms | 0.23 | 0.88 |

## Notes

- This is a safe production-facing read test. It does not sign up users, create products, call admin routes, or write recommendation events.
- Results include public internet, TLS, nginx, backend, Redis, and MongoDB/Atlas latency.
- `SPLIT_CLIENT_IPS=true` is intended for local/staging tests where one k6 process should model multiple client IPs behind a trusted proxy.
- Use the broader `backend-load.k6.js` script only against staging or when write/auth/admin traffic is explicitly intended.

## Artifacts

- Raw k6 summary: `reports/load/backend-public-read-local-1000-20000-summary.json`
- This report: `reports/load/backend-public-read-local-1000-20000-report.md`
