# The one output the env root wires into the compute modules: the plan entries with the
# created id and ARN filled in. A base on another engine stays empty here, because this
# module did not create it and has nothing true to say about it.
output "knowledge_bases" {
  description = "Base id -> {id, arn, env_name, retrievers}. Empty until the base exists."
  value = {
    for id, base in var.knowledge_bases : id => {
      id         = try(aws_bedrockagent_knowledge_base.this[id].id, "")
      arn        = try(aws_bedrockagent_knowledge_base.this[id].arn, "")
      env_name   = base.env_name
      retrievers = base.retrievers
    }
  }
}

output "knowledge_base_ids" {
  description = "Base id -> the service id the engine assigned. The deployment exports these."
  value = { for id, base in aws_bedrockagent_knowledge_base.this : id => base.id }
}

output "knowledge_base_arns" {
  description = "Base id -> ARN, for granting the app a retrieve action on exactly these bases."
  value = { for id, base in aws_bedrockagent_knowledge_base.this : id => base.arn }
}

output "data_source_ids" {
  description = "Base id -> data source id, which is what a `StartIngestionJob` call names."
  value = { for id, base in aws_bedrockagent_data_source.this : id => base.data_source_id }
}

output "collection_arns" {
  description = "Base id -> the vector collection ARN, whether provisioned here or supplied."
  value = {
    for id, base in aws_bedrockagent_knowledge_base.this :
    # A supplied store is already an ARN; a provisioned one has no entry in the map it
    # was read from, so `try` is what covers both without a conditional per branch.
    id => try(coalesce(aws_opensearchserverless_collection.vectors[id].arn, base.vector_store.arn), "")
  }
}
