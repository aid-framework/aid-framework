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
    # Engines the declaring guardrail uses. Only `model-armor` reaches this module:
    # `bedrock` has no GCP counterpart and `aid infra gen` refuses it here.
    guardrail_engines = list(string)
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
    runtime = optional(any)
  }))
}

variable "tasks" {
  description = "The plan tasks, verbatim. Only one carrying a schedule reaches a scheduler."
  type = list(object({
    id         = string
    kind       = string
    source     = string
    schedule   = optional(string)
    module     = optional(string)
    deployment = optional(string)
  }))
  default = []
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

variable "knowledge_bases" {
  description = "Managed corpora this module may read, with the corpus name the env root resolved."
  type = map(object({
    # Empty until the corpus exists. The environment skips it while it is.
    id  = optional(string, "")
    arn = optional(string, "")
    # The name the runtime reads the corpus from. Computed by the CLI, not here: HCL has
    # no regex-lower-case-UPPER pipeline that would match the Python spelling exactly.
    env_name   = string
    retrievers = list(string)
  }))
  default = {}
}

variable "model_armor_templates" {
  description = "Template resource names this module may export, keyed by service id."
  type        = map(string)
  default     = {}
}
