# FitLook Backend Load Test Report

Generated: 2026-08-05T09:42:26.000Z

## Executive Summary

This was a staged k6 backend load test against the local FitLook API process at `http://localhost:5050`. The test reached the requested 10,000 simultaneous virtual users for a 30-second constant-VU window after earlier 10, 100, and 1,000 user stages.

The backend remained alive after the run and `/api/health` returned `{"ok":true,"mongo":true}` immediately afterward. However, the run did not meet the configured pass criteria. k6 exited with code 99 because the global check pass-rate threshold and global HTTP failure-rate threshold were crossed, and the 10,000-user p95 latency threshold failed.

The practical result is: FitLook can survive a short 10k VU burst without the Node process dying, but it cannot currently serve that load within acceptable latency or reliability. The failure pattern is dominated by request timeouts at the 10k stage, especially on product listing/search/featured reads and similar-product recommendation reads.

## Test Configuration

| Item | Value |
| --- | --- |
| Tool | k6 v2.0.0 |
| Script | `tests/load/backend-load.k6.js` |
| Base URL | `http://localhost:5050` |
| Backend command | `npm run server` |
| Stage targets | 10, 100, 1,000, 10,000 simultaneous VUs |
| Stage duration | 30 seconds each |
| Smoke window | 2 minutes |
| Max timeout per request | 30 seconds |
| Paid/external AI generation | Disabled |
| Global delete-all-products route | Disabled |
| Test machine | macOS arm64, 16 GB RAM, 10 logical CPUs |
| Max initialized VUs | 11,000 |

The script performed one smoke pass first, then ran one request per virtual-user journey iteration during load. The journey mix included:

- Health checks.
- Product listing reads.
- Product search reads.
- Featured product listing reads.
- Product detail reads.
- Similar product recommendation reads.
- Authenticated profile reads.
- Authenticated recommendation reads.
- Try-on history reads.
- Recommendation event writes.

## Pass/Fail Status

| Criterion | Configured expectation | Result |
| --- | ---: | --- |
| Overall checks | `rate > 0.95` | Failed: `0.8311` |
| Overall HTTP failures | `rate < 0.10` | Failed: `0.3378` |
| 10 VU p95 latency | `< 1,500 ms` | Passed: `4.14 ms` |
| 100 VU p95 latency | `< 2,500 ms` | Passed: `13.93 ms` |
| 1,000 VU p95 latency | `< 5,000 ms` | Passed: `113.70 ms` |
| 10,000 VU p95 latency | `< 10,000 ms` | Failed: `30,000.36 ms` |

The 10k p95 is effectively the request timeout ceiling, so at least 5% of requests in that stage reached the 30-second timeout limit.

## Stage Results

| Simultaneous users | Requests | Approx stage req/s | Avg latency | Median | p90 latency | p95 latency | p99 latency | HTTP failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 299 | 10.0/s | 8.73 ms | 2.08 ms | 3.77 ms | 4.14 ms | 97.73 ms | 25.75% | 87.12% |
| 100 | 2,992 | 99.7/s | 11.18 ms | 1.68 ms | 4.67 ms | 13.93 ms | 220.63 ms | 26.80% | 86.60% |
| 1,000 | 18,198 | 606.6/s | 658.65 ms | 2.78 ms | 46.42 ms | 113.70 ms | 22,050.36 ms | 27.03% | 86.48% |
| 10,000 | 99,337 | 3,311.2/s | 2,685.38 ms | 10.89 ms | 1,429.07 ms | 30,000.36 ms | 30,002.79 ms | 35.25% | 82.38% |

Important nuance: the low medians and high tail latencies mean many requests were still fast, but a large minority piled up and timed out. That is queueing behavior, not a uniform slowdown.

## Overall Results

| Metric | Value |
| --- | ---: |
| Total HTTP requests | 120,852 |
| Completed iterations | 120,630 |
| Interrupted iterations | 197 |
| Average request rate | 402.63 req/s across full 5-minute test wall time |
| HTTP failure rate | 33.78% |
| Approx failed HTTP requests | 40,826 |
| Approx successful HTTP requests | 80,026 |
| Check pass rate | 83.11% |
| Check passes | 200,876 |
| Check failures | 40,826 |
| Overall avg latency | 2,307.05 ms |
| Overall median latency | 6.43 ms |
| Overall p90 latency | 1,255.45 ms |
| Overall p95 latency | 30,000.31 ms |
| Overall p99 latency | 30,001.94 ms |
| Max observed latency | 30,028.47 ms |
| Data received | 1,022,292,620 bytes |
| Data sent | 15,218,799 bytes |

## What Happened Under Load

The backend handled the 10 and 100 VU stages with very low p95 latency, but the HTTP failure rate was already high even at low concurrency. That indicates the load script is receiving non-expected responses on a meaningful fraction of requests even before the 10k stress point. Because the summary artifact does not include endpoint-tagged submetrics, the exact low-stage endpoint split is not available from the JSON alone.

At 1,000 VUs, the median and p95 stayed healthy, but p99 jumped to 22 seconds. This is the first clear sign of tail saturation: most requests still moved quickly, while the slowest 1% began waiting behind constrained resources.

At 10,000 VUs, saturation became obvious. p95 and p99 both hit the 30-second timeout boundary, and the failure rate rose to 35.25%. k6 also reported repeated request timeouts for:

- `GET /api/products?limit=24`
- `GET /api/products?limit=24&q=shirt`
- `GET /api/products?limit=24&featured=true`
- `GET /api/products/:id`
- `GET /api/recommendations/similar/:productId?limit=4`

After the 10k window closed, 531 VUs were still draining for an extended tail period. The teardown cleanup delete for the disposable product also timed out once, which suggests the backend or database was still heavily queued after active load ended.

## Bottleneck Interpretation

The strongest signal is backend/database saturation rather than network transfer cost. Request sending and receiving times stayed very small compared with waiting time:

| Metric | p95 | p99 | Interpretation |
| --- | ---: | ---: | --- |
| `http_req_waiting` | 30,000.27 ms | 30,001.83 ms | Server-side wait dominates the tail. |
| `http_req_sending` | 2.82 ms | 12.33 ms | Client upload overhead is not the bottleneck. |
| `http_req_receiving` | 0.09 ms | 0.36 ms | Download time is not the bottleneck. |
| `http_req_blocked` | 237.80 ms | 417.70 ms | Some client-side connection queuing exists, but it is smaller than server wait. |

Given the affected endpoints, likely pressure points are:

- MongoDB query volume on product listing, search, and featured filters.
- Similar-product recommendation query shape or missing indexes.
- Node/Express request concurrency and MongoDB connection pool saturation.
- Local single-process backend capacity; this run did not test a horizontally scaled production topology.
- Possible k6 generator pressure at 10k local VUs, though the dominant timeout signature is server waiting.

## Reliability Notes

The service stayed reachable after the run. That is good: the API process did not crash, and MongoDB still reported connected through `/api/health`.

The service did not recover all in-flight work cleanly before k6 teardown. The timeout on `DELETE /api/products/:id cleanup` showed that administrative cleanup was still queued after the 10k burst. After the test, the API was restarted briefly and the disposable product was deleted successfully. The product ID from this run was:

`6a7304556aee2d04a42a0cf0`

## Test Limitations

This was a local load generator hitting a local Node API process. It is a useful backend stress test, but it is not the same as a full production capacity test behind CDN, load balancer, multiple Node workers, autoscaling, regional networking, and production observability.

Endpoint-level aggregate metrics were not emitted into the k6 summary because the current script only thresholds by scenario, not by endpoint tag. The console showed timeout-heavy endpoints, but the raw JSON cannot calculate exact per-endpoint error rates. The next version of the k6 script should add explicit endpoint metrics or threshold tags so reports can rank endpoints by p95, p99, and failure rate.

The test used one shared authenticated user and one disposable product. That is useful for repeatability, but it can over-concentrate hot keys and query paths compared with real traffic.

External AI generation was intentionally disabled, so this report does not measure FAL/Fitroom/OpenAI image generation behavior under 10k users.

## Recommendations

1. Add endpoint-tagged k6 thresholds and custom counters.
   This will let future reports say exactly which endpoints fail first and by how much.

2. Profile MongoDB queries for product list, product search, featured products, and similar recommendations.
   These were the endpoints visibly timing out during the 10k stage.

3. Add or verify indexes for common product filters.
   Focus on active/deleted status, category, featured/new flags, text search fields, tags, brand, gender, and recommendation lookup fields.

4. Add short-TTL cache coverage for read-heavy catalog endpoints.
   A 10k traffic wave will repeatedly request the same product listing/search pages. Cache hits should absorb most of that load.

5. Protect expensive recommendation routes.
   Consider precomputed similar-product lists, bounded query fanout, cache keys by product ID, and fast fallback responses under pressure.

6. Run Node in clustered or horizontally scaled mode before another 10k test.
   A single Node process is not the architecture to judge final 10k user readiness.

7. Tune MongoDB connection pool and server timeouts.
   Current behavior suggests request queues can become very deep. Failing fast with graceful fallback is better than holding thousands of requests until 30 seconds.

8. Add load-shedding and rate limiting.
   For noncritical routes, return cached/stale/fallback data before the backend enters a timeout cascade.

9. Repeat the test with production-like infrastructure.
   Use isolated staging data, production-sized indexes, multiple API instances, real Redis if intended, and observability dashboards.

10. Keep destructive and paid endpoints disabled until isolated.
    The current defaults were correct for this run.

## Suggested Next Test Plan

The next test should not immediately repeat 10k. Start with instrumentation:

- Add per-endpoint k6 submetrics.
- Capture API process CPU and memory.
- Capture MongoDB query profiler output.
- Capture connection pool stats.
- Capture Redis availability and cache hit rates if Redis is part of the intended deployment.

Then run:

| Test | Target | Duration | Goal |
| --- | ---: | ---: | --- |
| Baseline | 100 VUs | 5 min | Confirm low-stage failures and identify endpoints. |
| Sustained | 1,000 VUs | 10 min | Validate p99 behavior and DB stability. |
| Spike | 5,000 VUs | 2 min | Observe recovery and queue clearing. |
| Peak | 10,000 VUs | 1 min | Re-test after caching/indexing/scaling changes. |

## Artifacts

- Raw k6 summary: `reports/load/backend-load-summary.json`
- Report: `reports/load/backend-load-report.md`
