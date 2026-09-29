#!/usr/bin/env bash
set -Eeuo pipefail

ROLLBACK=/etc/lookmefy/phase11-rollback-20260929
test -f "$ROLLBACK/.env"

# Restore the original dotenv file first, then remove the SSM drop-ins.
install -o ubuntu -g ubuntu -m 0600 "$ROLLBACK/.env" /opt/lookmefy/.env
rm -f /etc/systemd/system/lookmefy-backend.service.d/ssm.conf
rm -f /etc/systemd/system/lookmefy-worker.service.d/ssm.conf
rm -f /etc/systemd/system/lookmefy-load-ssm.service
systemctl daemon-reload
systemctl reset-failed lookmefy-backend.service lookmefy-worker.service
systemctl restart lookmefy-backend.service || true
systemctl restart lookmefy-worker.service || true

check_ready() {
  curl -fsS --max-time 6 "$1" 2>/dev/null |
    python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if x.get("ready") is True and all(x.get(k)=="ready" for k in ("database","redis","queue")) else 1)' 2>/dev/null
}

local_ready=0
for attempt in $(seq 1 15); do
  if systemctl is-active --quiet lookmefy-backend.service &&
     systemctl is-active --quiet lookmefy-worker.service &&
     check_ready http://127.0.0.1:5050/api/health/ready; then
    local_ready=1
    break
  fi
  sleep 2
done
test "$local_ready" -eq 1
echo 'local readiness: ready'

public_ready=0
for attempt in $(seq 1 5); do
  if check_ready https://api.lookmefy.in/api/health/ready; then
    public_ready=1
    break
  fi
  sleep 2
done
test "$public_ready" -eq 1
echo 'public readiness: ready'
echo 'Rollback complete; protected env copy retained.'
