output "backend_public_ip" {
  description = "Backend Elastic IP."
  value       = aws_eip.backend.public_ip
}

output "backend_private_ip" {
  description = "Backend private IP used by the frontend proxy."
  value       = aws_instance.backend.private_ip
}

output "frontend_public_ip" {
  description = "Frontend Elastic IP."
  value       = aws_eip.frontend.public_ip
}

output "frontend_url" {
  description = "Public frontend URL."
  value       = "http://${aws_eip.frontend.public_ip}"
}

output "health_check_url" {
  description = "Backend health check through the frontend proxy."
  value       = "http://${aws_eip.frontend.public_ip}/api/health"
}

output "ssh_backend" {
  description = "SSH command for the backend instance."
  value       = "ssh ubuntu@${aws_eip.backend.public_ip}"
}

output "ssh_frontend" {
  description = "SSH command for the frontend instance."
  value       = "ssh ubuntu@${aws_eip.frontend.public_ip}"
}
