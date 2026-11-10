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

variable "bedrock_region" {
  description = "Region for Bedrock model calls, when it differs from the region this stack deploys into."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
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

variable "gateways" {
  description = "Gateways this module may reach, with the URL and ARN the env root resolved."
  type = map(object({
    # Empty until the gateway exists. The environment and the grant skip it while it is.
    arn = optional(string, "")
    url = optional(string, "")
    # The variable the runtime reads the URL from. Computed by the CLI, not here.
    env_name = string
  }))
  default = {}
}
