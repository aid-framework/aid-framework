output "agent_runtimes" {
  description = "Runtime id, ARN and version per deployment id."
  value = {
    for id, runtime in aws_bedrockagentcore_agent_runtime.managed : id => {
      id      = runtime.agent_runtime_id
      arn     = runtime.agent_runtime_arn
      version = runtime.agent_runtime_version
    }
  }
}

output "memory_ids" {
  description = "Memory id per deployment id, for the deployments that asked for memory."
  value       = { for id, memory in aws_bedrockagentcore_memory.managed : id => memory.id }
}
