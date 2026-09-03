# FitLook AWS Public-Read Load Test Report

Generated: 2026-08-05T11:03:19.210Z
Base URL: `https://fitlook.in`
Deploy marker observed before test: `X-FitLook-Deploy: de502bd`
Stage duration: 30s
Targets: 10, 50, 100 VUs
Traffic profile: public GET routes only
Command:

```sh
BASE_URL=https://fitlook.in TARGETS=10,50,100 STAGE_DURATION=30s THINK_TIME_SECONDS=1 k6 run tests/load/backend-public-read.k6.js
```

## Executive Summary

The AWS backend is fast when requests are accepted and completed: p95 latency stayed around 44 ms across 10, 50, and 100 public-read VUs. That is a strong signal for the happy-path read performance of nginx + backend + Redis/Mongo when the stack is not dropping or timing out connections.

However, the test did not pass reliability thresholds. Failure rate rose from 0% at 10 VUs to 2.32% at 50 VUs and 3.89% at 100 VUs. k6 also logged request timeouts and dial/connect timeouts during the 100-VU stage. Immediately after the run, repeated health checks from the same terminal network path timed out before establishing a connection.

So the honest read is: AWS public reads are low-latency at modest load, but the current deployed ingress/backend stack is not reliable enough even at 100 safe read-only VUs. I stopped there and did not escalate to 500, 1000, or 10k.

## Stage Results

| Simultaneous users | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 250 | 32.88 ms | 42.79 ms | 44.31 ms | 58.85 ms | 0% | 100% |
| 50 | 777 | 38.14 ms | 42.77 ms | 44.80 ms | 58.72 ms | 2.32% | 98.84% |
| 100 | 1,310 | 31.33 ms | 41.55 ms | 43.36 ms | 58.65 ms | 3.89% | 98.05% |

## Overall

- Requests: 2,338
- Request rate: 25.65 req/s
- HTTP failure rate: 2.95%
- Check pass rate: 98.52%
- p95 latency: 44.16 ms
- p99 latency: 58.77 ms
- Max request duration: 4,819.44 ms
- k6 exit code: non-zero, thresholds crossed

## Slowest Endpoints

| Endpoint | Requests | Avg latency | p90 latency | p95 latency | p99 latency | Failure rate | Check pass rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/products?q= | 453 | 51.16 ms | 43.77 ms | 49.04 ms | 78.41 ms | 2% | 99% |
| GET /api/products | 568 | 40.17 ms | 43.34 ms | 48.30 ms | 60.29 ms | 3% | 99% |
| GET /api/products?category= | 269 | 39.37 ms | 43.42 ms | 47.20 ms | 59.31 ms | 5% | 98% |
| GET /api/recommendations/similar/:productId | 156 | 22.70 ms | 24.46 ms | 30.03 ms | 52.00 ms | 3% | 99% |
| GET /api/products?featured= | 370 | 21.75 ms | 24.56 ms | 26.95 ms | 38.05 ms | 3% | 99% |
| GET /api/products/:id | 231 | 21.73 ms | 23.49 ms | 24.75 ms | 30.30 ms | 3% | 98% |
| GET /api/health | 291 | 19.73 ms | 21.65 ms | 22.26 ms | 24.42 ms | 2% | 99% |

## Timeout Signal

k6 warnings during the 100-VU transition included:

- request timeout on product list/search/category/featured routes
- request timeout on product detail and similar recommendation routes
- dial/connect timeout on product and health routes

The raw k6 network timing supports that interpretation:

| Metric | p95 | p99 | Max |
| --- | ---: | ---: | ---: |
| `http_req_connecting` | 0 ms | 7,022.89 ms | 27,521.82 ms |
| `http_req_blocked` | 0.02 ms | 7,066.30 ms | 27,568.31 ms |
| `http_req_waiting` | 43.32 ms | 54.10 ms | 4,819.30 ms |

This means most successful requests were quick once connected, but a small tail of requests got stuck before or during connection establishment. That points toward nginx/instance/network/connection backlog limits, source-IP throttling, or local/AWS connection exhaustion more than a pure Mongo query latency problem.

## Post-Test Health

Before the run:

- `https://fitlook.in/api/health` returned `{"ok":true,"mongo":true}`
- `https://fitlook.in/api/products?limit=1` returned HTTP 200

Immediately after the run, repeated health checks from the same terminal network path timed out with `status=000` and no TCP connect time:

```text
curl: (28) Connection timed out after 10006 milliseconds
status=000 total=10.006s connect=0.000s starttransfer=0.000s
```

The site root was reachable from a separate browser-side fetch path, so this may be source-path throttling or connection exhaustion rather than full global downtime. Still, it is a serious production-readiness signal, and it is why I did not increase the load.

## What This Says About AWS

The deployed AWS stack appears to be good at serving accepted cached reads, but brittle under even moderate public concurrent load. The failure shape is different from the local 10k test:

- Local after-cache-fix: high 10k latency under a single local process, but massive local request generation.
- AWS read test: low latency for successful requests, but connection/request failures starting at 50-100 VUs.

Given the repo's AWS deployment notes, the likely current architecture is one backend EC2 instance behind nginx with Redis on the same instance. That is probably the main constraint.

## Recommended Fixes Before Larger AWS Tests

1. Check backend EC2 health during/after load: CPU, memory, network, nginx active connections, Node process status, and Redis status.
2. Raise nginx connection/backlog limits if they are still defaults: `worker_connections`, `worker_rlimit_nofile`, `keepalive_timeout`, and OS `somaxconn`/file descriptor limits.
3. Run the backend with multiple workers on the EC2 instance using PM2 cluster mode, at least one worker per vCPU.
4. Move Redis from local EC2 to ElastiCache before adding multiple backend instances.
5. Move uploads/session-like temporary state to shared services before horizontal scaling.
6. Put the backend behind an AWS Application Load Balancer and run at least two backend instances or ECS tasks for any serious concurrency claim.
7. Re-run this exact public-read test from a separate load generator after the nginx/process tuning.

## Artifacts

- Raw k6 summary: `reports/load/aws-public-read-summary.json`
- Archived raw k6 summary: `reports/load/archive/aws-public-read-summary-10-50-100-2026-08-05.json`
- Archived raw report: `reports/load/archive/aws-public-read-report-10-50-100-raw-2026-08-05.md`
- Safe public-read script: `tests/load/backend-public-read.k6.js`
