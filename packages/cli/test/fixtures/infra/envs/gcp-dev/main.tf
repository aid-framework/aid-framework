# The project a resource lands in is an account fact the spec cannot know, so the
# env root configures the provider once instead of every resource naming it.
provider "google" {
  project = var.gcp_project
  region  = var.region
}

# The Cloud Run module, fed from the generated tfvars and the inputs below. dev and
# prod differ only in the values they supply, which is what lets one generated tree
# deploy to a second GCP project unchanged.

module "cloudrun" {
  source = "../../generated/modules/cloudrun"

  project               = var.project
  services              = var.services
  image_uris            = var.image_uris
  secret_ids            = var.secret_ids
  cloudrun_sizing       = var.cloudrun_sizing
  region                = var.region
  allow_unauthenticated = var.allow_unauthenticated
  deletion_protection   = var.deletion_protection
  tags                  = var.tags
}

output "cloudrun_urls" {
  value = module.cloudrun.service_urls
}
