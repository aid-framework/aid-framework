---
description: "What ships out of the box, which cloud runs each deployment target, and what the compiler refuses, with the release that first shipped each feature."
---

# Features

The provider and cloud matrices are read from the declarations the compiler enforces, not maintained by hand. Everything else is a registry that a test holds to those declarations and to the release that first shipped each row. The spec language is at `0.11`.

## Deployment targets

A deployment names one target, and the generated infrastructure runs it on one cloud. A cell names the managed service the emitted OpenTofu configures. A dash is a refusal with a named diagnostic, not a target that is still to come.

| Target | `aws` | `gcp` |
| --- | --- | --- |
| `serverless` | API Gateway + Lambda | Cloud Run |
| `container` | ECS on Fargate | Cloud Run |
| `batch` | AWS Batch | Cloud Run job |
| `edge` | Lambda@Edge on CloudFront | <span title="Cloud CDN serves static assets and cannot run the app, so there is no GCP resource to map edge to.">—</span> |

`edge` on `gcp` is refused with `cli/infra-cloud-target-unsupported`: Cloud CDN serves static assets and cannot run the app, so there is no GCP resource to map `edge` to.

## Model providers

Every provider in `SERVED_PROVIDERS` is a row. A check means the generated adapter advertises the capability the spec's `capabilities` enum names; a dash means a spec that declares it is refused with `ir/model-capability-missing`, because the provider's API has no such endpoint.

| Provider | Adapter | Tools | Structured output | Streaming | Embeddings | Catalog |
| --- | --- | --- | --- | --- | --- | --- |
| `anthropic` | `AnthropicProvider` | yes | yes | yes | <span title="AnthropicProvider does not advertise EMBEDDINGS.">—</span> | 2 models, 2 priced |
| `bedrock` | `BedrockProvider` | yes | yes | <span title="BedrockProvider does not advertise STREAMING.">—</span> | <span title="BedrockProvider does not advertise EMBEDDINGS.">—</span> | 2 models, 2 priced |
| `gemini` | `GeminiProvider` | yes | yes | yes | <span title="GeminiProvider does not advertise EMBEDDINGS.">—</span> | 1 model, 1 priced |
| `google` | `VertexProvider` | yes | yes | yes | <span title="VertexProvider does not advertise EMBEDDINGS.">—</span> | 2 models, 2 priced |
| `openai` | `OpenAICompatibleProvider` | yes | yes | yes | yes | 5 models, 5 priced |
| `openai-compatible` | `OpenAICompatibleProvider` | yes | yes | yes | yes | <span title="No pinned model or cost profile is published for this provider, so the spec must give an explicit modelId and the call prices as unknown.">—</span> |
| `fake` | `FakeProvider` | yes | yes | yes | yes | <span title="No pinned model or cost profile is published for this provider, so the spec must give an explicit modelId and the call prices as unknown.">—</span> |

## Cloud AI infrastructure

The generated infrastructure does not only run the service; it grants the service the cloud identity it needs to call a managed model. Where a cloud needs extra configuration to reach its model platform, the module sets that too.

| Managed service | Declared by | Emitted | Runtime credential | Since |
| --- | --- | --- | --- | --- |
| **Bedrock from the AWS module** | `models[].provider: bedrock` | `bedrock:InvokeModel`, plus `bedrock:InvokeModelWithResponseStream` when a service declares `streaming`, scoped to the foundation-model and inference-profile ARNs | the IAM role the module creates for the service | `0.1.81` |
| **Vertex AI from the GCP modules** | `models[].provider: google` | `roles/aiplatform.user` on the project, plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_REGION` on the Cloud Run service or job, which Cloud Run does not set | the service account the module creates | `0.1.83` |
| **Bedrock Guardrails as the guardrail engine** | `guardrails[].engine: bedrock` | an `aws_bedrock_guardrail` and its numbered version from the `bedrock:` block, `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` on the service, and `bedrock:ApplyGuardrail` on that guardrail alone — the CDK construct mirrors all of it; omit the block and the app reads the two variables for a guardrail the operator owns | the IAM role the module creates for the service | `0.1.98` |

## Out of the box

Each row is behaviour the generator writes for you, the spec key or command that turns it on, and the release that first shipped it. A construct that needs a later spec version is refused by name rather than ignored.

| Feature | What it does | Turned on by | Reference | Since |
| --- | --- | --- | --- | --- |
| **Versioned spec language** | A construct that needs a later version is refused by name instead of being ignored, so a spec never silently means less than it says. | `specVersion` | [spec](./reference/spec.md#top-level-keys) | `0.1.0` |
| **Pinned model ids** | A model alias is what the rest of the spec refers to; the vendor id is pinned in one place and never floats to a vendor default. | `models[].modelId` | [spec](./reference/spec.md#model) | `0.1.0` |
| **Priced calls** | A committed cost profile prices every call. An unpriced model is reported as unknown, never as free. | `models[].costProfile` | [spec](./reference/spec.md#model) | `0.1.0` |
| **Capability refusal** | A spec that asks a target for something it cannot serve is refused at plan time with a named diagnostic, not shipped and debugged in production. | `deployments[].target` | [targets](./reference/targets.md#capability-matrix) | `0.1.2` |
| **Eval coverage** | An HTTP pipeline with no CI eval claiming it is a build error, so a prompt edit cannot ship unmeasured. | `evals[].gate.ci` | [spec](./reference/spec.md#eval) | `0.1.2` |
| **Retrieval with citations** | A retriever can require that retrieved items carry the source path and offsets a generated answer cites. | `retrievers[].traits` | [spec](./reference/spec.md#retriever) | `0.1.6` |
| **Guardrail stages** | Policies are evaluated at declared stages, and a failing policy has a declared action rather than a default. | `guardrails[]` | [spec](./reference/spec.md#guardrail) | `0.1.18` |
| **Unprotected routes are refused** | A POST route that passes caller text to a prompt with no input guardrail fails the build before it can be exposed. | `guardrails[].stages` | [spec](./reference/spec.md#guardrail) | `0.1.18` |
| **Agents and handoffs** | An agent declares its model, instructions, tools, retrievers and budget; a handoff cycle and an exhausted budget are plan-time errors. | `agents[]` | [spec](./reference/spec.md#agent) | `0.1.19` |
| **Memory tiers** | What is remembered, for how long, within what token budget, and where it lives. | `memory[]` | [spec](./reference/spec.md#memory) | `0.1.19` |
| **Semantic cache** | The opt-in fuzzy layer beside exact-match caching, carrying its own similarity threshold rather than a global default. | `models[].cache.semantic` | [spec](./reference/spec.md#semanticcache) | `0.1.25` |
| **Local trace capture** | A run writes JSONL spans to a directory you name, and `aid trace` prints the span tree from them. No collector to stand up. | `aid trace` | [cli](./reference/cli.md#trace) | `0.1.56` |
| **Infrastructure from the spec** | A deployment plan derives OpenTofu modules for the chosen cloud, byte-asserted against fixtures and validated with `tofu` in CI. | `deployments[]` | [spec](./reference/spec.md#deployment) | `0.1.54` |
| **A CDK backend** | The same deployment plan can emit a CDK app instead, for a team already deploying with it. | `aid infra --backend cdk` | [cli](./reference/cli.md#infra) | `0.1.57` |
| **Eject** | Take ownership of a generated file: it stops being regenerated and the app keeps booting, because it never depended on a control plane. | `aid eject` | [cli](./reference/cli.md#eject) | `0.1.58` |
| **Generated project CI** | Every generated project ships the workflow that runs its evals, so the gate travels with the code it gates. | `aid gen` | [cli](./reference/cli.md#gen) | `0.1.59` |
| **A cost ceiling in CI** | Cost is an eval metric, and the generated workflow exits non-zero when a run exceeds the recorded budget. | `evals[].metrics[].kind: cost` | [spec](./reference/spec.md#kind-cost) | `0.1.65` |
| **A Dockerfile and an image** | A container deployment emits the Dockerfile and the release workflow that builds and pushes the image it deploys. | `deployments[].image` | [spec](./reference/spec.md#image) | `0.1.70` |
| **Jev-backed decisions** | A named question with its own reply shape, answered by TypeSafe AI Jev, and referenced by guardrails, routers and evals. | `decisions[]` | [spec](./reference/spec.md#decision) | `0.1.88` |
| **A decision-backed guardrail** | An input guardrail asks a declared decision and enforces a minimum confidence, so the check is a typed answer rather than free text. | `guardrails[].decision` | [spec](./reference/spec.md#guardrail) | `0.1.90` |
| **A decision eval metric** | An eval scores a decision on its own reply shape, so a guardrail change is measured like any other behaviour. | `evals[].metrics[].kind: decision` | [spec](./reference/spec.md#kind-decision) | `0.1.91` |

## Refused, on purpose

An absent capability is stated once, here, with the diagnostic that enforces it, instead of being discovered during an apply or debugged in production.

| Not supported | Why | Enforced by |
| --- | --- | --- |
| Streaming on `ts-vercel` | The Vercel target declares no `streaming` capability, so a spec that needs SSE is refused rather than emitted with a buffered response. | `ir/capability-missing` |
| Jev as a generation model | Jev answers a declared decision. It is not in `SERVED_PROVIDERS`, so a `models[]` entry naming it has no adapter and is refused. | `ir/provider-unsupported` |
| Embeddings on a provider with no embeddings endpoint | The Anthropic Messages API and the Bedrock Converse API have no embeddings endpoint, so the adapter does not advertise `embeddings` and a spec that declares it is refused. | `ir/model-capability-missing` |
| Streaming on an HTTP API | A deployment whose transport cannot stream is refused instead of buffering the response and calling it streaming. | `ir/deploy-streaming` |
| `edge` on GCP | Cloud CDN serves static assets and cannot run the app, so the infra planner refuses the plan instead of emitting part of a project. | `cli/infra-cloud-target-unsupported` |

---

Next: [the full support matrix](./reference/support.md), [the generator targets](./reference/targets.md), or [the spec reference](./reference/spec.md).
