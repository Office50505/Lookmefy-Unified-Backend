#!/bin/bash
set -euxo pipefail

AWS_REGION="ap-south-1"
DEPLOY_BUCKET="fitlook-backend-deploy-443845328552-ap-south-1"
APP_BUNDLE_KEY="releases/current.tar.gz"
ENV_KEY="env/production.env"
APP_DIR="/opt/fitlook"

dnf update -y
dnf install -y nodejs npm nginx awscli tar gzip

mkdir -p "$APP_DIR"
aws s3 cp "s3://${DEPLOY_BUCKET}/${APP_BUNDLE_KEY}" /tmp/fitlook-backend.tar.gz --region "$AWS_REGION"
tar -xzf /tmp/fitlook-backend.tar.gz -C "$APP_DIR"
aws s3 cp "s3://${DEPLOY_BUCKET}/${ENV_KEY}" "$APP_DIR/.env" --region "$AWS_REGION"
chmod 600 "$APP_DIR/.env"

cd "$APP_DIR"
npm ci --omit=dev
mkdir -p uploads
chown -R ec2-user:ec2-user "$APP_DIR"

cat >/etc/systemd/system/fitlook-backend.service <<'SERVICE'
[Unit]
Description=FitLook Backend API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/fitlook
EnvironmentFile=/opt/fitlook/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
User=ec2-user
Group=ec2-user

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/nginx/conf.d/fitlook.conf <<'NGINX'
server {
  listen 80 default_server;
  server_name _;

  client_max_body_size 30m;

  location / {
    proxy_pass http://127.0.0.1:5050;
    proxy_http_version 1.1;
    proxy_connect_timeout 30s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
NGINX

rm -f /etc/nginx/conf.d/default.conf
systemctl daemon-reload
systemctl enable --now fitlook-backend
systemctl enable --now nginx
systemctl restart nginx
