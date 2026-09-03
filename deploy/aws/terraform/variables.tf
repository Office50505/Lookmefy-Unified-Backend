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
  description = "CIDR allowed to SSH into the instances. Use your IP with /32."
  type        = string
}

variable "subnet_id" {
  description = "Optional subnet ID. Defaults to the first subnet in the default VPC."
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "Git URL for the FitLook repository. EC2 instances must be able to clone it."
  type        = string
}

variable "repo_branch" {
  description = "Git branch to deploy."
  type        = string
  default     = "main"
}

variable "backend_iam_role_name" {
  description = "Existing backend EC2 IAM role that receives Cost Explorer read permission."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_aws_cost_explorer || var.backend_iam_role_name != ""
    error_message = "backend_iam_role_name is required when enable_aws_cost_explorer is true."
  }
}

variable "backend_instance_profile_name" {
  description = "Existing IAM instance profile attached to the backend EC2 instance."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_aws_cost_explorer || var.backend_instance_profile_name != ""
    error_message = "backend_instance_profile_name is required when enable_aws_cost_explorer is true."
  }
}

variable "enable_aws_cost_explorer" {
  description = "Enable live AWS Cost Explorer reporting for the admin panel."
  type        = bool
  default     = false
}

variable "aws_cost_cache_ms" {
  description = "Backend cache duration for billable Cost Explorer API responses."
  type        = number
  default     = 21600000

  validation {
    condition     = var.aws_cost_cache_ms >= 900000 && var.aws_cost_cache_ms <= 86400000
    error_message = "aws_cost_cache_ms must be between 15 minutes and 24 hours."
  }
}

variable "backend_env" {
  description = "Environment variables written to /etc/fitlook/backend.env on the backend instance."
  type        = map(string)
  sensitive   = true
  default     = {}
}
