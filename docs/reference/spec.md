---
description: "Every spec key, type and constraint, generated from the JSON Schema that aid validate enforces."
---

# Spec reference

Every key, type, and constraint below is read from `packages/spec/src/schema/spec.schema.json`, the schema `aid validate` enforces. A `required` column of `yes` means `aid validate` rejects a spec that omits the key.

Spec schema title: *AID Framework spec v0.6*.

**Required at the top level:** `specVersion`, `project`.

## Top-level keys

| Key | Type | Description |
| --- | --- | --- |
| `specVersion` | `string` | Spec language version. Each version's additions are listed in the spec version changelog (`docs/reference/spec-changelog.md`). A section or construct that needs a later version is reported as `spec/not-supported` with the version it needs, rather than as an unknown key. |
| `profile` | `standard`, `enterprise` | The operating profile: a named bundle of defaults and required controls, not a mode. `standard` is the default and is what an absent `profile` means, so every spec written before 0.25 keeps exactly the behaviour it had. `enterprise` requires the controls a regulated deployment cannot go without, and the profile gate refuses a spec that declares it and then omits them: a region pin, an audit sink, a declared identity provider, private networking and an approval policy on every deployment, plus at least one guardrail that runs on output. A requirement that a spec could not satisfy is never added to a profile, so `enterprise` is always passable. Declarable from spec v0.25; the identity, network and approval requirements are enforced from 0.26. From 0.33 the identity requirement also covers `verifiedBy`: AID generates no token verification, so an `enterprise` deployment must name the component that performs it (`ir/identity-verified-by`). |
| `project` | `project` | — |
| `types` | map of `typeDef` | Named structured types referenced by prompts (structured output) and tools (input/output). |
| `models` | map of `model` | Model aliases. The alias is what the rest of the spec refers to; the vendor id is pinned here and only here. |
| `prompts` | map of `prompt` | — |
| `tools` | map of `tool` | — |
| `stores` | map of `store` | Vector store instances. `kind: memory` is the fully supported default and needs no service; `kind: pgvector` is declarable here and its adapter ships with the retrieval runtime. |
| `retrievers` | map of `retriever` | Retrievers: what to index, how to chunk it, which embedding model and store to use, and how to rank. |
| `knowledgeBases` | map of `knowledgeBase` | Managed knowledge bases: a source, chunker, embedding pass, store and index the cloud owns, referenced by a retriever's `knowledgeBase`. Declarable from spec v0.12. A managed knowledge base is a retriever, not a pipeline: the runtime still retrieves chunks and generates the answer, so the cost gate, the evals and the trace keep covering the generation path. |
| `gateways` | map of `gateway` | Managed MCP gateways: an endpoint the cloud hosts, fronting federated tool targets, reached by a runtime over MCP instead of bundling every tool into it. Declarable from spec v0.24, and AWS only: the resource is Amazon Bedrock AgentCore Gateway. A gateway federates tools the spec does not own -- this is not a second generation path for `tools:`, which keeps emitting the same local tool registry whether or not a gateway exists. Every target kind lives under the gateway's one `Mcp` target union, which is why a target is one shape with a `kind` discriminator rather than sibling keys: the CloudFormation resource accepts no top-level OpenAPI target. The `authorizer` is required because a gateway with no authentication is reachable by anyone who learns its URL, and neither `NONE` nor `AUTHENTICATE_ONLY` is reachable from this surface. |
| `agents` | map of `agent` | Agents: a model, instructions, the tools and retrievers it may use, and the budget it may spend. Declarable from spec v0.2; a target that emits no agent route is rejected by the capability gate rather than silently generating one. |
| `state` | `agentState` | The durable run store for the project, shared by every agent and by every pipeline step that pauses for approval. Declarable from spec v0.26. One app has one process and one run history, so the store is declared once rather than per agent; an agent may still override it with `agents.&lt;id&gt;.state` when its runs need their own retention. Absent means runs are held in the process, which is why an agent that can call a side-effecting tool is refused without it (`ir/agents-state-store`): a run that pauses for a human decision cannot survive a restart if nothing wrote it down. |
| `guardrails` | map of `guardrail` | Guardrails: the stages a check runs at, the policies it evaluates, and what happens when one fails. Declarable from spec v0.2. The runtime evaluates them and both targets (`py-fastapi` and `ts-vercel`) emit the wiring; a guardrail declared here applies to every pipeline route of the document, not to the one that named it. |
| `decisions` | map of `decision` | Decision points answered by TypeSafe AI Jev: a named question with its own reply shape, referenced by guardrails, routers and evals. Declarable from spec v0.6. A decision is not a provider, because Jev has no chat surface: it returns a typed answer rather than text. `choice` and `score` require `criteria`; `noul` forbids it. A pinned model version is the reproducible choice; an eval reference refuses a moving alias, while interactive routing may use one. |
| `memory` | map of `memory` | Memory tiers: what is remembered, for how long, within what token budget, and where it lives. Declarable from spec v0.2; the kinds a target cannot serve are refused by its plan gate rather than approximated. |
| `deployments` | map of `deployment` | Deployment intents: the target shape, the transport it assumes, and the secrets it needs. Declarable from spec v0.2. `streaming: true` derives a `streaming` requirement; both `py-fastapi` and `ts-vercel` declare that capability and answer an `Accept: text/event-stream` request with SSE frames, and a target that declares nothing is refused by the deploy gate. |
| `evals` | map of `eval` | — |
| `observability` | `observability` | — |
| `pipelines` | map of `pipeline` | — |
| `overridable` | map of `overridableRule` | The contract a customer overlay may change: the document paths that are open to an overlay, and how far each may move. A path that is not listed here is not overridable, so a base spec that declares nothing accepts no override at all. Declarable from spec v0.29, and it is the only key an overlay can ever act on. |

`specVersion` must be one of the versions in the [spec version changelog](./spec-changelog.md), which lists what each version adds.

## `semanticCache`

Semantic cache settings. `threshold` is the minimum cosine similarity (0..1) a new prompt must reach against a cached one before the cached response is reused; `ttlSeconds` bounds how long a cached response may be reused. Both are required together so a spec cannot opt in with a silent default threshold or TTL.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `threshold` | `number` | yes | — |
| `ttlSeconds` | `integer` | yes | — |

## `project`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | yes | — |
| `namespace` | `string` | no | Dotted namespace used to qualify generated symbols. |
| `description` | `string` | no | — |
| `targets` | array of `py-fastapi`, `ts-vercel` | no | Generator targets to emit. Defaults to [py-fastapi] when omitted. |

## `typeDef`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"struct"` | yes | Only struct is in spec v0.1. enum/union/list land with the agents work, and adding them is a schema change, not a silent widening. |
| `description` | `string` | no | — |
| `fields` | map of `field` | yes | — |

## `field`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `fieldType` | yes | — |
| `required` | `boolean` | no | Defaults to false. Drives required-vs-optional on the generated side. |
| `description` | `string` | no | — |
| `enum` | array of `string` or `number` or `boolean` | no | — |
| `minimum` | `number` | no | — |
| `maximum` | `number` | no | — |

## `model`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `openai`, `openai-compatible`, `anthropic`, `bedrock`, `google`, `gemini`, `fake` | yes | The provider set the shipped adapters serve. `fake` is deterministic and keyless, which is what lets the eval gate run offline in CI. `bedrock` takes its credentials from the execution role and `google` (Vertex AI) from a short-lived bearer token supplied by the environment or the metadata server, so neither needs an `apiKeyEnv`. `gemini` is the Gemini API, not Vertex: one API key and no project, location or OAuth2. |
| `modelId` | `string` | yes | Pinned vendor model id. Never an alias or a moving target: the resolved id is recorded in the IR so a run is reproducible. |
| `capabilities` | array of `json-schema`, `tools`, `streaming`, `embeddings` | no | Declared model capabilities. json-schema is negotiated within a prompt (a structured-output prompt must bind a model that declares it) and embeddings within a retriever (a retriever's embedModel must declare it); the others are recorded in the IR for the capability gate to use in later phases. The embeddings capability additionally requires a provider that serves an embeddings endpoint: the runtime routes embedding calls by provider (bedrock and google to their own adapters, gemini to the AI Studio adapter, openai and openai-compatible to the OpenAI-compatible wire), so declaring it on anthropic is refused rather than sent over a wire that vendor does not serve. |
| `params` | object (fields below) | no | — |
| `fallbacks` | array of `name` | no | Ordered model aliases to fail over to. Simple alias failover only; no routing policy in Phase 0. |
| `costProfile` | `string` | no | Name of a priced entry in the pinned model catalog. Omit to resolve it from the catalog by modelId. |
| `limits` | object (fields below) | no | — |
| `baseUrl` | `string` | no | Required for openai-compatible. Never a credential. |
| `apiKeyEnv` | `string` | no | — |
| `cache` | object (fields below) | no | Model caching, declarable from spec v0.3. `prompt` is the exact-match layer (model, prompt, tool schema and temperature); `semantic` is the opt-in fuzzy layer and carries its own threshold and TTL so there is no silent default. |
| `description` | `string` | no | — |

### `model.params`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `temperature` | `number` | no | — |
| `topP` | `number` | no | — |
| `maxTokens` | `integer` | no | — |
| `seed` | `integer` | no | — |

### `model.limits`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxInputTokens` | `integer` | no | — |
| `maxOutputTokens` | `integer` | no | — |

### `model.cache`

Model caching, declarable from spec v0.3. `prompt` is the exact-match layer (model, prompt, tool schema and temperature); `semantic` is the opt-in fuzzy layer and carries its own threshold and TTL so there is no silent default.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | `boolean` | no | — |
| `semantic` | `semanticCache` | no | — |

## `prompt`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `integer` | yes | Bumped by hand when the template changes. The prompt identity includes it (prompt:&lt;name&gt;@&lt;version&gt;) so a revision does not move the IR node id. |
| `model` | `name` | yes | — |
| `template` | `string` | yes | Mustache-style text. Placeholders are &#123;&#123;variable&#125;&#125; references and are checked by the parser for well-formedness; whether each one resolves is a build-time IR gate, not a schema concern. |
| `variables` | map of `variable` | no | — |
| `output` | object (fields below) | yes | — |

### `prompt.output`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `text`, `json`, `structured` | yes | — |
| `schema` | `typeName` | no | — |

## `variable`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `fieldType` | yes | — |
| `required` | `boolean` | no | — |
| `description` | `string` | no | — |
| `default` | any | no | — |

## `tool`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | yes | Shown to the model once model-selected tool choice exists (Phase 2). Required now so the field never has to be added retroactively. |
| `input` | `typeName` | yes | — |
| `output` | `typeName` | yes | — |
| `sideEffects` | `none`, `read`, `write`, `destructive` | no | Drives the fail-closed security gate: write and destructive require auth. |
| `requiresConfirmation` | `boolean` | no | The agent loop pauses before running this tool and waits for a human decision. A pipeline step has no confirmation step, so a target that emits no agent route refuses the flag rather than ignoring it. |
| `handler` | object (fields below) | yes | Where the implementation lives. `business` means a user-owned module, so the generated code imports it rather than inlining logic. |
| `timeoutMs` | `integer` | no | — |
| `retries` | `integer` | no | — |
| `idempotency` | `none`, `key`, `natural` | no | — |
| `auth` | `string` | no | PolicyExpr source. Parsed once, on the TypeScript side, into a JSON AST that the runtime interprets; the string form never reaches a runtime. |

### `tool.handler`

Where the implementation lives. `business` means a user-owned module, so the generated code imports it rather than inlining logic.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"business"` | yes | — |
| `symbol` | `string` | no | — |

## `store`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `memory`, `pgvector` | yes | `memory` is the fully supported default and is what every gated test uses; `pgvector` is declarable in Phase 1 but no gate requires a database, so a pgvector-backed app is never the only thing that can pass. |
| `uri` | `string` | no | — |
| `dimensions` | `integer` | yes | Vector width. It must agree with the embedding model's own width; the normalize gate compares the two. |

## `knowledgeDataSource`

Where a managed knowledge base reads documents from. The kind is the engine's own source: `s3` for Bedrock Knowledge Bases and `gcs` for Vertex AI RAG, because neither engine can read the other's bucket.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `s3`, `gcs` | yes | — |
| `uri` | `string` | yes | The source root, e.g. `s3://acme-docs/handbook` or `gs://acme-docs/handbook`. |

## `knowledgeBase`

A managed knowledge base: the cloud owns ingestion, chunking, embedding, the vector store and the index, and the runtime only asks it for chunks. Declarable from spec v0.12. A retriever binds to one with `knowledgeBase`. The engine owns ingestion, so a deploy never starts it: a base whose corpus is empty fails the first retrieve with an error naming the missing job, and the emitted README names the command that starts one for this engine. It also owns the schema, so `refresh` is refused beside the binding and `aid migrate --check` reports a managed base as not applicable. The emitted module sets `prevent_destroy` on the base and on any vector store it creates, and `aid infra plan` warns when the saved plan would delete either -- a teardown is allowed, it just cannot be silent; a replacement is not a delete. `aid doctor` reports the engine and the environment name the runtime reads without contacting the cloud, so it cannot say whether ingestion has run: the first retrieve answers that.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `engine` | `aws-bedrock`, `vertex-rag` | yes | Which cloud's managed knowledge base this is. `aws-bedrock` is Bedrock Knowledge Bases; `vertex-rag` is the Vertex AI RAG Engine. Both are reachable only from their own cloud, which the infra emitter checks against `--cloud`. |
| `dataSource` | `knowledgeDataSource` | yes | — |
| `chunking` | object (fields below) | yes | How the managed engine splits documents. The engine performs the split, so this is configured on the knowledge base rather than performed by the runtime. |
| `embedModel` | `name` | yes | Model alias that must declare `embeddings`, and whose provider must belong to the same cloud as `engine`. The knowledge base owns the vector store, so this replaces the store-width gate rather than being exempt from it. |
| `filterable` | array of `name` | no | Metadata keys the filter contract may use. Bedrock sources need metadata sidecar files for a filter to match anything, so this is what makes the emitter write the sidecar convention instead of a filter that silently matches nothing. |
| `vectorStore` | object (fields below) | no | Where the engine keeps vectors. `provisioned` (the default) has the module create one; `existing` points at a store the operator already pays for and requires `arn`. The plan's default is not OpenSearch Serverless: its two-OCU floor is the most common way this feature becomes a surprise bill. |

### `knowledgeBase.chunking`

How the managed engine splits documents. The engine performs the split, so this is configured on the knowledge base rather than performed by the runtime.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy` | `fixed`, `recursive`, `code` | yes | — |
| `size` | `integer` | yes | — |
| `overlap` | `integer` | yes | — |

### `knowledgeBase.vectorStore`

Where the engine keeps vectors. `provisioned` (the default) has the module create one; `existing` points at a store the operator already pays for and requires `arn`. The plan's default is not OpenSearch Serverless: its two-OCU floor is the most common way this feature becomes a surprise bill.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `provisioned`, `existing` | yes | — |
| `arn` | `string` | no | — |

## `gateway`

A managed MCP gateway: the cloud hosts the endpoint, the targets behind it are federated tools, and a runtime reaches it over MCP instead of bundling every tool. Declarable from spec v0.24. The gateway owns its invocation surface, so a target here is a tool the app does not run -- which is why nothing in this section is copied into the generated tool registry: `tools:` is unchanged and a gateway is reached through an MCP client, not through a second emitter.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | no | What this gateway is for. Carried to the resource's `Description`, which the CloudFormation reference caps at 200 characters. |
| `authorizer` | `gatewayAuthorizer` | yes | — |
| `targets` | array of `gatewayTarget` | yes | The federated tool targets this gateway fronts. Every kind is one target under the gateway's `Mcp` configuration, so a single shape carries them all. |

## `gatewayAuthorizer`

How a caller proves it may invoke the gateway. `awsIam` signs with SigV4 and is what a runtime on the same account uses; `jwt` validates a bearer token against an OIDC discovery document and is what an outside caller uses. The CloudFormation resource also accepts `NONE` and `AUTHENTICATE_ONLY`, which are deliberately unreachable: a gateway that authenticates nobody is reachable by anyone who learns its URL, and one that only authenticates forwards every request to a target the platform then authorizes with the gateway's own role.

A `gatewayAuthorizer` is exactly one of the 2 forms below; each form is recognised by its discriminating key.

### `kind` = `awsIam`

SigV4 request signing with an IAM identity. Maps to `AuthorizerType: AWS_IAM`.

Takes the value `"awsIam"` and no other keys.

### `kind` = `jwt`

A JWT bearer token validated against OpenID Connect discovery. Maps to `AuthorizerType: CUSTOM_JWT`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `discoveryUrl` | `string` | yes | The OIDC discovery document the gateway reads to find the issuer's signing keys. The platform requires the `.well-known/openid-configuration` suffix, so the pattern refuses a bare issuer URL here rather than at apply time. |
| `audience` | array of `string` | yes | Accepted `aud` values, at least one. A token minted for another audience is refused by the gateway rather than by the target. |

## `gatewayTarget`

One federated target behind a gateway. `kind` selects which of the two configurations below is required, and the other is refused rather than ignored: a target that carried both would describe two tools, and the CloudFormation resource accepts exactly one per target.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `name` | yes | The target's name, used for the resource name and the tool prefix the gateway advertises. |
| `kind` | `openApiSchema`, `mcpServer` | yes | `openApiSchema` federates every operation in an OpenAPI document; `mcpServer` federates every tool an existing MCP server already exposes. |
| `description` | `string` | no | What this target fronts. Carried to the target resource's `Description`. |
| `openApiSchema` | `gatewayOpenApiSchema` | no | — |
| `mcpServer` | `gatewayMcpServer` | no | — |

## `gatewayOpenApiSchema`

An OpenAPI document the gateway reads to advertise one tool per operation. Either an object-store URI or the document itself, never both: the CloudFormation `ApiSchemaConfiguration` accepts `S3` or `InlinePayload`, and a target that named both would leave the platform choosing which one wins.

A `gatewayOpenApiSchema` is exactly one of the 2 forms below; each form is recognised by its discriminating key.

### `uri`

`s3://` URI of the document. The pattern is the one the CloudFormation `S3Configuration.Uri` property documents, so an invalid URI is refused here rather than at apply time.

Takes the single key `uri`, holding `string`.

### `inline`

The document itself, for a schema too small or too changeable to publish to a bucket. Written verbatim into the target's `InlinePayload`.

Takes the single key `inline`, holding `string`.

## `gatewayMcpServer`

An MCP server the gateway proxies: the app reaches one gateway URL and the platform reaches every tool the server behind it exposes. Nothing is copied here -- the server keeps owning its own tool list.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `endpoint` | `string` | yes | The server's HTTPS MCP endpoint. The platform refuses a plaintext endpoint, so the pattern is enforced at build time rather than at apply time. |

## `retriever`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `knowledgeBase` | `name` | no | Bind this retriever to a managed knowledge base. It replaces `source`, `chunking`, `embedModel`, `store` and `index` -- declaring one of those beside it is ambiguous and refused rather than silently preferred. |
| `source` | object (fields below) | no | — |
| `chunking` | object (fields below) | no | — |
| `embedModel` | `name` | no | Model alias that must declare the `embeddings` capability; the referential gate enforces that. |
| `store` | `name` | no | — |
| `index` | object (fields below) | no | — |
| `topK` | `integer` | yes | Candidates the retriever returns per query. This is the retriever's value; Phase 1 has no step-level override. |
| `rerank` | object (fields below) | no | — |
| `filters` | array of `string` | no | Expressions that narrow a query to the passages it may see, ANDed in order. The grammar is `&lt;field&gt; &lt;operator&gt; &lt;value&gt;` with operators `==`, `!=`, `^=`, `$=`, `*=`. `&lt;field&gt;` is a chunk metadata key, or the reserved `doc_id`/`uri`; a value containing spaces is quoted with single or double quotes. A field a chunk does not carry never matches, for every operator including `!=`, so a corpus cannot opt out of a selector by omitting the key. Requires spec 0.20. |
| `refresh` | object (fields below) | no | — |
| `traits` | array of `citations` | no | Behavioural traits the generated retrieval path must honour. `citations` means retrieved items carry the source path and offsets a generated answer can cite. |

### `retriever.source`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `file`, `s3`, `http`, `db`, `mcp` | yes | `file` indexes a local directory and is implemented at every version. `s3` loads an object-store corpus and `http` loads exactly one URL; both are implemented at spec 0.21. `db` and `mcp` are reserved by the design and rejected by a spec-local rule until the phase that ships their loaders, so a spec can be written against the final spelling without being silently ignored. |
| `uri` | `string` | yes | — |
| `glob` | `string` | no | A pattern selecting documents from a `file` or `s3` source, using `*`, `**`, `?` and literal text. For `s3`, the pattern matches object keys relative to the uri's prefix. An `http` source is one document and takes no `glob`, because a pattern describes a set. |

### `retriever.chunking`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy` | `fixed`, `recursive`, `semantic`, `code` | yes | `fixed`, `recursive` and `code` cut a document by size. `semantic` cuts where the cosine similarity between adjacent units dips, so a boundary follows the text rather than a character count; it is implemented at spec 0.22, and a spec-local rule rejects it below that version. |
| `size` | `integer` | yes | Target chunk size in characters. The cost gate turns it into tokens at a fixed characters-per-token ratio, so estimates compare. |
| `overlap` | `integer` | yes | — |
| `keepMetadata` | array of `name` | no | — |

### `retriever.index`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `metric` | `cosine`, `dot`, `l2` | yes | — |
| `hybrid` | `boolean` | no | Blend the lexical and the vector ranking instead of ranking on the vector alone. Off by default, so a retrieval that needs no lexical half declares nothing. |

### `retriever.rerank`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | `name` | yes | Model alias the reranker is bound to. Phase 1 ships a deterministic lexical reranker, so the alias is a `fake` or local model; a hosted reranker adapter is a later phase's seam. |
| `topN` | `integer` | yes | — |

### `retriever.refresh`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `full`, `incremental` | yes | How a rebuild treats work already in the index. `full` re-embeds and upserts every chunk without deleting anything; `incremental` treats the documents it is given as the whole corpus, embeds only chunks whose content hash is not stored, and deletes the vectors of documents the corpus no longer contains. |
| `schedule` | `string` | no | Spec 0.23. A five-field cron (minute hour day-of-month month day-of-week) read as UTC, at which the compiler emits a scheduler resource for this retriever: `aws_scheduler_schedule` submitting the AWS Batch job, or `google_cloud_scheduler_job` calling the Cloud Run job's `:run` endpoint. Each field is `*`, `*/n`, a number, `a-b`, `a-b/n`, or a comma list of those; six-field expressions, `@daily`-style macros and the `?`, `L`, `W` and `#` extensions are refused. The retriever also needs a `target: batch` deployment to trigger, and a retriever that binds a managed knowledge base refuses `refresh` entirely because the managed engine owns ingestion. |

## `eval`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | `string` | yes | What the eval scores. `pipeline:&lt;id&gt;` scores a pipeline's HTTP response through its declared route. `agent:&lt;id&gt;` (0.27) names an agent run, which is what a trajectory metric needs; the py-fastapi target declares `agent-evals` and runs the agent offline, and `evals/trajectory` refuses the target with `ir/eval-trajectory` when a targeted generator does not declare that capability. |
| `dataset` | object (fields below) | yes | — |
| `metrics` | array of `metric` | yes | — |
| `gate` | object (fields below) | no | How this eval's result is compared against the committed baseline. Never an equality check: sampling noise is expected, so the gate is a threshold on the regression relative to the baseline. |
| `description` | `string` | no | — |

### `eval.dataset`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | `"file"` | yes | — |
| `uri` | `string` | no | — |

### `eval.gate`

How this eval's result is compared against the committed baseline. Never an equality check: sampling noise is expected, so the gate is a threshold on the regression relative to the baseline.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ci` | `boolean` | no | When true this eval runs in the CI gate. At least one eval per HTTP-triggered pipeline should set it (an IR warning, not a schema rule). |
| `maxRegression` | `number` | no | Largest tolerated absolute drop in the metric's score versus the baseline. |
| `samples` | `integer` | no | Runs per case. More samples shrink the sampling-uncertainty term the gate also requires before it fails. |
| `minMean` | `number` | no | Absolute floor: the eval fails whenever the mean score falls below this value, regardless of maxRegression. A 0/1 metric (such as `assert`) needs it, because the regression allowance can otherwise absorb a drop it must never absorb. Required to be 1 when an `assert` metric is present. |
| `promotion` | object (fields below) | no | The policy a candidate release must satisfy before it replaces the accepted baseline for this eval. Declarable from spec v0.28. `aid eval --compare` applies this policy to two recorded baselines and refuses a candidate whose quality drops more than the allowance permits. A baseline also records the spend and latency of the run that produced it, so the cost allowance is judged rather than deferred -- and an allowance it cannot judge is refused, not passed. Nothing promotes automatically -- the refusal is a failed check in CI, and the promotion is still a merged pull request. |

#### `eval.gate.promotion`

The policy a candidate release must satisfy before it replaces the accepted baseline for this eval. Declarable from spec v0.28. `aid eval --compare` applies this policy to two recorded baselines and refuses a candidate whose quality drops more than the allowance permits. A baseline also records the spend and latency of the run that produced it, so the cost allowance is judged rather than deferred -- and an allowance it cannot judge is refused, not passed. Nothing promotes automatically -- the refusal is a failed check in CI, and the promotion is still a merged pull request.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `baseline` | object (fields below) | yes | The prompt version this candidate is measured against. Declaring it is what makes the staleness rule checkable: a promotion that names the version already in the spec has nothing to promote, because two different templates would share one identity. |
| `allowedQualityDrop` | `number` | yes | Largest tolerated absolute drop in any metric's mean between the accepted baseline and the candidate. |
| `allowedCostIncrease` | `number` | no | Largest tolerated relative increase in cost per run, as a fraction of the accepted baseline's spend. `aid eval --compare` computes the increase from the `cost` block both baselines record and refuses a candidate above the allowance; when either file records no spend it refuses the promotion as unjudged rather than passing it. The per-case spend bound is the separate `cost` metric's `max` ceiling, which is compared like any other metric. |
| `approval` | object (fields below) | no | The record a human approval leaves behind. Required under `profile: enterprise`, where a promotion with no named approver and no recorded decision is refused by `ir/promotion-approval`. |

##### `eval.gate.promotion.baseline`

The prompt version this candidate is measured against. Declaring it is what makes the staleness rule checkable: a promotion that names the version already in the spec has nothing to promote, because two different templates would share one identity.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | `name` | yes | The prompt whose accepted version the candidate replaces. |
| `version` | `integer` | yes | The accepted version. The candidate must declare a strictly greater `version` on that prompt. |

##### `eval.gate.promotion.approval`

The record a human approval leaves behind. Required under `profile: enterprise`, where a promotion with no named approver and no recorded decision is refused by `ir/promotion-approval`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `by` | array of `string` | yes | Who approved the promotion. Names or roles, never credentials. |
| `record` | `string` | yes | The committed path holding the decision, e.g. `app/approvals/triage-5.md`. A path, because the record lives in the repository the promotion is reviewed in. |

## `metric`

A `metric` is exactly one of the 13 forms below; each form is recognised by its discriminating key.

### `kind` = `exact`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `field` | `name` | yes | — |

### `kind` = `contains`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `field` | `name` | yes | — |
| `value` | `string` | no | — |

### `kind` = `json-schema`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `schema` | `typeName` | yes | — |

### `kind` = `tool-trace`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `expect` | array of `name` | yes | — |
| `ordered` | `boolean` | no | — |

### `kind` = `cost`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `max` | `number` | yes | Maximum tolerated USD per case, measured by the eval harness from the gateway ledger around each case. |

### `kind` = `latency`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxMs` | `integer` | yes | Maximum tolerated milliseconds per case, measured by the eval harness from the clock around each case. |

### `kind` = `llm-judge`

Allowed in the spec but rejected by a spec-local rule when gate.ci is true: a judging model is neither deterministic nor available offline, so it can never be part of the CI gate.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rubric` | `string` | yes | — |
| `field` | `name` | no | — |
| `model` | `name` | no | — |
| `threshold` | `number` | no | — |

### `kind` = `retrieval`

Deterministic and offline: it compares the ranking against known-correct source paths, so unlike llm-judge it is allowed under gate.ci.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `expectDocs` | array of `string` | yes | Source paths, spelled relative to the retriever's source uri, that the ranking must place inside the top k. A warning in the eval-coverage gate if a spec declares retrievers and no eval measures them. |
| `k` | `integer` | yes | — |

### `kind` = `assert`

Deterministic and offline: a closed predicate evaluated against the prediction and the case, so unlike llm-judge it is allowed under gate.ci. Needs `gate.minMean: 1.0`, which a spec-local rule enforces.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `expr` | `string` | yes | A PredicateExpr over `prediction`, `case.id` and `case.metadata.&lt;name&gt;`. Closed grammar: no eval, no regex. |
| `message` | `string` | yes | The failure detail, verbatim. Required: it is the whole value of a failing assertion. |

### `kind` = `decision`

Scores a prediction with a `score` decision: the rubric is declared once in `decisions` and the answer's position becomes the metric. Not deterministic, so a spec-local rule rejects it under gate.ci.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `decision` | `name` | yes | The name of a `decisions` entry whose `type` is `score`. A moving alias is refused, because two runs of an eval would otherwise score two different models. |

### `kind` = `step-count`

Deterministic and offline: an agent runner reports how many model calls a case took, so unlike llm-judge it is allowed under gate.ci. An agent target only -- a prompt or pipeline target has no steps to count.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxSteps` | `integer` | yes | The ceiling on model calls this case may take. The agent's own `maxSteps` already bounds a run; this asserts that the bound held for *this* case, so a case expected to take three steps that takes nine is a run that looped and the answer it produced is not the run the case described. Refused by `ir/eval-metric-vacuous` when it is not below the agent's own `maxSteps`, because a ceiling the budget always reaches first can never fail. |

### `kind` = `forbidden-tool`

Deterministic and offline: it reads the calls an agent runner reports, so unlike llm-judge it is allowed under gate.ci. An agent target only.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `forbid` | array of `name` | yes | The tools this case must not reach for. The inverse of `tool-trace`, which asks whether the run did a thing: this asks whether it crossed a line, so a run that calls no tools at all passes. Every name must be a declared tool, which the referential gate enforces. |

### `kind` = `approval-respected`

Deterministic and offline: the runner records the pauses it took and the decisions it was given, so unlike llm-judge it is allowed under gate.ci. Three findings, and a case passes only when none fires: `pause-missed`, `pause-unexpected`, and `decision-ignored` -- a call that ran after a rejection, which fails the case even when the answer matches. A case supplies its decisions in `approvals`. An agent target only, and refused by `ir/eval-metric-vacuous` when the agent can never pause, because a metric that can only pass measures nothing.

Takes the value `"approval-respected"` and no other keys.

## `pipeline`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | no | — |
| `trigger` | one of 2 (fields below) | yes | How the pipeline starts. `http` mounts a route; `manual` starts nothing on its own and exists so a `target: batch` deployment can run the pipeline once to completion. Exactly one of the two is declared. |
| `steps` | array of `step` | yes | — |

### `pipeline.trigger`

How the pipeline starts. `http` mounts a route; `manual` starts nothing on its own and exists so a `target: batch` deployment can run the pipeline once to completion. Exactly one of the two is declared.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `http` | object (fields below) | no | — |
| `manual` | `true` | no | A pipeline with no inbound route. A `target: batch` deployment names it and runs it once per job. |

#### `pipeline.trigger.http`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | `get`, `post`, `put`, `patch`, `delete` | yes | — |
| `path` | `string` | yes | — |

## `step`

A `step` is exactly one of the 12 forms below; each form is recognised by its discriminating key.

### `generate`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | `name` | yes | — |
| `input` | `stepInput` | no | — |
| `context` | `binding` | no | Binding name holding retrieved items: a retrieve step's result. The generator passes the items to the prompt and returns the citation list alongside the model call. |
| `as` | `binding` | yes | — |

### `tool`

Explicitly invoked by the pipeline, never chosen by the model. That is what keeps Phase 0 control flow plain async while still exercising the tool, auth and tracing seams.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tool` | `name` | no | — |
| `input` | `stepInput` | no | — |
| `as` | `binding` | yes | — |
| `requiresApproval` | `boolean` | no | Pause the run before this call and wait for a recorded decision. Spec 0.26. Only a tool whose `sideEffects` is `write` or `destructive` may set it (`ir/approval-step-tool`): approving a read adds a run record and a delay for no control. A pause needs somewhere to be written, so a pipeline that declares one requires a durable `state`. |

### `retrieve`

One retrieval over a declared retriever, bound to `as` for a later generate step's `context`. Retrieval is an explicit pipeline step rather than something a step does implicitly, so what was searched and in what order stays visible in the spec.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `retriever` | `name` | yes | — |
| `query` | `string` | yes | Mustache-style text, checked for well-formedness like a prompt template. A placeholder naming a later step's binding is a build-time IR error, not a schema one. |
| `as` | `binding` | yes | — |

### `rerank`

Reorders a retrieval result with the reranker named by `model`. The runtime's reranker takes both a query and the items, so the step names both: `over` is the retrieval binding it reorders and `query` is what it ranks against. The design doc's single `input` field could not supply both, so it is not part of this shape.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `over` | `binding` | yes | Binding name holding the retrieval result to reorder: a retrieve step's or an earlier rerank step's `as`. |
| `query` | `string` | yes | Mustache-style text the reranker scores against, checked for well-formedness like a prompt template. |
| `model` | `string` | yes | Reranker alias matched by the runtime, not a `models[]` entry. Only the lexical reranker is implemented, so the name must contain 'lexical'. |
| `topN` | `integer` | yes | — |
| `as` | `binding` | yes | — |

### `guard`

Runs one declared guardrail against one payload at one stage. A blocked payload stops the pipeline the same way an input-stage guardrail does on a generate step; a `flag` records a verdict and changes nothing, which is why a guard step binds no name.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `guardrail` | `name` | yes | — |
| `stage` | `input`, `output`, `retrieval`, `tool-call` | yes | — |
| `text` | `string` | yes | Mustache-style text for the `input` and `output` stages; at the `retrieval` stage a single reference to a retrieval binding, whose passages are what the guardrail inspects. |

### `agent`

Runs a declared agent to completion and binds its answer. The step owns a fresh run of that agent, so it declares `text` (the user turn) rather than an `input` map; an agent that can pause, or that declares `memory`, is not a legal target.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `name` | no | — |
| `text` | `string` | yes | Mustache-style text sent as the agent's user turn. |
| `as` | `binding` | yes | — |

### `emit`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | `typeName` | yes | — |

### `branch`

Authorization branching. `when` is evaluated against the caller's Principal, so it answers "who is asking" and never "what did the last step produce" -- the grammar has no operand for a context value. Use `map`/`reduce` for data-driven control flow.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `when` | `string` | yes | A policy expression over the authenticated caller. Parsed by the IR layer, which rejects an operand that is not a builtin call or a literal. |
| `then` | `stepList` | yes | — |
| `else` | `stepList` | no | — |

### `parallel`

Runs each arm concurrently under the deployment's single concurrency cap. Results merge into one context, in branch order.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `branches` | array of `stepList` | yes | — |

### `map`

Applies one step to every item of a bound list, concurrently, and binds the ordered list of results.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `over` | `binding` | yes | Binding name holding the list to iterate. |
| `as` | `binding` | yes | — |
| `step` | `step` | yes | — |

### `reduce`

Applies one prompt to every item of a bound list, concurrently, and binds the ordered list of results. Combining them into a single value stays explicit in a following `generate` step.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `over` | `binding` | yes | Binding name holding the list to iterate. |
| `prompt` | `name` | yes | — |
| `as` | `binding` | yes | — |

### `route`

Data-driven control flow: asks a declared `choice` decision what the input is, then runs the arm its answer names. Every label the decision can return must reach an arm, so an answer never has an unhandled continuation; `default` covers the labels `on` leaves out. Unlike `branch`, whose `when` sees only the caller's Principal, `input` is a template, so routing may depend on what an earlier step produced.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `decision` | `name` | yes | A declared decision of type `choice`. A `score` or `noul` answer names no arm, so neither is a legal router. |
| `input` | `string` | yes | The text the decision classifies. A mustache template over earlier bindings, like a `retrieve` step's query. |
| `on` | map of `stepList` | yes | The arm to run for each answer label. A key the decision never returns is refused, as is a decision whose label has no arm and no `default`. |
| `default` | `stepList` | no | The arm for a label `on` leaves out. Required when `on` is partial; refused when `on` already maps every label, because it could never run. |
| `as` | `binding` | no | Binding name for the chosen label, so a later step can name the path it took. |

## `agent`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | no | — |
| `instructions` | `name` | yes | Prompt alias supplying the agent's instructions. |
| `model` | `name` | yes | — |
| `tools` | array of `name` | no | — |
| `retrievers` | array of `name` | no | — |
| `memory` | array of `name` | no | — |
| `guardrails` | array of `name` | no | — |
| `structuredOutput` | `typeName` | no | — |
| `maxSteps` | `integer` | yes | — |
| `maxTokensBudget` | `integer` | no | — |
| `maxCostBudget` | `number` | no | — |
| `onBudgetExhausted` | `fail`, `degrade` | no | What a budget breach does. `fail` (the default) is a hard failure. `degrade` steps once to the first cheaper fallback alias; it requires maxCostBudget and a cheaper fallback, which the agents gate enforces at build time. |
| `handoffs` | array of `name` | no | Agents this one may transfer the conversation to; the receiving agent owns the rest of the turn. |
| `delegates` | array of `name` | no | Agents this one may delegate a sub-task to; control returns to this agent when the sub-task finishes. |
| `engine` | `native`, `deepagents` | no | Who owns the loop. `native` is the AID agent runtime; `deepagents` delegates to the pinned framework, which requires an engineVersion. |
| `engineVersion` | `string` | no | — |
| `humanInTheLoop` | object (fields below) | no | — |
| `state` | `agentState` | no | A durable run store for this agent, overriding the project-level `state`. Spec 0.26. Required when the agent can call a tool with side effects, so a replayed resume is refused across replicas and a paused run has a declared place to live; note that AID generates the nonce claim, not the run persistence. |

### `agent.humanInTheLoop`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `when` | `string` | yes | Closed policy expression deciding when a human must approve. |
| `channel` | `string` | yes | — |

## `decision`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `"typesafe"` | yes | The decision vendor. Closed: `typesafe` is the only one the runtime serves. |
| `model` | `string` | yes | A pinned Jev version such as `jev-1.14.0`. Moving aliases (`jev-latest`, `jev-preview`) are refused inside `evals`, where a score must be reproducible. |
| `type` | `choice`, `score`, `noul` | yes | — |
| `instructions` | `string` | yes | The question, in one sentence. Not a prompt template: Jev does not carry a conversation. |
| `criteria` | one of 2 | no | — |
| `onError` | `allow`, `block` | no | What a failed call means for a guardrail that names this decision. `block` (the default) keeps the gate closed when the vendor is unreachable; `allow` keeps an advisory check from stopping traffic. A `route` and an eval metric still fail the run, because neither has an arm or a score to fall back on. |
| `description` | `string` | no | — |

## `guardrail`

A check at one stage. A guardrail is either a policy check (`policies` + `action`) or a decision-backed check (`decision` + `onDecision`); it may declare both, and the policy check runs first.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stages` | array of `input`, `output`, `retrieval`, `tool-call` | yes | — |
| `policies` | array of `pii-detect`, `pii-redact`, `prompt-injection`, `jailbreak`, `moderation`, `toxicity`, `secret-scan` | no | Closed policy vocabulary; a name the guardrails engine does not implement is rejected at the spec layer, never passed through. |
| `action` | `block`, `redact`, `flag`, `escalate` | no | — |
| `engine` | `builtin`, `bedrock`, `model-armor` | no | Who evaluates the declaration. `builtin` (the default) is the runtime's offline detector layer; `bedrock` is a managed AWS Bedrock guardrail; `model-armor` (spec 0.14) is a Vertex AI Model Armor template in Google Cloud, owned by the spec from 0.15 when a `modelArmor` block is present. An engine is a location for the policy, not a policy itself, so a managed guardrail carries no `policies`. |
| `bedrock` | object (fields below) | no | The managed policy a `bedrock`-engine guardrail owns, rendered into the deployment as an `aws_bedrock_guardrail`. Omit the block to point the app at a guardrail the operator already owns, through `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION`. Account ids and ARNs are never spec inputs. |
| `modelArmor` | object (fields below) | no | The managed policy a `model-armor`-engine guardrail owns, rendered into the deployment as a `google_model_armor_template`. Omit the block to point the app at a template the operator already created, through `MODEL_ARMOR_TEMPLATE`. DLP inspect/deidentify templates and custom filter rules are references to resources this deployment does not create, so they stay operator inputs. |
| `decision` | `name` | no | A `choice` decision to ask before the stage runs. Only the `input` stage may carry one, and the name must be declared under `decisions` (spec 0.7). |
| `onDecision` | map of `allow`, `block`, `flag`, `escalate` | no | What each answer label means. `allow` lets the run continue; the others record that action. Every label the decision declares must appear here, and no other label may (checked by the spec gate, which knows the criteria). |
| `minConfidence` | `number` | no | The lowest answer confidence this guardrail accepts. A less confident answer counts as a failed check and fails closed as a block. Defaults to 0. |
| `redact` | array of `string` | no | Field names the `redact` action removes. Required when `action: redact`, which the guardrails gate enforces. |
| `tools` | array of `name` | no | Tools this guardrail covers. Absent or empty means every tool that reaches the stage. |
| `onFail` | object (fields below) | yes | — |

### `guardrail.bedrock`

The managed policy a `bedrock`-engine guardrail owns, rendered into the deployment as an `aws_bedrock_guardrail`. Omit the block to point the app at a guardrail the operator already owns, through `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION`. Account ids and ARNs are never spec inputs.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | map of `low`, `medium`, `high` | no | Content-filter strength per category; the same strength is applied to input and output. A category absent from the map is not filtered. |
| `topics` | map of `string` | no | Denied topics, name -&gt; the definition the classifier is given. The definition is the policy: two specs that name the same topic but describe it differently are asking different questions. |
| `words` | array of `string` | no | Exact terms the managed word filter refuses. |
| `pii` | array of `email`, `phone`, `name`, `address`, `ssn`, `credit-card`, `bank-account`, `passport`, `drivers-license`, `ip-address`, `url`, `aws-access-key`, `aws-secret-key` | no | Personal-information entities the managed policy detects. `action: redact` anonymises them; `action: block` refuses the text instead. |

### `guardrail.modelArmor`

The managed policy a `model-armor`-engine guardrail owns, rendered into the deployment as a `google_model_armor_template`. Omit the block to point the app at a template the operator already created, through `MODEL_ARMOR_TEMPLATE`. DLP inspect/deidentify templates and custom filter rules are references to resources this deployment does not create, so they stay operator inputs.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rai` | object (fields below) | no | Responsible-AI categories the template filters, category -&gt; the lowest confidence it refuses. A category absent from the map is not filtered. |
| `promptInjection` | `modelArmorConfidence` | no | Refuse prompt-injection and jailbreak attempts at this confidence or above. Absent leaves the filter off. |
| `maliciousUri` | `boolean` | no | Refuse text that carries a malicious or phishing URL. `false` writes an explicit `DISABLED`, which differs from omission only in intent. |
| `sensitiveData` | `boolean` | no | Inspect text for sensitive data with the basic configuration. `false` writes an explicit `DISABLED`. A DLP inspect or deidentify template is an operator input, not a spec input. |

#### `guardrail.modelArmor.rai`

Responsible-AI categories the template filters, category -> the lowest confidence it refuses. A category absent from the map is not filtered.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sexual` | `modelArmorConfidence` | no | — |
| `hate` | `modelArmorConfidence` | no | — |
| `harassment` | `modelArmorConfidence` | no | — |
| `dangerous` | `modelArmorConfidence` | no | — |

### `guardrail.onFail`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `message` | `string` | yes | — |
| `fallbackPrompt` | `name` | no | — |
| `log` | `boolean` | yes | — |

## `memory`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `buffer`, `window`, `summary`, `semantic`, `episodic`, `vector` | yes | — |
| `scope` | `thread`, `user`, `global` | yes | `thread` is one conversation, `user` spans a user's threads, `global` is shared by every caller. |
| `tokenBudget` | `integer` | yes | — |
| `summarizeModel` | `name` | no | — |
| `store` | `name` | no | — |
| `backend` | `string` | no | A declared store id or `in-process`. The memory gate resolves it. |
| `ttl` | `string` | no | — |
| `redact` | array of `string` | no | — |

## `deployment`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | `serverless`, `container`, `batch`, `edge` | yes | — |
| `streaming` | `boolean` | no | — |
| `concurrency` | `integer` | no | — |
| `autoscale` | object (fields below) | no | — |
| `secrets` | array of `string` | yes | — |
| `cloud` | `string` | no | The cloud this deployment lands in: `aws` or `gcp`. Spec 0.25. Before 0.25 the cloud was only a CLI flag (`aid infra --cloud`, defaulting to `aws`), which put a property of the customer's deployment in whoever's shell happened to run the apply. When the spec declares it, the spec wins and an agreeing `--cloud` is ignored, while a disagreeing one is refused with `cli/infra-cloud-conflict` rather than silently dropped. When the spec omits it, `--cloud` decides, and `aws` when that is absent too -- byte-identical to the behaviour before this key existed. Deployments that pin *different* clouds are refused separately, by `ir/cloud-conflict`, because one module set targets one cloud. Any other name is accepted by this schema on purpose: a cloud AID does not provision is then refused by `ir/cloud-unsupported`, which names the supported set and the capability matrix, instead of reading as a mistyped enum entry. Uppercase is accepted for the same reason: `Azure` is refused by that gate rather than by a pattern message, and `AWS` is `ir/deploy-target-unknown` with the lower-case spelling as its fix. |
| `region` | `string` | no | The region the deployment is placed in, and the residency pin. Spec 0.25. A deployment scalar rather than a project one, because one project may place `prod` and `dev` in different regions. Validated against the region set of the deployment's cloud, so a region that belongs to the other cloud is `ir/region-target` at validate time rather than a module that fails at apply time. |
| `audit` | `audit` | no | Where this deployment's audit record lands. Spec 0.25. The sink names a service the customer already owns; AID emits the log group or sink, never its contents. `enterprise` requires one on every deployment. |
| `identity` | `identity` | no | The identity provider this deployment trusts. Spec 0.26. A reference to an IdP the customer already runs -- an issuer URL and an audience -- never a secret and never a credential. AID records the reference and gates its presence; it generates no token verification. The generated app's `current_principal` dependency returns an anonymous principal, and the application replaces it with its own verifier, named in `verifiedBy` (spec 0.33). `enterprise` requires this block and a `verifiedBy` on every deployment. |
| `network` | `network` | no | Where this deployment's compute sits on the network. Spec 0.26. `private: true` is the placement pin, and `enterprise` requires it on every deployment: the profile gate refuses a missing or false pin with `ir/profile-network`. The generated container module already builds a two-AZ VPC with private task subnets and one NAT gateway, so the pin states a requirement rather than selecting a different module, and no gate refuses a cloud for lacking a private-placement module because no generator branches on this key yet. |
| `approvals` | `approvals` | no | Change control for this deployment, which is a review policy and not runtime human-in-the-loop. Spec 0.26. Compiled into `infra/approvals.json` and into the generated plan workflow's `environment` binding, so the policy is a file the customer's GitHub organisation applies reviewers from; AID neither reads nor sets repository settings. `enterprise` requires it on every deployment. |
| `image` | `image` | no | Where the image is published. Spec 0.4, and only on a `target: container` deployment: another target builds no image to publish. |
| `pipeline` | `name` | no | The pipeline this job runs, by id. Spec 0.5, and only on a `target: batch` deployment: a run-to-completion job exists to run exactly one pipeline once, and a target that answers requests runs whichever pipeline its route names. The pipeline must declare `trigger.manual`. |
| `runtime` | `runtime` | no | The managed agent runtime the process runs on. Spec 0.13, and only on a `target: container` deployment: the platform schedules, isolates and addresses the process, so the compute module is replaced rather than paired with it. The spec must declare exactly one HTTP route, because the platform's invocation route carries one request shape. The app is unchanged: the generated contract wrapper mounts the same ASGI app and route handlers, so the cost ceiling, trace span, eval hook and refusals stay on the invocation path. |
| `env` | array of object | no | — |

### `deployment.autoscale`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `min` | `integer` | yes | — |
| `max` | `integer` | yes | — |
| `metric` | `string` | yes | — |

## `runtime`

A managed agent runtime: a service that stops being a container the operator keeps warm and becomes an agent the platform schedules, isolates and addresses. `aws-agentcore` is Amazon Bedrock AgentCore Runtime, one microVM per session with up to 8 hours; `gcp-agent-platform` is the Gemini Enterprise Agent Platform (formerly Vertex AI Agent Engine, still `google_vertex_ai_reasoning_engine` in Terraform), a managed per-session runtime. Both accept the image `target: container` already builds, which is what makes this a deployment destination rather than a second generation path. `memory.shortTerm` maps to AgentCore Memory on `aws-agentcore` and to a Vertex AI Memory Bank on `gcp-agent-platform`, where it is configured on the reasoning engine through `context_spec.memory_bank_config`. `session.ttlMinutes` defaults to 480, the AgentCore microVM ceiling; the Google platform accepts up to 20160 (14 days).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `aws-agentcore`, `gcp-agent-platform` | yes | The platform that runs the process. The platform's credentials are the deploy's credentials, so a platform and `--cloud` that disagree are refused instead of deployed unreachable. |
| `memory` | object (fields below) | no | Managed short-term memory. On `aws-agentcore` it is AgentCore Memory; on `gcp-agent-platform` it is a Vertex AI Memory Bank on the reasoning engine. Short-term events are the session transcript; long-term memory is deliberately absent until the spec has a construct that names what is stored and who may read it. |
| `session` | object (fields below) | no | How long one session may live. Defaults to 480 minutes, the AgentCore microVM ceiling. |
| `gateway` | `name` | no | Name of a `gateways` entry this runtime reaches over MCP. Spec 0.24, `aws-agentcore` only: the gateway is an AgentCore resource and the Google platform has no counterpart. Presence does two things and nothing else: the emitted module exports the gateway URL into the runtime's environment and grants the runtime role `bedrock-agentcore:InvokeGateway` on exactly that gateway. The app keeps its own tool list -- a gateway adds tools it does not own, it does not replace one it does. |

### `runtime.memory`

Managed short-term memory. On `aws-agentcore` it is AgentCore Memory; on `gcp-agent-platform` it is a Vertex AI Memory Bank on the reasoning engine. Short-term events are the session transcript; long-term memory is deliberately absent until the spec has a construct that names what is stored and who may read it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `shortTerm` | `boolean` | no | Store the session transcript in managed memory: AgentCore Memory on `aws-agentcore`, a Vertex AI Memory Bank on `gcp-agent-platform`. The backend forgets an event after 30 days. |

### `runtime.session`

How long one session may live. Defaults to 480 minutes, the AgentCore microVM ceiling.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ttlMinutes` | `integer` | no | Session lifetime in minutes. AgentCore microVMs stop at 480; the Google platform accepts up to 20160 (14 days). |

## `audit`

The audit destination for a deployment: a service the customer already runs, named rather than configured here. Each sink belongs to one cloud, and a sink named for the other cloud is refused (`ir/audit-target`) instead of emitted as a resource the deploy cannot create.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sink` | `cloudwatch`, `s3`, `gcs`, `bigquery` | yes | The log destination. `cloudwatch` and `s3` are AWS; `gcs` and `bigquery` are Google Cloud. |
| `retentionDays` | `integer` | no | How long the record is kept, in days. Omitted means the sink's own default, which is the honest answer: AID does not invent a retention policy for an operator's log store, and no lifecycle rule is emitted at all rather than one guessed. When the document does name one, every sink honours it, each in its own provider's terms: a CloudWatch log group via `retention_in_days`, an S3 archive via a lifecycle expiration, a GCS bucket via a lifecycle rule, and a partitioned BigQuery dataset via a partition expiration. Two deployments naming the same sink with different retention are different destinations, and `ir/audit-conflict` refuses them. |

## `identity`

The identity provider a deployment trusts, as a reference: an issuer URL a reader can fetch and an audience name. No field accepts a credential. AID records the reference and gates its presence; it does not generate token verification, so `verifiedBy` (spec 0.33) names the component that really checks a token. Moving to another IdP is a reviewed spec change rather than an environment variable nobody reads.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `oidc`, `saml` | yes | `oidc` is a JWT issuer the app validates tokens from. `saml` is declared for an organisation whose SSO asserts identity before the gateway forwards it; either way the check is the verifier named in `verifiedBy`, not something AID emits. |
| `issuer` | `string` | yes | The issuer URL the token's `iss` claim must equal exactly. AID records it in the IR and the profile gate refuses an `enterprise` deployment that names no identity provider; no generated code compares this value, so the verifier named in `verifiedBy` is what checks it. |
| `audience` | `string` | no | The `aud` claim the token must carry. Omitted means the project id, which is the audience a verifier should expect. AID records it and emits no check. |
| `rolesClaim` | `string` | no | Which claim holds the token's roles, so the verifier named in `verifiedBy` can map them onto the runtime `Principal` that `auth` policies read. Omitted means `roles`. AID records the name; it reads no claim itself. |
| `scopesClaim` | `string` | no | Which claim holds the token's scopes. Omitted means `scp`, which is what OIDC providers issue. AID records the name; the verifier applies it. |
| `verifiedBy` | `string` | no | Who verifies tokens for this deployment, named so a reviewer can point at it: a module path such as `app.business.principal:current_principal`, a gateway, or a service. Spec 0.33. AID generates no token verification, so this is what turns the responsibility into a declaration instead of an implication -- `enterprise` refuses a deployment that declares `identity` without it (`ir/identity-verified-by`). |

## `network`

Private placement for a deployment. `private: true` is the only value that satisfies the `enterprise` profile; a deployment may declare `private: false` explicitly, which behaves like omitting the key and is what lets the profile gate's refusal say what was declared rather than what was missing.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `private` | `boolean` | yes | — |
| `egress` | `declared-only`, `open` | no | What the workload may reach outbound. `declared-only` (the default) routes egress through the endpoints the generated module creates for the declared dependencies and creates no path to the internet; `open` adds a NAT path, which is accepted and is documented as the weaker placement. |

## `approvals`

Change control for a deployment: the reviewers a credentialed infrastructure plan needs before it applies. Named as teams or logins the customer's repository already knows, because AID generates the policy file and the workflow binding while the repository's environment protection rules are what enforce the reviewers.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `require` | array of `string` | yes | The teams or logins that must approve. At least one, because a policy that names nobody approves everything. |
| `minApprovers` | `integer` | yes | How many of `require` must approve. Never more than the number named, which the profile gate refuses rather than emitting a policy that can never be satisfied. |
| `environments` | array of `string` | no | Which environments this policy covers. Omitted means the deployment it is declared on. |

## `agentState`

A durable run store: where the nonce that refuses a replayed resume is claimed, and a declared place for a paused or long-running run to live. AID generates the nonce claim; it does not write the run itself, so the checkpoint for a paused run returns to the caller until the app persists it. `urlEnv` is the *name* of an environment variable holding the connection string, following the `models.*.apiKeyEnv` precedent: the value stays in the platform and never enters the spec. Deliberately not `stores`, which is a vector store whose `dimensions` the normalize gate compares against the embedding model's width; run state is neither embedded nor a width, so putting it there would force a meaningless `dimensions`. An agent that can pause hands the caller a checkpoint, and that checkpoint is a bearer capability over the call it holds: whoever has it can approve it. So a checkpoint is signed, and it expires. `signingKeyEnv` names the variable the key comes from -- a name, never a value, for the same reason as `urlEnv` -- and the generated resume route refuses a checkpoint whose signature does not verify, whose deadline has passed, or whose nonce the store already holds. From spec v0.32 an `enterprise` document whose agent can pause and declares no `signingKeyEnv` is refused with `ir/resume-unsigned`; below that version, and under `profile: standard`, it is a warning naming what a resume accepts. A store is a second, separate guarantee: without one, a spent checkpoint is refused only by the process that issued it, so a replay reaches a second replica or a restarted process and is accepted. `ir/resume-replay-weak` says exactly that, as a warning under `standard` and an error under `enterprise`. The nonce record lives where this block points -- `postgres` for a store more than one replica shares, `sqlite` for one filesystem -- and the key named by `signingKeyEnv` is read at request time, so a deployment missing it refuses the run rather than pausing into a checkpoint it cannot sign. Signing is not authentication: the route trusts the checkpoint, not a caller identity, so whatever fronts the app still decides who may present one.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `postgres`, `sqlite` | yes | `postgres` is a database the customer runs and names through `urlEnv`; `sqlite` is a file, which survives a restart only on a mounted volume and is therefore refused for `target: container` without one. |
| `urlEnv` | `string` | yes | The environment variable holding the connection string or file path. A name, never a value. |
| `ttlHours` | `integer` | no | How long the app keeps a saved run before the store may delete it. Recorded, not acted on: AID emits no deletion job, because it does not delete an operator's rows on a policy it invented. Omitted means no expiry, which is accepted and documented rather than defaulted. Retention is not the same as the window a pause may be resumed in: a run kept for a week may still only be resumable for an hour, and `checkpointTtlMinutes` governs that. |
| `signingKeyEnv` | `string` | no | The environment variable holding the HMAC key the app signs its run checkpoints with. A name, never the key. A checkpoint carries the pending tool call and the human's answer, so holding one is authority to continue a paused run -- including a paused write. Signed, a checkpoint this app did not issue, one whose answer or pending arguments were edited, and one whose deadline was moved forward are all refused by the generated resume route. Omitted, the route keeps the pre-0.32 behaviour and accepts any well-formed checkpoint; `profile: enterprise` refuses that with `ir/resume-unsigned` rather than shipping a bearer capability. Signed is not single-use: the nonce that refuses a checkpoint already spent is remembered only where this block's store points, so with no `state` a spent checkpoint is refused by the process that issued it and accepted by a second replica or after a restart, which `ir/resume-replay-weak` says out loud -- a warning under `standard`, an error under `enterprise`. Signing also does not authenticate the caller: the route trusts the checkpoint, not an identity, so the app in front still decides who may present it. The key never enters the spec for the same reason a connection string does not: it is a credential, and it has to be rotatable without editing the document. |
| `checkpointTtlMinutes` | `integer` | no | How long a paused run may be resumed for, in minutes. Defaults to 15. The deadline is inside the signature, so it cannot be extended by the holder of a checkpoint; a fresh run is the only way to get a longer one. Set this to the longest a human approval may realistically take, because too short a window refuses a real approval and too long a one keeps a live capability in circulation. |

## `observability`

How much the generated app records about a run, and where it goes. Omitted entirely, tracing is on with nothing exported, which is the behaviour every document before 0.27 already had; the security gate derives the set of fields a trace must never carry and refuses a `redact` that drops one, though no target applies that set yet -- `redact` below records the refusal that stands in for it. The same set governs `aid trace export`, which refuses to write a dataset from captured prompts and completions under `profile: enterprise`, because an enterprise deployment may not move recorded content out of itself while nothing removes what must not travel. `export: otlp` declares intent rather than a transport: the generated app reports the destination and reads the address from the environment. The exporter is opt-in twice over -- `aid_runtime.telemetry.configure_export` installs one only when called, never on import, because a runtime library that installed one would decide telemetry for every application embedding it; and the generated app exposes the call rather than making it, because the ASGI entrypoint belongs to the developer. `aid gen` for py-fastapi emits `tracing_export_status()` and `metrics_export_status()` into `app/generated/observability.py` for that entrypoint to call, so one call site turns on whatever the document asked for; `configure_metrics()` is the metric-side installer beside `configure_export()`. A target that installs no exporter refuses `export: otlp` instead of accepting a destination it never writes to.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `trace` | `boolean` | no | Whether spans are recorded at all. Defaults to true. Turning it off under `profile: enterprise` is refused, and turning it off while declaring `export: otlp` is refused as a contradiction rather than resolved in either direction. |
| `redact` | array of `string` | no | The fields a trace must never carry. Omitted, this defaults to every field the security gate derives as sensitive, and the security gate still refuses a declared set that drops one. Naming a field the IR does not mark sensitive is accepted: a spec may be stricter than the derived set, never looser. A pipeline honours it: the generated app replaces the value of each named field in the text it records with `[redacted:&lt;name&gt;]`, while the model still receives the original text, because redaction decides what is recorded and never what is asked. The binding is made where the prompt is rendered, so the guarantee covers a value that was rendered into a prompt and nothing else -- a value an application records by another route is outside it. An agent run has no render to bind to, so it binds where values do arrive named: from the arguments of the tool calls its model composes. The runner withholds the value of each named argument before the copy is recorded, recursing into nested objects and lists, and keeps the model's own view intact -- the same split a pipeline makes, reached a different way. A value is bound only when it is a non-blank string: a number has no text to match in prose, and binding a blank value would put a marker between every character. A name may carry more than one value, so two customers' addresses in one long run are both withheld. A resumed run re-derives the bindings from the transcript its checkpoint carries, so a pause does not hand back an unprotected run. The limit is the ingress a name cannot reach: `AgentRuntime.run` takes a plain string, so a value that enters only through prose has no field name to match and is recorded as written. A document that runs an agent and declares no tool at all has nothing to bind to, and is refused with `unsupported-redact` rather than emitted with a guarantee nothing keeps; declaring the tool whose arguments carry those fields is the fix, and serving the same work through a pipeline is the alternative. The refusal covers the inherited set as well, since an omitted `redact` defaults to the names the security gate derives. `aid trace export` reads this set before it writes a dataset, and under `profile: enterprise` it refuses to export captured content while the set is empty -- a document that withholds nothing has said nothing about what may leave. It applies the same test to an agent document, where `feedback.pii.redact` is not a substitute: a set declared for stored signals says nothing about what a trace kept. |
| `export` | `otlp`, `none` | no | `none` records spans in-process only, which is what every document before 0.27 did. `otlp` declares that they should leave for an OTLP collector, and requires `endpointEnv`, because an export with no destination is a promise to nobody. One switch governs both signals: `otlp` opts traces and the cost/latency series in together, because a deployment that exported one and not the other could not be reasoned about from either side. Refused under `profile: enterprise` with `none`: an enterprise deployment that keeps no trace cannot answer the audit question the profile promises. Only a target that emits the exporter wiring accepts `otlp`; the rest refuse it rather than accept a destination nothing is sent to. |
| `endpointEnv` | `string` | no | The environment variable holding the collector's address. A name, never a URL: following `models.*.apiKeyEnv`, the address stays in the platform so a spec can move between environments without edit. The value is the collector's address, not one signal's path: the runtime appends `/v1/traces` or `/v1/metrics` as it sends, and strips a trailing signal path when the variable already carries one, so a single variable serves traces and metrics without the two disagreeing. Only meaningful with `export: otlp`, which the schema requires rather than defaulting. |
| `alerts` | array of object | no | The alarm policies `aid infra gen` turns into provider resources. Declarable from spec v0.30. An alert is the one observability declaration with an operational cost when it is wrong: an alarm over a series nothing produces reports no data forever, which reads as healthy. So the gate refuses an alert whose `metric` no derived series backs, whose `aggregate` cannot interpret its `metric`, and -- above all -- an alert in a document whose spans never leave the process, because a collector cannot derive from what it is never sent. The `metric` values are exactly the alarm hooks the deploy plan already derives from declared budgets, so a threshold here and a ceiling there name the same measurement. A series exists only where the generated runtime writes it: py-fastapi records `agent.cost`, `agent.tokens`, `eval.cost` and `eval.latency.p95`, and an alert over anything else is refused by `ir/alerts-unproduced` naming the target that would have written nothing. So is an alert in a document that never exports, however well the series is recorded. Declaring the export is still not the last step: the series appears when the entrypoint calls `metrics_export_status()`, and the entrypoint is the application's own file, so no gate can require that call. `aid doctor` reports it instead, as `cli/metrics-uninstalled`, when an alert is declared and no call is found. |
| `feedback` | object (fields below) | no | The signals the generated app accepts back from the people who use it, and the handling they require. Declarable from spec v0.28. A feedback signal is the input to the improvement loop, which is why it is declared here: `aid eval --compare` can turn two accepted baselines into a promotion decision, but nothing else in the build knows that a review comment is data about a person. `correction` stores free text by definition, so the feedback gate refuses one whose redaction set does not cover every field the spec already marks sensitive, or a persistent store that keeps it with no retention limit. |

### `observability.feedback`

The signals the generated app accepts back from the people who use it, and the handling they require. Declarable from spec v0.28. A feedback signal is the input to the improvement loop, which is why it is declared here: `aid eval --compare` can turn two accepted baselines into a promotion decision, but nothing else in the build knows that a review comment is data about a person. `correction` stores free text by definition, so the feedback gate refuses one whose redaction set does not cover every field the spec already marks sensitive, or a persistent store that keeps it with no retention limit.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `signals` | map of `feedbackSignal` | yes | The signals this app accepts, by name. One entry per endpoint the generator emits, so a reviewer reads the data surface rather than discovering it in code. |
| `pii` | object (fields below) | no | What must be stripped from a signal before it is stored. Omitted, this defaults to every field the security gate derives as sensitive, exactly as `redact` defaults for a trace; the feedback gate still refuses a declared set that drops one. No generated app stores or routes a signal yet, so the set is a statement the gate checks rather than a transform the runtime performs. |
| `retentionDays` | `integer` | no | How long a stored signal is kept. `0` means it is held no longer than the request that wrote it, which is the only value that lets a text-storing signal skip the redaction requirement. |
| `persistent` | `boolean` | no | Whether a signal outlives the process. Defaults to false. Declaring true without `retentionDays` is refused by the feedback gate, because keeping a record forever is not a policy a spec can leave unstated. |

#### `observability.feedback.pii`

What must be stripped from a signal before it is stored. Omitted, this defaults to every field the security gate derives as sensitive, exactly as `redact` defaults for a trace; the feedback gate still refuses a declared set that drops one. No generated app stores or routes a signal yet, so the set is a statement the gate checks rather than a transform the runtime performs.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `redact` | array of `string` | no | — |

## `feedbackSignal`

One signal the app accepts back from its users. The `kind` decides the shape, so a signal cannot claim to be a bare rating and then store prose: `thumbs` carries a score and no text, `correction` carries the corrected text the user supplied, and `escalation` carries the outcome of a handoff. Declarable from spec v0.28.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `thumbs`, `correction`, `escalation` | yes | What the signal records. `correction` is the only kind that stores free text, which is why it is the only kind the PII rule applies to. |
| `description` | `string` | no | What this signal means and who reads it. Free text for a reviewer; it is not emitted into the app. |

## `image`

Where the image for a `target: container` deployment is published. `ghcr.io` needs no credential: a generated release workflow pushes there with the `GITHUB_TOKEN` it already has. Every other registry declares the fields its login reads -- `docker.io` (spec 0.16) the *names* of two repository secrets, `aws.ecr` (spec 0.17) the account, region and role the workflow federates with, and `gcp.artifact-registry` (spec 0.18) the project, region and Workload Identity pair. No credential value is ever written into the spec.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `registry` | `ghcr.io`, `docker.io`, `aws.ecr`, `gcp.artifact-registry` | yes | The registry to publish to. Each has its own credential path: `ghcr.io` uses the workflow token; `docker.io` uses the two secrets below; `aws.ecr` and `gcp.artifact-registry` exchange the run's OIDC identity for a short-lived cloud credential. |
| `name` | `string` | yes | Repository path under the registry, without the host, e.g. `acme/support-copilot`. Lowercase, because a registry rejects the alternative. On `gcp.artifact-registry` the project is prefixed to it when the image reference is emitted. |
| `usernameSecret` | `string` | no | Repository secret holding the account name. Required on `docker.io`, refused elsewhere: a registry that logs in with the workflow token or a federated cloud identity has no stored account. |
| `tokenSecret` | `string` | no | Repository secret holding the access token. Required on `docker.io`, refused elsewhere, for the same reason. |
| `accountId` | `string` | no | The AWS account that owns the repository. Required on `aws.ecr`, refused elsewhere. The registry host is derived from it and `region`, so it is never written twice. |
| `region` | `string` | no | The region the registry lives in. Required on `aws.ecr` and `gcp.artifact-registry`, refused elsewhere: `us-east-1` for ECR, `us-central1` for Artifact Registry. |
| `roleArn` | `string` | no | The IAM role the release workflow assumes through GitHub's OIDC provider. Required on `aws.ecr`, refused elsewhere. A role ARN is an identifier, not a credential: nothing is assumed until the workflow exchanges its OIDC token for it. |
| `project` | `string` | no | The Google Cloud project that owns the repository. Required on `gcp.artifact-registry`, refused elsewhere; the emitted repository path is `&lt;project&gt;/&lt;name&gt;`. |
| `workloadIdentityProvider` | `string` | no | The Workload Identity Provider the release workflow federates with. Required on `gcp.artifact-registry`, refused elsewhere. |
| `serviceAccount` | `string` | no | The service account the federated identity impersonates. Required on `gcp.artifact-registry`, refused elsewhere. |

## `overridableRule`

How far an overlay may move one path. `true` accepts any value. `from` accepts only one of the listed values. `max` accepts a number no greater than the bound. `allowWeaken` is a separate, explicit permission: without it, an override that relaxes a control at this path is refused, whichever form the value takes. Removing a `gate.ci` eval is refused under every form, including `allowWeaken`.

An `overridableRule` is exactly one of the 4 forms below.

### `true`

Any value of the right type is accepted at this path.

### `from`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | array of any | yes | The values this path may be set to. A closed set: a value outside it is refused even when `allowWeaken` is set. |
| `allowWeaken` | `allowWeaken` | no | — |

### `max`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `max` | `number` | yes | The largest number this path may be set to. A ceiling: a larger value is refused even when `allowWeaken` is set. |
| `allowWeaken` | `allowWeaken` | no | — |

### `allowWeaken`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `allowWeaken` | `allowWeaken` | yes | — |

---

This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.

Next: [write a spec](../guide/writing-a-spec.md) or read the [CLI reference](./cli.md).
