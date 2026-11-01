# Declared so the generated tfvars binds without an "undeclared variable" warning.
variable "project" {}
variable "services" {}
variable "data_stores" {}
variable "tasks" {}
variable "alarms" {}

# Business inputs. None of these is derivable from the spec, by design.
variable "image_uris" {
  description = "Service id -> container image URI in a registry Lambda can pull from."
  type        = map(string)
}

variable "secret_arns" {
  description = "Secret name -> Secrets Manager ARN. The module resolves these at invoke time."
  type        = map(string)
  default     = {}
}

variable "sizing" {
  description = "Service id -> memory and timeout. The module defaults are deliberately modest."
  type = map(object({
    memory_mb       = number
    timeout_seconds = number
  }))
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
