# Lookmefy AWS Load Test Preflight Report

Generated: 2026-08-17T08:00:31Z

Requested stages: 10, 50, 100, 500, 1000, 10000 simultaneous users

## Result

The full k6 load test was not started because no valid deployed AWS API endpoint could be confirmed.

Running a 10k load profile against an unresolved domain, parked domain, or plain nginx placeholder would produce misleading failure numbers and unnecessary traffic. The app must first answer `/api/health` with the expected backend JSON response.

## Endpoint Checks

| Candidate | Check | Result |
| --- | --- | --- |
| `https://fitlook.in/api/health` | DNS + HTTPS health | DNS did not resolve from this machine |
| `http://fitlook.in/api/health` | DNS + HTTP health | DNS did not resolve from this machine |
| `https://lookmefy.com/api/health` | HTTPS health | Connection timed out |
| `https://www.lookmefy.com/api/health` | HTTPS health | TLS connection failed; domain resolves to parking infrastructure |
| `http://13.201.10.20/api/health` | Documented AWS/IP-style health check | HTTP 404 from nginx |
| `http://13.201.10.20/` | Root page | HTTP 200 nginx default page, not the app API |

AWS CLI discovery was also attempted in region `ap-south-1`, but the local AWS credentials are invalid, so EC2/load balancer discovery could not be used to find the current deployment.

## Intended k6 Command

Once the correct AWS app URL is available and `/api/health` returns healthy JSON, run:

```bash
BASE_URL=https://YOUR_AWS_LOOKMEFY_HOST \
TARGETS=10,50,100,500,1000,10000 \
STAGE_DURATION=30s \
THINK_TIME_SECONDS=1 \
k6 run tests/load/backend-public-read.k6.js
```

This will generate:

- `reports/load/aws-public-read-summary.json`
- `reports/load/aws-public-read-report.md`

## Why Public-Read

The production-safe script `tests/load/backend-public-read.k6.js` only exercises public GET routes. It does not create users, create products, call admin routes, delete catalog data, or trigger paid generation flows.

The broader `tests/load/backend-load.k6.js` script should be reserved for staging or for an explicitly approved production write/auth/admin test.

