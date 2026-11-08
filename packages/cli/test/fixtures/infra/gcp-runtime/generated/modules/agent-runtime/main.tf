data "google_project" "current" {
  project_id = var.project_id
}

locals {
  runtime = {
    for id, service in var.services : id => service
    if service.target == "container" && service.runtime != null
  }

  managed = {
    for id, service in local.runtime : id => service
    if service.runtime.platform == "gcp-agent-platform"
  }

  # Display names allow lowercase letters, digits and hyphens and cap at 63 characters;
  # a namespace may carry a dot, and a trailing hyphen after truncation is not legal.
  name = {
    for id, service in local.managed :
    id => substr(
      replace(
        replace(lower("${var.project.namespace}-${var.project.name}-${id}"), "/[^a-z0-9-]/", "-"),
        "/-+$/",
        "",
      ),
      0,
      63,
    )
  }

  # Service-account ids are 6-30 characters and must start with a letter, so the fixed
  # `aid-` stem keeps even a one-character project legal.
  account_id = {
    for id, service in local.managed :
    id => substr("aid-${replace(lower(id), "/[^a-z0-9-]/", "-")}", 0, 30)
  }

  literal_env = {
    for id, service in local.managed : id => {
      for variable in service.env : variable.name => variable.value
      if variable.secret == false && variable.value != null
    }
  }

  # Only a secret the operator mapped to a secret id is resolvable; the module refuses
  # the rest below rather than letting the platform start a container with no value.
  secret_env = {
    for id, service in local.managed : id => [
      for variable in service.env : {
        name    = variable.name
        secret  = var.secret_ids[variable.name]
        version = "latest"
      }
      if variable.secret
    ]
  }

  # The platform pulls the image and resolves `secret_env` as this agent, not as the
  # runtime service account the app runs as.
  platform_agent = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
}

# ---------------------------------------------------------------------------- iam

resource "google_service_account" "runtime" {
  for_each = local.managed

  project      = var.project_id
  account_id   = local.account_id[each.key]
  display_name = "Agent runtime ${each.key}"
}

# The engine calls Vertex for RAG retrievals and model access, and writes its logs as
# the account the deployment names; neither is implied by running on the platform.
resource "google_project_iam_member" "runtime" {
  for_each = local.managed

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

resource "google_project_iam_member" "logs" {
  for_each = local.managed

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

# An image in Artifact Registry is readable by the platform agent only if granted;
# without this the first invocation fails with a pull error, not a deploy error.
resource "google_project_iam_member" "image" {
  count = length(local.managed) > 0 ? 1 : 0

  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = local.platform_agent
}

# One grant per (deployment, secret). The resource is created from the pair, so a secret
# two deployments share is granted once.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = {
    for pair in flatten([
      for id, variables in local.secret_env : [
        for variable in variables : {
          key    = "${id}/${variable.name}"
          id     = id
          name   = variable.name
          secret = variable.secret
        }
      ]
    ]) : pair.key => pair
  }

  project   = var.project_id
  secret_id = each.value.secret
  role      = "roles/secretmanager.secretAccessor"
  member    = local.platform_agent
}

# ------------------------------------------------------------------------ engine

# The engine schedules the same image the container target builds. `port` is the
# platform contract, and the spec refuses a deployment that moves `PORT` off it.
resource "google_vertex_ai_reasoning_engine" "managed" {
  for_each = local.managed

  project      = var.project_id
  region       = var.region
  display_name = local.name[each.key]
  description  = "Deployed by aid infra gen from the spec."

  spec {
    container_spec {
      image_uri = var.image_uris[each.key]
      port      = 8080
    }

    deployment_spec {
      dynamic "env" {
        for_each = local.literal_env[each.key]
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "secret_env" {
        for_each = local.secret_env[each.key]
        content {
          name = secret_env.value.name
          secret_ref {
            secret  = secret_env.value.secret
            version = secret_env.value.version
          }
        }
      }
    }

    service_account = google_service_account.runtime[each.key].email
  }

  lifecycle {
    precondition {
      condition     = contains(keys(var.image_uris), each.key)
      error_message = "No image_uris entry for \"${each.key}\". Name the released tag this runtime runs; the spec names a repository, not a tag."
    }

    precondition {
      condition     = alltrue([for variable in each.value.env : !variable.secret || contains(keys(var.secret_ids), variable.name)])
      error_message = "Service \"${each.key}\" references a secret with no secret_ids entry. Add name -> secret id for every secret it declares."
    }

    # v1 gap, said out loud: the provider has no Memory Bank resource. The spec refuses
    # `memory` on this platform, so a plan that reaches here cannot have asked for it.
    precondition {
      condition     = !each.value.runtime.memory_short_term
      error_message = "Service \"${each.key}\" asks for managed memory, which the Google provider has no resource for yet. Remove memory from this deployment or deploy it on aws-agentcore."
    }

    precondition {
      condition     = alltrue([for service in local.runtime : service.runtime.platform == "gcp-agent-platform"])
      error_message = "The agent-runtime module is rendering for GCP but the plan also declares a runtime on another platform. One environment is one cloud; split the deployments across environments."
    }
  }
}
