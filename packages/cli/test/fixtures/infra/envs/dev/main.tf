# The one module call every environment makes. dev and prod differ only in the values
# it is given, which is what lets one generated tree run in more than one account.
module "app" {
  source = "../../generated/modules/serverless"

  project     = var.project
  services    = var.services
  image_uris  = var.image_uris
  secret_arns = var.secret_arns
  sizing      = var.sizing
  tags        = var.tags
}

output "api_endpoint" {
  value = module.app.api_endpoint
}
