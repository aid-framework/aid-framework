variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "project_id" {
  description = "The project the corpus is created in. The embedding endpoint names it by number."
  type        = string
}

variable "region" {
  type = string
}

variable "knowledge_bases" {
  description = "The plan knowledge bases, verbatim. Entries not on this engine are ignored."
  type = map(object({
    # Present so one shape flows to the compute modules; the created corpus overwrites
    # `id` on the way out, so nothing here needs the operator to fill it in.
    id  = optional(string, "")
    # For `vector_store.kind = "existing"` this is the corpus resource name
    # (`projects/<n>/locations/<r>/ragCorpora/<id>`), which is also what the runtime
    # reads from the environment.
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
    # The provider's identifier for that alias, which the embedding endpoint names.
    embed_model_id = string
    # The name the deployment exports the corpus name under. Computed by the CLI from
    # the base id, because the runtime computes it the same way.
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
  description = "Labels applied to the corpus. Vertex accepts the same key/value shape as every other resource."
  type        = map(string)
  default     = {}
}
