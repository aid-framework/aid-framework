# The project a resource lands in is an account fact the spec cannot know, so the
# env root configures the provider once instead of every resource naming it.
provider "google" {
  project = var.gcp_project
  region  = var.region
}

# dev and prod differ only in the values they supply, which is what lets one
# generated tree deploy to a second GCP project unchanged.

module "agent-runtime" {
  source = "../../generated/modules/agent-runtime"

  project               = var.project
  services              = var.services
  image_uris            = var.image_uris
  project_id            = var.gcp_project
  region                = var.region
  secret_ids            = var.secret_ids
  model_armor_templates = var.model_armor_templates
  tags                  = var.tags
}

output "reasoning_engines" {
  value = module.agent-runtime.reasoning_engines
}
