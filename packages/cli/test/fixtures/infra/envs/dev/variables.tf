# Declared so the generated tfvars binds without an "undeclared variable" warning.
variable "project" {}
variable "services" {}
variable "guardrails" {}
variable "data_stores" {}
variable "tasks" {}
variable "alarms" {}
variable "knowledge_bases" {}
variable "model_armor_templates" {}

# Business inputs. None of these is derivable from the spec, by design.
variable "image_uris" {
  description = "Service id -> the image it runs, pinned to a released tag."
  type        = map(string)
}

variable "secret_arns" {
  description = "Secret name -> Secrets Manager ARN. The module resolves these at runtime."
  type        = map(string)
  default     = {}
}

variable "bedrock_region" {
  description = "Region for Bedrock model calls, when it differs from the region this stack deploys into."
  type        = string
  default     = ""
}

variable "sizing" {
  description = "Service id -> memory and timeout. The module defaults are deliberately modest."
  type = map(object({
    memory_mb       = number
    timeout_seconds = number
  }))
  default = {}
}

variable "container_sizing" {
  description = "Service id -> CPU units, memory and task count."
  type = map(object({
    cpu           = optional(number)
    memory_mb     = optional(number)
    desired_count = optional(number)
  }))
  default = {}
}

# Networking. An empty vpc_id has the module build a two-AZ VPC; setting it, with both
# subnet lists, deploys into a VPC you already run.
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
  description = "Subnets the tasks run in. They need egress to pull an image."
  type        = list(string)
  default     = []
}

variable "vpc_cidr" {
  description = "Range for the VPC the module builds. Required when vpc_id is empty; ignored otherwise."
  type        = string
  default     = ""
}

variable "health_check_path" {
  description = "Path the target group probes. Any 2xx-4xx counts as healthy."
  type        = string
  default     = "/"
}

variable "idle_timeout" {
  description = "Load balancer idle timeout in seconds. Raise it for a long stream."
  type        = number
  default     = 300
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "batch_sizing" {
  description = "Deployment id -> vCPU, memory, attempts and attempt timeout."
  type = map(object({
    vcpus           = optional(number)
    memory_mb       = optional(number)
    attempts        = optional(number)
    timeout_seconds = optional(number)
  }))
  default = {}
}

variable "batch_subnet_ids" {
  description = "Subnets a batch task runs in. At least one; the module refuses an empty list."
  type        = list(string)
}

variable "batch_security_group_ids" {
  description = "Security groups a batch task joins."
  type        = list(string)
  default     = []
}

variable "batch_assign_public_ip" {
  description = "Give the task a public IP. A private subnet needs a NAT gateway instead."
  type        = bool
  default     = false
}

variable "batch_max_vcpus" {
  description = "The ceiling the batch queue may scale to."
  type        = number
  default     = 16
}

variable "batch_log_retention_days" {
  type    = number
  default = 30
}

variable "edge_zip_path" {
  description = "Path to a zip of the app, resolved from this env root. Build it before planning."
  type        = string
  default     = "edge.zip"
}

variable "edge_sizing" {
  description = "Deployment id -> memory and timeout. Lambda@Edge caps the timeout at 30s."
  type = map(object({
    memory_mb       = optional(number)
    timeout_seconds = optional(number)
  }))
  default = {}
}

variable "edge_aliases" {
  description = "Custom domain names the distribution answers on. Empty keeps the cloudfront.net name."
  type        = list(string)
  default     = []
}

variable "edge_certificate_arn" {
  description = "ACM certificate in us-east-1 for edge_aliases. Required with aliases, ignored without."
  type        = string
  default     = ""
}

variable "edge_price_class" {
  description = "Which CloudFront edge locations serve the app."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  type    = map(string)
  default = {}
}
