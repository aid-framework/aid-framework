output "job_queue_arn" {
  description = "The queue a submission targets, empty when the plan declares no batch job."
  value = (
    length(aws_batch_job_queue.queue) > 0
    ? aws_batch_job_queue.queue[0].arn
    : ""
  )
}

output "job_definition_arns" {
  value = { for id, job in aws_batch_job_definition.job : id => job.arn }
}

output "log_groups" {
  value = { for id, group in aws_cloudwatch_log_group.job : id => group.name }
}
