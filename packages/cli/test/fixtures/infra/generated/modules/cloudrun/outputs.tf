output "service_urls" {
  description = "Service id -> the HTTPS URL Cloud Run answers on."
  value       = { for id, service in google_cloud_run_v2_service.service : id => service.uri }
}

output "service_names" {
  value = { for id, service in google_cloud_run_v2_service.service : id => service.name }
}

output "service_accounts" {
  value = { for id, account in google_service_account.service : id => account.email }
}

output "repository_id" {
  description = "The Artifact Registry repository images are pushed to, empty when none exists."
  value = (
    length(google_artifact_registry_repository.images) > 0
    ? values(google_artifact_registry_repository.images)[0].repository_id
    : ""
  )
}
