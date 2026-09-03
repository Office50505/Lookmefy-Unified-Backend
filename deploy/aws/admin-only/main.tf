provider "aws" {
  region = var.aws_region
}

data "aws_vpc" "default" {
  count = var.vpc_id == "" ? 1 : 0

  default = true
}

data "aws_subnets" "selected" {
  filter {
    name   = "vpc-id"
    values = [local.selected_vpc_id]
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
  selected_vpc_id    = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
  selected_subnet_id = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.selected.ids)[0]

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_security_group" "admin" {
  name        = "${var.project_name}-${var.environment}-admin"
  description = "FitLook admin frontend security group"
  vpc_id      = local.selected_vpc_id

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
    Name = "${var.project_name}-${var.environment}-admin-sg"
  })
}

resource "aws_security_group_rule" "backend_http_from_admin" {
  count = var.backend_security_group_id != "" ? 1 : 0

  type                     = "ingress"
  description              = "HTTP from FitLook admin frontend"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = var.backend_security_group_id
  source_security_group_id = aws_security_group.admin.id
}

resource "aws_eip" "admin" {
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-admin-eip"
  })
}

resource "aws_instance" "admin" {
  ami                         = data.aws_ami.ubuntu_arm64.id
  instance_type               = "t4g.micro"
  subnet_id                   = local.selected_subnet_id
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.admin.id]
  associate_public_ip_address = true
  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/templates/admin-user-data.sh.tftpl", {
    repo_url           = var.repo_url
    repo_branch        = var.repo_branch
    backend_private_ip = var.backend_private_ip
    store_base_url     = var.store_base_url
  })

  root_block_device {
    volume_size = 12
    volume_type = "gp3"
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-admin"
    Role = "admin"
  })
}

resource "aws_eip_association" "admin" {
  instance_id   = aws_instance.admin.id
  allocation_id = aws_eip.admin.id
}
