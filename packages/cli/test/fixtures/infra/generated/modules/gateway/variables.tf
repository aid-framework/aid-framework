variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "gateways" {
  description = "The plan gateways, verbatim. Every entry gets a gateway and its targets."
  type = map(object({
    description = optional(string, "")
    # The variable the deployment exports this gateway's URL under. Computed by the CLI
    # from the gateway id, because the runtime project reads the same spelling.
    env_name = string
    authorizer = object({
      # `awsIam` or `jwt`. The two platform authorizers this spec can reach; `NONE` and
      # `AUTHENTICATE_ONLY` are refused upstream rather than offered here.
      kind          = string
      discovery_url = optional(string, "")
      audience      = optional(list(string), [])
    })
    targets = list(object({
      name = string
      # Optional prose on the target resource. The schema caps it at 200 characters, which
      # is the same cap the API applies, so an accepted value is one the API will take.
      description = optional(string, "")
      # `openApiSchema` or `mcpServer`. Only one of the two blocks below is ever set;
      # both live under the resource's single `mcp` configuration.
      kind = string
      open_api_schema = optional(object({
        uri                     = optional(string, "")
        bucket_owner_account_id = optional(string, "")
        inline                  = optional(string, "")
      }), null)
      mcp_server = optional(object({
        endpoint = optional(string, "")
      }), null)
    }))
  }))
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
