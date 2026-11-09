data "aws_region" "current" {}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  serverless = {
    for id, service in var.services : id => service
    if service.target == "serverless"
  }

  # A service that names Bedrock calls it with the function role, so the grant below is
  # the only credential it needs. `providers` is derived from the build's models, so this
  # is conservative: every function in a build that mentions Bedrock gets the grant.
  bedrock = {
    for id, service in local.serverless : id => service
    if contains(service.providers, "bedrock")
  }

  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : data.aws_region.current.region

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

  # Lambda names allow letters, digits, hyphens and underscores, while a namespace may
  # carry a dot; the replacement is what keeps `aid.test` a legal function name.
  name = {
    for id, service in local.serverless :
    id => substr(
      replace("${var.project.namespace}-${var.project.name}-${id}", "/[^A-Za-z0-9-_]/", "-"),
      0,
      64,
    )
  }

  # A literal env value is copied; a secret reference becomes a Lambda dynamic
  # reference, so the value never enters state or a plan file.
  literal_env = {
    for id, service in local.serverless : id => merge(
      contains(service.providers, "bedrock") ? { AWS_REGION = local.bedrock_region } : {},
      {
        for variable in service.env : variable.name => variable.value
        if variable.secret == false && variable.value != null
      },
      # A provisioned guardrail is named here, so the app never learns an id by hand.
      contains(keys(local.managed_guardrails), id) ? {
        BEDROCK_GUARDRAIL_ID      = aws_bedrock_guardrail.managed[id].guardrail_id
        BEDROCK_GUARDRAIL_VERSION = aws_bedrock_guardrail_version.managed[id].version
      } : {},
      local.knowledge_base_env[id],
    )
  }

  secret_env = {
    for id, service in local.serverless : id => {
      for variable in service.env :
      variable.name => "{{resolve:secretsmanager:${var.secret_arns[variable.name]}:SecretString}}"
      if variable.secret
    }
  }

  # A service the module runs, whose spec asks Bedrock to run the policy, owns one.
  managed_guardrails = {
    for id, guardrail in var.guardrails : id => guardrail
    if contains(keys(local.serverless), id) && contains(local.serverless[id].guardrail_engines, "bedrock")
  }

  # Only the bases that exist. `tofu plan` before the first apply sees none, and
  # emitting a policy with an empty resource would fail the plan rather than skip it.
  knowledge_base_arns = [for base in values(var.knowledge_bases) : base.arn if base.arn != ""]

  # Exported only to a service that binds one of the base's retrievers, and only once
  # the base exists: the runtime raises a named error for a missing id, while an empty
  # string would read as a created base with an empty corpus.
  knowledge_base_env = {
    for id, service in local.serverless : id => {
      for base_id, base in var.knowledge_bases :
      base.env_name => base.id
      if base.id != "" && length(setintersection(toset(base.retrievers), toset(service.ingest))) > 0
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

# A container-image function pulls from ECR with its own role, and the repository a
# release pushes to is private by default. The managed policy is account-scoped by the
# token ECR returns, so it admits an image in this account and costs nothing to a public
# image.
resource "aws_iam_role_policy_attachment" "ecr" {
  for_each   = local.serverless
  role       = aws_iam_role.service[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Lambda resolves a dynamic secret reference with the function's own role, so a
# declared secret is unusable without this. `for_each` over an empty map rather than
# `count`, because a policy with no resource is invalid rather than merely empty.
resource "aws_iam_role_policy" "secrets" {
  for_each = length(var.secret_arns) > 0 ? local.serverless : {}
  name     = "${local.name[each.key]}-secrets"
  role     = aws_iam_role.service[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(var.secret_arns)
    }]
  })
}

# Bedrock authenticates with this role, so the function needs no API key. The stream
# action is granted only to a service that streams, so the policy describes what the
# spec asked for.
resource "aws_iam_role_policy" "bedrock" {
  for_each = local.bedrock
  name     = "${local.name[each.key]}-bedrock"
  role     = aws_iam_role.service[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = concat(
        ["bedrock:InvokeModel"],
        each.value.streaming ? ["bedrock:InvokeModelWithResponseStream"] : [],
      )
      Resource = [
        "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
        "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

# The spec names filters and strengths, never a vendor enum -- `aid infra gen` maps them
# once, so this resource reads like the policy the author wrote.
resource "aws_bedrock_guardrail" "managed" {
  for_each = local.managed_guardrails

  # A guardrail name caps at 50 characters and allows letters, digits, hyphens and
  # underscores; `local.name` is already sanitised, so only the cap is left.
  name = substr("${local.name[each.key]}-guardrail", 0, 50)

  description               = each.value.message
  blocked_input_messaging   = each.value.message
  blocked_outputs_messaging = each.value.message

  dynamic "content_policy_config" {
    for_each = length(each.value.content) > 0 ? [1] : []
    content {
      dynamic "filters_config" {
        for_each = each.value.content
        content {
          type            = filters_config.value.type
          input_strength  = filters_config.value.strength
          output_strength = filters_config.value.strength
        }
      }
    }
  }

  dynamic "topic_policy_config" {
    for_each = length(each.value.topics) > 0 ? [1] : []
    content {
      dynamic "topics_config" {
        for_each = each.value.topics
        content {
          name       = topics_config.value.name
          definition = topics_config.value.definition
          type       = "DENY"
        }
      }
    }
  }

  # Only the author's own words, never a managed list: adding one here would block
  # vocabulary the spec did not ask for.
  dynamic "word_policy_config" {
    for_each = length(each.value.words) > 0 ? [1] : []
    content {
      dynamic "words_config" {
        for_each = each.value.words
        content {
          text = words_config.value
        }
      }
    }
  }

  dynamic "sensitive_information_policy_config" {
    for_each = length(each.value.pii) > 0 ? [1] : []
    content {
      dynamic "pii_entities_config" {
        for_each = each.value.pii
        content {
          type   = pii_entities_config.value.type
          action = pii_entities_config.value.action
        }
      }
    }
  }
}

# A guardrail is mutable and every change mints a new immutable version, so the app is
# pinned to this one. Pointing it at DRAFT would let a later edit change a live
# deployment without a plan.
resource "aws_bedrock_guardrail_version" "managed" {
  for_each      = local.managed_guardrails
  guardrail_arn = aws_bedrock_guardrail.managed[each.key].guardrail_arn
  description   = "Published by aid infra gen from the spec."
}

# Evaluating a guardrail is the app's job; provisioning it is this module's. Scoping the
# grant to the ARN means a compromised function cannot apply or edit another guardrail.
resource "aws_iam_role_policy" "guardrail" {
  for_each = local.managed_guardrails
  name     = substr("${local.name[each.key]}-guardrail", 0, 64)
  role     = aws_iam_role.service[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:ApplyGuardrail"]
      Resource = [aws_bedrock_guardrail.managed[each.key].guardrail_arn]
    }]
  })
}

# Retrieve is the only call the app makes: generation stays in this project, where the
# model gate, the guardrail stage and the cost ledger can see it.
resource "aws_iam_role_policy" "knowledge_base" {
  for_each = length(local.knowledge_base_arns) > 0 ? local.serverless : {}
  role     = aws_iam_role.service[each.key].id
  name = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 40)}-kb-retrieve"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:Retrieve"]
      Resource = local.knowledge_base_arns
    }]
  })
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
      error_message = "No image_uris entry for \"${each.key}\". Name the released tag this service runs; the spec names a repository, not a tag."
    }

    precondition {
      condition     = !each.value.streaming
      error_message = "Service \"${each.key}\" declares streaming, which an HTTP API cannot deliver on AWS. Serve it from a container target here, or deploy it as serverless on GCP, where Cloud Run streams."
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
