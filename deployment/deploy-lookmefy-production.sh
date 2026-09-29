#!/usr/bin/env bash
set -Eeuo pipefail

HOST="65.2.123.254"
USER="ubuntu"
KEY="$HOME/Downloads/fitlook-backend-medium-key.pem"

echo "========================================"
echo " LOOKMEFY PRODUCTION DEPLOYMENT"
echo "========================================"

if [ ! -f "$KEY" ]; then
    echo "ERROR: SSH key not found:"
    echo "$KEY"
    exit 1
fi

echo
echo "Connecting to production server..."
echo

ssh \
    -i "$KEY" \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    "$USER@$HOST" \
    'cd /opt/lookmefy && ./deployment/deploy-lookmefy-production.sh'

echo
echo "========================================"
echo " LOOKMEFY DEPLOY COMMAND FINISHED"
echo "========================================"
