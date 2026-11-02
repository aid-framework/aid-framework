data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

# A function must exist in us-east-1 to be attached to a distribution, wherever the
# rest of the stack lives, so this module configures its own provider for it. An alias
# is not inherited, which is what keeps the choice local to this module.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  edge = {
    for id, service in var.services : id => service
    if service.target == "edge"
  }

  # One distribution serves the whole app, so the association names the only deployment;
  # the function below refuses a plan that declares more.
  edge_id = try(keys(local.edge)[0], "")

  name = {
    for id, service in local.edge :
    id => substr(
      replace("${var.project.namespace}-${var.project.name}-${id}", "/[^A-Za-z0-9-_]/", "-"),
      0,
      64,
    )
  }

  bedrock = {
    for id, service in local.edge : id => service
    if contains(service.providers, "bedrock")
  }
}

# A replica in any CloudFront region assumes this role, so it must trust the edge service
# as well as Lambda itself.
resource "aws_iam_role" "edge" {
  for_each = local.edge
  provider = aws.us_east_1
  name     = "${local.name[each.key]}-edge"
  tags     = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
      {
        Effect    = "Allow"
        Principal = { Service = "edgelambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "edge_logs" {
  for_each   = local.edge
  provider   = aws.us_east_1
  role       = aws_iam_role.edge[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda@Edge refuses environment variables, so the handler reads one secret and
# setdefaults each of its entries. The secret is created empty: its value is the
# operator reads, and putting it in tfvars would put it in state.
resource "aws_secretsmanager_secret" "edge" {
  for_each    = local.edge
  provider    = aws.us_east_1
  name        = local.name[each.key]
  description = "Environment values for the AID edge handler."
  tags        = var.tags

  # A generated tree is destroyed and rebuilt often; the default 30-day recovery window
  # would hold the name and fail the next apply.
  recovery_window_in_days = 0
}

resource "aws_iam_role_policy" "edge_secrets" {
  for_each = local.edge
  provider = aws.us_east_1
  name     = "${local.name[each.key]}-secrets"
  role     = aws_iam_role.edge[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.edge[each.key].arn]
    }]
  })
}

# Bedrock authenticates with this role, so the function needs no API key. A replica calls
# the Bedrock endpoint of its own region, which is why the resource covers every region.
resource "aws_iam_role_policy" "edge_bedrock" {
  for_each = local.bedrock
  provider = aws.us_east_1
  name     = "${local.name[each.key]}-bedrock"
  role     = aws_iam_role.edge[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel"]
      Resource = [
        "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
        "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

resource "aws_lambda_function" "edge" {
  for_each = local.edge
  provider = aws.us_east_1

  function_name    = local.name[each.key]
  role             = aws_iam_role.edge[each.key].arn
  runtime          = "python3.12"
  handler          = "app.generated.edge.handler"
  filename         = var.edge_zip_path
  source_code_hash = filebase64sha256(var.edge_zip_path)
  tags             = var.tags

  # CloudFront associates a numbered version, never $LATEST or an alias.
  publish = true

  memory_size = try(var.edge_sizing[each.key].memory_mb, 512)
  timeout     = try(var.edge_sizing[each.key].timeout_seconds, 30)

  depends_on = [aws_iam_role_policy_attachment.edge_logs]

  lifecycle {
    precondition {
      condition     = length(local.edge) == 1
      error_message = "The plan declares ${length(local.edge)} edge deployments; one CloudFront distribution serves the app, so keep one edge deployment and let it own every HTTP route."
    }

    precondition {
      condition     = fileexists(var.edge_zip_path)
      error_message = "No Lambda zip at \"${abspath(var.edge_zip_path)}\". Build the app into that file before planning; the function deploys that archive."
    }

    precondition {
      condition     = !each.value.streaming
      error_message = "Deployment \"${each.key}\" declares streaming, which a CloudFront response cannot deliver. Serve it from a container target."
    }

    precondition {
      condition     = try(var.edge_sizing[each.key].timeout_seconds, 30) <= 30
      error_message = "Lambda@Edge allows at most 30 seconds for a request; deployment \"${each.key}\" asks for more."
    }

    precondition {
      condition = (
        try(var.edge_sizing[each.key].memory_mb, 512) >= 128 &&
        try(var.edge_sizing[each.key].memory_mb, 512) <= 3008
      )
      error_message = "Lambda@Edge accepts 128 to 3008 MB; deployment \"${each.key}\" is outside that range."
    }
  }
}

# CloudFront invokes a version, so the permission names the version as its qualifier.
# The source is every distribution in this account rather than this one: the permission
# has to exist before the distribution that references it, and an ARN reference back
# would be a cycle.
resource "aws_lambda_permission" "edge" {
  for_each = local.edge
  provider = aws.us_east_1

  statement_id  = "cloudfront"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.edge[each.key].function_name
  qualifier     = aws_lambda_function.edge[each.key].version
  principal     = "edgelambda.amazonaws.com"
  source_arn    = "arn:${data.aws_partition.current.partition}:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*"
}

resource "aws_cloudfront_distribution" "edge" {
  count    = length(local.edge) > 0 ? 1 : 0
  provider = aws.us_east_1

  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.project.namespace}-${var.project.name} edge API"
  price_class     = var.edge_price_class
  aliases         = var.edge_aliases
  tags            = var.tags

  depends_on = [aws_lambda_permission.edge]

  # A cache behaviour must name an origin. The association answers every request, so
  # nothing is ever fetched from it -- the documentation domain says so.
  origin {
    domain_name = "example.com"
    origin_id   = "aid-edge"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "aid-edge"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # CachingDisabled: the handler answers before the origin is reached, and a cached
    # POST is not a thing. AllViewer forwards the request as the app expects it.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"

    lambda_function_association {
      event_type   = "origin-request"
      lambda_arn   = aws_lambda_function.edge[local.edge_id].qualified_arn
      include_body = true
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.edge_certificate_arn == ""
    acm_certificate_arn            = var.edge_certificate_arn == "" ? null : var.edge_certificate_arn
    ssl_support_method             = var.edge_certificate_arn == "" ? null : "sni-only"
    minimum_protocol_version       = var.edge_certificate_arn == "" ? null : "TLSv1.2_2021"
  }
}
