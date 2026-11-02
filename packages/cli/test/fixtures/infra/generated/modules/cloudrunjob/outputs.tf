output "job_ids" {
  description = "Job id -> the resource a `gcloud run jobs execute` call names."
  value       = { for id, job in google_cloud_run_v2_job.job : id => job.id }
}

output "job_names" {
  value = { for id, job in google_cloud_run_v2_job.job : id => job.name }
}

output "service_accounts" {
  value = { for id, account in google_service_account.job : id => account.email }
}
