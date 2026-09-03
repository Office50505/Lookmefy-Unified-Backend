output "admin_public_ip" {
  description = "Admin panel Elastic IP."
  value       = aws_eip.admin.public_ip
}

output "admin_url" {
  description = "Public admin panel URL."
  value       = "http://${aws_eip.admin.public_ip}"
}

output "admin_health_check_url" {
  description = "Backend health check through the admin panel proxy."
  value       = "http://${aws_eip.admin.public_ip}/api/health"
}

output "admin_security_group_id" {
  description = "Security group ID attached to the admin panel instance."
  value       = aws_security_group.admin.id
}

output "ssh_admin" {
  description = "SSH command for the admin panel instance."
  value       = "ssh ubuntu@${aws_eip.admin.public_ip}"
}
