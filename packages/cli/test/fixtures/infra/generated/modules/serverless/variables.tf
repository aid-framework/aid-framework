variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "services" {
  description = "The plan services, verbatim. Entries not targeting serverless are ignored."
  type = map(object({
    target       = string
    streaming    = bool
    providers    = list(string)
    ingest       = list(string)
    secret_names = list(string)
    # Every guardrail engine the spec names; `bedrock` means this build calls one.
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
    runtime = optional(any)
  }))
}

variable "image_uris" {
  description = "Business input: the container image each serverless service runs."
  type        = map(string)
}

variable "secret_arns" {
  description = "Business input: Secrets Manager ARN per secret name, resolved at invoke time."
  type        = map(string)
  default     = {}
}

variable "sizing" {
  description = "Business input: per-service memory and timeout."
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

variable "bedrock_region" {
  description = "Region for Bedrock calls. Empty means the region this stack deploys into."
  type        = string
  default     = ""
}

variable "guardrails" {
  description = "Managed guardrails to provision, keyed by service id. Empty means no service owns one."
  type = map(object({
    id      = string
    message = string
    content = list(object({ type = string, strength = string }))
    topics  = list(object({ name = string, definition = string }))
    words   = list(string)
    pii     = list(object({ type = string, action = string }))
  }))
  default = {}
}

variable "knowledge_bases" {
  description = "Managed bases this module may read, with the id and ARN the env root resolved."
  type = map(object({
    # Empty until the base exists. The grant and the environment skip it while it is.
    id  = optional(string, "")
    arn = optional(string, "")
    # The name the runtime reads the id from. Computed by the CLI, not here: HCL has no
    # regex-lower-case-UPPER pipeline that would match the Python spelling exactly.
    env_name   = string
    retrievers = list(string)
  }))
  default = {}
}
