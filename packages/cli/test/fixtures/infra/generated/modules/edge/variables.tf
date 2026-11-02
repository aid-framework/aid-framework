variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "services" {
  description = "The plan services, verbatim. Entries not targeting edge are ignored."
  type = map(object({
    target       = string
    streaming    = bool
    providers    = list(string)
    ingest       = list(string)
    secret_names = list(string)
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

variable "edge_zip_path" {
  description = "Path to a zip of the app, resolved from the env root. The plan reads it, so build it first."
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
