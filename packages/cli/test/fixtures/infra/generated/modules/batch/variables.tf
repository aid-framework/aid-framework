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
    # Every guardrail engine the spec names; `bedrock` means this build calls one.
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
  }))
}

variable "image_uris" {
  description = "Business input: the container image each batch job runs."
  type        = map(string)
}

variable "secret_arns" {
  description = "Business input: Secrets Manager ARN per secret name, resolved at start."
  type        = map(string)
  default     = {}
}

variable "batch_sizing" {
  description = "Business input: per-job vCPU, memory, attempts and attempt timeout."
  type = map(object({
    vcpus           = optional(number)
    memory_mb       = optional(number)
    attempts        = optional(number)
    timeout_seconds = optional(number)
  }))
  default = {}
}

variable "subnet_ids" {
  description = "Business input: the subnets Fargate tasks run in. At least one."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Business input: the security groups the task joins."
  type        = list(string)
  default     = []
}

variable "assign_public_ip" {
  description = "Whether the task gets a public IP. A private subnet needs a NAT instead."
  type        = bool
  default     = false
}

variable "max_vcpus" {
  description = "Business input: the ceiling the queue may scale to."
  type        = number
  default     = 16
}

variable "log_retention_days" {
  type    = number
  default = 30
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

variable "tags" {
  type    = map(string)
  default = {}
}
