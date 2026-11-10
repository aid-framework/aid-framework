---
description: "What ships out of the box, which cloud runs each deployment target, and what the compiler refuses, with the release that first shipped each feature."
---

# Features

The provider and cloud lists are read from the declarations the compiler enforces, not maintained by hand. Everything else is a registry that a test holds to those declarations and to the release that first shipped each entry. The spec language is at `0.21`.

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

### A cost ceiling in CI

Cost is an eval metric, and the generated workflow exits non-zero when a run exceeds the recorded budget.

- **Turned on by:** `evals[].metrics[].kind: cost`
- **Reference:** [spec](./reference/spec.md#kind-cost)
- **Since:** `0.1.65`

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

---

Next: [the full support matrix](./reference/support.md), [the generator targets](./reference/targets.md), or [the spec reference](./reference/spec.md).
