output "metric_prefix" {
  description = "The custom metric prefix every policy here watches. Configure the collector's metric exporter to publish under it."
  value       = local.metric_prefix
}

output "alarm_ids" {
  description = "The alert policies this module created, one per declared alert."
  value       = local.alarm_ids
}
