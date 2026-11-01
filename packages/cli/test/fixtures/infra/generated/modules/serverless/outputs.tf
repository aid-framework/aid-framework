output "api_endpoint" {
  description = "The HTTP API base URL, empty when the plan declares no routes."
  value = (
    length(aws_apigatewayv2_stage.default) > 0
    ? aws_apigatewayv2_stage.default[0].invoke_url
    : ""
  )
}

output "function_names" {
  value = { for id, function in aws_lambda_function.service : id => function.function_name }
}

output "function_arns" {
  value = { for id, function in aws_lambda_function.service : id => function.arn }
}
