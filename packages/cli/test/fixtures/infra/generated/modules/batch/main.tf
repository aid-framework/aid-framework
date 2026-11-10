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

  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : data.aws_region.current.region

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
      [for name, value in local.knowledge_base_env[id] : { name = name, value = value }],
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

  # A task that carries a schedule is a retriever this build ingests itself: a managed
  # knowledge base ingests inside its engine, so `refresh` never reaches a task for one.
  refresh = {
    for task in var.tasks : task.id => task
    if try(task.schedule, null) != null && try(task.schedule, "") != ""
  }

  # EventBridge Scheduler takes `cron(minutes hours day-of-month month day-of-week
  # year)`, with day-of-week 1-7 and 1 = Sunday, and exactly one of the two day fields
  # `?`. `schedule_aws` is that spelling; the fields of the spec spelling are kept
  # beside it because the translation can no longer tell them apart.
  refresh_fields = {
    for id, task in local.refresh : id => split(" ", trimspace(try(task.schedule, "")))
  }

  # A standard five-field cron ORs the two day fields when both are named, and
  # EventBridge Scheduler cannot express that: it refuses an expression that names
  # both. A schedule of that shape is refused rather than collapsed to one field.
  refresh_dual_day = {
    for id, fields in local.refresh_fields : id => fields
    if try(fields[2], "*") != "*" && try(fields[4], "*") != "*"
  }

  # A refresh runs the retriever ingest module, not the pipeline entrypoint: a pipeline
  # is a manual run someone asks for, and a schedule is not that request.
  refresh_command = {
    for id, task in local.refresh : id => ["python", "-m", try(task.module, "")]
  }

  # Job definition names are capped at 50 characters, so the suffix is appended after
  # the truncation rather than being cut off by it.
  refresh_name = {
    for id, task in local.refresh :
    id => "${substr(replace("${var.project.namespace}-${var.project.name}-${id}", "/[^A-Za-z0-9-_]/", "-"), 0, 43)}-refresh"
  }

  # A service the module runs, whose spec asks Bedrock to run the policy, owns one.
  managed_guardrails = {
    for id, guardrail in var.guardrails : id => guardrail
    if contains(keys(local.batch), id) && contains(local.batch[id].guardrail_engines, "bedrock")
  }

  # Only the bases that exist. `tofu plan` before the first apply sees none, and
  # emitting a policy with an empty resource would fail the plan rather than skip it.
  knowledge_base_arns = [for base in values(var.knowledge_bases) : base.arn if base.arn != ""]

  # Exported only to a service that binds one of the base's retrievers, and only once
  # the base exists: the runtime raises a named error for a missing id, while an empty
  # string would read as a created base with an empty corpus.
  knowledge_base_env = {
    for id, service in local.batch : id => {
      for base_id, base in var.knowledge_bases :
      base.env_name => base.id
      if base.id != "" && length(setintersection(toset(base.retrievers), toset(service.ingest))) > 0
    }
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
  # A scheduled refresh is a job definition too, so the roles exist for either runner.
  count = length(local.batch) + length(local.refresh) > 0 ? 1 : 0
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
  count      = length(local.batch) + length(local.refresh) > 0 ? 1 : 0
  role       = aws_iam_role.execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# A job definition with no task role runs with no AWS credentials at all, so a Bedrock
# call would fail with an auth error while every other secret still resolved. The role
# exists for every batch job; the grant below only exists when a job names Bedrock.
resource "aws_iam_role" "task" {
  count = length(local.batch) + length(local.refresh) > 0 ? 1 : 0
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

  name = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 50)}-batch"
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

# Retrieve is the only call the app makes: generation stays in this project, where the
# model gate, the guardrail stage and the cost ledger can see it.
resource "aws_iam_role_policy" "knowledge_base" {
  count = length(local.knowledge_base_arns) > 0 ? 1 : 0
  role  = aws_iam_role.task[0].id
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
    executionRoleArn = aws_iam_role.execution[0].arn

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
        "awslogs-region"        = data.aws_region.current.region
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

# The scheduler submits the job, so it needs what Batch asks of any submitter: permission
# on the queue and on the job definition, plus `iam:PassRole` for the roles that job
# definition names. It exists only when something is scheduled.
resource "aws_iam_role" "scheduler" {
  count = length(local.refresh) > 0 ? 1 : 0
  name  = "${substr(replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-_]/", "-"), 0, 43)}-batch-scheduler"
  tags  = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  count = length(local.refresh) > 0 ? 1 : 0
  name  = "batch-scheduler"
  role  = aws_iam_role.scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "batch:SubmitJob"
      # `compact` drops the queue ARN when the plan names no batch deployment, so this
      # policy stays valid and the schedule below is what reports the real problem.
      Resource = compact(concat(
        [try(aws_batch_job_queue.queue[0].arn, "")],
        [for definition in aws_batch_job_definition.refresh : definition.arn],
      ))
    }, {
      Effect   = "Allow"
      Action   = "iam:PassRole"
      Resource = [aws_iam_role.task[0].arn, aws_iam_role.execution[0].arn]
    }]
  })
}

# A refresh job definition is per retriever, because a job definition is what names the
# command: `python -m <ingest module>`. It borrows the deployment it ingests for its
# image, sizing, environment and secrets, so a build publishes one image and declares a
# secret once.
resource "aws_cloudwatch_log_group" "refresh" {
  for_each = local.refresh

  name              = "/aws/batch/${local.refresh_name[each.key]}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_batch_job_definition" "refresh" {
  for_each = local.refresh

  name = local.refresh_name[each.key]
  type = "container"
  tags = var.tags

  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image   = try(var.image_uris[try(each.value.deployment, "")], "")
    command = local.refresh_command[each.key]

    taskRoleArn      = aws_iam_role.task[0].arn
    executionRoleArn = aws_iam_role.execution[0].arn

    resourceRequirements = [
      {
        type  = "VCPU"
        value = tostring(try(var.batch_sizing[try(each.value.deployment, "")].vcpus, 1))
      },
      {
        type  = "MEMORY"
        value = tostring(try(var.batch_sizing[try(each.value.deployment, "")].memory_mb, 2048))
      },
    ]

    environment = try(local.literal_env[try(each.value.deployment, "")], [])
    secrets     = try(local.secret_env[try(each.value.deployment, "")], [])

    networkConfiguration = {
      assignPublicIp = var.assign_public_ip ? "ENABLED" : "DISABLED"
    }

    fargatePlatformConfiguration = {
      platformVersion = "LATEST"
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.refresh[each.key].name
        "awslogs-region"        = data.aws_region.current.region
        "awslogs-stream-prefix" = "refresh"
      }
    }
  })

  retry_strategy {
    attempts = try(var.batch_sizing[try(each.value.deployment, "")].attempts, 1)
  }

  timeout {
    attempt_duration_seconds = try(var.batch_sizing[try(each.value.deployment, "")].timeout_seconds, 3600)
  }

  lifecycle {
    precondition {
      condition     = try(each.value.module, "") != ""
      error_message = "Retriever \"${each.value.source}\" has a refresh.schedule but no generated ingest module to run. Regenerate the app, then the schedule."
    }

    precondition {
      condition     = contains(keys(local.batch), try(each.value.deployment, ""))
      error_message = "Retriever \"${each.value.source}\" has a refresh.schedule but no `target: batch` deployment ingests it. Add one, or drop the schedule: nothing would run it."
    }

    precondition {
      condition     = try(var.image_uris[try(each.value.deployment, "")], "") != ""
      error_message = "No image_uris entry for deployment \"${try(each.value.deployment, "")}\". A refresh job definition must name the image it runs."
    }
  }
}

# EventBridge Scheduler rather than a Batch resource, because that is the resource AWS
# provides: the target is the queue submission API, so a scheduled refresh is an ordinary
# job that Batch meters, retries and logs like any other. The expression is read as UTC,
# which is what the spec means and what the docs say, and `schedule_aws` is the same
# expression in this provider dialect.
resource "aws_scheduler_schedule" "refresh" {
  for_each = local.refresh

  name                         = local.refresh_name[each.key]
  schedule_expression          = try(each.value.schedule_aws, "")
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:${data.aws_partition.current.partition}:scheduler:::aws-sdk:batch:submitJob"
    role_arn = aws_iam_role.scheduler[0].arn

    # A static job name is safe here: `SubmitJob` requires a name but not a unique one,
    # and the queue records the submission either way.
    input = jsonencode({
      jobName       = local.refresh_name[each.key]
      jobQueue      = try(aws_batch_job_queue.queue[0].arn, "")
      jobDefinition = try(aws_batch_job_definition.refresh[each.key].arn, "")
    })
  }

  lifecycle {
    precondition {
      condition     = try(each.value.schedule_aws, "") != ""
      error_message = "Retriever \"${each.value.source}\" has a refresh.schedule this module cannot spell for EventBridge Scheduler. Check that it is the five fields minute hour day-of-month month day-of-week."
    }

    precondition {
      condition     = !contains(keys(local.refresh_dual_day), each.key)
      error_message = "Retriever \"${each.value.source}\" schedules both day-of-month and day-of-week. A five-field cron ORs those two fields, and EventBridge Scheduler refuses an expression that names both: name one and use `*` for the other."
    }

    precondition {
      condition     = contains(keys(local.batch), try(each.value.deployment, ""))
      error_message = "Retriever \"${each.value.source}\" has a refresh.schedule but no `target: batch` deployment ingests it. Add one, or drop the schedule: nothing would run it."
    }
  }
}
