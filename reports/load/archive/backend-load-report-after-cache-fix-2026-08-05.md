# FitLook Backend Load Test Report

Generated: 2026-08-05T10:18:02.895Z
Environment: local Mac backend, local MongoDB, local Redis on `localhost:6379`
Base URL: `http://localhost:5050`
Test command: `k6 run tests/load/backend-load.k6.js`
Stage duration: 30s per stage
Target stages: 10, 100, 1,000, and 10,000 simultaneous virtual users
External/paid generation enabled: false
Global product delete enabled: false

## Executive Summary

The safest backend cache changes helped a lot. With Redis running and the product/recommendation cache coalescing change applied, the 10,000-user stage no longer sat at the 30s timeout ceiling. The 10k p95 latency moved from about 30,000 ms before the fix to 3,302 ms after the fix, an 89.0% improvement. Throughput also improved from 347 req/s overall before the fix to 782 req/s after the fix.

The app is still not production-ready for a real 10,000 simultaneous-user event on a single local Node process. The backend survives the synthetic 10k burst much better now, but the local process still saturates at that stage: p95 is 3.3s, p99 is 4.0s, and k6 still exits non-zero because the global failure/check thresholds are not passing.

The strongest current bottleneck is no longer "Redis was missing" or "every hot product list request hits Mongo." The remaining bottleneck is capacity and write/authenticated route pressure at the 10k local stage: one local Node process, one local MongoDB, one local Redis, no horizontal scaling, and a load script that mixes reads with authenticated/user-event routes.

## Result Comparison

| Run | Redis | Backend cache fix | Requests | Req/s | Overall p95 | Overall p99 | HTTP failure rate | Check pass rate |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Redis off | No | No | 120,852 | 402.63 | 30,000.31 ms | 30,001.94 ms | 33.78% | 83.11% |
| Redis on, before fix | Yes | No | 104,181 | 347.16 | 30,000.36 ms | 30,001.54 ms | 35.88% | 82.06% |
| Redis on, after fix | Yes | Yes | 190,164 | 781.61 | 3,247.33 ms | 3,952.76 ms | 26.94% | 86.53% |

## Stage-Level Comparison

| Users | Before requests | After requests | Before p95 | After p95 | p95 change | Before p99 | After p99 | Failure rate after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 300 | 300 | 3.80 ms | 4.49 ms | -18.1% | 138.08 ms | 94.59 ms | 26.67% |
| 100 | 2,982 | 3,000 | 8.92 ms | 8.73 ms | 2.2% | 388.36 ms | 23.96 ms | 26.30% |
| 1,000 | 18,694 | 30,000 | 86.15 ms | 13.98 ms | 83.8% | 17,199.67 ms | 44.58 ms | 26.69% |
| 10,000 | 82,179 | 156,838 | 30,000.43 ms | 3,302.23 ms | 89.0% | 30,002.12 ms | 3,981.03 ms | 27.00% |

## What The App Is Hitting Now

- Overall after the fix: 190,164 requests in about 4m03s, or 781.61 req/s.
- 10k stage after the fix: 156,838 requests in the 30s stage, which is roughly 5,228 req/s during that stage.
- 10k latency after the fix: average 951.36 ms, median 715.81 ms, p90 2,495.73 ms, p95 3,302.23 ms, p99 3,981.03 ms.
- 1k latency after the fix: p95 13.98 ms and p99 44.58 ms, which is healthy for the cached read-heavy path in this local setup.

## Bottlenecks And Fixes

| Bottleneck | Evidence | Safest fix |
| --- | --- | --- |
| Single local backend process saturates at 10k VUs | 1k p95 is 13.98 ms, but 10k p95 jumps to 3,302.23 ms | Run multiple Node workers/processes behind a load balancer in production; for local testing, use `pm2`/cluster or container replicas before claiming 10k capacity |
| Global request/check thresholds still fail | k6 exit code 99, HTTP failure rate 26.94%, check pass rate 86.53% | Add endpoint-level k6 metrics so we can identify which routes return unexpected statuses, then fix the specific failing routes instead of guessing |
| Authenticated/write routes are mixed into the 10k read test | Load journey includes `/api/auth/me`, `/api/recommendations/for-you`, `/api/tryons`, and `POST /api/recommendations/events` | Split tests into `read-heavy browse`, `authenticated browse`, and `write/event` profiles; tune each separately |
| Mongo still receives pressure from uncached user-specific routes | Cached product/recommendation reads improved dramatically, but global failure rate remains high | Add targeted caching for safe user-independent data, batch/debounce recommendation events, and add indexes for the exact query patterns used by `for-you`, `tryons`, and events |
| Redis/local event loop still shows stress at shutdown | Backend printed pending `Redis cache timeout` messages after the 10k burst | Keep Redis on a separate host in staging/production, tune Redis timeout/pool behavior after endpoint-level profiling, and avoid relying on local single-machine results for capacity claims |
| 10k test is local-machine limited | Backend, k6, Redis, Mongo, and OS networking all share the same machine | Re-run from a separate load-generator machine or cloud k6 runner against a staging deployment before using the numbers as production capacity |

## What Changed In The Safe Backend Pass

- Product list/detail cache TTL default was increased from 30s to 5 minutes.
- Similar-product recommendation cache TTL default was increased from 30s to 5 minutes.
- Product list, product detail, and similar-product reads now use the hybrid cache more consistently.
- Cache `remember()` now coalesces in-flight loads for the same key, so a hot key under burst traffic triggers one loader instead of thousands of duplicate Mongo calls.

These are backend-only changes. They do not change frontend UI behavior.

## Recommended Next Backend Steps

1. Add endpoint-level k6 summary output for `endpoint` tags so the failure rate points to exact routes.
2. Run three separate profiles: read-only catalog, authenticated browsing, and write/event ingestion.
3. Add low-risk Mongo indexes for the slow query patterns found in those profiles.
4. Batch or buffer recommendation event writes under load.
5. Run the same test against a production-like staging stack with separate load generator, Redis, Mongo, and multiple backend workers.

## Artifacts

- Current raw summary: `reports/load/backend-load-summary.json`
- Current comparison report: `reports/load/backend-load-report.md`
- Archived Redis-off summary: `reports/load/archive/backend-load-summary-redis-off-2026-08-05.json`
- Archived Redis-on before-fix summary: `reports/load/archive/backend-load-summary-redis-on-before-cache-fix-2026-08-05.json`
- Archived Redis-on after-fix summary: `reports/load/archive/backend-load-summary-after-cache-fix-2026-08-05.json`
- Archived final comparison report: `reports/load/archive/backend-load-report-after-cache-fix-2026-08-05.md`
- Archived raw after-fix report: `reports/load/archive/backend-load-report-after-cache-fix-raw-2026-08-05.md`
