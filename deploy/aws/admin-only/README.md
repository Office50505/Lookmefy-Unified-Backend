# FitLook Admin-Only AWS Deployment

Use this Terraform module when moving only the admin panel from Netlify to a new AWS EC2 `t4g.micro` instance.

Do not run `deploy/aws/terraform` for this change. That folder manages the full stack and can create backend plus storefront instances.

## What This Creates

- One admin EC2 instance: `t4g.micro`
- One admin security group
- One Elastic IP for the admin panel
- One optional backend security-group rule so the admin instance can call the existing backend on port `80`

It does not create or run the customer website frontend. It does not create or run the backend.

## Setup

```sh
cd deploy/aws/admin-only
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

- `key_name`: existing AWS EC2 key pair
- `ssh_cidr`: your public IP with `/32`
- `repo_url`: Git URL the EC2 instance can clone
- `backend_private_ip`: private IP of the existing backend EC2 instance
- `backend_security_group_id`: existing backend SG ID, recommended if backend currently only allows HTTP from the old frontend SG
- `store_base_url`: current customer website URL for admin preview links
- `vpc_id` and `subnet_id`: set these if the backend is not in the default VPC

## Apply

```sh
terraform init
terraform plan
terraform apply
```

The plan should be small: admin security group, admin Elastic IP, admin EC2 instance, EIP association, and optionally one backend SG ingress rule. It should not show backend or storefront EC2 instances.

## Verify

After apply:

```sh
terraform output admin_url
terraform output admin_health_check_url
```

Open `admin_url` for the admin panel. The admin instance serves the static admin build with Nginx and proxies `/api` and `/uploads` to the existing backend private IP.

For deploy logs on the instance:

```sh
sudo tail -n 200 /var/log/cloud-init-output.log
sudo nginx -t
```

To redeploy the latest repo branch later:

```sh
sudo /usr/local/bin/deploy-fitlook-admin
```
