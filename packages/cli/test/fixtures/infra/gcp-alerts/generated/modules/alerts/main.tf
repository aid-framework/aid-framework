locals {
  metric_prefix = "custom.googleapis.com/aid/"

  alarm_ids = [
    google_monitoring_alert_policy.turn_cost.id,
    google_monitoring_alert_policy.eval_spend.id,
    google_monitoring_alert_policy.turn_tokens.id,
    google_monitoring_alert_policy.reply_latency.id,
  ]
}


resource "google_monitoring_alert_policy" "turn_cost" {
  project      = var.project_id
  display_name = "aid-${var.project.name}-turn_cost"
  combiner     = "OR"

  conditions {
    display_name = "agent.cost (sum) over 15m exceeded 25 usd for \"support\". Declared in observability.alerts."

    condition_threshold {
      filter          = "metric.type=\"${local.metric_prefix}agent.cost\" AND resource.type=\"global\" AND metric.label.source=\"support\""
      comparison      = "COMPARISON_GT"
      threshold_value = 25

      # The window in the document is the alignment period, so the policy measures
      # what the author declared rather than a provider default.
      duration = "0s"

      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = var.alert_channel_ids

  user_labels = var.tags
}

resource "google_monitoring_alert_policy" "eval_spend" {
  project      = var.project_id
  display_name = "aid-${var.project.name}-eval_spend"
  combiner     = "OR"

  conditions {
    display_name = "eval.cost (sum) over 24h exceeded 250 usd across the whole environment. Declared in observability.alerts."

    condition_threshold {
      filter          = "metric.type=\"${local.metric_prefix}eval.cost\" AND resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 250

      # The window in the document is the alignment period, so the policy measures
      # what the author declared rather than a provider default.
      duration = "0s"

      aggregations {
        alignment_period     = "86400s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = var.alert_channel_ids

  user_labels = var.tags
}

resource "google_monitoring_alert_policy" "turn_tokens" {
  project      = var.project_id
  display_name = "aid-${var.project.name}-turn_tokens"
  combiner     = "OR"

  conditions {
    display_name = "agent.tokens (average) over 5m exceeded 6000 tokens for \"support\". Declared in observability.alerts."

    condition_threshold {
      filter          = "metric.type=\"${local.metric_prefix}agent.tokens\" AND resource.type=\"global\" AND metric.label.source=\"support\""
      comparison      = "COMPARISON_GT"
      threshold_value = 6000

      # The window in the document is the alignment period, so the policy measures
      # what the author declared rather than a provider default.
      duration = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MEAN"
      }
    }
  }

  notification_channels = var.alert_channel_ids

  user_labels = var.tags
}

resource "google_monitoring_alert_policy" "reply_latency" {
  project      = var.project_id
  display_name = "aid-${var.project.name}-reply_latency"
  combiner     = "OR"

  conditions {
    display_name = "eval.latency.p95 (p95) over 1h exceeded 2500 ms across the whole environment. Declared in observability.alerts."

    condition_threshold {
      filter          = "metric.type=\"${local.metric_prefix}eval.latency.p95\" AND resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2500

      # The window in the document is the alignment period, so the policy measures
      # what the author declared rather than a provider default.
      duration = "0s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MEAN"
      }
    }
  }

  notification_channels = var.alert_channel_ids

  user_labels = var.tags
}

