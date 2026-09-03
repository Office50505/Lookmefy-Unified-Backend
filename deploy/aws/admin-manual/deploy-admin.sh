#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy-admin.sh PEM_FILE ADMIN_PUBLIC_IP_OR_HOST BACKEND_PRIVATE_IP STORE_BASE_URL

Example:
  ./deploy-admin.sh ~/Downloads/fitlook.pem 13.201.10.20 172.31.10.50 https://your-store-domain.com

Notes:
  - ADMIN_PUBLIC_IP_OR_HOST can be either 13.201.10.20 or ubuntu@13.201.10.20.
  - BACKEND_PRIVATE_IP must be reachable from the admin EC2 instance on port 80.
  - The script builds admin/ locally, uploads the static files, and configures Nginx remotely.
USAGE
}

if [ "$#" -ne 4 ]; then
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PEM_FILE="$1"
ADMIN_HOST="$2"
BACKEND_PRIVATE_IP="$3"
STORE_BASE_URL="$4"

if [ ! -f "$PEM_FILE" ]; then
  echo "PEM file not found: $PEM_FILE" >&2
  exit 1
fi

if [[ "$ADMIN_HOST" != *@* ]]; then
  ADMIN_HOST="ubuntu@$ADMIN_HOST"
fi

chmod 400 "$PEM_FILE"

quote() {
  printf "%q" "$1"
}

SSH_OPTS=(
  -i "$PEM_FILE"
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30
)

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Building FitLook admin locally..."
(
  cd "$REPO_ROOT"
  VITE_API_BASE_URL= VITE_STORE_BASE_URL="$STORE_BASE_URL" npm run admin:build
  tar -C admin/dist -czf "$TMP_DIR/admin-dist.tgz" .
)

echo "Uploading installer to $ADMIN_HOST..."
scp "${SSH_OPTS[@]}" "$SCRIPT_DIR/remote-admin-install.sh" "$ADMIN_HOST:/tmp/fitlook-admin-install.sh"
scp "${SSH_OPTS[@]}" "$TMP_DIR/admin-dist.tgz" "$ADMIN_HOST:/tmp/fitlook-admin-dist.tgz"

REMOTE_ENV=(
  "BACKEND_PRIVATE_IP=$(quote "$BACKEND_PRIVATE_IP")"
  "ADMIN_DIST_ARCHIVE=/tmp/fitlook-admin-dist.tgz"
)

echo "Installing FitLook admin on $ADMIN_HOST..."
ssh "${SSH_OPTS[@]}" "$ADMIN_HOST" "sudo env ${REMOTE_ENV[*]} bash /tmp/fitlook-admin-install.sh"

echo
echo "Done. Open: http://${ADMIN_HOST#*@}"
echo "Health check: http://${ADMIN_HOST#*@}/api/health"
