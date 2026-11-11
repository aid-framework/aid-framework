output "metric_namespace" {
  description = "The CloudWatch namespace every alarm here watches. Configure the collector's metric exporter to publish into it."
  value       = local.metric_namespace
}

output "alarm_arns" {
  description = "The alarms this module created, one per declared alert."
  value       = local.alarm_arns
}
