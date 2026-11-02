locals {
  batch = {
    for id, service in var.services : id => service
    if service.target == "batch"
  }

  # Cloud Run names allow lowercase letters, digits and hyphens only, are at most 63
  # characters, and are not allowed to end in a hyphen -- while a namespace may carry a
  # dot (`aid.test`). Both are cleared here; a name that still cannot start is refused
  # by the precondition below.
  name = {
    for id, service in local.batch :
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
    for id, service in local.batch :
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

  # One binding per (job, secret). Keyed by both because two jobs may read the same
  # secret and each needs its own grant for its own identity.
  secret_env = {
    for pair in flatten([
      for id, service in local.batch : [
        for variable in service.env : { service = id, name = variable.name }
        if variable.secret
      ]
    ]) : "${pair.service}/${pair.name}" => pair
  }

  # A job whose models name Vertex calls it with its own service account, so the project
  # role below is the only credential it needs -- the same shape as the AWS modules'
  # Bedrock grant, and derived from `providers` rather than from a flag.
  vertex = {
    for id, service in local.batch : id => service
    if contains(service.providers, "google")
  }

  # The Vertex adapter reads its project and location from the environment, and Cloud Run
  # sets neither. Both facts are already inputs here, so they are supplied rather than
  # left to fail on the first model call. A variable the spec declares itself wins:
  # pointing a job at another project is a decision, not a mistake to overwrite.
  vertex_defaults = {
    GOOGLE_CLOUD_PROJECT = var.project_id
    GOOGLE_CLOUD_REGION  = var.region
  }

  vertex_env = {
    for id, service in local.vertex : id => {
      for name, value in local.vertex_defaults : name => value
      if !contains([for variable in service.env : variable.name], name)
    }
  }
}

resource "google_service_account" "job" {
  for_each     = local.batch
  account_id   = local.account_id[each.key]
  display_name = "${var.project.namespace}-${var.project.name}-${each.key}"
}

# A user-managed service account starts with no project permissions, and Cloud Run
# forwards a container's stdout through it. Without this role the job runs and leaves no
# log behind, which is the least debuggable failure this module can produce. The default
# compute identity has it; swapping in a service account silently drops it.
resource "google_project_iam_member" "logging" {
  for_each = local.batch

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.job[each.key].email}"
}

# Vertex AI authenticates with the service account, so a `google`-backed job needs no
# key in state -- the same bargain as the AWS modules' Bedrock grant. The role is
# project-scoped because `aiplatform.user` has no per-job resource to attach to, and it is
# granted only to a job that names the provider.
resource "google_project_iam_member" "vertex" {
  for_each = local.vertex

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.job[each.key].email}"
}

# Defining the job does not run it, exactly as on AWS: an execution is started
# separately (`gcloud run jobs execute <name> --region <region>`). That split is why no
# start/run execution token is needed here, and why this module needs no `google-beta`.
resource "google_cloud_run_v2_job" "job" {
  for_each = local.batch

  name                = local.name[each.key]
  location            = var.region
  labels              = var.tags
  deletion_protection = var.deletion_protection

  template {
    # One task per execution: a `batch` deployment is one pipeline run, so parallelism
    # buys nothing and a retry must not double a model call.
    task_count  = 1
    parallelism = 1

    template {
      service_account = google_service_account.job[each.key].email

      # A whole-run deadline, not a per-attempt one as on AWS Batch. Cloud Run caps it at
      # 24 hours; the default matches the AWS module so one env root reads the same.
      timeout = "${coalesce(try(var.batch_sizing[each.key].timeout_seconds, null), 3600)}s"

      # Cloud Run counts retries after the first attempt, AWS Batch counts attempts.
      # The input keeps the AWS spelling so the two env roots stay comparable.
      max_retries = max(coalesce(try(var.batch_sizing[each.key].attempts, null), 1) - 1, 0)

      containers {
        # `lookup` rather than an index: a missing entry is a business input still to
        # supply, and the precondition below should say so instead of an index error.
        image = lookup(var.image_uris, each.key, "")

        # The generated entrypoint takes the pipeline as argv, and the image already has
        # `python` on its path because the Dockerfile builds the app from it.
        command = ["python", "-m", "app.generated.batch"]
        args    = [coalesce(each.value.pipeline, "")]

        resources {
          limits = {
            cpu    = coalesce(try(var.batch_sizing[each.key].cpu, null), "1")
            memory = "${coalesce(try(var.batch_sizing[each.key].memory_mb, null), 512)}Mi"
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

        # Vertex reads the project and location it should call from the environment, so a
        # job that names `google` gets both without the spec restating them.
        dynamic "env" {
          for_each = lookup(local.vertex_env, each.key, {})
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = try(var.image_uris[each.key], "") != ""
      error_message = "No image_uris entry for \"${each.key}\". A Cloud Run job must name the image it runs."
    }

    precondition {
      condition     = try(each.value.pipeline, "") != ""
      error_message = "Deployment \"${each.key}\" targets batch but names no pipeline. Set deployments.${each.key}.pipeline to the pipeline the job runs."
    }

    precondition {
      condition = alltrue([
        for variable in each.value.env : contains(keys(var.secret_ids), variable.name)
        if variable.secret
      ])
      error_message = "Deployment \"${each.key}\" references a secret with no secret_ids entry. Add name -> Secret Manager secret id for every secret it declares."
    }

    precondition {
      condition     = can(regex("^[a-z][a-z0-9-]*$", local.name[each.key]))
      error_message = "Job name \"${local.name[each.key]}\" cannot be a Cloud Run name: it must start with a lowercase letter. Shorten or rename the project namespace."
    }
  }
}

# Without this binding the service account cannot read a secret, and the job fails on its
# first model call rather than at plan time. `for_each` over an empty map rather than
# `count`, because a binding with no secret id is invalid rather than merely empty.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = length(var.secret_ids) > 0 ? local.secret_env : {}

  secret_id = lookup(var.secret_ids, each.value.name, each.value.name)
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job[each.value.service].email}"
}
