output "distribution_domain_name" {
  description = "The cloudfront.net name the app answers on."
  value       = length(aws_cloudfront_distribution.edge) > 0 ? aws_cloudfront_distribution.edge[0].domain_name : ""
}

output "distribution_id" {
  value = length(aws_cloudfront_distribution.edge) > 0 ? aws_cloudfront_distribution.edge[0].id : ""
}

output "function_versions" {
  description = "Deployment id -> the published version CloudFront runs."
  value       = { for id, function in aws_lambda_function.edge : id => function.qualified_arn }
}

output "secret_arns" {
  description = "Deployment id -> the secret to populate with the app environment."
  value       = { for id, secret in aws_secretsmanager_secret.edge : id => secret.arn }
}
