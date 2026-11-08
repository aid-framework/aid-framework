# The one output the env root wires into the compute modules: the plan entries with the
# corpus name filled in. A base on another engine stays empty here, because this module
# did not create it and has nothing true to say about it.
output "knowledge_bases" {
  description = "Base id -> {id, arn, env_name, retrievers}. Empty until the corpus exists."
  value = {
    for id, base in var.knowledge_bases : id => {
      id         = lookup(local.corpora, id, "")
      arn        = lookup(local.corpora, id, "")
      env_name   = base.env_name
      retrievers = base.retrievers
    }
  }
}

output "corpus_names" {
  description = "Base id -> the corpus resource name, which is what `:retrieveContexts` takes."
  value       = local.corpora
}

output "rag_file_ids" {
  description = "`<base>/<object>` -> the RagFile id the import created."
  value       = { for key, file in google_vertex_ai_rag_file.this : key => file.id }
}

output "source_objects" {
  description = "Base id -> how many objects the import covers. Zero means nothing was imported."
  value       = { for id, listing in data.google_storage_bucket_objects.source : id => length(listing.bucket_objects) }
}
