data "aws_availability_zones" "available" {
  state = "available"
}

# Read rather than required as a variable: the provider already knows the region, and
# a second place to state it is a second place to disagree with itself.
data "aws_region" "current" {}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  container = {
    for id, service in var.services : id => service
    if service.target == "container" && service.runtime == null
  }

  # A service that names Bedrock calls it with the task role, so the grant below is the
  # only credential it needs. `providers` is derived from the build's models, so this is
  # conservative: every container in a build that mentions Bedrock gets the grant.
  bedrock = {
    for id, service in local.container : id => service
    if contains(service.providers, "bedrock")
  }

  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : data.aws_region.current.name

  routed = {
    for id, service in local.container : id => service
    if length(service.routes) > 0
  }

  # One entry per (service, path). The ALB matches a path, not a method, so the map is
  # keyed by path and a duplicate is refused below rather than silently collapsed.
  route_pairs = flatten([
    for id, service in local.routed : [
      for route in distinct([for route in service.routes : route.path]) : {
        service = id
        path    = route
      }
    ]
  ])

  paths = { for pair in local.route_pairs : pair.path => pair.service }

  create_network = var.vpc_id == ""
  vpc_id         = local.create_network ? one(aws_vpc.this[*].id) : var.vpc_id

  public_subnet_ids = (
    local.create_network ? aws_subnet.public[*].id : var.public_subnet_ids
  )
  private_subnet_ids = (
    local.create_network ? aws_subnet.private[*].id : var.private_subnet_ids
  )

  # IAM, ECS and ALB names allow letters, digits and hyphens only, while a namespace
  # may carry a dot; the replacement is what keeps `aid.test` a legal name. The
  # truncation matches the shortest of the limits (32, for an ALB).
  prefix = substr(
    replace("${var.project.namespace}-${var.project.name}", "/[^A-Za-z0-9-]/", "-"),
    0,
    24,
  )

  name = {
    for id, service in local.container :
    id => substr("${local.prefix}-${id}", 0, 32)
  }

  literal_env = {
    for id, service in local.container : id => merge(
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

  # A task receives the ARN reference, not the value: the agent in the task resolves it
  # with the execution role, so the secret never enters state or a plan file.
  secret_ref = {
    for id, service in local.container : id => {
      for variable in service.env :
      variable.name => var.secret_arns[variable.name]
      if variable.secret
    }
  }

  # A service the module runs, whose spec asks Bedrock to run the policy, owns one.
  managed_guardrails = {
    for id, guardrail in var.guardrails : id => guardrail
    if contains(keys(local.container), id) && contains(local.container[id].guardrail_engines, "bedrock")
  }

  # Only the bases that exist. `tofu plan` before the first apply sees none, and
  # emitting a policy with an empty resource would fail the plan rather than skip it.
  knowledge_base_arns = [for base in values(var.knowledge_bases) : base.arn if base.arn != ""]

  # Exported only to a service that binds one of the base's retrievers, and only once
  # the base exists: the runtime raises a named error for a missing id, while an empty
  # string would read as a created base with an empty corpus.
  knowledge_base_env = {
    for id, service in local.container : id => {
      for base_id, base in var.knowledge_bases :
      base.env_name => base.id
      if base.id != "" && length(setintersection(toset(base.retrievers), toset(service.ingest))) > 0
    }
  }
}

# --------------------------------------------------------------------------- network

resource "aws_vpc" "this" {
  count = local.create_network ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = local.prefix })

  lifecycle {
    precondition {
      condition     = var.vpc_cidr != ""
      error_message = "The module builds a VPC because vpc_id is empty, so vpc_cidr must name the range it should use. Set vpc_id plus both subnet lists to deploy into a VPC you already run."
    }
  }
}

resource "aws_internet_gateway" "this" {
  count  = local.create_network ? 1 : 0
  vpc_id = one(aws_vpc.this[*].id)
  tags   = var.tags
}

resource "aws_subnet" "public" {
  count = local.create_network ? 2 : 0

  vpc_id                  = one(aws_vpc.this[*].id)
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(var.tags, { Name = "${local.prefix}-public-${count.index}" })
}

resource "aws_subnet" "private" {
  count = local.create_network ? 2 : 0

  vpc_id            = one(aws_vpc.this[*].id)
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = merge(var.tags, { Name = "${local.prefix}-private-${count.index}" })
}

resource "aws_route_table" "public" {
  count  = local.create_network ? 1 : 0
  vpc_id = one(aws_vpc.this[*].id)
  tags   = var.tags
}

resource "aws_route" "internet" {
  count                  = local.create_network ? 1 : 0
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = one(aws_internet_gateway.this[*].id)
}

resource "aws_route_table_association" "public" {
  count          = local.create_network ? 2 : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

# One NAT gateway, not one per AZ: tasks need egress to pull an image, and a second
# NAT doubles a fixed cost for an availability guarantee a quick start does not need.
resource "aws_eip" "nat" {
  count  = local.create_network ? 1 : 0
  domain = "vpc"
  tags   = var.tags
}

resource "aws_nat_gateway" "this" {
  count         = local.create_network ? 1 : 0
  allocation_id = one(aws_eip.nat[*].id)
  subnet_id     = aws_subnet.public[0].id
  tags          = var.tags

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = local.create_network ? 1 : 0
  vpc_id = one(aws_vpc.this[*].id)
  tags   = var.tags
}

resource "aws_route" "egress" {
  count                  = local.create_network ? 1 : 0
  route_table_id         = aws_route_table.private[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = one(aws_nat_gateway.this[*].id)
}

resource "aws_route_table_association" "private" {
  count          = local.create_network ? 2 : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# ------------------------------------------------------------------------ security

resource "aws_security_group" "alb" {
  count       = length(local.routed) > 0 ? 1 : 0
  name        = "${local.prefix}-alb"
  description = "Ingress to the generated load balancer."
  vpc_id      = local.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count             = length(local.routed) > 0 ? 1 : 0
  security_group_id = aws_security_group.alb[0].id
  description       = "HTTP from anywhere. Terminate TLS in front of this when you need it."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  count             = length(local.routed) > 0 ? 1 : 0
  security_group_id = aws_security_group.alb[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "task" {
  count       = length(local.container) > 0 ? 1 : 0
  name        = "${local.prefix}-task"
  description = "Only the load balancer may reach a task; tasks may reach anything."
  vpc_id      = local.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  count                        = length(local.routed) > 0 ? 1 : 0
  security_group_id            = aws_security_group.task[0].id
  description                  = "The generated load balancer is the only caller."
  referenced_security_group_id = aws_security_group.alb[0].id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "task" {
  count             = length(local.container) > 0 ? 1 : 0
  security_group_id = aws_security_group.task[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------------------- iam

resource "aws_iam_role" "execution" {
  for_each = local.container
  name     = substr("${local.name[each.key]}-exec", 0, 64)
  tags     = var.tags

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
  for_each   = local.container
  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role, not the task role, reads a secret before the container starts.
resource "aws_iam_role_policy" "secrets" {
  for_each = length(var.secret_arns) > 0 ? local.container : {}
  name     = substr("${local.name[each.key]}-secrets", 0, 64)
  role     = aws_iam_role.execution[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(var.secret_arns)
    }]
  })
}

resource "aws_iam_role" "task" {
  for_each = local.container
  name     = substr("${local.name[each.key]}-task", 0, 64)
  tags     = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Bedrock authenticates with this role, so the task needs no API key. The stream action is
# granted only to a service that streams, so the policy describes what the spec asked for.
resource "aws_iam_role_policy" "bedrock" {
  for_each = local.bedrock
  name     = substr("${local.name[each.key]}-bedrock", 0, 64)
  role     = aws_iam_role.task[each.key].id

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

# --------------------------------------------------------------------------- ecs

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.container
  name              = "/aws/ecs/${local.name[each.key]}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_cluster" "this" {
  count = length(local.container) > 0 ? 1 : 0
  name  = "${local.prefix}-cluster"
  tags  = var.tags
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
  role     = aws_iam_role.task[each.key].id

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
  for_each = length(local.knowledge_base_arns) > 0 ? local.container : {}
  role     = aws_iam_role.task[each.key].id
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

resource "aws_ecs_task_definition" "service" {
  for_each = local.container

  family                   = local.name[each.key]
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(try(var.container_sizing[each.key].cpu, 512))
  memory                   = tostring(try(var.container_sizing[each.key].memory_mb, 1024))
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  tags                     = var.tags

  container_definitions = jsonencode([{
    name      = "app"
    image     = var.image_uris[each.key]
    essential = true

    # The generated Dockerfile listens on 8080 and reads no other port.
    portMappings = [{
      containerPort = 8080
      protocol      = "tcp"
    }]

    environment = [
      for name, value in local.literal_env[each.key] : { name = name, value = value }
    ]

    secrets = [
      for name, arn in local.secret_ref[each.key] : { name = name, valueFrom = arn }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = contains(keys(var.image_uris), each.key)
      error_message = "No image_uris entry for \"${each.key}\". Name the released tag this service runs; the spec names a repository, not a tag."
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

resource "aws_ecs_service" "service" {
  for_each = local.container

  name            = local.name[each.key]
  cluster         = aws_ecs_cluster.this[0].id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = try(var.container_sizing[each.key].desired_count, 1)
  launch_type     = "FARGATE"
  tags            = var.tags

  network_configuration {
    subnets         = local.private_subnet_ids
    security_groups = [aws_security_group.task[0].id]
  }

  # Registering with the target group is what puts a task behind the listener; a
  # service that routes nowhere deliberately has no load balancer to join.
  dynamic "load_balancer" {
    for_each = contains(keys(local.routed), each.key) ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = "app"
      container_port   = 8080
    }
  }

  # The probe starts before the app has finished importing, so give it room rather
  # than let the scheduler replace a task that was merely still starting.
  health_check_grace_period_seconds = contains(keys(local.routed), each.key) ? 60 : null

  # A task the platform cannot place must fail the apply, not sit pending forever.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]

  lifecycle {
    # An empty subnet list is a valid object and an invalid service, so the failure is
    # named here rather than surfacing as "subnets must not be empty" mid-apply.
    precondition {
      condition     = length(local.private_subnet_ids) >= 2
      error_message = "Tasks need two private subnets in different availability zones. Supply private_subnet_ids alongside vpc_id, or leave vpc_id empty to have the module build a VPC."
    }
  }
}

# ---------------------------------------------------------------------------- alb

resource "aws_lb" "this" {
  count = length(local.paths) > 0 ? 1 : 0

  name               = "${local.prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  subnets            = local.public_subnet_ids
  security_groups    = [aws_security_group.alb[0].id]
  idle_timeout       = var.idle_timeout
  tags               = var.tags

  lifecycle {
    precondition {
      condition     = length(local.public_subnet_ids) >= 2
      error_message = "A load balancer needs at least two subnets in different availability zones. Supply public_subnet_ids, or leave vpc_id empty to have the module build a VPC."
    }

    precondition {
      condition     = length(local.route_pairs) == length(local.paths)
      error_message = "Two container services declare the same path. An ALB routes by path, not by method, so one path must belong to one service."
    }
  }
}

resource "aws_lb_target_group" "service" {
  for_each = local.routed

  name        = substr("${local.name[each.key]}-tg", 0, 32)
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"
  tags        = var.tags

  health_check {
    path = var.health_check_path
    # Any answer up to 499 proves the process is serving; requiring 200 would fail a
    # service whose every route sits behind authentication.
    matcher = "200-499"
  }
}

resource "aws_lb_listener" "http" {
  count = length(local.paths) > 0 ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"
  tags              = var.tags

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "no route"
      status_code  = "404"
    }
  }
}

# Priorities come from the sorted key order, so the same plan always assigns the same
# numbers; adding a path may renumber the ones after it, which is a diff, not a drift.
resource "aws_lb_listener_rule" "path" {
  for_each     = local.paths
  listener_arn = aws_lb_listener.http[0].arn
  priority     = index(sort(keys(local.paths)), each.key) + 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.value].arn
  }

  condition {
    path_pattern {
      values = [each.key]
    }
  }
}

