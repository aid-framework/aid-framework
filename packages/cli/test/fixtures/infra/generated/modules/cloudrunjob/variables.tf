variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "services" {
  description = "The plan services, verbatim. Entries not targeting batch are ignored."
  type = map(object({
    target       = string
    streaming    = bool
    providers    = list(string)
    ingest       = list(string)
    secret_names = list(string)
    pipeline     = optional(string)
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
  description = "Business input: the container image each job runs."
  type        = map(string)
}

variable "project_id" {
  description = "Business input: the GCP project a service account is granted a role in."
  type        = string
}

variable "secret_ids" {
  description = "Business input: Secret Manager secret id per secret name."
  type        = map(string)
  default     = {}
}

variable "batch_sizing" {
  description = "Business input: per-job CPU, memory, attempts and attempt timeout."
  type = map(object({
    cpu             = optional(string)
    memory_mb       = optional(number)
    attempts        = optional(number)
    timeout_seconds = optional(number)
  }))
  default = {}
}

variable "region" {
  description = "The region every resource is created in. A business input, not derived."
  type        = string
}

variable "deletion_protection" {
  description = "Leave on for anything real: destroying a protected job is refused."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
