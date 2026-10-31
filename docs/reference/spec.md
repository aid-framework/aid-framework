---
description: "Every spec key, type and constraint, generated from the JSON Schema that aid validate enforces."
---

# Spec reference

Every key, type, and constraint below is read from `packages/spec/src/schema/spec.schema.json`, the schema `aid validate` enforces. A `required` column of `yes` means `aid validate` rejects a spec that omits the key.

Spec schema title: *AID Framework spec v0.3*.

**Required at the top level:** `specVersion`, `project`.

## Top-level keys

| Key | Type | Description |
| --- | --- | --- |
| `specVersion` | `0.1`, `0.2`, `0.3` | Spec language version. 0.1 is the original surface; 0.2 adds the closed `agents`, `guardrails`, `memory` and `deployments` sections; 0.3 adds the `models[].cache` construct (prompt and semantic caching). A section or construct that needs a later version is reported as `spec/not-supported` with the version it needs, rather than as an unknown key. |
| `project` | `project` | — |
| `types` | map of `typeDef` | Named structured types referenced by prompts (structured output) and tools (input/output). |
| `models` | map of `model` | Model aliases. The alias is what the rest of the spec refers to; the vendor id is pinned here and only here. |
| `prompts` | map of `prompt` | — |
| `tools` | map of `tool` | — |
| `stores` | map of `store` | Vector store instances. `kind: memory` is the fully supported default and needs no service; `kind: pgvector` is declarable here and its adapter ships with the retrieval runtime. |
| `retrievers` | map of `retriever` | Retrievers: what to index, how to chunk it, which embedding model and store to use, and how to rank. |
| `agents` | map of `agent` | Agents: a model, instructions, the tools and retrievers it may use, and the budget it may spend. Declarable from spec v0.2; a target that emits no agent route is rejected by the capability gate rather than silently generating one. |
| `guardrails` | map of `guardrail` | Guardrails: the stages a check runs at, the policies it evaluates, and what happens when one fails. Declarable from spec v0.2. The runtime evaluates them, and `py-fastapi` emits the wiring; a guardrail declared here applies to every pipeline route of the document, not to the one that named it. |
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
| `provider` | `openai`, `openai-compatible`, `fake` | yes | The Phase 0 provider set. `fake` is deterministic and keyless, which is what lets the eval gate run offline in CI. |
| `modelId` | `string` | yes | Pinned vendor model id. Never an alias or a moving target: the resolved id is recorded in the IR so a run is reproducible. |
| `capabilities` | array of `json-schema`, `tools`, `streaming`, `embeddings` | no | Declared model capabilities. json-schema is negotiated within a prompt (a structured-output prompt must bind a model that declares it) and embeddings within a retriever (a retriever's embedModel must declare it); the others are recorded in the IR for the capability gate to use in later phases. |
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

## `retriever`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | object | yes | — |
| `chunking` | object | yes | — |
| `embedModel` | `name` | yes | Model alias that must declare the `embeddings` capability; the referential gate enforces that. |
| `store` | `name` | yes | — |
| `index` | object | yes | — |
| `topK` | `integer` | yes | Candidates the retriever returns per query. This is the retriever's value; Phase 1 has no step-level override. |
| `rerank` | object | no | — |
| `filters` | array of `string` | no | Reserved: the expression form is not implemented in Phase 1, so a spec-local rule rejects it rather than accepting a filter nothing applies. |
| `refresh` | object | yes | — |
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

A `metric` is exactly one of the 9 forms below; each form is recognised by its discriminating key.

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

## `pipeline`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | no | — |
| `trigger` | object | yes | — |
| `steps` | array of `step` | yes | — |

## `step`

A `step` is exactly one of the 11 forms below; each form is recognised by its discriminating key.

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

## `guardrail`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stages` | array of `input`, `output`, `retrieval`, `tool-call` | yes | — |
| `policies` | array of `pii-detect`, `pii-redact`, `prompt-injection`, `jailbreak`, `moderation`, `toxicity`, `secret-scan` | yes | Closed policy vocabulary; a name the guardrails engine does not implement is rejected at the spec layer, never passed through. |
| `action` | `block`, `redact`, `flag`, `escalate` | yes | — |
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
| `env` | array of object | no | — |

---

This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.

Next: [write a spec](../guide/writing-a-spec.md) or read the [CLI reference](./cli.md).
