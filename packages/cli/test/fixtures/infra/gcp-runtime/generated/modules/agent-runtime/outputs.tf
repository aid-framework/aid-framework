output "reasoning_engines" {
  description = "Reasoning engine resource id per deployment id."
  value       = { for id, engine in google_vertex_ai_reasoning_engine.managed : id => engine.id }
}

output "service_accounts" {
  description = "The account each engine runs as."
  value       = { for id, account in google_service_account.runtime : id => account.email }
}
