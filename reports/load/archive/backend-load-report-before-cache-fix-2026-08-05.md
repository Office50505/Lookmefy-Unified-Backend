# FitLook Backend Load Test Comparison Report

Generated: 2026-08-05T09:54:00.000Z

## Executive Summary

Two local k6 backend load tests were run against `http://localhost:5050` using the same script, same staged profile, and same local single-process Node API setup.

- Run 1: Redis effectively unavailable / timing out.
- Run 2: Redis running locally on `localhost:6379`, verified with `redis-cli ping -> PONG`.

Redis improved some lower-stage latency numbers and reduced interrupted iterations from 197 to 81, but it did not fix the 10,000-user failure mode. At 10k VUs, p95 latency still hit the 30-second timeout ceiling, and overall HTTP failure rate increased from 33.78% to 35.88%.

The conclusion is sharper now: Redis availability helps, but the current local backend architecture still saturates under 10k simultaneous users. The 10k bottleneck is not just “Redis was off.” The app is hitting a mix of server wait, connection backlog, cache pressure, and expensive recommendation/catalog paths.

## Test Setup

| Item | Value |
| --- | --- |
| Tool | k6 v2.0.0 |
| Script | `tests/load/backend-load.k6.js` |
| Base URL | `http://localhost:5050` |
| Backend command | `npm run server` |
| Stage targets | 10, 100, 1,000, 10,000 simultaneous VUs |
| Stage duration | 30 seconds each |
| Smoke window | 2 minutes |
| Request timeout | 30 seconds |
| Paid/external AI generation | Disabled |
| Delete-all-products route | Disabled |
| Environment | Local Mac, single Node API process, MongoDB from configured `.env` |

## Headline Comparison

| Metric | Redis off / timing out | Redis on | Change |
| --- | ---: | ---: | ---: |
| Total HTTP requests | 120,852 | 104,181 | -13.79% |
| Completed iterations | 120,630 | 104,075 | -13.72% |
| Interrupted iterations | 197 | 81 | Better |
| Overall request rate | 402.63 req/s | 347.16 req/s | Worse |
| Overall HTTP failure rate | 33.78% | 35.88% | Worse |
| Overall check pass rate | 83.11% | 82.06% | Worse |
| Overall median latency | 6.43 ms | 31.91 ms | Worse |
| Overall p90 latency | 1.26 s | 15.08 s | Worse |
| Overall p95 latency | 30.00 s | 30.00 s | Same timeout ceiling |
| Overall p99 latency | 30.00 s | 30.00 s | Same timeout ceiling |

## Stage Comparison

| Users | Redis | Requests | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 10 | Off | 299 | 4.14 ms | 97.73 ms | 25.75% | 87.12% |
| 10 | On | 300 | 3.80 ms | 138.08 ms | 25.33% | 87.33% |
| 100 | Off | 2,992 | 13.93 ms | 220.63 ms | 26.80% | 86.60% |
| 100 | On | 2,982 | 8.92 ms | 388.36 ms | 27.40% | 86.30% |
| 1,000 | Off | 18,198 | 113.70 ms | 22.05 s | 27.03% | 86.48% |
| 1,000 | On | 18,694 | 86.15 ms | 17.20 s | 26.71% | 86.65% |
| 10,000 | Off | 99,337 | 30.00 s | 30.00 s | 35.25% | 82.38% |
| 10,000 | On | 82,179 | 30.00 s | 30.00 s | 38.30% | 80.85% |

## What Improved With Redis

Redis helped the moderate stages:

- 10 VU p95 improved from 4.14 ms to 3.80 ms.
- 100 VU p95 improved from 13.93 ms to 8.92 ms.
- 1,000 VU p95 improved from 113.70 ms to 86.15 ms.
- 1,000 VU p99 improved from 22.05 s to 17.20 s.
- Interrupted iterations dropped from 197 to 81.

This suggests the app did benefit from Redis on cacheable read paths, especially before the system entered hard saturation.

## What Got Worse

At 10k users, Redis did not save the run:

- 10k p95 stayed at the 30-second timeout ceiling.
- 10k failure rate worsened from 35.25% to 38.30%.
- 10k completed request count dropped from 99,337 to 82,179.
- Overall p90 latency worsened from 1.26 s to 15.08 s.
- Overall request throughput dropped from 402.63 req/s to 347.16 req/s.

The second run also produced early `dial: i/o timeout` errors during the 10k stage. That indicates some requests could not even establish a connection to the local API quickly enough. This points to local TCP backlog / connection saturation, Node accept-loop pressure, or k6 local generator pressure in addition to backend/database work.

## Redis-Specific Observation

Even with Redis running, the API logged:

`[cache] Redis cache timeout`

That matters. Redis was not absent in the second run, but under 10k local pressure the API still timed out talking to Redis at least once. The cache layer currently uses short Redis timeouts, and Redis calls are still in the request path. Under extreme concurrency, Redis itself or the Node Redis client path can become another queue.

## Bottleneck Interpretation

The Redis-on run still shows server-side waiting dominating the tail:

| Metric | Redis off p95 | Redis on p95 | Interpretation |
| --- | ---: | ---: | --- |
| `http_req_waiting` | 30.00 s | 30.00 s | Server wait still reaches request timeout. |
| `http_req_blocked` | 237.80 ms | 346.49 ms | Connection/client-side queuing got worse with Redis-on run. |
| `http_req_sending` | 2.82 ms | n/a in report table | Upload was not the limiting factor. |
| `http_req_receiving` | 0.09 ms | n/a in report table | Download was not the limiting factor. |

The repeated console failures again centered around:

- `GET /api/recommendations/similar/:productId?limit=4`
- `GET /api/products?limit=24`
- `GET /api/products?limit=24&q=shirt`
- `GET /api/products?limit=24&featured=true`
- `GET /api/auth/me`
- `POST /api/recommendations/events`
- `GET /api/health`

The biggest recurring timeout route in the second run was similar recommendations. That route is a prime optimization target.

## Cleanup Notes

The k6 teardown cleanup timed out again for the Redis-on disposable product:

`6a730703660f17bb33cb475d`

After the run, the API was restarted and the product was deleted successfully.

The earlier Redis-off disposable product was also cleaned up successfully:

`6a7304556aee2d04a42a0cf0`

## What This Says About The App

The app benefits from Redis, but Redis alone is not enough. At 10,000 simultaneous local VUs, the current single-process backend cannot keep latency and reliability within acceptable bounds.

The app has two different performance profiles:

1. Up to around 1,000 VUs, Redis helps and p95 remains usable.
2. At 10,000 VUs, the system falls into queueing and timeout behavior.

The 10k issue is likely a combined capacity problem:

- Single Node process.
- Local TCP backlog and socket pressure.
- MongoDB query pressure.
- Redis/client queue pressure.
- Cache stampede risk on misses.
- Similar recommendation route doing expensive work under load.
- Product listing route doing product fetch plus count/facet work on cache miss.

## Recommended Fix Plan

1. Add per-endpoint k6 metrics.
   The current JSON summary is scenario-level. We need exact p95, p99, and failure rate per route.

2. Fix similar recommendations first.
   Precompute similar products, extend cache TTL, or return a fast fallback under pressure. This route repeatedly timed out in both runs.

3. Split product list data from facets.
   `/api/products` currently does product query, count, distinct brand, distinct category, and category aggregation on cache miss. Cache facets separately or precompute them after writes.

4. Add request coalescing to cache misses.
   If 5,000 users request the same uncached key, only one database query should run and the rest should await that result.

5. Increase cache TTLs for catalog and recommendations.
   Current default is 30 seconds. For high traffic, try 2-5 minutes for catalog and similar recommendations, then invalidate on product writes.

6. Keep Redis, but monitor it.
   Redis running is necessary, but under load we still saw Redis cache timeouts. Track Redis latency, connected clients, command rate, and memory.

7. Run multiple API workers.
   A single local Node process is not a realistic target for 10k users. Use cluster/PM2/Docker replicas behind a load balancer.

8. Tune connection limits.
   Increase OS backlog limits and Node/server keep-alive behavior for high concurrency tests.

9. Add graceful load shedding.
   Noncritical routes such as similar recommendations should serve stale/fallback data instead of holding requests until 30 seconds.

10. Retest with production-like staging.
    Local 10k tests are useful, but the real answer needs load balancer, multiple API instances, production-sized Redis, MongoDB metrics, and server CPU/memory telemetry.

## Artifacts

- Current Redis-on raw summary: `reports/load/backend-load-summary.json`
- Archived Redis-on raw summary: `reports/load/archive/backend-load-summary-redis-on-2026-08-05.json`
- Archived Redis-off raw summary: `reports/load/archive/backend-load-summary-redis-off-2026-08-05.json`
- Archived Redis-off report: `reports/load/archive/backend-load-report-redis-off-2026-08-05.md`
- Current comparison report: `reports/load/backend-load-report.md`
