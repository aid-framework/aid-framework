data "aws_region" "current" {}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  batch = {
    for id, service in var.services : id => service
    if service.target == "batch"
  }

  # A job that names Bedrock calls it with the task role, so the grant below is the only
  # credential it needs. `providers` is derived from the build's models, so this is
  # conservative: every job in a build that mentions Bedrock gets the grant.
  bedrock = {
    for id, service in local.batch : id => service
    if contains(service.providers, "bedrock")
  }

  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : data.aws_region.current.name

  # IAM and Batch names allow letters, digits, hyphens and underscores, while a namespace
  # may carry a dot; the replacement is what keeps `aid.test` a legal name.
  name = {
    for id, service in local.batch :
    id => substr(
      replace("${var.project.namespace}-${var.project.name}-${id}", "/[^A-Za-z0-9-_]/", "-"),
      0,
      50,
    )
  }

  # A literal env value is copied; a secret becomes a job-definition `secrets` entry, so
  # the value never enters state or a plan file.
  literal_env = {
    for id, service in local.batch : id => concat(
      contains(service.providers, "bedrock") ? [{
        name  = "AWS_REGION"
        value = local.bedrock_region
      }] : [],
      [
        for variable in service.env : {
          name  = variable.name
          value = variable.value
        }
        if variable.secret == false && variable.value != null
      ],
      # A provisioned guardrail is named here, so the job never learns an id by hand.
      contains(keys(local.managed_guardrails), id) ? [{
        name  = "BEDROCK_GUARDRAIL_ID"
        value = aws_bedrock_guardrail.managed[id].guardrail_id
      }, {
        name  = "BEDROCK_GUARDRAIL_VERSION"
        value = aws_bedrock_guardrail_version.managed[id].version
      }] : [],
    )
  }

  secret_env = {
    for id, service in local.batch : id => [
      for variable in service.env : {
        name      = variable.name
        valueFrom = try(var.secret_arns[variable.name], "")
      }
      if variable.secret
    ]
  }

  # The entrypoint takes the pipeline as argv, because a build with more than one manual
  # pipeline cannot resolve a default. The spec refuses a batch deployment without one,
  # so a null here is a plan from somewhere else -- refused rather than guessed.
  command = {
    for id, service in local.batch :
    id => ["python", "-m", "app.generated.batch", coalesce(service.pipeline, "")]
  }

  # A service the module runs, whose spec asks Bedrock to run the policy, owns one.
  managed_guardrails = {
    for id, guardrail in var.guardrails : id => guardrail
    if contains(keys(local.batch), id) && contains(local.batch[id].guardrail_engines, "bedrock")
  }
}

# Batch itself needs a role to manage the compute environment, and ECS needs a second
# one to pull the image, write logs and read the secrets the job names.
resource "aws_iam_role" "service" {
  count = length(local.batch) > 0 ? 1 : 0
  name  = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 45)}-batch-service"
  tags  = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "batch.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "service" {
  count      = length(local.batch) > 0 ? 1 : 0
  role       = aws_iam_role.service[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

resource "aws_iam_role" "execution" {
  count = length(local.batch) > 0 ? 1 : 0
  name  = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 42)}-batch-execution"
  tags  = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  count      = length(local.batch) > 0 ? 1 : 0
  role       = aws_iam_role.execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# A job definition with no task role runs with no AWS credentials at all, so a Bedrock
# call would fail with an auth error while every other secret still resolved. The role
# exists for every batch job; the grant below only exists when a job names Bedrock.
resource "aws_iam_role" "task" {
  count = length(local.batch) > 0 ? 1 : 0
  name  = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 46)}-batch-task"
  tags  = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# The stream action is granted only when a job streams, so the policy describes what the
# spec asked for rather than the union of everything Bedrock can do.
resource "aws_iam_role_policy" "bedrock" {
  count = length(local.bedrock) > 0 ? 1 : 0
  name  = "batch-bedrock"
  role  = aws_iam_role.task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = concat(
        ["bedrock:InvokeModel"],
        anytrue([for service in local.bedrock : service.streaming]) ? ["bedrock:InvokeModelWithResponseStream"] : [],
      )
      Resource = [
        "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
        "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

# The job definition's `secrets` are resolved by the execution role, so a declared secret
# is unusable without this. `for_each` over an empty map rather than `count`, because a
# policy with no resource is invalid rather than merely empty.
resource "aws_iam_role_policy" "secrets" {
  count = length(local.batch) > 0 && length(var.secret_arns) > 0 ? 1 : 0
  name  = "batch-secrets"
  role  = aws_iam_role.execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(var.secret_arns)
    }]
  })
}

resource "aws_batch_compute_environment" "fargate" {
  count = length(local.batch) > 0 ? 1 : 0

  compute_environment_name = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 50)}-batch"
  type                     = "MANAGED"
  state                    = "ENABLED"
  service_role             = aws_iam_role.service[0].arn

  compute_resources {
    type               = "FARGATE"
    max_vcpus          = var.max_vcpus
    subnets            = var.subnet_ids
    security_group_ids = var.security_group_ids
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = length(var.subnet_ids) > 0
      error_message = "No subnet_ids were supplied. Fargate has nowhere to run a task without at least one subnet; name the subnets this job may use."
    }
  }
}

resource "aws_batch_job_queue" "queue" {
  count = length(local.batch) > 0 ? 1 : 0

  name     = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 50)}-batch"
  state    = "ENABLED"
  priority = 1
  tags     = var.tags

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.fargate[0].arn
  }
}

resource "aws_cloudwatch_log_group" "job" {
  for_each = local.batch

  name              = "/aws/batch/${local.name[each.key]}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
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
  role     = aws_iam_role.task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:ApplyGuardrail"]
      Resource = [aws_bedrock_guardrail.managed[each.key].guardrail_arn]
    }]
  })
}

resource "aws_batch_job_definition" "job" {
  for_each = local.batch

  name = local.name[each.key]
  type = "container"
  tags = var.tags

  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image   = try(var.image_uris[each.key], "")
    command = local.command[each.key]

    taskRoleArn = aws_iam_role.task[0].arn

    resourceRequirements = [
      {
        type  = "VCPU"
        value = tostring(try(var.batch_sizing[each.key].vcpus, 1))
      },
      {
        type  = "MEMORY"
        value = tostring(try(var.batch_sizing[each.key].memory_mb, 2048))
      },
    ]

    environment = local.literal_env[each.key]
    secrets     = local.secret_env[each.key]

    networkConfiguration = {
      assignPublicIp = var.assign_public_ip ? "ENABLED" : "DISABLED"
    }

    fargatePlatformConfiguration = {
      platformVersion = "LATEST"
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.job[each.key].name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "batch"
      }
    }
  })

  retry_strategy {
    attempts = try(var.batch_sizing[each.key].attempts, 1)
  }

  timeout {
    attempt_duration_seconds = try(var.batch_sizing[each.key].timeout_seconds, 3600)
  }

  lifecycle {
    precondition {
      condition     = try(var.image_uris[each.key], "") != ""
      error_message = "No image_uris entry for \"${each.key}\". A job definition must name the image it runs."
    }

    precondition {
      condition     = try(each.value.pipeline, "") != ""
      error_message = "Deployment \"${each.key}\" targets batch but names no pipeline. Set deployments.${each.key}.pipeline to the pipeline the job runs."
    }

    precondition {
      condition = alltrue([
        for variable in each.value.env : try(var.secret_arns[variable.name], "") != ""
        if variable.secret
      ])
      error_message = "Deployment \"${each.key}\" references a secret with no secret_arns entry. Add name -> ARN for every secret it declares."
    }
  }
}
