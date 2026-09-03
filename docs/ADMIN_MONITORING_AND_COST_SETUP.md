# Lookmefy Admin Monitoring and Cost Setup

The admin backend now supports persistent request metrics, a Prometheus scrape endpoint, live provider probes, direct Bunny reconciliation, and optional live billing integrations. Missing credentials remain `not_connected`; they are never represented as a zero balance.

## 1. Backend environment

Set these values in `/etc/fitlook/backend.env` on both API instances:

```dotenv
PERSIST_REQUEST_METRICS=true
REQUEST_METRICS_FLUSH_MS=10000
REQUEST_METRICS_RETENTION_DAYS=30
ADMIN_METRICS_WINDOW_HOURS=24
METRICS_BEARER_TOKEN=<long-random-secret>
NGINX_STATUS_URL=http://127.0.0.1/nginx_status
```

Both instances must use distinct `INSTANCE_NAME` values. Request buckets are stored in MongoDB and aggregated by the admin API, so restarts and load-balancer distribution no longer split the 24-hour view.

Run indexes once after deployment:

```bash
sudo bash -lc 'set -a; source /etc/fitlook/backend.env; set +a; cd /opt/fitlook; npm run db:create-indexes'
```

## 2. Nginx status

Each backend Nginx server needs this localhost-only location:

```nginx
location = /nginx_status {
  stub_status;
  allow 127.0.0.1;
  deny all;
}
```

Validate with `curl -fsS http://127.0.0.1/nginx_status`. Do not expose this route publicly.

## 3. Prometheus or CloudWatch

Prometheus can scrape `https://api.lookmefy.com/api/metrics/prometheus` with `Authorization: Bearer <METRICS_BEARER_TOKEN>`. The endpoint is hidden with `404` when no token is configured.

For AWS, attach the CloudWatch Agent or an OpenTelemetry collector to both instances and use the same instance/environment labels. Configure external checks against:

- `https://api.lookmefy.com/api/health/live` for process availability.
- `https://api.lookmefy.com/api/health/ready` for MongoDB/Redis readiness.

Alerts should cover: readiness failure for two consecutive checks, HTTP 5xx rate above 2%, p95 above 2 seconds, disk above 80%, memory above 85%, and no healthy backend target. An SNS topic/email/Slack destination is required before alerts can notify anyone.

## 4. Live costs

### AWS

Set `AWS_COST_EXPLORER_ENABLED=true`. The integration caches responses for six hours by default because Cost Explorer data normally refreshes daily; override that with `AWS_COST_CACHE_MS` only when needed. Attach an EC2 instance role with this minimum read-only permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "ce:GetCostAndUsage",
    "Resource": "*"
  }]
}
```

The backend uses IMDSv2 credentials. Static AWS keys are only a local fallback.
The API follows Cost Explorer pagination and groups month-to-date `UnblendedCost` by AWS service. Cost Explorer API requests are billable, so do not disable or aggressively shorten the cache in production.
For local development, set `AWS_PROFILE` to a dedicated read-only profile in `~/.aws/credentials`; never copy access keys into the project `.env` file.

### FAL / PixVerse

Set `FAL_ADMIN_KEY` to a FAL platform key with model usage access. `FAL_KEY` remains the inference key. The provider page shows live month-to-date cost and model usage when the admin key has the required scope.

### Bunny

Set `BUNNY_ACCOUNT_API_KEY` for account statistics. Keep `BUNNY_STORAGE_API_KEY` as the separate Storage Zone password. The Storage page uses the Storage API to compare live files with database references.

### MongoDB Atlas

Create an Atlas service account with `Organization Billing Viewer`, then set:

```dotenv
MONGODB_ATLAS_CLIENT_ID=
MONGODB_ATLAS_CLIENT_SECRET=
MONGODB_ATLAS_ORG_ID=
```

The admin reads pending invoice totals through Atlas OAuth. It never stores the short-lived OAuth token in MongoDB.

### Pruna

Pruna's public prediction API does not expose account billing in this integration. Lookmefy continues to show recorded price estimates. Set `PRUNA_HEALTH_URL` only when Pruna provides a documented, non-mutating account health endpoint.

PhonePe settlement and OTP wallet integrations remain intentionally deferred.

## 5. Bunny retention and deletion

`Scan Bunny` lists the storage zone recursively and reports:

- Files present in Bunny and referenced by MongoDB.
- Orphan files present only in Bunny.
- Missing files referenced by MongoDB but absent from Bunny.

Deletion requires the exact `DELETE` confirmation, re-runs reconciliation, accepts no more than 100 files, and rejects files newer than `MEDIA_ORPHAN_DELETE_MIN_AGE_DAYS` (default 7). Automatic deletion is disabled. A truncated scan cannot delete anything.
