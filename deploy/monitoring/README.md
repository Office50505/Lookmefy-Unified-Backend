# Lookmefy Monitoring

## Prometheus

Use `prometheus.yml` as the scrape baseline. Replace `${METRICS_BEARER_TOKEN}` with the same server-only value configured in production.

## Grafana

Import `grafana/lookmefy-overview-dashboard.json` and connect it to the Prometheus datasource.

Recommended alerts:

- API up is `0` for two checks.
- P95 latency stays above the endpoint target for five minutes.
- 5xx errors increase for five minutes.
- Process memory remains above the instance budget.
- Redis or Mongo readiness fails on `/api/health/ready`.

## Loki

Set these production env vars on the API process:

```sh
LOKI_ENABLED=true
LOKI_URL=https://your-loki-host
LOKI_USERNAME=
LOKI_PASSWORD=
CONSOLE_LOG_MIN_STATUS=500
STRUCTURED_REQUEST_LOGS=true
```

Request logs below 5xx go to Loki instead of production console when Loki is enabled.
