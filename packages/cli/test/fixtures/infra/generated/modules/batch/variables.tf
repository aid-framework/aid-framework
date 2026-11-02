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

variable "tags" {
  type    = map(string)
  default = {}
}
