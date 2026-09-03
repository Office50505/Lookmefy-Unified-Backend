# FitLook Admin Manual AWS Deployment

Use this when you create the admin EC2 instance manually in AWS and deploy through a `.pem` file plus public IP.

This deploys only the admin panel. It does not deploy the customer website and it does not deploy the backend.

## 1. Create The EC2 Instance

In AWS Console, create a new EC2 instance:

- AMI: Ubuntu Server 24.04 LTS, arm64
- Instance type: `t4g.micro`
- Key pair: use or create a `.pem` key
- Network: use the same VPC as the existing backend
- Subnet: preferably same VPC/private network as backend
- Auto-assign public IP: enabled, or attach an Elastic IP after launch

Security group for the admin instance:

- SSH `22`: your public IP only, for example `YOUR_IP/32`
- HTTP `80`: `0.0.0.0/0`
- HTTPS `443`: `0.0.0.0/0`, optional now but useful if you add SSL later

Important: the existing backend security group must allow HTTP `80` from the new admin instance security group. If AWS Console does not let you pick the admin security group, temporarily allow the admin instance private IP with `/32`.

## 2. Deploy From Your Mac

From the repo root:

```sh
./deploy/aws/admin-manual/deploy-admin.sh \
  /path/to/key.pem \
  ADMIN_PUBLIC_IP \
  BACKEND_PRIVATE_IP \
  https://YOUR_EXISTING_WEBSITE_URL
```

Example:

```sh
./deploy/aws/admin-manual/deploy-admin.sh \
  ~/Downloads/fitlook-admin.pem \
  13.201.10.20 \
  172.31.10.50 \
  https://fitlook.example.com
```

The script builds `admin/` locally, uploads the static files with `scp`, installs Nginx on the EC2 instance, serves the admin panel from `/var/www/fitlook-admin`, and proxies:

- `/api/*` to `http://BACKEND_PRIVATE_IP:80`
- `/uploads/*` to `http://BACKEND_PRIVATE_IP:80`

## 3. Verify

Open:

```txt
http://ADMIN_PUBLIC_IP
```

Check backend access through the admin server:

```txt
http://ADMIN_PUBLIC_IP/api/health
```

On the server, useful checks are:

```sh
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
sudo tail -n 200 /var/log/cloud-init-output.log
```

## Redeploy Later

Run the same `deploy-admin.sh` command again. It will rebuild locally and upload the latest admin panel.
