# The one output the env root wires into the runtime module: the plan entries with the
# platform-assigned URL and ARN filled in. A URL only exists after the gateway does, so a
# `tofu plan` before the first apply hands the runtime an empty map and no environment
# variable -- the same shape a knowledge base uses.
output "gateways" {
  description = "Gateway id -> {arn, url, env_name}. Empty until the gateway exists."
  value = {
    for id, gateway in aws_bedrockagentcore_gateway.this : id => {
      arn      = gateway.gateway_arn
      url      = gateway.gateway_url
      env_name = var.gateways[id].env_name
    }
  }
}

output "gateway_urls" {
  description = "Gateway id -> the MCP endpoint a runtime connects to."
  value       = { for id, gateway in aws_bedrockagentcore_gateway.this : id => gateway.gateway_url }
}

output "gateway_arns" {
  description = "Gateway id -> ARN, for granting a runtime invoke on exactly these gateways."
  value       = { for id, gateway in aws_bedrockagentcore_gateway.this : id => gateway.gateway_arn }
}

output "gateway_identifiers" {
  description = "Gateway id -> the identifier the API assigned, which a target names."
  value       = { for id, gateway in aws_bedrockagentcore_gateway.this : id => gateway.gateway_id }
}

output "target_ids" {
  description = "`gateway/target` -> the target id the platform assigned."
  value       = { for key, target in aws_bedrockagentcore_gateway_target.this : key => target.target_id }
}
