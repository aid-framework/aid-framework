variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "services" {
  description = "The plan services, verbatim. Entries without a runtime, or on another platform, are ignored."
  type = map(object({
    target       = string
    streaming    = bool
    providers    = list(string)
    ingest       = list(string)
    secret_names = list(string)
    guardrail_engines = list(string)
    pipeline = optional(string)
    runtime = object({
      platform          = string
      cloud             = string
      memory_short_term = bool
      ttl_minutes       = number
      # The gateway this deployment federates its tools through, absent when none.
      gateway = optional(string)
    })
    routes = list(object({
      pipeline = string
      method   = string
      path     = string
    }))
    env = list(object({
      name   = string
      secret = bool
      from   = string
      value  = optional(string)
    }))
  }))
}

variable "image_uris" {
  description = "Business input: the released tag each runtime runs."
  type        = map(string)
}

variable "project_id" {
  description = "Business input: the GCP project the engine, its account and its grants live in."
  type        = string
}

variable "region" {
  description = "Business input: the region the reasoning engine is created in."
  type        = string
}

variable "secret_ids" {
  description = "Business input: Secret Manager secret id per secret name, resolved by the platform."
  type        = map(string)
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "model_armor_templates" {
  description = "Template resource names this module may export, keyed by service id."
  type        = map(string)
  default     = {}
}
