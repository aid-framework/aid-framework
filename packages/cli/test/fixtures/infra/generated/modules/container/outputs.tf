output "api_endpoint" {
  description = "The load balancer base URL, empty when the plan declares no routes."
  value       = length(aws_lb.this) > 0 ? "http://${aws_lb.this[0].dns_name}" : ""
}

output "service_names" {
  value = { for id, service in aws_ecs_service.service : id => service.name }
}

output "cluster_name" {
  value = length(aws_ecs_cluster.this) > 0 ? aws_ecs_cluster.this[0].name : ""
}
