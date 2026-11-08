data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  # Only Bedrock bases reach this module. A `vertex-rag` base binds to GCP, where the
  # corpus is a Vertex AI RAG resource this configuration does not own, so emitting a
  # Bedrock base for it would create a second corpus the spec never asked for.
  bases = {
    for id, base in var.knowledge_bases : id => base
    if base.engine == "aws-bedrock"
  }

  # A collection name caps at 32 characters and allows only lower-case letters, digits
  # and hyphens; a namespace may carry a dot, so the replacement is what keeps
  # `aid.test` a legal collection name.
  name = {
    for id, base in local.bases :
    id => substr(
      lower(replace("${var.project.namespace}-${var.project.name}-${id}", "/[^A-Za-z0-9-_]/", "-")),
      0,
      32,
    )
  }

  # Only a base whose spec names a provisioned store gets an OpenSearch Serverless
  # collection. A base that points at an existing ARN must not create one, and the
  # `try(...)` below is what keeps that branch from reading a missing key.
  provisioned = {
    for id, base in local.bases : id => base
    if base.vector_store.kind == "provisioned"
  }

  # The bucket and the key prefix under it, split once here rather than at each of the
  # four places the S3 policy and the data source need them.
  buckets = {
    for id, base in local.bases :
    id => split("/", trimprefix(base.data_source.uri, "s3://"))[0]
  }

  # `s3://bucket` with no key means "the whole bucket", which the empty list below
  # spells as no prefix filter. A trailing slash is kept off so `docs` and `docs/` are
  # not two different filters for the same corpus.
  prefixes = {
    for id, base in local.bases :
    id => try(regex("^s3://[^/]+/(.*)$", base.data_source.uri)[0], "")
  }
}

resource "aws_opensearchserverless_collection" "vectors" {
  for_each = local.provisioned

  name = "${local.name[each.key]}-vectors"
  type = "VECTORSEARCH"
  tags = var.tags

  lifecycle {
    # A collection holds the indexed corpus. Re-creating one re-embeds every document,
    # so a rename upstream should be a deliberate change rather than a destroy.
    prevent_destroy = true
  }
}

# An encryption policy is required before a collection accepts a document, and it is
# account-regional: one per collection is harmless and keeps each base self-contained.
resource "aws_opensearchserverless_security_policy" "encryption" {
  for_each = local.provisioned

  name        = "${local.name[each.key]}-encryption"
  type        = "encryption"
  description = "Encrypts the corpus ${var.project.namespace} indexed for ${each.key}."
  policy = jsonencode({
    Rules = [{
      ResourceType = "collection"
      Resource     = ["collection/${local.name[each.key]}-vectors"]
    }]
    AWSOwnedKey = true
  })
}

# Bedrock reaches the collection over the service network, which a private network
# policy blocks unless the collection is also fronted by a VPC endpoint. The data
# policy is the authorization boundary here: nothing but the knowledge base role is
# granted, so reachability without a principal reads nothing.
resource "aws_opensearchserverless_security_policy" "network" {
  for_each = local.provisioned

  name        = "${local.name[each.key]}-network"
  type        = "network"
  description = "Reachable for the ${each.key} knowledge base; the data policy is the limit."
  policy = jsonencode([{
    Rules = [
      {
        ResourceType = "collection"
        Resource     = ["collection/${local.name[each.key]}-vectors"]
      },
      {
        ResourceType = "dashboard"
        Resource     = ["collection/${local.name[each.key]}-vectors"]
      },
    ]
    AllowFromPublic = true
  }])
}

# The knowledge base writes vectors with its own role, so the access policy names that
# role rather than the app's. Scoping it here is why the app needs no aoss permissions.
resource "aws_opensearchserverless_access_policy" "vectors" {
  for_each = local.provisioned

  name        = "${local.name[each.key]}-access"
  type        = "data"
  description = "Lets the ${each.key} knowledge base read and write its own vectors."
  policy = jsonencode([{
    Rules = [
      {
        ResourceType = "index"
        Resource     = ["index/${local.name[each.key]}-vectors/*"]
        Permission   = ["aoss:CreateIndex", "aoss:DescribeIndex", "aoss:ReadDocument", "aoss:WriteDocument", "aoss:UpdateIndex", "aoss:DeleteIndex"]
      },
    ]
    Principal = [aws_iam_role.knowledge_base[each.key].arn]
  }])
}

# The engine assumes this role to read the corpus and write vectors. The source-account
# condition is what stops a confused-deputy: without it any Bedrock caller that knew the
# ARN could have it read a bucket it was never granted.
resource "aws_iam_role" "knowledge_base" {
  for_each = local.bases

  name = "${local.name[each.key]}-kb-role"
  tags = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

# Three grants, each for one thing the engine does: read the source objects, embed them
# with the pinned model, and reach the collection. Nothing here is granted to the app.
resource "aws_iam_role_policy" "knowledge_base" {
  for_each = local.bases

  name = "${local.name[each.key]}-kb"
  role = aws_iam_role.knowledge_base[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${local.buckets[each.key]}",
          "arn:aws:s3:::${local.buckets[each.key]}/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = ["arn:aws:bedrock:${data.aws_region.current.name}::foundation-model/${each.value.embed_model_id}"]
      },
      {
        Effect   = "Allow"
        Action   = ["aoss:APIAccessAll"]
        Resource = ["arn:aws:aoss:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:collection/*"]
      },
    ]
  })
}

resource "aws_bedrockagent_knowledge_base" "this" {
  for_each = local.bases

  name     = local.name[each.key]
  role_arn = aws_iam_role.knowledge_base[each.key].arn
  tags     = var.tags

  knowledge_base_configuration {
    type = "VECTOR"

    vector_knowledge_base_configuration {
      embedding_model_arn = "arn:aws:bedrock:${data.aws_region.current.name}::foundation-model/${each.value.embed_model_id}"
    }
  }

  storage_configuration {
    type = "OPENSEARCH_SERVERLESS"

    opensearch_serverless_configuration {
      collection_arn    = try(aws_opensearchserverless_collection.vectors[each.key].arn, each.value.vector_store.arn)
      vector_index_name = "bedrock-knowledge-base-default-index"
      field_mapping {
        vector_field   = "bedrock-knowledge-base-default-vector"
        text_field     = "AMAZON_BEDROCK_TEXT_CHUNK"
        metadata_field = "AMAZON_BEDROCK_METADATA"
      }
    }
  }

  lifecycle {
    # A destroy deletes the index, and re-ingesting it costs money and API calls.
    prevent_destroy = true
  }
}

resource "aws_bedrockagent_data_source" "this" {
  for_each = local.bases

  name                 = "${local.name[each.key]}-source"
  knowledge_base_id    = aws_bedrockagent_knowledge_base.this[each.key].id
  description          = "The ${each.value.data_source.kind} prefix ${each.key} reads."
  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn = "arn:aws:s3:::${local.buckets[each.key]}"
      # A URI that names the bucket alone has no prefix to filter on, and an empty
      # list is how the API asks for the whole bucket.
      inclusion_prefixes = local.prefixes[each.key] == "" ? [] : [local.prefixes[each.key]]
    }
  }

  vector_ingestion_configuration {
    chunking_configuration {
      chunking_strategy = each.value.chunking.strategy == "fixed" ? "FIXED_SIZE" : "HIERARCHICAL"

      dynamic "fixed_size_chunking_configuration" {
        for_each = each.value.chunking.strategy == "fixed" ? [1] : []
        content {
          max_tokens         = each.value.chunking.size
          overlap_tokens     = each.value.chunking.overlap
        }
      }

      dynamic "hierarchical_chunking_configuration" {
        for_each = each.value.chunking.strategy == "fixed" ? [] : [1]
        content {
          level_configuration {
            max_tokens = each.value.chunking.size
          }
        }
      }
    }
  }

  lifecycle {
    # A data source is cheap to recreate; the corpus it fills is not. Keeping it stable
    # means a `tofu apply` after a chunking edit does not delete the indexed documents.
    ignore_changes = [vector_ingestion_configuration]
  }
}
