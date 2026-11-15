---
description: "The shipped provider, cloud and target matrix, generated from the declarations the compiler enforces."
---

# Support

This page is read from the declarations the compiler enforces, not maintained by hand: the provider set is `SERVED_PROVIDERS` (what the normalize gate accepts) and the cloud matrix is `CLOUD_TARGETS` (what the infra planner refuses outside of). If a provider or cloud is missing here, a spec that names it is rejected at plan time rather than quietly generated.

## Model providers

Every provider below is served by `py-fastapi` and `ts-vercel` and is accepted by the normalize gate.

| Provider | Served by |
| --- | --- |
| `anthropic` | `py-fastapi`, `ts-vercel` |
| `bedrock` | `py-fastapi`, `ts-vercel` |
| `gemini` | `py-fastapi`, `ts-vercel` |
| `google` | `py-fastapi`, `ts-vercel` |
| `openai` | `py-fastapi`, `ts-vercel` |
| `openai-compatible` | `py-fastapi`, `ts-vercel` |
| `fake` | `py-fastapi`, `ts-vercel` |

## Clouds and deployment targets

A `yes` means the infra planner emits a module for that target on that cloud. A dash means it refuses the plan with a named diagnostic; it does not emit unvalidated HCL. Every emitted module is byte-asserted against a committed fixture and validated with `tofu validate` in CI.

| Target | `aws` | `gcp` | `azure` |
| --- | --- | --- | --- |
| `batch` | yes | yes | — |
| `container` | yes | yes | — |
| `edge` | yes | — | — |
| `serverless` | yes | yes | — |

The emitted infrastructure is OpenTofu, CDK, or a Helm chart. A plan targets one cloud at a time, because two providers in one state is a blast radius rather than a feature.

`kubernetes` is a deployment target rather than a cloud, so it has no column here: `aid infra gen --iac helm` emits a chart that installs on any conformant cluster, and `cloud` keeps naming where the image registry and the audit sink live. `azure` has a column and a dash in every row because AID emits no Azure compute module. An Azure customer places the workload on their own cluster -- `target: kubernetes` with `cloud: azure` and `region: uksouth` for the registry and the `azure-monitor` audit sink -- and installs the chart on AKS. That is the boundary stated plainly: the chart is cloud-neutral, and the Azure module set does not exist. The trigger to write one is the first customer whose policy forbids running the workload on a cluster they hold the control plane for.

A cloud name is not a runtime: `cloud: kubernetes`, `cloud: k8s` and `cloud: openshift` are refused by `ir/cloud-unsupported`, which names the supported set and points here. To run on a cluster, set `target: kubernetes` and let `cloud` keep describing the account the registry and audit sink belong to. A name that is not a cloud at all (`awz`) is `ir/deploy-target-unknown` instead. A cloud enters this table by way of a module set per target, byte-asserted fixtures and `tofu validate` in CI, so the trigger to add one is a customer requirement that cannot be served on `aws` or `gcp` -- not a preference for a different vendor.

## Alerts and the target you choose

`observability.alerts` is the one observability declaration that can be wrong without failing: an alarm over a series nothing records reports no data forever, which reads as healthy. The series it watches are published only by a target whose manifest declares the `metrics` capability, so the compiler checks the pair rather than generating an alarm that can never fire.

Only `py-fastapi` publishes them, so a document that asks for an alert and generates for `ts-vercel` is refused with `ir/alerts-unproduced`, naming the metric and the target that would have written nothing.

Publishing takes two steps, and declaring the export is only the first: the series appear when the application entrypoint calls `metrics_export_status()`, and the entrypoint is the developer's own file, so no gate can require that call. `aid doctor` reports it as `cli/metrics-uninstalled` instead of leaving an alarm to watch an empty series.

## Spec language

The current spec language version is `0.36`.
A construct that needs a later version is reported as `spec/not-supported`, naming the version it needs, instead of being ignored.

Retriever chunking strategies are all implemented in both runtimes:

| `chunking.strategy` | Python | TypeScript | Since |
| --- | --- | --- | --- |
| `fixed` | yes | yes | 0.1 |
| `recursive` | yes | yes | 0.1 |
| `semantic` | yes | yes | 0.22 |
| `code` | yes | yes | 0.1 |

A retriever the application ingests itself can declare `refresh.schedule` since 0.23: a five-field cron read as UTC, which the plan turns into a scheduler rather than a second ingestion path. A retriever bound to a managed knowledge base still refuses `refresh` entirely, because the managed engine owns ingestion.

| `refresh.schedule` | `aws` | `gcp` |
| --- | --- | --- |
| Scheduler | `aws_scheduler_schedule` | `google_cloud_scheduler_job` |
| Run it starts | `aws_batch_job_definition` | `google_cloud_run_v2_job` |
| Cron dialect | EventBridge `cron(...)`, UTC | five-field cron, `Etc/UTC` |
| Also required | a `target: batch` deployment that ingests the retriever | the same |

## Conformance

The corpus holds 77 cases over 41 operations, run against every target. A case that a target cannot satisfy is a declared capability boundary, not a skipped test.

---

Next: [the generator targets](./targets.md), [the CLI reference](./cli.md), or [the conformance index](./conformance.md).
