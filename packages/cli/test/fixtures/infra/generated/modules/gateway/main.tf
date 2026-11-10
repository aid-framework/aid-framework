data "aws_region" "current" {}

locals {
  # The gateway name allows letters, digits and single hyphens and caps at 48
  # characters; a spec name is snake_case and a namespace may carry a dot. Collapsing
  # every run of disallowed characters is what turns `support_tools` into `support-tools`
  # in one pass, and the trim is what keeps a leading or trailing hyphen out.
  slug = {
    for id, gateway in var.gateways :
    id => trim(replace(lower("${var.project.namespace}-${var.project.name}-${id}"), "/[^a-z0-9]+/", "-"), "-")
  }

  # Truncation can expose a trailing hyphen, which the same pattern forbids, so the
  # suffix is stripped after the cut rather than before it.
  gateway_name = { for id, name in local.slug : id => trimsuffix(substr(name, 0, 48), "-") }

  # One entry per (gateway, target) pair, keyed by both so a target name only has to be
  # unique inside its own gateway and the emitted resource set does not depend on list
  # order. The two names have different caps: a gateway caps at 48 characters and a
  # target at 100, which is why the target name is built from the derived gateway name
  # and capped again rather than reusing the gateway slug uncut.
  targets = merge([
    for id, gateway in var.gateways : {
      for target in gateway.targets :
      "${id}/${target.name}" => merge(target, { gateway = id })
    }
  ]...)

  target_name = {
    for key, target in local.targets :
    key => trimsuffix(substr(trim(replace(lower("${local.gateway_name[target.gateway]}-${target.name}"), "/[^a-z0-9]+/", "-"), "-"), 0, 100), "-")
  }
}

# ---------------------------------------------------------------------------- iam

# The gateway assumes this role to reach the targets behind it. The principal is the
# AgentCore service, which is the same one an agent runtime assumes.
resource "aws_iam_role" "gateway" {
  for_each = var.gateways

  name = substr("${local.gateway_name[each.key]}-role", 0, 64)
  tags = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# ------------------------------------------------------------------------ gateway

resource "aws_bedrockagentcore_gateway" "this" {
  for_each = var.gateways

  name        = local.gateway_name[each.key]
  description = each.value.description != "" ? each.value.description : null
  role_arn    = aws_iam_role.gateway[each.key].arn

  # The two platform authorizers this spec can reach. `NONE` is refused upstream because
  # it publishes an unauthenticated endpoint, and `AUTHENTICATE_ONLY` authorizes nothing.
  authorizer_type = each.value.authorizer.kind == "jwt" ? "CUSTOM_JWT" : "AWS_IAM"

  # Required by the provider, and a constant rather than a spec field: an AgentCore
  # gateway speaks MCP to its caller, which is the only protocol this layer federates.
  protocol_type = "MCP"

  tags = var.tags

  # A JWT gateway validates the caller's token against the issuer it names. Without one
  # the block is omitted rather than rendered empty: `discovery_url` is required inside it.
  dynamic "authorizer_configuration" {
    for_each = each.value.authorizer.kind == "jwt" ? [each.value.authorizer] : []
    content {
      custom_jwt_authorizer {
        discovery_url    = authorizer_configuration.value.discovery_url
        allowed_audience = authorizer_configuration.value.audience
      }
    }
  }
}

# ------------------------------------------------------------------------ targets

resource "aws_bedrockagentcore_gateway_target" "this" {
  for_each = local.targets

  name = local.target_name[each.key]

  # The gateway identifier, not the ARN: the API addresses a target through its gateway.
  # Reading it off the gateway resource is also what orders the two.
  gateway_identifier = aws_bedrockagentcore_gateway.this[each.value.gateway].gateway_id

  description = each.value.description != "" ? each.value.description : null

  # No `credential_provider_configuration` for either target kind. That is deliberate and
  # matches the AWS CDK L2, which applies no default for `open_api_schema` or `mcp_server`
  # and omits the key from the synthesized template. The gap it leaves: an OpenAPI backend
  # that *does* need auth wants an API key or OAuth provider, which 0.24 has no field for,
  # so such an upstream is a documented limitation rather than a silent default.

  # All target kinds live under `mcp`. The resource has no top-level `open_api_schema`
  # and no sibling `api` block: a schema-backed target is one MCP target whose
  # configuration happens to be a document.
  target_configuration {
    mcp {
      dynamic "mcp_server" {
        for_each = each.value.kind == "mcpServer" ? [each.value.mcp_server] : []
        content {
          endpoint = mcp_server.value.endpoint
        }
      }

      dynamic "open_api_schema" {
        for_each = each.value.kind == "openApiSchema" ? [each.value.open_api_schema] : []
        content {
          # Exactly one of the two, which is what `open_api_schema` documents and what the
          # spec already made exclusive. An inline document travels in the plan; a uri is
          # read from S3 at apply time, with the owner id only when the bucket is elsewhere.
          dynamic "inline_payload" {
            for_each = open_api_schema.value.inline != "" ? [open_api_schema.value.inline] : []
            content {
              payload = inline_payload.value
            }
          }

          dynamic "s3" {
            for_each = open_api_schema.value.inline == "" ? [open_api_schema.value.uri] : []
            content {
              uri                     = s3.value
              bucket_owner_account_id = open_api_schema.value.bucket_owner_account_id != "" ? open_api_schema.value.bucket_owner_account_id : null
            }
          }
        }
      }
    }
  }
}
