# Declared so the generated tfvars binds without an "undeclared variable" warning.
variable "project" {}
variable "services" {}
variable "guardrails" {}
variable "data_stores" {}
variable "tasks" {}
variable "alarms" {}
variable "knowledge_bases" {}
variable "model_armor_templates" {}

variable "gcp_project" {
  description = "The GCP project id resources are created in. Not the aid project name."
  type        = string
}

# Business inputs. None of these is derivable from the spec, by design.
variable "image_uris" {
  description = "Service id -> the image it runs, pinned to a released tag."
  type        = map(string)
}

variable "secret_ids" {
  description = "Secret name -> Secret Manager secret id. The module resolves these at runtime."
  type        = map(string)
  default     = {}
}

# Cloud Run names the region in a URL, and a job is created in one; both are deployment
# choices, not something the spec can infer.
variable "region" {
  description = "The region every resource is created in."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
