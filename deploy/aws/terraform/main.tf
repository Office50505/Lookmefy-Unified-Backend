provider "aws" {
  region = var.aws_region
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu_arm64" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  selected_subnet_id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default.ids[0]

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  backend_env = merge(
    {
      NODE_ENV                  = "production"
      PORT                      = "5050"
      REDIS_URL                 = "redis://127.0.0.1:6379"
      REDIS_KEY_PREFIX          = "fitlook"
      CLIENT_ORIGIN             = "http://${aws_eip.frontend.public_ip}"
      ADMIN_ORIGIN              = "http://${aws_eip.frontend.public_ip}"
      ALLOWED_ORIGINS           = "http://${aws_eip.frontend.public_ip}"
      PHONEPE_REDIRECT_URL      = "http://${aws_eip.frontend.public_ip}/tokens"
      PHONEPE_CALLBACK_URL      = "http://${aws_eip.frontend.public_ip}/api/payments/phonepe/callback"
      AWS_COST_EXPLORER_ENABLED = tostring(var.enable_aws_cost_explorer)
      AWS_COST_CACHE_MS         = tostring(var.aws_cost_cache_ms)
    },
    var.backend_env
  )

  backend_env_file = join("\n", [
    for key, value in local.backend_env : "${key}=${replace(tostring(value), "\n", "")}"
  ])
}

data "aws_iam_role" "backend" {
  count = var.enable_aws_cost_explorer ? 1 : 0
  name  = var.backend_iam_role_name
}

resource "aws_iam_role_policy" "backend_cost_explorer" {
  count = var.enable_aws_cost_explorer ? 1 : 0
  name  = "FitlookCostExplorerRead"
  role  = data.aws_iam_role.backend[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ce:GetCostAndUsage"
      Resource = "*"
    }]
  })
}

resource "aws_security_group" "backend" {
  name        = "${var.project_name}-${var.environment}-backend"
  description = "FitLook backend security group"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }

  ingress {
    description     = "HTTP from frontend"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.frontend.id]
  }

  egress {
    description = "Outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-sg"
  })
}

resource "aws_security_group" "frontend" {
  name        = "${var.project_name}-${var.environment}-frontend"
  description = "FitLook frontend security group"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-frontend-sg"
  })
}

resource "aws_eip" "backend" {
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-eip"
  })
}

resource "aws_eip" "frontend" {
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-frontend-eip"
  })
}

resource "aws_instance" "backend" {
  ami                         = data.aws_ami.ubuntu_arm64.id
  instance_type               = "t4g.small"
  subnet_id                   = local.selected_subnet_id
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.backend.id]
  associate_public_ip_address = true
  iam_instance_profile        = var.backend_instance_profile_name != "" ? var.backend_instance_profile_name : null
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  user_data = templatefile("${path.module}/templates/backend-user-data.sh.tftpl", {
    repo_url         = var.repo_url
    repo_branch      = var.repo_branch
    backend_env_file = local.backend_env_file
  })

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend"
    Role = "backend"
  })
}

resource "aws_eip_association" "backend" {
  instance_id   = aws_instance.backend.id
  allocation_id = aws_eip.backend.id
}

resource "aws_instance" "frontend" {
  ami                         = data.aws_ami.ubuntu_arm64.id
  instance_type               = "t4g.micro"
  subnet_id                   = local.selected_subnet_id
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.frontend.id]
  associate_public_ip_address = true
  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/templates/frontend-user-data.sh.tftpl", {
    repo_url           = var.repo_url
    repo_branch        = var.repo_branch
    backend_private_ip = aws_instance.backend.private_ip
  })

  root_block_device {
    volume_size = 12
    volume_type = "gp3"
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-frontend"
    Role = "frontend"
  })
}

resource "aws_eip_association" "frontend" {
  instance_id   = aws_instance.frontend.id
  allocation_id = aws_eip.frontend.id
}
