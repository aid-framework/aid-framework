variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "services" {
  description = "The plan services, verbatim. Entries not targeting container or serverless are ignored."
  type = map(object({
    target       = string
    streaming    = bool
    providers    = list(string)
    ingest       = list(string)
    secret_names = list(string)
    # Declared for shape parity with the AWS modules; `aid infra gen` refuses a managed
    # guardrail engine on GCP, since nothing there evaluates one.
    guardrail_engines = list(string)
    # Set only by a `batch` service; the other targets ignore it and the entrypoint does
    # not read it, but the shared variable type must admit it.
    pipeline = optional(string)
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
  description = "Business input: the container image each service runs."
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

variable "cloudrun_sizing" {
  description = "Business input: per-service CPU, memory, instance bounds and concurrency."
  type = map(object({
    cpu           = optional(string)
    memory_mb     = optional(number)
    min_instances = optional(number)
    max_instances = optional(number)
    concurrency   = optional(number)
  }))
  default = {}
}

variable "region" {
  description = "The region every resource is created in. A business input, not derived."
  type        = string
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
