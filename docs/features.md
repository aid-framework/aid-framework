---
description: "What ships out of the box, which cloud runs each deployment target, and what the compiler refuses, with the release that first shipped each feature."
---

# Features

The provider and cloud lists are read from the declarations the compiler enforces, not maintained by hand. Everything else is a registry that a test holds to those declarations and to the release that first shipped each entry. The spec language is at `0.30`.

## Deployment targets

A deployment names one target, and the generated infrastructure runs it on one cloud. Each bullet names the managed service the emitted OpenTofu configures. A cloud that cannot run the target is a refusal with a named diagnostic, not a target that is still to come.

### `serverless`

- **`aws`:** API Gateway + Lambda
- **`gcp`:** Cloud Run

### `container`

- **`aws`:** ECS on Fargate
- **`gcp`:** Cloud Run

### `batch`

- **`aws`:** AWS Batch
- **`gcp`:** Cloud Run job

### `edge`

- **`aws`:** Lambda@Edge on CloudFront
- **`gcp`:** refused with `cli/infra-cloud-target-unsupported` — Cloud CDN serves static assets and cannot run the app, so there is no GCP resource to map `edge` to.

## Model providers

Every provider in `SERVED_PROVIDERS` has a section. The capabilities it advertises are the ones the spec's `capabilities` enum may declare; a spec that names one the adapter does not advertise is refused with `ir/model-capability-missing`, because the provider's API has no such endpoint.

### `anthropic`

- **Adapter:** `AnthropicProvider`
- **Advertises:** tools, structured output, streaming
- **Refuses:** embeddings (`AnthropicProvider` does not advertise `EMBEDDINGS`).
- **Catalog:** 2 models, 2 priced

### `bedrock`

- **Adapter:** `BedrockProvider`
- **Advertises:** tools, structured output, embeddings
- **Refuses:** streaming (`BedrockProvider` does not advertise `STREAMING`).
- **Catalog:** 3 models, 3 priced

### `gemini`

- **Adapter:** `GeminiProvider`
- **Advertises:** tools, structured output, streaming, embeddings
- **Catalog:** 1 model, 1 priced

### `google`

- **Adapter:** `VertexProvider`
- **Advertises:** tools, structured output, streaming, embeddings
- **Catalog:** 2 models, 2 priced

### `openai`

- **Adapter:** `OpenAICompatibleProvider`
- **Advertises:** tools, structured output, streaming, embeddings
- **Catalog:** 5 models, 5 priced

### `openai-compatible`

- **Adapter:** `OpenAICompatibleProvider`
- **Advertises:** tools, structured output, streaming, embeddings
- **Catalog:** none — no pinned model or cost profile is published for this provider, so the spec must give an explicit `modelId` and the call prices as unknown.

### `fake`

- **Adapter:** `FakeProvider`
- **Advertises:** tools, structured output, streaming, embeddings
- **Catalog:** none — no pinned model or cost profile is published for this provider, so the spec must give an explicit `modelId` and the call prices as unknown.

## Cloud AI infrastructure

The generated infrastructure does not only run the service; it grants the service the cloud identity it needs to call a managed model. Where a cloud needs extra configuration to reach its model platform, the module sets that too.

### Bedrock from the AWS module

- **Declared by:** `models[].provider: bedrock`
- **Emitted:** `bedrock:InvokeModel`, plus `bedrock:InvokeModelWithResponseStream` when a service declares `streaming`, scoped to the foundation-model and inference-profile ARNs
- **Runtime credential:** the IAM role the module creates for the service
- **Since:** `0.1.81`

### Vertex AI from the GCP modules

- **Declared by:** `models[].provider: google`
- **Emitted:** `roles/aiplatform.user` on the project, plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_REGION` on the Cloud Run service or job, which Cloud Run does not set
- **Runtime credential:** the service account the module creates
- **Since:** `0.1.83`

### Bedrock Guardrails as the guardrail engine

- **Declared by:** `guardrails[].engine: bedrock`
- **Emitted:** an `aws_bedrock_guardrail` and its numbered version from the `bedrock:` block, `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` on the service, and `bedrock:ApplyGuardrail` on that guardrail alone — the CDK construct mirrors all of it; omit the block and the app reads the two variables for a guardrail the operator owns
- **Runtime credential:** the IAM role the module creates for the service
- **Since:** `0.1.98`

### Vertex AI Model Armor as the guardrail engine

- **Declared by:** `guardrails[].engine: model-armor`
- **Emitted:** `MODEL_ARMOR_TEMPLATE`, the full template name `projects/{project}/locations/{location}/templates/{id}` the runtime reads, and `sanitizeUserPrompt` / `sanitizeModelResponse` calls against it; a 0.15 `modelArmor:` block makes the module create a `google_model_armor_template` from the spec and hand its name to the service, and without one the app reads the variable for a template the operator owns
- **Runtime credential:** a service account the operator grants `roles/modelarmor.user`
- **Since:** `0.1.109`

### Bedrock knowledge bases

- **Declared by:** `knowledgeBases[].engine: aws-bedrock`
- **Emitted:** an `aws_bedrockagent_knowledge_base` over an S3 prefix, its `aws_bedrockagent_data_source`, an OpenSearch Serverless collection with the data-access policy the base needs, and `bedrock:Retrieve` on the service that reads it — the base is created empty, so ingestion is a separate operator step
- **Runtime credential:** the IAM role the module creates for the service
- **Since:** `0.1.99`

### Vertex AI RAG corpora

- **Declared by:** `knowledgeBases[].engine: vertex-rag`
- **Emitted:** a `google_vertex_ai_rag_corpus` on the RAG-managed store with the spec’s embedding model, one `google_vertex_ai_rag_file` per object under the `gs://` prefix, `roles/storage.objectViewer` for the RAG service agent, and `VERTEX_RAG_CORPUS_&lt;ID&gt;` on the Cloud Run service or job
- **Runtime credential:** the service account the module creates
- **Since:** `0.1.99`

## Out of the box

Each section is behaviour the generator writes for you, the spec key or command that turns it on, and the release that first shipped it. A construct that needs a later spec version is refused by name rather than ignored.

### Versioned spec language

A construct that needs a later version is refused by name instead of being ignored, so a spec never silently means less than it says.

- **Turned on by:** `specVersion`
- **Reference:** [spec](./reference/spec.md#top-level-keys)
- **Since:** `0.1.0`

### Pinned model ids

A model alias is what the rest of the spec refers to; the vendor id is pinned in one place and never floats to a vendor default.

- **Turned on by:** `models[].modelId`
- **Reference:** [spec](./reference/spec.md#model)
- **Since:** `0.1.0`

### Priced calls

A committed cost profile prices every call. An unpriced model is reported as unknown, never as free.

- **Turned on by:** `models[].costProfile`
- **Reference:** [spec](./reference/spec.md#model)
- **Since:** `0.1.0`

### Capability refusal

A spec that asks a target for something it cannot serve is refused at plan time with a named diagnostic, not shipped and debugged in production.

- **Turned on by:** `deployments[].target`
- **Reference:** [targets](./reference/targets.md#capability-matrix)
- **Since:** `0.1.2`

### Eval coverage

An HTTP pipeline with no CI eval claiming it is a build error, so a prompt edit cannot ship unmeasured.

- **Turned on by:** `evals[].gate.ci`
- **Reference:** [spec](./reference/spec.md#eval)
- **Since:** `0.1.2`

### Retrieval with citations

A retriever can require that retrieved items carry the source path and offsets a generated answer cites.

- **Turned on by:** `retrievers[].traits`
- **Reference:** [spec](./reference/spec.md#retriever)
- **Since:** `0.1.6`

### Embeddings on Bedrock, Vertex AI and the Gemini API

A pinned embedding is routed by its provider, so Titan on Bedrock is signed with SigV4, `google` on Vertex AI is sent under the project and bearer token, and `gemini` is sent to the AI Studio `:batchEmbedContents` endpoint with `x-goog-api-key` — each instead of the OpenAI-compatible shape.

- **Turned on by:** `models[].capabilities`
- **Reference:** [spec](./reference/spec.md#model)
- **Since:** `0.1.109`

### Guardrail stages

Policies are evaluated at declared stages, and a failing policy has a declared action rather than a default.

- **Turned on by:** `guardrails[]`
- **Reference:** [spec](./reference/spec.md#guardrail)
- **Since:** `0.1.18`

### Unprotected routes are refused

A POST route that passes caller text to a prompt with no input guardrail fails the build before it can be exposed.

- **Turned on by:** `guardrails[].stages`
- **Reference:** [spec](./reference/spec.md#guardrail)
- **Since:** `0.1.18`

### Agents and handoffs

An agent declares its model, instructions, tools, retrievers and budget; a handoff cycle and an exhausted budget are plan-time errors.

- **Turned on by:** `agents[]`
- **Reference:** [spec](./reference/spec.md#agent)
- **Since:** `0.1.19`

### Step-level human approval

A tool that writes something pauses the run for a person, and the approved run continues from the same step instead of starting over; a side-effecting tool with no approval policy is refused under the enterprise profile.

- **Turned on by:** `agents[].humanInTheLoop, tools[].requiresConfirmation`
- **Reference:** [spec](./reference/spec.md#agent-humanintheloop)
- **Since:** `0.1.27`

### Durable run state

A paused or long-running run outlives the process that started it: the checkpoint goes to the store the spec names, and an agent that can call a side-effecting tool is refused without one.

- **Turned on by:** `state, agents[].state`
- **Reference:** [spec](./reference/spec.md#agentstate)
- **Since:** `0.1.143`

### Memory tiers

What is remembered, for how long, within what token budget, and where it lives.

- **Turned on by:** `memory[]`
- **Reference:** [spec](./reference/spec.md#memory)
- **Since:** `0.1.19`

### Semantic cache

The opt-in fuzzy layer beside exact-match caching, carrying its own similarity threshold rather than a global default.

- **Turned on by:** `models[].cache.semantic`
- **Reference:** [spec](./reference/spec.md#semanticcache)
- **Since:** `0.1.25`

### Local trace capture

A run writes JSONL spans to a directory you name, and `aid trace` prints the span tree from them. No collector to stand up.

- **Turned on by:** `aid trace`
- **Reference:** [cli](./reference/cli.md#trace)
- **Since:** `0.1.56`

### Infrastructure from the spec

A deployment plan derives OpenTofu modules for the chosen cloud, byte-asserted against fixtures and validated with `tofu` in CI.

- **Turned on by:** `deployments[]`
- **Reference:** [spec](./reference/spec.md#deployment)
- **Since:** `0.1.54`

### A CDK backend

The same deployment plan can emit a CDK app instead, for a team already deploying with it.

- **Turned on by:** `aid infra --iac cdk`
- **Reference:** [cli](./reference/cli.md#infra)
- **Since:** `0.1.57`

### Eject

Take ownership of a generated file: it stops being regenerated and the app keeps booting, because it never depended on a control plane.

- **Turned on by:** `aid eject`
- **Reference:** [cli](./reference/cli.md#eject)
- **Since:** `0.1.58`

### Generated project CI

Every generated project ships the workflow that runs its evals, so the gate travels with the code it gates.

- **Turned on by:** `aid gen`
- **Reference:** [cli](./reference/cli.md#gen)
- **Since:** `0.1.59`

### Cost and latency ceilings in CI

A cost or latency budget is an eval metric the harness measures around every case, so the generated workflow exits non-zero when a run spends or takes more than the spec allowed.

- **Turned on by:** `evals[].metrics[].kind: cost`
- **Reference:** [spec](./reference/spec.md#kind-cost)
- **Since:** `0.1.153`

### A Dockerfile and an image

A container deployment emits the Dockerfile and the release workflow that builds and pushes the image it deploys.

- **Turned on by:** `deployments[].image`
- **Reference:** [spec](./reference/spec.md#image)
- **Since:** `0.1.70`

### Jev-backed decisions

A named question with its own reply shape, answered by TypeSafe AI Jev, and referenced by guardrails, routers and evals.

- **Turned on by:** `decisions[]`
- **Reference:** [spec](./reference/spec.md#decision)
- **Since:** `0.1.88`

### A decision-backed guardrail

An input guardrail asks a declared decision and enforces a minimum confidence, so the check is a typed answer rather than free text.

- **Turned on by:** `guardrails[].decision`
- **Reference:** [spec](./reference/spec.md#guardrail)
- **Since:** `0.1.90`

### A decision eval metric

An eval scores a decision on its own reply shape, so a guardrail change is measured like any other behaviour.

- **Turned on by:** `evals[].metrics[].kind: decision`
- **Reference:** [spec](./reference/spec.md#kind-decision)
- **Since:** `0.1.91`

### S3 and HTTP corpus sources

A retriever indexes an `s3://` prefix or one `http(s)://` document instead of a local directory, under the same glob grammar, with document ids relative to the prefix.

- **Turned on by:** `retrievers[].source.kind`
- **Reference:** [spec](./reference/spec.md#retriever)
- **Since:** `0.1.134`

### Semantic chunking

A retriever cuts a document where the cosine similarity between adjacent units dips, so a boundary follows the topic rather than a character count; the units are embedded before the chunks are, and that boundary pass is priced into the ingest report.

- **Turned on by:** `retrievers[].chunking.strategy: semantic`
- **Reference:** [spec](./reference/spec.md#retriever)
- **Since:** `0.1.135`

### Scheduled re-ingestion

A retriever the application ingests itself declares a five-field cron read as UTC, and the generated module emits a cloud scheduler that submits the job running that retriever's ingest.

- **Turned on by:** `retrievers[].refresh.schedule`
- **Reference:** [spec](./reference/spec.md#retriever)
- **Since:** `0.1.136`

### Tools federated behind a managed MCP endpoint

A `gateways` entry names an Amazon Bedrock AgentCore Gateway, its authorizer and the OpenAPI or MCP-server targets behind it, so a runtime reaches federated tools over one MCP endpoint instead of bundling every tool; an `aws-agentcore` runtime that names a gateway is handed its URL and the permission to invoke it.

- **Turned on by:** `gateways[], deployments[].runtime.gateway`
- **Reference:** [spec](./reference/spec.md#gateway)
- **Since:** `0.1.139`

### Delivery profiles with a pinned placement and audit sink

A top-level `profile` names a bundle of required controls -- `standard` is the default and `enterprise` is the regulated one -- and a deployment can pin the `cloud`, `region` and `audit` sink it lands in, so the placement and the audit record are properties of the customer rather than of whoever ran the apply. The `profile` gate refuses an `enterprise` spec that omits a region pin, an audit sink, or a guardrail that runs on output.

- **Turned on by:** `profile, deployments[].cloud, deployments[].region, deployments[].audit`
- **Reference:** [spec](./reference/spec.md#top-level-keys)
- **Since:** `0.1.142`

### Durable run state, deployment identity, private network and change approval

Spec 0.26 declares the controls an enterprise delivery is held to: a `state` store that outlives the process, an `identity` reference (issuer, audience and claim names) that becomes the runtime `Principal`, a `network` block whose `private` pin is required, an `approvals` policy for production change, and `requiresApproval` on a pipeline tool step. The `state` and `approvals` gates refuse a document that declares a control it cannot honour -- an enterprise agent that can write with no store, an approval on a read, or a pause with nowhere to wait.

- **Turned on by:** `state, deployments[].identity, deployments[].network, deployments[].approvals`
- **Reference:** [spec](./reference/spec.md#top-level-keys)
- **Since:** `0.1.143`

### A declared place for the spans, and an exporter that reaches it

Spec 0.27 gives a document an `observability` block: whether to record spans, what to redact, and whether they belong somewhere other than the process (`export: otlp`, with `endpointEnv` naming the variable that holds the collector address). The `observability/export` gate refuses an `otlp` export beside `trace: false`, and an `enterprise` profile that exports nothing, because an audit trail whose spans stay in the process is not one. Generating with py-fastapi emits `tracing_export_status()` into `app/generated/observability.py`, which the app calls at startup to install an OTLP/HTTP exporter over a batched processor from `aid-runtime-python[otlp]`; nothing is installed on import, so embedding AID does not decide telemetry for you. A target that installs no exporter refuses `export: otlp` rather than accept a destination nothing is sent to.

- **Turned on by:** `observability`
- **Reference:** [spec](./reference/spec.md#observability)
- **Since:** `0.1.150`

### The series the alarms watch, recorded and exported

Four series -- `agent.cost`, `agent.tokens`, `eval.cost` and `eval.latency.p95` -- are recorded by `aid-runtime-python` and leave by the same opt-in export as the spans: `configure_metrics()` installs an OTLP/HTTP reader and the generated `metrics_export_status()` reports where it went. A run stopped by a guardrail or an exhausted ceiling publishes what it spent before the refusal propagates, and an eval suite publishes one `eval.cost` and one `eval.latency.p95` sample per case per run under the declared eval id, so the series an alarm filters on is the eval the spec declares. An alert over a series the target does not record is refused by `ir/alerts-unproduced` rather than shipped as an alarm that would never fire; ts-vercel records none and refuses all four.

- **Turned on by:** `observability`
- **Reference:** [spec](./reference/spec.md#observability)
- **Since:** `0.1.152`

### A report across every deployment

`aid report &lt;dir&gt;` reads one directory of deployments -- each holding the `*.jsonl` files that deployment's trace sink wrote and any `*.baseline.json` it committed -- and prints spans, traces, measured cost, p95 latency, errors and baseline scores side by side, then a fleet total. A deployment with no trace files shows a dash rather than `$0.000000`, because "nothing was measured" and "measured zero" are different answers. Nothing is uploaded and nothing is joined to the repository, so the same command runs on a CI artifact download; `--budget` turns the total into a ceiling that fails the job.

- **Turned on by:** `aid report`
- **Reference:** [cli](./reference/cli.md#report)
- **Since:** `0.1.148`

### Declared feedback signals

Spec 0.28 lets a document say which feedback it collects (thumbs, corrections, escalations) and which fields may ride along. The `feedback` gate refuses a persistent store with no retention window, and refuses a correction store whose redaction list misses a field the spec already marks sensitive -- so a signal that could carry a customer name cannot be collected without a rule about it. AID routes and stores nothing; the declaration and its refusal are what exist.

- **Turned on by:** `observability.feedback`
- **Reference:** [spec](./reference/spec.md#observability)
- **Since:** `0.1.146`

### Promotion policy for a candidate

Spec 0.28 states what a candidate is allowed to cost in quality and in spend: `evals[].gate.promotion` names the baseline prompt version, the quality drop and cost increase it may not exceed, and -- under `enterprise` -- who records the approval. `aid eval --compare` judges a recorded candidate baseline against a recorded accepted one and exits non-zero on a regression. Nothing auto-deploys: promotion is a gate pass plus a file in the tree.

- **Turned on by:** `evals[].gate.promotion`
- **Reference:** [spec](./reference/spec.md#eval)
- **Since:** `0.1.146`

### A stated list of what a customer may change

Spec 0.29 adds `overridable`: the base spec names every path an overlay may set and the bound each may move within -- a closed set of values (`from`) or a ceiling (`max`). A path that is not listed is not overridable, so "what may differ per customer" is a reviewable line in the base repo rather than a convention nobody wrote down. Listing a path does not open its children, and `allowWeaken` is a separate permission the base author grants per path.

- **Turned on by:** `overridable`
- **Reference:** [spec](./reference/spec.md#overridablerule)
- **Since:** `0.1.147`

### One base spec, one file per customer

A per-customer overlay names its base and the paths it changes; `aid resolve` writes the concrete spec beside it, so the document that actually deploys is reviewed in the pull request like any other file. Six refusals stand between a customer file and a weakened control: an unlisted path, a relaxed guardrail action, a value outside its bound, a removed CI-gating eval, a profile that disagrees with the base, and a base that is not there. `aid resolve --check` fails in CI when the resolved artifact has drifted from its overlay.

- **Turned on by:** `aid resolve`
- **Reference:** [cli](./reference/cli.md#resolve)
- **Since:** `0.1.147`

### A fleet inventory computed from the tree

`aid fleet` discovers every overlay in the repository and reports one row per customer -- profile, pinned models, region, cost ceiling and whether the resolved document still passes every gate today -- with `--json` for a script. Discovery is by content rather than by a directory convention, and the gates are re-run rather than trusted, so `ok` means "passes now" and not "passed once". There is no service to keep warm and no state to drift.

- **Turned on by:** `aid fleet`
- **Reference:** [cli](./reference/cli.md#fleet)
- **Since:** `0.1.147`

### Two shipped golden paths

`aid init --template` scaffolds a spec that already passes the gates instead of an empty one: `support-copilot` is the mid-size path (standard profile, managed services, default budgets) and `enterprise-approvals` is the regulated one (identity, private network, audit sink, and a pause for a human before the write tool). The test suite scaffolds and compiles both, so a template that stops passing a gate breaks the build rather than onboarding someone into a broken spec.

- **Turned on by:** `aid init`
- **Reference:** [cli](./reference/cli.md#init)
- **Since:** `0.1.147`

### Alarms as generated infrastructure

Spec 0.30 lets a document declare `observability.alerts`: a metric, a window, a reduction and a threshold, optionally scoped to one agent or eval. The infra planner turns each one into a real alarm -- a CloudWatch alarm in the Terraform env root, a Cloud Monitoring policy on GCP, a `CfnAlarm` in the CDK app -- that pages `alert_channel_ids` and treats missing data as `missing` rather than healthy. The metric list is closed to the four series the deploy plan already derives (`agent.cost`, `agent.tokens`, `eval.cost`, `eval.latency.p95`), so an alarm cannot watch a number nothing produces. The unit comes from the metric rather than the author, so the description and the threshold cannot disagree.

- **Turned on by:** `observability.alerts`
- **Reference:** [spec](./reference/spec.md#observability)
- **Since:** `0.1.149`

### A dataset from the runs you already have

`aid trace export --dataset &lt;name&gt;` turns a directory of traced runs into an eval dataset, so the first cases for a new agent come from production traffic instead of from someone guessing what people will ask. One run is one case: the prompt it was first given, the answer it last produced, and the calls, cost, wall time, model and tools beside it. The file is written in the same canonical form the Python `Dataset` writes, so a regenerated dataset diffs cleanly. The exit code separates the two failures that matter -- a run that recorded no payloads (the sink keeps text only when the application ran with `AID_TRACE_CONTENT=1`, and the refusal names that variable) and a file that already exists (refused without `--force`, because it may have been curated by hand since). Every case is tagged `unreviewed`, because `expected` is what the run happened to output: it is a record of behaviour, not a judgement about a good answer, and the honest next step is a person editing the file.

- **Turned on by:** `aid trace export`
- **Reference:** [cli](./reference/cli.md#trace)
- **Since:** `0.1.154`

### A trajectory eval that runs an agent

An eval can name an agent (`target: agent:&lt;id&gt;`) instead of a pipeline, and the `py-fastapi` target -- which declares `agent-evals` -- emits an offline evaluator that runs the agent against each case and scores the calls it made with `tool-trace`, beside the response metrics, within the step and cost ceiling the agent declares. The evaluator drives the agent with a scripted or recorded model, so a case verifies the policy and plumbing of a run -- which tools were reachable, in what order they were called, whether an approval was respected -- and not the quality of a model answer; model quality is what the prompt and pipeline evals measure. A target that does not declare the capability is refused by `ir/eval-trajectory` rather than shipping an eval nothing runs.

- **Turned on by:** `evals[].target`
- **Reference:** [spec](./reference/spec.md#eval)
- **Since:** `0.1.158`

## Refused, on purpose

An absent capability is stated once, here, with the diagnostic that enforces it, instead of being discovered during an apply or debugged in production.

### Jev as a generation model

Jev answers a declared decision. It is not in `SERVED_PROVIDERS`, so a `models[]` entry naming it has no adapter and is refused.

- **Enforced by:** `ir/provider-unsupported`

### Embeddings on a provider with no embeddings endpoint

The Anthropic Messages API serves chat only, so its adapter does not advertise `embeddings` and a spec that declares it is refused; Bedrock, Vertex AI and the Gemini API do advertise it, because each serves an embedding model over `invoke`, `:predict` and `:batchEmbedContents`.

- **Enforced by:** `ir/model-capability-missing`

### Streaming on an HTTP API

A deployment whose transport cannot stream is refused instead of buffering the response and calling it streaming.

- **Enforced by:** `ir/deploy-streaming`

### An image registry the release workflow cannot log in to

A generated release workflow knows four credential paths: the workflow token `ghcr.io` accepts, the repository secret pair `docker.io` names, and the OIDC federation `aws.ecr` and `gcp.artifact-registry` use. A registry id outside that table has no login the emitter can write, so the schema admits no other value and the spec is refused rather than publishing a workflow that fails on the first tag. A cloud registry is named by its id, not its host: the account, region and project are separate fields, and the workflow derives the host from them.

- **Enforced by:** `ir/deploy-image-incomplete`

### A registry whose login secrets are not named

The spec holds the *names* of the repository secrets a login reads, never the values. A `docker.io` image that omits `usernameSecret` or `tokenSecret` is refused, because the emitted workflow would otherwise log in with an empty credential and fail on the first tag. A cloud image is refused the same way when its `roleArn`, `serviceAccount` or `workloadIdentityProvider` is missing, or when it declares a field its registry does not read.

- **Enforced by:** `ir/deploy-image-credentials`

### `edge` on GCP

Cloud CDN serves static assets and cannot run the app, so the infra planner refuses the plan instead of emitting part of a project.

- **Enforced by:** `cli/infra-cloud-target-unsupported`

### An `enterprise` profile with a required control missing

`enterprise` is a promise that the controls a regulated deployment cannot go without are present, so a spec that declares it and then omits a region pin, an audit sink, or a guardrail that runs on output is refused by the `profile` gate. The three are reported separately -- `ir/profile-region`, `ir/profile-audit` and `ir/profile-guardrail` -- because each has its own fix, and the gate is what keeps the word `enterprise` from meaning nothing.

- **Enforced by:** `ir/profile-audit`

### An `enterprise` profile with no identity reference

A regulated deployment has to say where a caller is authenticated, so an `enterprise` spec with no `deployments[].identity` is refused by the `profile` gate. The block carries an issuer, an audience and the claim names that become the runtime `Principal`; signature verification stays in `business/`, so AID never holds a tenant's signing key. `network`, `region` and `approvals` are refused separately -- `ir/profile-network` and `ir/profile-approvals` -- because each has its own fix.

- **Enforced by:** `ir/profile-identity`

### A private network that is not private, or not declared

The `network` block requires `private` to be stated, so a spec that omits it is refused rather than read as false -- silence is not a decision about whether traffic leaves a VPC. Under `enterprise`, `private: false` is refused too, because the profile promises otherwise.

- **Enforced by:** `ir/profile-network`

### An `enterprise` profile with no production approval policy

A change-control policy is what makes a production apply reviewable, so an `enterprise` spec that deploys to production with no `deployments[].approvals` is refused. The policy is emitted as infrastructure, not read from repository settings: AID writes `infra/approvals.json` and binds it to the plan workflow, and never reads or sets a repo's protection rules.

- **Enforced by:** `ir/profile-approvals`

### An OTLP export with tracing turned off

A destination for spans that are not recorded is a contradiction, so `export: otlp` beside `trace: false` is refused by the `observability/export` gate. The exporter installs itself only when it is called, so the block names a destination the app may reach and the gate keeps the declaration from contradicting itself.

- **Enforced by:** `ir/observability-export`

### An `enterprise` profile whose spans never leave the process

The profile promises an audit trail, and a trail that stays inside the process disappears with the process. An `enterprise` document that records spans without exporting them to a collector is refused, which is the same argument the profile already makes about a missing audit sink.

- **Enforced by:** `ir/observability-export`

### An eval that targets an agent

An agent run has no single response to score: the eval runner calls one prediction per case and hands the metric a string. An `agent:` target is therefore expressible and refused, with the missing runner named -- not reported as an undeclared agent, which would send the author looking for a typo in a name spelled correctly.

- **Enforced by:** `ir/eval-trajectory`

### A `tool-trace` metric

Comparing the tool calls a run made needs a runner that reports them. `aid-runtime-python` can — a runner may return a `RunOutput` carrying a `Trajectory`, and the `tool-trace` metric scores it — but no generated eval does, because an `agent:` target is still refused. So the metric is refused at generation rather than reported as unmeasured. `cost` and `latency` ceilings are measured, and each also sets a budget the cost gate and the deploy plan check.

- **Enforced by:** `ir/eval-trajectory`

### An approval policy that names fewer reviewers than it requires

`approvals.require: [security, platform]` with `minApprovers: 3` is not stricter, it is dead: every change would wait forever. The profile gate refuses it and quotes both numbers back, rather than emitting a workflow binding that reads as governance and behaves as an outage.

- **Enforced by:** `ir/profile-approvals`

### An agent that can write, with no durable store

An agent that can call a writing tool can be paused mid-write, and a paused run with no store dies with the process, leaving a write the operator cannot account for. So the `state` gate refuses an `enterprise` agent that reaches a `write` or `destructive` tool and declares no state.

- **Enforced by:** `ir/agents-state-store`

### An approval pause in front of a read

`requiresApproval` on a tool with no side effects pauses a run to ask a human about a read; the operator learns to approve without reading, which is worse than no approval step at all. The `approvals` gate refuses it, and refuses a pause whose run has nowhere to wait.

- **Enforced by:** `ir/approval-step-tool`

### A promotion policy with no baseline to promote from

A promotion compares two named prompt versions, so `gate.promotion.baseline` is required rather than defaulted. Without it the gate could not tell a bump from a no-op, and the CLI would compare a candidate against whatever happened to be in the tree.

- **Enforced by:** `ir/prompt-version-stale`

### A promotion of the version already in force

Promoting a prompt whose declared version is not greater than the baseline is refused: equal means nothing was bumped, so the candidate is the baseline and there is nothing to promote; behind means a rollback wearing the name of a promotion. Both are named, because the fix differs.

- **Enforced by:** `ir/prompt-version-stale`

### A quality allowance that no metric can spend

`allowedQualityDrop` is a budget over a quality metric. An eval whose metrics are all `cost` or `latency` has no quality to spend it on, so the policy is refused rather than read as a looser cost ceiling -- a stale allowance is how a regression ships.

- **Enforced by:** `ir/promotion-regression`

### A cost ceiling on an eval that records no cost

`allowedCostIncrease` compares two cost measurements. An eval with no `cost` metric records none, so the ceiling would be checked against nothing; the gate refuses it and points at the `cost` metric that would make it real.

- **Enforced by:** `ir/promotion-cost`

### An `enterprise` promotion nobody has to approve

The enterprise profile promises recorded change control. A promotion is a change to what production answers, so a `gate.promotion` with no `approval` block is refused under `enterprise` -- and `aid eval --compare` refuses to report a candidate as promotable until the approval record it names exists and is not empty.

- **Enforced by:** `ir/promotion-approval`

### Feedback kept forever, or kept without a redaction rule

A persistent feedback store with no `retentionDays` is refused, and so is one that collects `correction` text while its `pii.redact` list misses a field the spec already marks sensitive. Collected free text is the most likely place for a customer identifier to end up, so the gate asks both questions at build time rather than at audit time.

- **Enforced by:** `ir/feedback-pii`

### A customer overlay that edits a path the base never opened

An overlay is a strict allowlist, not a merge patch: a path absent from the base `overridable` block is refused by name, so a customer file cannot quietly set a field the framework author never considered per-customer. Adding the path to the base is the fix, and it is a diff somebody reviews.

- **Enforced by:** `overlay/path-not-overridable`

### A customer overlay that relaxes a control

Lowering a guardrail from `block` to `flag`, shortening an audit retention, or deleting a path is refused unless the base author wrote `allowWeaken: true` on that exact path -- so a weakened control is a decision recorded in the base repo rather than an edit buried in a customer file.

- **Enforced by:** `overlay/weakens-control`

### A customer overlay that deletes the eval gating CI

No base can permit this one. `allowWeaken` buys a weaker value, never the absence of the check, so an overlay that removes an eval with `gate.ci: true` is refused before the value is even compared. Deleting the `gate.ci` flag and keeping the eval is refused the same way -- it removes the check, not a value.

- **Enforced by:** `overlay/removes-eval`

### A customer overlay that moves a value past its declared bound

A `from` list is a closed set of values and a `max` is a ceiling, so a cost budget above the ceiling is refused even when the path is overridable and even when weakening is permitted: the bound is the answer, and the hint says which bound was hit.

- **Enforced by:** `overlay/value-out-of-bounds`

### An alarm whose series never leave the process

An alarm watches a metric, so the series has to be recorded and has to leave. A document that declares `observability.alerts` without `export: otlp` is refused by the `observability/alerts` gate, because the emitted alarm would watch a series that is recorded into a process that never sends it and stay silent forever -- which reads as health.

- **Enforced by:** `ir/alerts-unexported`

### An alarm over a series this build never writes

A series is only real where the generated runtime writes it, so an alarm over a metric the build does not record is refused by `ir/alerts-unproduced` rather than emitted as an alarm that reports no data forever. The diagnostic names the metric, the target that would have written nothing, and the capability plus `export: otlp` the document needs. py-fastapi records all four -- `agent.cost`, `agent.tokens`, `eval.cost` and `eval.latency.p95` -- while a target that records none refuses every alert in the document.

- **Enforced by:** `ir/alerts-unproduced`

### An alarm whose reduction the series cannot answer

Alerts are limited to the four metrics the deploy plan derives, and each declares which reductions make sense for it. A `p95` over a cost total, or an `average` over a per-eval spend, is refused rather than emitted as an alarm that fires on a quantity nobody meant -- the diagnostic names the metric and the reductions it does support.

- **Enforced by:** `ir/alerts-aggregate`

### An alarm scoped to a name the document does not declare

An alarm may name the agent or eval it watches; that name becomes a metric dimension, so a typo would emit an alarm that filters on a value nothing writes and never fires. The gate resolves the name against the document and refuses an unknown one instead of letting it become a permanently silent alarm.

- **Enforced by:** `ir/alerts-source`

### A customer overlay whose profile label disagrees with the spec it resolves to

An overlay's `profile` is a checked label, not a second source of truth: it must match what the resolved document actually declares, so a customer file cannot claim `enterprise` control over a base that imposes none. Raising one customer to `enterprise` means marking `profile` overridable in the base and setting it in the overlay, so the stronger controls are gated on the resolved document.

- **Enforced by:** `overlay/profile-mismatch`

---

Next: [the full support matrix](./reference/support.md), [the generator targets](./reference/targets.md), or [the spec reference](./reference/spec.md).
