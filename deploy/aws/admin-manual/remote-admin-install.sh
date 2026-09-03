#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "$name is required" >&2
    exit 1
  fi
}

require_env BACKEND_PRIVATE_IP
require_env ADMIN_DIST_ARCHIVE

if [ ! -f "$ADMIN_DIST_ARCHIVE" ]; then
  echo "Admin build archive not found: $ADMIN_DIST_ARCHIVE" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates nginx

WEB_ROOT=/var/www/fitlook-admin

rm -rf "$WEB_ROOT"
mkdir -p "$WEB_ROOT"
tar -xzf "$ADMIN_DIST_ARCHIVE" -C "$WEB_ROOT"
chown -R www-data:www-data "$WEB_ROOT"

cat >/etc/nginx/sites-available/fitlook-admin <<NGINX
upstream fitlook_backend {
  server ${BACKEND_PRIVATE_IP}:80;
}

server {
  listen 80 default_server;
  server_name _;

  root /var/www/fitlook-admin;
  index index.html;

  client_max_body_size 25m;

  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml;

  location = /index.html {
    add_header Cache-Control "no-cache, must-revalidate" always;
    try_files /index.html =404;
  }

  location /api/ {
    proxy_pass http://fitlook_backend;
    proxy_http_version 1.1;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header Origin "";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location ^~ /uploads/ {
    proxy_pass http://fitlook_backend;
    proxy_http_version 1.1;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    send_timeout 300s;
    proxy_set_header Host \$host;
    proxy_set_header Origin "";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location ~* \.(?:js|css)$ {
    add_header Cache-Control "no-cache, must-revalidate" always;
    try_files \$uri =404;
  }

  location ~* \.(?:png|jpg|jpeg|gif|svg|webp|avif|woff2?)$ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files \$uri =404;
  }

  location / {
    add_header Cache-Control "no-cache, must-revalidate" always;
    try_files \$uri \$uri/ /index.html;
  }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/fitlook-admin /etc/nginx/sites-enabled/fitlook-admin
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "FitLook admin deployed to $WEB_ROOT"
