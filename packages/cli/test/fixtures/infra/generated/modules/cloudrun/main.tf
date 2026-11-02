locals {
  container = {
    for id, service in var.services : id => service
    if service.target == "container"
  }

  # Cloud Run names allow lowercase letters, digits and hyphens only, are at most 63
  # characters, and become the URL path -- while a namespace may carry a dot
  # (`aid.test`), and a trailing hyphen after truncation is not legal. Both are cleared
  # here; a name that still cannot start a request is refused by the precondition below.
  name = {
    for id, service in local.container :
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

  # Service account ids are 6-30 characters and must start with a letter, so the same
  # name with a fixed prefix keeps even a one-character project legal.
  account_id = {
    for id, service in local.container :
    id => substr(
      replace(
        replace(lower("aid-${var.project.namespace}-${var.project.name}-${id}"), "/[^a-z0-9-]/", "-"),
        "/-+$/",
        "",
      ),
      0,
      30,
    )
  }

  # Repository id: lowercase letters, digits and hyphens, 4-63 characters, so the
  # namespace and project name are enough without the service id.
  repository_id = replace(
    replace(lower("${var.project.namespace}-${var.project.name}"), "/[^a-z0-9-]/", "-"),
    "/-+$/",
    "",
  )

  # One binding per (service, secret). Keyed by both because two services may read the
  # same secret and each needs its own grant for its own identity.
  secret_env = {
    for pair in flatten([
      for id, service in local.container : [
        for variable in service.env : { service = id, name = variable.name }
        if variable.secret
      ]
    ]) : "${pair.service}/${pair.name}" => pair
  }
}

resource "google_service_account" "service" {
  for_each     = local.container
  account_id   = local.account_id[each.key]
  display_name = "${var.project.namespace}-${var.project.name}-${each.key}"
}

resource "google_cloud_run_v2_service" "service" {
  for_each = local.container

  name                = local.name[each.key]
  location            = var.region
  labels              = var.tags
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.service[each.key].email

    # Cloud Run defaults to 80 concurrent requests per instance, which suits an ASGI
    # app that awaits models; lower it for a service whose memory grows per request.
    max_instance_request_concurrency = coalesce(
      try(var.cloudrun_sizing[each.key].concurrency, null),
      80,
    )

    scaling {
      min_instance_count = coalesce(try(var.cloudrun_sizing[each.key].min_instances, null), 0)
      max_instance_count = coalesce(try(var.cloudrun_sizing[each.key].max_instances, null), 10)
    }

    containers {
      # `lookup` rather than an index: a missing entry is a business input still to
      # supply, and the precondition below should say so instead of an index error.
      image = lookup(var.image_uris, each.key, "")

      # The generated Dockerfile reads `$PORT` and defaults it to 8080, which is also
      # the port Cloud Run sends traffic to.
      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = coalesce(try(var.cloudrun_sizing[each.key].cpu, null), "1")
          memory = "${coalesce(try(var.cloudrun_sizing[each.key].memory_mb, null), 512)}Mi"
        }
      }

      dynamic "env" {
        for_each = {
          for variable in each.value.env : variable.name => variable
          if variable.secret == false && variable.value != null
        }
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      # A secret is a reference, not a value: the image reads it from the environment,
      # and the value never enters state or a plan file.
      dynamic "env" {
        for_each = {
          for variable in each.value.env : variable.name => variable
          if variable.secret
        }
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = lookup(var.secret_ids, env.value.name, "")
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = contains(keys(var.image_uris), each.key)
      error_message = "No image_uris entry for \"${each.key}\". Name the container image this service runs."
    }

    precondition {
      condition = alltrue([
        for variable in each.value.env : contains(keys(var.secret_ids), variable.name)
        if variable.secret
      ])
      error_message = "Service \"${each.key}\" references a secret with no secret_ids entry. Add name -> Secret Manager secret id for every secret it declares."
    }

    precondition {
      condition     = can(regex("^[a-z][a-z0-9-]*$", local.name[each.key]))
      error_message = "Service name \"${local.name[each.key]}\" cannot be a Cloud Run name: it must start with a lowercase letter. Shorten or rename the project namespace."
    }
  }
}

# Without this binding the service account cannot read a secret, and the image fails on
# its first model call rather than at plan time. `for_each` over an empty map rather than
# `count`, because a binding with no secret id is invalid rather than merely empty.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = length(var.secret_ids) > 0 ? local.secret_env : {}

  secret_id = lookup(var.secret_ids, each.value.name, each.value.name)
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.service[each.value.service].email}"
}

# Cloud Run authenticates every request by default. A model gateway is a public URL, so
# the operator asks for the allUsers binding explicitly instead of getting it silently.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = var.allow_unauthenticated ? local.container : {}

  name     = google_cloud_run_v2_service.service[each.key].name
  location = google_cloud_run_v2_service.service[each.key].location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The registry the images are pushed to. It is created once per project, not per
# service, and only when there is a service to run.
resource "google_artifact_registry_repository" "images" {
  for_each = length(local.container) > 0 ? { images = true } : {}

  location      = var.region
  repository_id = substr(local.repository_id, 0, 63)
  format        = "DOCKER"
  labels        = var.tags
}
