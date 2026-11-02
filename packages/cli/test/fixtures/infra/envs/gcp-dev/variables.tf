# Declared so the generated tfvars binds without an "undeclared variable" warning.
variable "project" {}
variable "services" {}
variable "data_stores" {}
variable "tasks" {}
variable "alarms" {}

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

# Cloud Run needs a region it can name in a URL, and nothing else about the network: it
# terminates TLS and scales behind a managed frontend the module creates.
variable "region" {
  description = "The region every resource is created in."
  type        = string
}

variable "cloudrun_sizing" {
  description = "Service id -> CPU, memory, instance bounds and concurrency."
  type = map(object({
    cpu           = optional(string)
    memory_mb     = optional(number)
    min_instances = optional(number)
    max_instances = optional(number)
    concurrency   = optional(number)
  }))
  default = {}
}

variable "allow_unauthenticated" {
  description = "Whether the internet may invoke the services without a Google identity."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Leave on for anything real: destroying a protected service is refused."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
