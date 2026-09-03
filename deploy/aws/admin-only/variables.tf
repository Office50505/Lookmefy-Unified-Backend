variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Name used for AWS resource tags."
  type        = string
  default     = "fitlook"
}

variable "environment" {
  description = "Environment name used for AWS resource tags."
  type        = string
  default     = "production"
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH access."
  type        = string
}

variable "ssh_cidr" {
  description = "CIDR allowed to SSH into the admin instance. Use your IP with /32."
  type        = string
}

variable "vpc_id" {
  description = "Optional VPC ID. Defaults to the default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Optional subnet ID for the admin instance. Defaults to the first subnet in the selected VPC."
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "Git URL for the FitLook repository. The admin EC2 instance must be able to clone it."
  type        = string
}

variable "repo_branch" {
  description = "Git branch to deploy."
  type        = string
  default     = "main"
}

variable "backend_private_ip" {
  description = "Private IP of the existing FitLook backend instance."
  type        = string
}

variable "backend_security_group_id" {
  description = "Optional existing backend security group ID. When set, Terraform adds an ingress rule allowing the admin instance to reach backend HTTP."
  type        = string
  default     = ""
}

variable "store_base_url" {
  description = "Public URL of the existing customer storefront, used by admin Preview links."
  type        = string
}
