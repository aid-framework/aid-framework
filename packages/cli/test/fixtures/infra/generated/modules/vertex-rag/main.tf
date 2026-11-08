# The number, not the id: the embedding endpoint below is addressed as
# `projects/<number>/locations/<region>/...`, and the project id is not accepted there.
data "google_project" "current" {}

locals {
  # Only Vertex bases reach this module. An `aws-bedrock` base binds to AWS, where the
  # corpus is a Bedrock knowledge base; creating a RAG corpus for it would index a
  # second copy the spec never asked for.
  bases = {
    for id, base in var.knowledge_bases : id => base
    if base.engine == "vertex-rag"
  }

  # Only a base whose spec names a provisioned store gets a corpus. A base pointing at
  # an existing corpus must not create a second one, and `try(...)` below is what keeps
  # that branch from reading a missing key.
  provisioned = {
    for id, base in local.bases : id => base
    if base.vector_store.kind == "provisioned"
  }

  # A RAG resource id allows lower-case letters, digits, hyphens and underscores and is
  # at most 128 characters, while a namespace may carry a dot -- so the replacement is
  # what keeps `aid.test` a legal display name.
  name = {
    for id, base in local.bases :
    id => substr(
      lower(replace("${var.project.namespace}-${var.project.name}-${id}", "/[^A-Za-z0-9-_]/", "-")),
      0,
      128,
    )
  }

  # The bucket and the object prefix under it, split once here rather than at each of
  # the three places the listing, the grant and the import need them.
  buckets = {
    for id, base in local.bases :
    id => split("/", trimprefix(base.data_source.uri, "gs://"))[0]
  }

  # `gs://bucket` with no prefix means "the whole bucket". `null` rather than "" because
  # the provider treats an unset prefix and an empty one differently in some versions.
  prefixes = {
    for id, base in local.bases :
    id => try(regex("^gs://[^/]+/(.*)$", base.data_source.uri)[0], null)
  }

  # The corpus each base imports into: created here, or the one the operator named. The
  # environment the runtime reads holds exactly this value.
  corpora = {
    for id, base in local.bases :
    id => base.vector_store.kind == "existing" ? coalesce(base.vector_store.arn, "") : try(google_vertex_ai_rag_corpus.this[id].name, "")
  }

  # One RagFile per source object. The provider has no prefix import -- each RagFile
  # names a single object -- so this listing is what turns a `gs://bucket/prefix` data
  # source into the per-file resources the API takes. The key is the object's full path,
  # which keeps two bases reading the same bucket from colliding.
  files = merge([
    for id, base in local.bases : {
      for object in try(data.google_storage_bucket_objects.source[id].bucket_objects, []) :
      "${id}/${object.name}" => {
        base = id
        uri  = "gs://${local.buckets[id]}/${object.name}"
      }
    }
  ]...)
}

# Read at plan time, so a plan against a bucket that does not exist yet fails by name
# rather than importing nothing. `prefix` is unset for a bucket-wide source.
data "google_storage_bucket_objects" "source" {
  for_each = local.bases

  bucket = local.buckets[each.key]
  prefix = local.prefixes[each.key]
}

# The RAG service agent is a Google-managed service account, created the first time a
# corpus is used in the project -- which is why the grant below depends on the corpus
# rather than on nothing. `_member` is additive: it adds one reader and leaves every
# other binding on the bucket alone, which is what makes it safe on a bucket the
# operator already owns.
resource "google_storage_bucket_iam_member" "rag_service_agent" {
  for_each = local.bases

  bucket = local.buckets[each.key]
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-vertex-rag.iam.gserviceaccount.com"

  depends_on = [google_vertex_ai_rag_corpus.this]
}

resource "google_vertex_ai_rag_corpus" "this" {
  for_each = local.provisioned

  project      = var.project_id
  display_name = local.name[each.key]
  description  = "The ${each.value.data_source.kind} corpus ${each.key} indexes for ${var.project.namespace}."
  region       = var.region
  labels       = var.tags
  # Delete protection at the API level. `prevent_destroy` below stops a plan from even
  # proposing a destroy; this stops an out-of-band one too.
  deletion_policy = "PREVENT"

  vector_db_config {
    # The RAG-managed store holds the index inside the corpus, so there is no endpoint,
    # no index resource and no per-hour floor for the operator to size.
    rag_managed_db {
      knn {}
    }

    rag_embedding_model_config {
      vertex_prediction_endpoint {
        # `embed_model_id` is the provider's model id; the project and region come from
        # this configuration so the spec does not restate two facts it already declared.
        endpoint = "projects/${data.google_project.current.number}/locations/${var.region}/publishers/google/models/${each.value.embed_model_id}"
      }
    }
  }

  lifecycle {
    # A corpus holds the embedded corpus, and re-importing it costs money and API
    # calls; an upstream rename should not destroy one as a side effect.
    prevent_destroy = true

    precondition {
      condition     = startswith(each.value.data_source.uri, "gs://")
      error_message = "Knowledge base \"${each.key}\" has a vertex-rag engine but its data source URI is \"${each.value.data_source.uri}\", which is not a gs:// object prefix. Vertex RAG reads Cloud Storage only."
    }

    precondition {
      condition     = each.value.chunking.strategy == "fixed"
      error_message = "Knowledge base \"${each.key}\" asks for chunking.strategy \"${each.value.chunking.strategy}\", and Vertex RAG has only fixed-length chunking (rag_file_chunking_config.fixed_length_chunking). Set chunking.strategy to fixed, or move this base to an engine that chunks it."
    }
  }
}

resource "google_vertex_ai_rag_file" "this" {
  for_each = local.files

  project    = var.project_id
  region     = var.region
  rag_corpus = local.corpora[each.value.base]

  gcs_source {
    # One object per RagFile: the API rejects a glob or a directory here.
    uris = [each.value.uri]
  }

  # The size and overlap the spec declared, in tokens -- which is what the API unit is,
  # so `chunking.size` needs no conversion. The accepted range depends on the embedder,
  # and the API is the authority on it: a spec default of 800 is legal for some models
  # and refused by others, so the plan says so rather than guessing a bound here.
  # `chunking.strategy` is known to be fixed: the corpus precondition above refuses
  # anything else.
  rag_file_transformation_config {
    rag_file_chunking_config {
      fixed_length_chunking {
        chunk_size    = local.bases[each.value.base].chunking.size
        chunk_overlap = local.bases[each.value.base].chunking.overlap
      }
    }
  }

  depends_on = [google_storage_bucket_iam_member.rag_service_agent]
}
