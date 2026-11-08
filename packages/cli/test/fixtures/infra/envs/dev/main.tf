# The one module call per platform this plan targets. dev and prod differ only in
# the values they supply, which is what lets one generated tree run in more than one
# account.

module "serverless" {
  source = "../../generated/modules/serverless"

  project         = var.project
  services        = var.services
  guardrails      = var.guardrails
  image_uris      = var.image_uris
  secret_arns     = var.secret_arns
  sizing          = var.sizing
  bedrock_region  = var.bedrock_region
  knowledge_bases = var.knowledge_bases
  tags            = var.tags
}

module "container" {
  source = "../../generated/modules/container"

  project            = var.project
  services           = var.services
  guardrails         = var.guardrails
  image_uris         = var.image_uris
  secret_arns        = var.secret_arns
  container_sizing   = var.container_sizing
  vpc_id             = var.vpc_id
  public_subnet_ids  = var.public_subnet_ids
  private_subnet_ids = var.private_subnet_ids
  vpc_cidr           = var.vpc_cidr
  health_check_path  = var.health_check_path
  idle_timeout       = var.idle_timeout
  log_retention_days = var.log_retention_days
  bedrock_region     = var.bedrock_region
  knowledge_bases    = var.knowledge_bases
  tags               = var.tags
}

module "agent-runtime" {
  source = "../../generated/modules/agent-runtime"

  project         = var.project
  services        = var.services
  guardrails      = var.guardrails
  image_uris      = var.image_uris
  bedrock_region  = var.bedrock_region
  knowledge_bases = var.knowledge_bases
  tags            = var.tags
}

module "batch" {
  source = "../../generated/modules/batch"

  project            = var.project
  services           = var.services
  guardrails         = var.guardrails
  image_uris         = var.image_uris
  secret_arns        = var.secret_arns
  batch_sizing       = var.batch_sizing
  subnet_ids         = var.batch_subnet_ids
  security_group_ids = var.batch_security_group_ids
  assign_public_ip   = var.batch_assign_public_ip
  max_vcpus          = var.batch_max_vcpus
  log_retention_days = var.batch_log_retention_days
  bedrock_region     = var.bedrock_region
  knowledge_bases    = var.knowledge_bases
  tags               = var.tags
}

module "edge" {
  source = "../../generated/modules/edge"

  project              = var.project
  services             = var.services
  edge_zip_path        = var.edge_zip_path
  edge_sizing          = var.edge_sizing
  edge_aliases         = var.edge_aliases
  edge_certificate_arn = var.edge_certificate_arn
  edge_price_class     = var.edge_price_class
  tags                 = var.tags
}

output "serverless_endpoint" {
  value = module.serverless.api_endpoint
}

output "container_endpoint" {
  value = module.container.api_endpoint
}

output "agent_runtimes" {
  value = module.agent-runtime.agent_runtimes
}

output "batch_job_queue" {
  value = module.batch.job_queue_arn
}

output "edge_domain_name" {
  value = module.edge.distribution_domain_name
}
