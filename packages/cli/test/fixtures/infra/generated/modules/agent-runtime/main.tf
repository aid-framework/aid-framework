data "aws_region" "current" {}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # Only the services this module owns: a `container` destination handed to a runtime,
  # on this platform. The filter is the map the whole module loops over.
  runtime = {
    for id, service in var.services : id => service
    if service.target == "container" && service.runtime != null
  }

  managed = {
    for id, service in local.runtime : id => service
    if service.runtime.platform == "aws-agentcore"
  }

  # A runtime name allows letters, digits and underscores and caps at 48 characters,
  # while a namespace may carry a dot or start with a digit. The `aid_` stem keeps the
  # first character legal in every case; the id keeps two runtimes distinct.
  name = {
    for id, service in local.managed :
    id => substr(replace(lower("aid_${var.project.namespace}_${var.project.name}_${id}"), "/[^a-z0-9_]/", "_"), 0, 48)
  }

  bedrock = {
    for id, service in local.managed : id => service
    if contains(service.providers, "bedrock")
  }

  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : data.aws_region.current.region

  # Memory is a resource the platform bills for, so it exists only when the spec asked
  # for it; a runtime without memory keeps its session on the microVM alone.
  managed_memory = {
    for id, service in local.managed : id => service
    if service.runtime.memory_short_term
  }

  literal_env = {
    for id, service in local.managed : id => merge(
      contains(service.providers, "bedrock") ? { AWS_REGION = local.bedrock_region } : {},
      {
        for variable in service.env : variable.name => variable.value
        if variable.secret == false && variable.value != null
      },
      contains(keys(local.managed_guardrails), id) ? {
        BEDROCK_GUARDRAIL_ID      = aws_bedrock_guardrail.managed[id].guardrail_id
        BEDROCK_GUARDRAIL_VERSION = aws_bedrock_guardrail_version.managed[id].version
      } : {},
      contains(keys(local.managed_memory), id) ? {
        BEDROCK_AGENTCORE_MEMORY_ID = aws_bedrockagentcore_memory.managed[id].id
      } : {},
      local.knowledge_base_env[id],
    )
  }

  # A service the module runs, whose spec asks Bedrock to run the policy, owns one.
  managed_guardrails = {
    for id, guardrail in var.guardrails : id => guardrail
    if contains(keys(local.managed), id) && contains(local.managed[id].guardrail_engines, "bedrock")
  }

  # Only the bases that exist. `tofu plan` before the first apply sees none, and
  # emitting a policy with an empty resource would fail the plan rather than skip it.
  knowledge_base_arns = [for base in values(var.knowledge_bases) : base.arn if base.arn != ""]

  # Exported only to a service that binds one of the base's retrievers, and only once
  # the base exists: the runtime raises a named error for a missing id, while an empty
  # string would read as a created base with an empty corpus.
  knowledge_base_env = {
    for id, service in local.managed : id => {
      for base_id, base in var.knowledge_bases :
      base.env_name => base.id
      if base.id != "" && length(setintersection(toset(base.retrievers), toset(service.ingest))) > 0
    }
  }
}

# ---------------------------------------------------------------------------- iam

resource "aws_iam_role" "runtime" {
  for_each = local.managed

  name = substr("${local.name[each.key]}-runtime", 0, 64)
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

# The platform pulls the image as this role. `GetAuthorizationToken` is account-wide by
# API design; the layer calls are scoped to this account's repositories.
resource "aws_iam_role_policy" "image" {
  for_each = local.managed
  name     = substr("${local.name[each.key]}-image", 0, 64)
  role     = aws_iam_role.runtime[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = ["arn:${data.aws_partition.current.partition}:ecr:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:repository/*"]
      },
    ]
  })
}

# A runtime writes its own logs; the container module's ECS log group has no analogue
# here, because the platform owns the log stream.
resource "aws_iam_role_policy" "logs" {
  for_each = local.managed
  name     = substr("${local.name[each.key]}-logs", 0, 64)
  role     = aws_iam_role.runtime[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"]
    }]
  })
}

# Bedrock authenticates with this role, so neither the image nor the runtime carries an
# API key. The stream action is granted only to a service that streams.
resource "aws_iam_role_policy" "bedrock" {
  for_each = local.bedrock
  name     = substr("${local.name[each.key]}-bedrock", 0, 64)
  role     = aws_iam_role.runtime[each.key].id

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
  role     = aws_iam_role.runtime[each.key].id

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
  for_each = length(local.knowledge_base_arns) > 0 ? local.managed : {}
  role     = aws_iam_role.runtime[each.key].id
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

# ------------------------------------------------------------------------- memory

# Short-term memory lives beside the session the platform already isolates. Thirty days
# is the shortest window that still spans a working month; a longer one is a cost
# decision the spec does not state yet, and inventing a number here would hide it.
resource "aws_bedrockagentcore_memory" "managed" {
  for_each = local.managed_memory

  name                  = local.name[each.key]
  description           = "Short-term memory for the ${each.key} deployment."
  event_expiry_duration = 30
  tags                  = var.tags
}

# ------------------------------------------------------------------------- runtime

resource "aws_bedrockagentcore_agent_runtime" "managed" {
  for_each = local.managed

  agent_runtime_name = local.name[each.key]
  role_arn           = aws_iam_role.runtime[each.key].arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = var.image_uris[each.key]
    }
  }

  # A generated agent is reachable by the platform's front door, not by a VPC a quick
  # start has not built. Private networking is a later decision, not a silent default.
  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  # The spec states minutes because that is how a person plans a session; the platform
  # takes seconds. Both fields track the same ceiling so an idle session and a long one
  # end at the same limit the spec names.
  lifecycle_configuration {
    idle_runtime_session_timeout = each.value.runtime.ttl_minutes * 60
    max_lifetime                 = each.value.runtime.ttl_minutes * 60
  }

  environment_variables = local.literal_env[each.key]
  tags                  = merge(var.tags, { Name = local.name[each.key] })

  lifecycle {
    precondition {
      condition     = contains(keys(var.image_uris), each.key)
      error_message = "No image_uris entry for \"${each.key}\". Name the released tag this runtime runs; the spec names a repository, not a tag."
    }

    # AgentCore has no secret reference for a runtime environment: the values are part
    # of the runtime definition and readable from its API, so a secret passed here
    # would be published and written to state.
    precondition {
      condition     = length(each.value.secret_names) == 0
      error_message = "Service \"${each.key}\" declares secrets, which Bedrock AgentCore cannot reference: its environment carries literal values only. Remove the secrets from this deployment, or read them in the app with the runtime role, and see the generated README for the gap."
    }

    precondition {
      condition     = each.value.runtime.ttl_minutes >= 1 && each.value.runtime.ttl_minutes <= 480
      error_message = "Service \"${each.key}\" asks for a session TTL over 480 minutes. An AgentCore microVM reclaims a session after 8 hours, so a longer TTL is a limit that can never be enforced."
    }

    # The command already refuses a cross-cloud platform; this keeps the module honest
    # if it is ever handed a mixed map, rather than dropping the other platform.
    precondition {
      condition     = alltrue([for service in local.runtime : service.runtime.platform == "aws-agentcore"])
      error_message = "The agent-runtime module is rendering for AWS but the plan also declares a runtime on another platform. One environment is one cloud; split the deployments across environments."
    }
  }
}
