#!/usr/bin/env bash
set -Eeuo pipefail

ROLLBACK=/etc/lookmefy/phase11-rollback-20260929/rollback.sh
fail_and_rollback() {
  echo 'Backend cutover check failed; starting rollback' >&2
  "$ROLLBACK" || echo 'ROLLBACK FAILED; inspect production immediately' >&2
  exit 1
}

check_ready() {
  curl -fsS --max-time 6 "$1" 2>/dev/null |
    python3 -c 'import json,sys; x=json.load(sys.stdin); c=x.get("checks",{}); sys.exit(0 if x.get("ok") is True and all(c.get(k)=="ready" for k in ("mongo","redis","queue")) else 1)' 2>/dev/null
}

test ! -e /opt/lookmefy/.env || fail_and_rollback
test -f /etc/lookmefy/phase11-rollback-20260929/.env || fail_and_rollback
systemctl restart lookmefy-backend.service || fail_and_rollback

local_ready=0
for attempt in $(seq 1 15); do
  if systemctl is-active --quiet lookmefy-backend.service &&
     check_ready http://127.0.0.1:5050/api/health/ready; then
    local_ready=1
    break
  fi
  sleep 2
done
test "$local_ready" -eq 1 || fail_and_rollback
echo 'BACKEND=active LOCAL_READY=true MONGODB=ready REDIS=ready QUEUE=ready'

public_ready=0
for attempt in $(seq 1 5); do
  if check_ready https://api.lookmefy.in/api/health/ready; then
    public_ready=1
    break
  fi
  sleep 2
done
test "$public_ready" -eq 1 || fail_and_rollback
systemctl is-active --quiet lookmefy-backend.service || fail_and_rollback
echo 'PUBLIC_READY=true BACKEND_CUTOVER=passed'
