locals {
  serverless = {
    for id, service in var.services : id => service
    if service.target == "serverless"
  }

  # Only a service with a route can be reached through the API, and a plan with no
  # route needs no API at all -- so the gateway is keyed off this, not off services.
  routed = {
    for id, service in local.serverless : id => service
    if length(service.routes) > 0
  }

  # One entry per (service, route), keyed the way the route key is written so the map
  # key is also the Terraform address -- a diff names the route that moved.
  routes = {
    for pair in flatten([
      for id, service in local.routed : [
        for route in service.routes : { service = id, method = route.method, path = route.path }
      ]
    ]) : "${pair.service} ${pair.method} ${pair.path}" => pair
  }

  name = {
    for id, service in local.serverless :
    id => "${var.project.namespace}-${var.project.name}-${id}"
  }

  # A literal env value is copied; a secret reference becomes a Lambda dynamic
  # reference, so the value never enters state or a plan file.
  literal_env = {
    for id, service in local.serverless : id => {
      for variable in service.env : variable.name => variable.value
      if variable.secret == false && variable.value != null
    }
  }

  secret_env = {
    for id, service in local.serverless : id => {
      for variable in service.env :
      variable.name => "{{resolve:secretsmanager:${var.secret_arns[variable.name]}:SecretString}}"
      if variable.secret
    }
  }
}

resource "aws_iam_role" "service" {
  for_each = local.serverless
  name     = "${local.name[each.key]}-role"
  tags     = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  for_each   = local.serverless
  role       = aws_iam_role.service[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "service" {
  for_each = local.serverless

  function_name = local.name[each.key]
  role          = aws_iam_role.service[each.key].arn
  package_type  = "Image"
  image_uri     = var.image_uris[each.key]
  tags          = var.tags

  memory_size = try(var.sizing[each.key].memory_mb, 1024)
  timeout     = try(var.sizing[each.key].timeout_seconds, 30)

  environment {
    variables = merge(local.literal_env[each.key], local.secret_env[each.key])
  }

  lifecycle {
    precondition {
      condition     = contains(keys(var.image_uris), each.key)
      error_message = "No image_uris entry for \"${each.key}\". Name the container image this service runs; deployments[].image is a ghcr.io registry, which Lambda cannot pull from."
    }

    precondition {
      condition     = !each.value.streaming
      error_message = "Service \"${each.key}\" declares streaming, which an HTTP API cannot deliver. Serve it from a container target, or drop streaming."
    }

    precondition {
      condition = alltrue([
        for variable in each.value.env : contains(keys(var.secret_arns), variable.name)
        if variable.secret
      ])
      error_message = "Service \"${each.key}\" references a secret with no secret_arns entry. Add name -> ARN for every secret it declares."
    }
  }
}

resource "aws_apigatewayv2_api" "http" {
  count         = length(local.routes) > 0 ? 1 : 0
  name          = "${var.project.namespace}-${var.project.name}"
  protocol_type = "HTTP"
  tags          = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  count       = length(local.routes) > 0 ? 1 : 0
  api_id      = aws_apigatewayv2_api.http[0].id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags
}

resource "aws_apigatewayv2_integration" "service" {
  for_each = local.routed

  api_id                 = aws_apigatewayv2_api.http[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.service[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "route" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.http[0].id
  route_key = "${each.value.method} ${each.value.path}"
  target    = "integrations/${aws_apigatewayv2_integration.service[each.value.service].id}"
}

# API Gateway cannot invoke a function without being told it may.
resource "aws_lambda_permission" "api" {
  for_each = local.routed

  statement_id  = "apigateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.service[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http[0].execution_arn}/*/*"
}
