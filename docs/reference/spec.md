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
| `specVersion` | `0.1`, `0.2`, `0.3`, `0.4`, `0.5`, `0.6`, `0.7`, `0.8`, `0.9`, `0.10`, `0.11`, `0.12`, `0.13`, `0.14` | Spec language version. 0.1 is the original surface; 0.2 adds the closed `agents`, `guardrails`, `memory` and `deployments` sections; 0.3 adds the `models[].cache` construct (prompt and semantic caching); 0.4 adds `deployments[].image`, the registry and repository a container image is published to; 0.5 adds `pipelines[].trigger.manual` and `deployments[].pipeline`, the pair that lets a `target: batch` deployment run one pipeline once to completion; 0.6 adds the `google` provider (Vertex AI) and the `decisions` section (TypeSafe AI Jev); 0.7 lets a `guardrails` entry name a decision (`decision` + `onDecision`). 0.8 adds the `decision` metric kind, which scores an eval prediction with a `score` decision. 0.9 adds the `route` pipeline step, which runs the arm a `choice` decision's answer names. 0.10 adds the `gemini` provider, which calls the Gemini API with an API key instead of Google Cloud credentials. 0.11 adds `guardrails[].engine` and the `bedrock` policy block, which move a guardrail's policy into a managed AWS Bedrock guardrail. 0.12 adds `knowledgeBases` and `retrievers[].knowledgeBase`, which bind a retriever to a managed knowledge base (Bedrock Knowledge Bases or Vertex AI RAG) instead of a local source, chunker, embedder and store. 0.13 adds `deployments[].runtime`, which moves a `container` service onto a managed agent runtime (Amazon Bedrock AgentCore or the Gemini Enterprise Agent Platform) instead of a compute module AID keeps warm. 0.14 adds `engine: model-armor`, which hands a guardrail's policy to Vertex AI Model Armor, the Google Cloud counterpart to a managed Bedrock guardrail. A section or construct that needs a later version is reported as `spec/not-supported` with the version it needs, rather than as an unknown key. |
| `project` | `project` | — |
| `types` | map of `typeDef` | Named structured types referenced by prompts (structured output) and tools (input/output). |
| `models` | map of `model` | Model aliases. The alias is what the rest of the spec refers to; the vendor id is pinned here and only here. |
| `prompts` | map of `prompt` | — |
| `tools` | map of `tool` | — |
| `stores` | map of `store` | Vector store instances. `kind: memory` is the fully supported default and needs no service; `kind: pgvector` is declarable here and its adapter ships with the retrieval runtime. |
| `retrievers` | map of `retriever` | Retrievers: what to index, how to chunk it, which embedding model and store to use, and how to rank. |
| `knowledgeBases` | map of `knowledgeBase` | Managed knowledge bases: a source, chunker, embedding pass, store and index the cloud owns, referenced by a retriever's `knowledgeBase`. Declarable from spec v0.12. A managed knowledge base is a retriever, not a pipeline: the runtime still retrieves chunks and generates the answer, so the cost gate, the evals and the trace keep covering the generation path. |
| `agents` | map of `agent` | Agents: a model, instructions, the tools and retrievers it may use, and the budget it may spend. Declarable from spec v0.2; a target that emits no agent route is rejected by the capability gate rather than silently generating one. |
| `guardrails` | map of `guardrail` | Guardrails: the stages a check runs at, the policies it evaluates, and what happens when one fails. Declarable from spec v0.2. The runtime evaluates them, and `py-fastapi` emits the wiring; a guardrail declared here applies to every pipeline route of the document, not to the one that named it. |
| `decisions` | map of `decision` | Decision points answered by TypeSafe AI Jev: a named question with its own reply shape, referenced by guardrails, routers and evals. Declarable from spec v0.6. A decision is not a provider, because Jev has no chat surface: it returns a typed answer rather than text. `choice` and `score` require `criteria`; `noul` forbids it. A pinned model version is the reproducible choice; an eval reference refuses a moving alias, while interactive routing may use one. |
| `memory` | map of `memory` | Memory tiers: what is remembered, for how long, within what token budget, and where it lives. Declarable from spec v0.2; the kinds a target cannot serve are refused by its plan gate rather than approximated. |
| `deployments` | map of `deployment` | Deployment intents: the target shape, the transport it assumes, and the secrets it needs. Declarable from spec v0.2. `streaming: true` derives a `streaming` requirement; `py-fastapi` declares that capability and answers an `Accept: text/event-stream` request with SSE frames, while `ts-vercel` declares nothing and the deploy gate still rejects it there. |
| `evals` | map of `eval` | — |
| `pipelines` | map of `pipeline` | — |

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
| `params` | object | no | — |
| `fallbacks` | array of `name` | no | Ordered model aliases to fail over to. Simple alias failover only; no routing policy in Phase 0. |
| `costProfile` | `string` | no | Name of a priced entry in the pinned model catalog. Omit to resolve it from the catalog by modelId. |
| `limits` | object | no | — |
| `baseUrl` | `string` | no | Required for openai-compatible. Never a credential. |
| `apiKeyEnv` | `string` | no | — |
| `cache` | object | no | Model caching, declarable from spec v0.3. `prompt` is the exact-match layer (model, prompt, tool schema and temperature); `semantic` is the opt-in fuzzy layer and carries its own threshold and TTL so there is no silent default. |
| `description` | `string` | no | — |

## `prompt`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `integer` | yes | Bumped by hand when the template changes. The prompt identity includes it (prompt:&lt;name&gt;@&lt;version&gt;) so a revision does not move the IR node id. |
| `model` | `name` | yes | — |
| `template` | `string` | yes | Mustache-style text. Placeholders are &#123;&#123;variable&#125;&#125; references and are checked by the parser for well-formedness; whether each one resolves is a build-time IR gate, not a schema concern. |
| `variables` | map of `variable` | no | — |
| `output` | object | yes | — |

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
| `handler` | object | yes | Where the implementation lives. `business` means a user-owned module, so the generated code imports it rather than inlining logic. |
| `timeoutMs` | `integer` | no | — |
| `retries` | `integer` | no | — |
| `idempotency` | `none`, `key`, `natural` | no | — |
| `auth` | `string` | no | PolicyExpr source. Parsed once, on the TypeScript side, into a JSON AST that the runtime interprets; the string form never reaches a runtime. |

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
| `chunking` | object | yes | How the managed engine splits documents. The engine performs the split, so this is configured on the knowledge base rather than performed by the runtime. |
| `embedModel` | `name` | yes | Model alias that must declare `embeddings`, and whose provider must belong to the same cloud as `engine`. The knowledge base owns the vector store, so this replaces the store-width gate rather than being exempt from it. |
| `filterable` | array of `name` | no | Metadata keys the filter contract may use. Bedrock sources need metadata sidecar files for a filter to match anything, so this is what makes the emitter write the sidecar convention instead of a filter that silently matches nothing. |
| `vectorStore` | object | no | Where the engine keeps vectors. `provisioned` (the default) has the module create one; `existing` points at a store the operator already pays for and requires `arn`. The plan's default is not OpenSearch Serverless: its two-OCU floor is the most common way this feature becomes a surprise bill. |

## `retriever`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `knowledgeBase` | `name` | no | Bind this retriever to a managed knowledge base. It replaces `source`, `chunking`, `embedModel`, `store` and `index` -- declaring one of those beside it is ambiguous and refused rather than silently preferred. |
| `source` | object | no | — |
| `chunking` | object | no | — |
| `embedModel` | `name` | no | Model alias that must declare the `embeddings` capability; the referential gate enforces that. |
| `store` | `name` | no | — |
| `index` | object | no | — |
| `topK` | `integer` | yes | Candidates the retriever returns per query. This is the retriever's value; Phase 1 has no step-level override. |
| `rerank` | object | no | — |
| `filters` | array of `string` | no | Reserved: the expression form is not implemented in Phase 1, so a spec-local rule rejects it rather than accepting a filter nothing applies. |
| `refresh` | object | no | — |
| `traits` | array of `citations` | no | Behavioural traits the generated retrieval path must honour. `citations` means retrieved items carry the source path and offsets a generated answer can cite. |

## `eval`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | `string` | yes | Only pipelines are evaluable in Phase 0. |
| `dataset` | object | yes | — |
| `metrics` | array of `metric` | yes | — |
| `gate` | object | no | How this eval's result is compared against the committed baseline. Never an equality check: sampling noise is expected, so the gate is a threshold on the regression relative to the baseline. |
| `description` | `string` | no | — |

## `metric`

A `metric` is exactly one of the 10 forms below; each form is recognised by its discriminating key.

### `kind` = `exact`

Takes the value `"exact"` and no other keys.

### `kind` = `contains`

Takes the value `"contains"` and no other keys.

### `kind` = `json-schema`

Takes the value `"json-schema"` and no other keys.

### `kind` = `tool-trace`

Takes the value `"tool-trace"` and no other keys.

### `kind` = `cost`

Takes the value `"cost"` and no other keys.

### `kind` = `latency`

Takes the value `"latency"` and no other keys.

### `kind` = `llm-judge`

Allowed in the spec but rejected by a spec-local rule when gate.ci is true: a judging model is neither deterministic nor available offline, so it can never be part of the CI gate.

Takes the value `"llm-judge"` and no other keys.

### `kind` = `retrieval`

Deterministic and offline: it compares the ranking against known-correct source paths, so unlike llm-judge it is allowed under gate.ci.

Takes the value `"retrieval"` and no other keys.

### `kind` = `assert`

Deterministic and offline: a closed predicate evaluated against the prediction and the case, so unlike llm-judge it is allowed under gate.ci. Needs `gate.minMean: 1.0`, which a spec-local rule enforces.

Takes the value `"assert"` and no other keys.

### `kind` = `decision`

Scores a prediction with a `score` decision: the rubric is declared once in `decisions` and the answer's position becomes the metric. Not deterministic, so a spec-local rule rejects it under gate.ci.

Takes the value `"decision"` and no other keys.

## `pipeline`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | no | — |
| `trigger` | one of 2 | yes | How the pipeline starts. `http` mounts a route; `manual` starts nothing on its own and exists so a `target: batch` deployment can run the pipeline once to completion. Exactly one of the two is declared. |
| `steps` | array of `step` | yes | — |

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
| `tool` | `name` | yes | — |
| `input` | `stepInput` | no | — |
| `as` | `binding` | yes | — |

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
| `agent` | `name` | yes | — |
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
| `humanInTheLoop` | object | no | — |

## `decision`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `"typesafe"` | yes | The decision vendor. Closed: `typesafe` is the only one the runtime serves. |
| `model` | `string` | yes | A pinned Jev version such as `jev-1.14.0`. Moving aliases (`jev-latest`, `jev-preview`) are refused inside `evals`, where a score must be reproducible. |
| `type` | `choice`, `score`, `noul` | yes | — |
| `instructions` | `string` | yes | The question, in one sentence. Not a prompt template: Jev does not carry a conversation. |
| `criteria` | one of 2 | no | — |
| `onError` | `allow`, `block` | no | What a failed call means. `block` (the default) keeps a gate closed when the vendor is unreachable; `allow` keeps an advisory check from stopping traffic. |
| `description` | `string` | no | — |

## `guardrail`

A check at one stage. A guardrail is either a policy check (`policies` + `action`) or a decision-backed check (`decision` + `onDecision`); it may declare both, and the policy check runs first.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stages` | array of `input`, `output`, `retrieval`, `tool-call` | yes | — |
| `policies` | array of `pii-detect`, `pii-redact`, `prompt-injection`, `jailbreak`, `moderation`, `toxicity`, `secret-scan` | no | Closed policy vocabulary; a name the guardrails engine does not implement is rejected at the spec layer, never passed through. |
| `action` | `block`, `redact`, `flag`, `escalate` | no | — |
| `engine` | `builtin`, `bedrock`, `model-armor` | no | Who evaluates the declaration. `builtin` (the default) is the runtime's offline detector layer; `bedrock` is a managed AWS Bedrock guardrail; `model-armor` (spec 0.14) is a Vertex AI Model Armor template in Google Cloud. An engine is a location for the policy, not a policy itself, so a managed guardrail carries no `policies`. |
| `bedrock` | object | no | The managed policy a `bedrock`-engine guardrail owns, rendered into the deployment as an `aws_bedrock_guardrail`. Omit the block to point the app at a guardrail the operator already owns, through `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION`. Account ids and ARNs are never spec inputs. |
| `decision` | `name` | no | A `choice` decision to ask before the stage runs. Only the `input` stage may carry one, and the name must be declared under `decisions` (spec 0.7). |
| `onDecision` | map of `allow`, `block`, `flag`, `escalate` | no | What each answer label means. `allow` lets the run continue; the others record that action. Every label the decision declares must appear here, and no other label may (checked by the spec gate, which knows the criteria). |
| `minConfidence` | `number` | no | The lowest answer confidence this guardrail accepts. A less confident answer counts as a failed check and fails closed as a block. Defaults to 0. |
| `redact` | array of `string` | no | Field names the `redact` action removes. Required when `action: redact`, which the guardrails gate enforces. |
| `tools` | array of `name` | no | Tools this guardrail covers. Absent or empty means every tool that reaches the stage. |
| `onFail` | object | yes | — |

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
| `autoscale` | object | no | — |
| `secrets` | array of `string` | yes | — |
| `image` | `image` | no | Where the image is published. Spec 0.4, and only on a `target: container` deployment: another target builds no image to publish. |
| `pipeline` | `name` | no | The pipeline this job runs, by id. Spec 0.5, and only on a `target: batch` deployment: a run-to-completion job exists to run exactly one pipeline once, and a target that answers requests runs whichever pipeline its route names. The pipeline must declare `trigger.manual`. |
| `runtime` | `runtime` | no | The managed agent runtime the process runs on. Spec 0.13, and only on a `target: container` deployment: the platform schedules, isolates and addresses the process, so the compute module is replaced rather than paired with it. The spec must declare exactly one HTTP route, because the platform's invocation route carries one request shape. The app is unchanged: the generated contract wrapper mounts the same ASGI app and route handlers, so the cost ceiling, trace span, eval hook and refusals stay on the invocation path. |
| `env` | array of object | no | — |

## `runtime`

A managed agent runtime: a service that stops being a container the operator keeps warm and becomes an agent the platform schedules, isolates and addresses. `aws-agentcore` is Amazon Bedrock AgentCore Runtime, one microVM per session with up to 8 hours; `gcp-agent-platform` is the Gemini Enterprise Agent Platform (formerly Vertex AI Agent Engine, still `google_vertex_ai_reasoning_engine` in Terraform), a managed per-session runtime. Both accept the image `target: container` already builds, which is what makes this a deployment destination rather than a second generation path. AgentCore Memory is the only memory resource with a Terraform representation in v1, so `memory` is refused on the Google platform rather than silently dropped. `session.ttlMinutes` defaults to 480, the AgentCore microVM ceiling; the Google platform accepts up to 20160 (14 days).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `aws-agentcore`, `gcp-agent-platform` | yes | The platform that runs the process. The platform's credentials are the deploy's credentials, so a platform and `--cloud` that disagree are refused instead of deployed unreachable. |
| `memory` | object | no | AgentCore Memory. Short-term events are the session transcript; long-term memory is deliberately absent until the spec has a construct that names what is stored and who may read it. |
| `session` | object | no | How long one session may live. Defaults to 480 minutes, the AgentCore microVM ceiling. |

## `image`

Where the image for a `target: container` deployment is published. Only GitHub Container Registry is accepted: a generated release workflow can push there with the `GITHUB_TOKEN` it already has, while every other registry needs a credential the spec cannot hold without inventing one.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `registry` | `ghcr.io` | yes | The registry host. `ghcr.io` only, for the reason above. |
| `name` | `string` | yes | Repository path under the registry, without the host, e.g. `acme/support-copilot`. Lowercase, because a registry rejects the alternative. |

---

This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.

Next: [write a spec](../guide/writing-a-spec.md) or read the [CLI reference](./cli.md).
