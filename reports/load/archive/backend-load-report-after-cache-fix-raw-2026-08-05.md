# FitLook Backend Load Test Report

Generated: 2026-08-05T10:18:02.895Z
Base URL: http://localhost:5050
Stage duration: 30s
External/paid generation enabled: false
Global product delete enabled: false

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 300 | 6.34 ms | 4.03 ms | 4.49 ms | 94.59 ms | 0.27 | 0.87 |
| 100 | 3000 | 3.26 ms | 6.45 ms | 8.73 ms | 23.96 ms | 0.26 | 0.87 |
| 1000 | 30000 | 4.49 ms | 8.67 ms | 13.98 ms | 44.58 ms | 0.27 | 0.87 |
| 10000 | 156838 | 951.36 ms | 2495.73 ms | 3302.23 ms | 3981.03 ms | 0.27 | 0.87 |

## Overall

- Requests: 190164
- Request rate: 781.61 req/s
- HTTP failure rate: 0.27
- Check pass rate: 0.87
- p95 latency: 3247.33 ms

## Endpoint Coverage Notes

- Smoke coverage runs before the staged load and exercises public, authenticated, recommendation, try-on, and admin product routes.
- By default, paid/external AI generation endpoints are validation-tested to avoid spending FAL credits or hammering remote services.
- `DELETE /api/products` is disabled by default because it soft-deletes the active catalog. Enable it only with `INCLUDE_DELETE_ALL_PRODUCTS=true` in an isolated database.

## Artifacts

- Raw k6 summary: `reports/load/backend-load-summary.json`
- This report: `reports/load/backend-load-report.md`
