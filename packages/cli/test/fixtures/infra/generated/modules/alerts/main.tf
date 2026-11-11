locals {
  metric_namespace = "AID/${var.project.namespace}/${var.project.name}"

  alarm_arns = [
    aws_cloudwatch_metric_alarm.turn_cost.arn,
    aws_cloudwatch_metric_alarm.eval_spend.arn,
    aws_cloudwatch_metric_alarm.turn_tokens.arn,
    aws_cloudwatch_metric_alarm.reply_latency.arn,
  ]
}


resource "aws_cloudwatch_metric_alarm" "turn_cost" {
  alarm_name        = "aid-${var.project.namespace}-${var.project.name}-turn_cost"
  alarm_description = "agent.cost (sum) over 15m exceeded 25 usd for \"support\". Declared in observability.alerts."

  namespace   = local.metric_namespace
  metric_name = "agent.cost"

  dimensions = {
    Source = "support"
  }

  period              = 900
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 25

  # One period is one evaluation: the window in the document *is* the period, so a
  # second evaluation would watch a longer span than the author declared.
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  # A pipeline that stopped exporting is not a pipeline that came in under budget.
  treat_missing_data = "missing"

  alarm_actions = var.alert_channel_ids

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "eval_spend" {
  alarm_name        = "aid-${var.project.namespace}-${var.project.name}-eval_spend"
  alarm_description = "eval.cost (sum) over 24h exceeded 250 usd across the whole environment. Declared in observability.alerts."

  namespace   = local.metric_namespace
  metric_name = "eval.cost"

  period              = 86400
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 250

  # One period is one evaluation: the window in the document *is* the period, so a
  # second evaluation would watch a longer span than the author declared.
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  # A pipeline that stopped exporting is not a pipeline that came in under budget.
  treat_missing_data = "missing"

  alarm_actions = var.alert_channel_ids

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "turn_tokens" {
  alarm_name        = "aid-${var.project.namespace}-${var.project.name}-turn_tokens"
  alarm_description = "agent.tokens (average) over 5m exceeded 6000 tokens for \"support\". Declared in observability.alerts."

  namespace   = local.metric_namespace
  metric_name = "agent.tokens"

  dimensions = {
    Source = "support"
  }

  period              = 300
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 6000

  # One period is one evaluation: the window in the document *is* the period, so a
  # second evaluation would watch a longer span than the author declared.
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  # A pipeline that stopped exporting is not a pipeline that came in under budget.
  treat_missing_data = "missing"

  alarm_actions = var.alert_channel_ids

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "reply_latency" {
  alarm_name        = "aid-${var.project.namespace}-${var.project.name}-reply_latency"
  alarm_description = "eval.latency.p95 (p95) over 1h exceeded 2500 ms across the whole environment. Declared in observability.alerts."

  namespace   = local.metric_namespace
  metric_name = "eval.latency.p95"

  period              = 3600
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2500

  # One period is one evaluation: the window in the document *is* the period, so a
  # second evaluation would watch a longer span than the author declared.
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  # A pipeline that stopped exporting is not a pipeline that came in under budget.
  treat_missing_data = "missing"

  alarm_actions = var.alert_channel_ids

  tags = var.tags
}

