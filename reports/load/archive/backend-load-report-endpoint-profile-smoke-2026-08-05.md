# FitLook Backend Load Test Report

Generated: 2026-08-05T10:29:24.857Z
Base URL: http://localhost:5050
Load profile: read
Stage duration: 2s
External/paid generation enabled: false
Global product delete enabled: false

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 17 | 20.07 ms | 54.77 ms | 73.28 ms | 119 ms | 0 | 1 |

## Overall

- Requests: 45
- Request rate: 2 req/s
- HTTP failure rate: 0
- Check pass rate: 1
- p95 latency: 240.69 ms

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| POST /api/auth/signup | 1 | 281.49 ms | 281.49 ms | 281.49 ms | 281.49 ms | 0 | 1 |
| POST /api/products/recategorize | 1 | 245.97 ms | 245.97 ms | 245.97 ms | 245.97 ms | 0 | 1 |
| GET /api/recommendations/admin/stats | 1 | 241.46 ms | 241.46 ms | 241.46 ms | 241.46 ms | 0 | 1 |
| POST /api/auth/login | 1 | 237.62 ms | 237.62 ms | 237.62 ms | 237.62 ms | 0 | 1 |
| GET /api/recommendations/similar/:productId | 2 | 165.86 ms | 194.2 ms | 197.74 ms | 200.58 ms | 0 | 1 |
| GET /api/recommendations/for-you | 1 | 120.77 ms | 120.77 ms | 120.77 ms | 120.77 ms | 0 | 1 |
| GET /api/auth/username-suggestions | 1 | 94.91 ms | 94.91 ms | 94.91 ms | 94.91 ms | 0 | 1 |
| POST /api/recommendations/events | 1 | 81.94 ms | 81.94 ms | 81.94 ms | 81.94 ms | 0 | 1 |
| DELETE /api/products/:id cleanup | 1 | 61.2 ms | 61.2 ms | 61.2 ms | 61.2 ms | 0 | 1 |
| POST /api/auth/body-photo | 1 | 58.48 ms | 58.48 ms | 58.48 ms | 58.48 ms | 0 | 1 |
| GET /api/products?q= | 5 | 19.5 ms | 47.2 ms | 53.09 ms | 57.81 ms | 0 | 1 |
| POST /api/products | 1 | 50.9 ms | 50.9 ms | 50.9 ms | 50.9 ms | 0 | 1 |
| POST /api/tryons/:productId missing | 1 | 49.98 ms | 49.98 ms | 49.98 ms | 49.98 ms | 0 | 1 |
| PATCH /api/products/:id/tryon-model | 1 | 49.26 ms | 49.26 ms | 49.26 ms | 49.26 ms | 0 | 1 |
| GET /api/tryons | 1 | 47.8 ms | 47.8 ms | 47.8 ms | 47.8 ms | 0 | 1 |

## Highest Failure Endpoints

| Endpoint | Requests | Avg latency | p95 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| None recorded | n/a | n/a | n/a | n/a | n/a |

## Endpoint Coverage Notes

- Smoke coverage runs before the staged load and exercises public, authenticated, recommendation, try-on, and admin product routes.
- `LOAD_PROFILE=mixed` keeps the existing blended user journey. Use `LOAD_PROFILE=read`, `LOAD_PROFILE=auth`, or `LOAD_PROFILE=write` to isolate catalog reads, authenticated browsing, or event-write pressure.
- Endpoint tables are emitted from the `endpoint_key` k6 tag, so failures can be traced to route families instead of only scenario stages.
- By default, paid/external AI generation endpoints are validation-tested to avoid spending FAL credits or hammering remote services.
- `DELETE /api/products` is disabled by default because it soft-deletes the active catalog. Enable it only with `INCLUDE_DELETE_ALL_PRODUCTS=true` in an isolated database.

## Artifacts

- Raw k6 summary: `reports/load/backend-load-summary.json`
- This report: `reports/load/backend-load-report.md`
