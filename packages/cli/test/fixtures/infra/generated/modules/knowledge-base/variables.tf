variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "knowledge_bases" {
  description = "The plan knowledge bases, verbatim. Entries not on this engine are ignored."
  type = map(object({
    # Present so one shape flows to the compute modules; the created base overwrites
    # both on the way out, so nothing here needs the operator to fill them in.
    id  = optional(string, "")
    arn = optional(string, "")
    engine = string
    data_source = object({
      kind = string
      uri  = string
    })
    chunking = object({
      strategy = string
      size     = number
      overlap  = number
    })
    # The spec alias, kept so a tfvars diff reads in the author's own words.
    embed_model = string
    # The provider's identifier for that alias, which is what the engine accepts.
    embed_model_id = string
    # The name the deployment exports the created service id under. Computed by the CLI
    # from the base id, because the runtime computes it the same way.
    env_name = string
    filterable = list(string)
    vector_store = object({
      kind = string
      arn  = optional(string)
    })
    retrievers = list(string)
  }))
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
