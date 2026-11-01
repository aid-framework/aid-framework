variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "services" {
  description = "The plan services, verbatim. Entries not targeting container are ignored."
  type = map(object({
    target       = string
    streaming    = bool
    providers    = list(string)
    ingest       = list(string)
    secret_names = list(string)
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
  description = "Business input: the released tag each container service runs."
  type        = map(string)
}

variable "secret_arns" {
  description = "Business input: Secrets Manager ARN per secret name, injected by the task."
  type        = map(string)
  default     = {}
}

variable "container_sizing" {
  description = "Business input: per-service CPU units, memory and task count."
  type = map(object({
    cpu           = optional(number)
    memory_mb     = optional(number)
    desired_count = optional(number)
  }))
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Networking. Leave vpc_id empty to have the module build a two-AZ VPC; set it,
# with both subnet lists, to deploy into a VPC you already run.
variable "vpc_id" {
  type    = string
  default = ""
}

variable "public_subnet_ids" {
  description = "Subnets the load balancer sits in. Two, in different AZs."
  type        = list(string)
  default     = []
}

variable "private_subnet_ids" {
  description = "Subnets the tasks run in. Needs egress to pull an image; the created VPC gets a NAT gateway."
  type        = list(string)
  default     = []
}

variable "vpc_cidr" {
  description = "Required when the module builds the VPC; ignored when vpc_id is set. The module will not guess a network range."
  type        = string
  default     = ""
}

variable "health_check_path" {
  description = "Path the target group probes. Any 2xx-4xx counts, so a 404 still proves the task answers."
  type        = string
  default     = "/"
}

variable "idle_timeout" {
  description = "Load balancer idle timeout in seconds. Raise it for a long streaming response."
  type        = number
  default     = 300
}

variable "log_retention_days" {
  type    = number
  default = 30
}
