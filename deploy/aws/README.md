# FitLook AWS EC2 Deployment

This Terraform setup creates two ARM EC2 instances:

- Backend: `t4g.small`, Node/Express API, Redis cache, Nginx reverse proxy
- Frontend: `t4g.micro`, Vite static build, Nginx proxy for `/api` and `/uploads`

The app still needs an external MongoDB URI, for example MongoDB Atlas. Redis is installed on the backend instance and exposed only locally as `redis://127.0.0.1:6379`.

## Prerequisites

- AWS CLI credentials configured locally
- Terraform installed
- An existing EC2 key pair in the target AWS region
- This repo pushed to a Git URL that the EC2 instances can clone
- A production `MONGODB_URI`

## Deploy

```sh
cd deploy/aws/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

- Set `key_name` to your EC2 key pair name.
- Set `repo_url` to this repo's Git URL.
- Restrict `ssh_cidr` to your public IP, for example `203.0.113.10/32`.
- Fill `backend_env` with production values.

Then run:

```sh
terraform init
terraform apply
```

After apply completes, Terraform prints:

- `frontend_url`: open this in the browser
- `health_check_url`: backend health routed through the frontend instance
- SSH commands for both instances

## Important Notes

Terraform stores variable values in state. For a serious production setup, move secrets such as `JWT_SECRET`, `FAL_KEY`, payment credentials, and `MONGODB_URI` into AWS SSM Parameter Store or Secrets Manager instead of keeping them in `terraform.tfvars`.

The frontend calls `/api` and `/uploads` on its own host. Nginx on the frontend instance proxies those paths to the backend instance's private IP, so the backend API does not need to be public.

If you attach a domain later, point it to the frontend Elastic IP and update these backend env vars:

```sh
CLIENT_ORIGIN=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
PHONEPE_REDIRECT_URL=https://your-domain.com/tokens
PHONEPE_CALLBACK_URL=https://your-domain.com/api/payments/phonepe/callback
```

Then re-run:

```sh
terraform apply
```

## Useful Commands

Check frontend:

```sh
curl http://FRONTEND_IP
```

Check backend through frontend proxy:

```sh
curl http://FRONTEND_IP/api/health
```

Backend logs:

```sh
sudo journalctl -u fitlook-backend -f
```

Nginx logs:

```sh
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

Redis status on the backend instance:

```sh
redis-cli ping
```

## Destroy

```sh
terraform destroy
```
