# The project a resource lands in is an account fact the spec cannot know, so the
# env root configures the provider once instead of every resource naming it.
provider "google" {
  project = var.gcp_project
  region  = var.region
}

# dev and prod differ only in the values they supply, which is what lets one
# generated tree deploy to a second GCP project unchanged.

module "vertex-rag" {
  source = "../../generated/modules/vertex-rag"

  project         = var.project
  project_id      = var.gcp_project
  region          = var.region
  knowledge_bases = var.knowledge_bases
  tags            = var.tags
}

module "cloudrun" {
  source = "../../generated/modules/cloudrun"

  project               = var.project
  services              = var.services
  image_uris            = var.image_uris
  secret_ids            = var.secret_ids
  cloudrun_sizing       = var.cloudrun_sizing
  project_id            = var.gcp_project
  region                = var.region
  allow_unauthenticated = var.allow_unauthenticated
  deletion_protection   = var.deletion_protection
  knowledge_bases       = module.vertex-rag.knowledge_bases
  model_armor_templates = var.model_armor_templates
  tags                  = var.tags
}

module "cloudrunjob" {
  source = "../../generated/modules/cloudrunjob"

  project               = var.project
  services              = var.services
  image_uris            = var.image_uris
  secret_ids            = var.secret_ids
  batch_sizing          = var.batch_sizing
  project_id            = var.gcp_project
  region                = var.region
  deletion_protection   = var.deletion_protection
  knowledge_bases       = module.vertex-rag.knowledge_bases
  model_armor_templates = var.model_armor_templates
  tasks                 = var.tasks
  tags                  = var.tags
}

output "corpus_names" {
  value = module.vertex-rag.corpus_names
}

output "cloudrun_urls" {
  value = module.cloudrun.service_urls
}

output "batch_jobs" {
  value = module.cloudrunjob.job_ids
}
