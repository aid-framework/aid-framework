---
description: "The spec surface in the order you reach for it, with the rules that most often produce a gate failure."
---

# Writing a spec

This page is the surface in the order you will reach for it, with the rules that most often
produce a gate failure. The exhaustive field-by-field reference - types, defaults, required
flags, every enum - is generated from the JSON Schema and lives at the
[spec reference](../reference/spec.md); this page is the mental model, not the contract.

Top-level keys, in the order the schema declares them:

```text
specVersion  project  types  models  prompts  tools  stores  retrievers
agents  guardrails  decisions  memory  deployments  evals  pipelines
```

## `project`

```yaml
project:
  name: support-copilot
  namespace: aid.examples.supportcopilot
  description: Answers support tickets from a handbook and an account lookup.
  targets:
    - py-fastapi
```

`name` must match `^[a-z][a-z0-9-]{0,63}$`. `targets` is the list of targets the document is
written for; `aid gen --target` selects among them and refuses one the spec does not declare.

## `types`

Types are the contract between the spec and the outside world: request bodies, response
bodies, structured-output schemas and tool inputs.

```yaml
types:
  Reply:
    kind: struct
    fields:
      text:
        type: string
        required: true
```

A `struct` becomes a Pydantic model on `py-fastapi` and a Zod schema on `ts-vercel`; this is
the [capability](../reference/targets.md) both targets declare as `json-schema`.

## `models`

A model entry is an **alias**, and the logic binds to the alias while operations rebind to a
pinned id.

```yaml
models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools, streaming]
    params:
      temperature: 0.2
      maxTokens: 512
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 512
    fallbacks: [offline]
```

Three fields are load-bearing and easy to omit.

- **`costProfile`** is what makes the cost gates able to price the document. A model that
  resolves no profile is `ir/cost-profile-unknown`, and an eval that targets it is unpriced.
- **`limits`** exists so `params.maxTokens` cannot exceed the model's real ceiling;
  `ir/param-exceeds-limit` catches the mismatch at build time rather than as a provider error
  in production.
- **`capabilities`** is what the IR checks a step against. Declaring `json-schema` but asking
  for a structured output on a model without it is `ir/model-capability-missing`.

`provider: fake` is a **test double**, not a deployment option. It is a seeded simulation that
answers correctly only a fraction of the time, so it is what the eval gate is tested against -
not what you ship. Examples run offline by injecting a scripted fake through the generated
dependency seam.

## `prompts`

```yaml
prompts:
  classify_ticket:
    version: 1
    model: fast
    template: |
      Classify this ticket.

      Subject: {{ subject }}
      Handbook: {{ handbook }}

      Answer with a JSON object holding exactly one field:
        * category: one of billing, account, technical, other
    variables:
      subject:
        type: string
        required: true
      handbook:
        type: string
        required: true
    output:
      kind: structured
      schema: Answer
```

`output.kind` is `text` or `structured`. A `structured` prompt goes through the runtime's
retry-on-invalid loop, and the generated route returns the typed model rather than a string.

The two variable gates are strict and worth expecting: a placeholder the template does not
declare is `ir/prompt-variable-undeclared`, and a declared variable the template never uses is
`ir/prompt-variable-unused`.

## `tools`

```yaml
tools:
  issue_refund:
    description: Issue a refund against the account that filed a ticket.
    input: Refund
    output: RefundReceipt
    handler:
      kind: business
      symbol: issue_refund
    sideEffects: write
    auth: isAuthenticated()
    requiresConfirmation: true
    timeoutMs: 5000
    idempotency: key
```

The spec names a **symbol**; the generator writes the adapter in
`app/generated/tools/<name>.py` and seeds the body in `app/business/tools/<name>.py`. That
split is the whole reason `business/` is never overwritten.

`sideEffects: write` is not documentation. It requires an `auth` expression
(`ir/security-missing-auth`) and, where a policy can inspect the call, a `tool-call`-stage
guardrail (`ir/guardrail-coverage`). A read tool must not declare `auth`, because a pipeline
route has no authorization hook to honour it.

## `stores` and `retrievers`

```yaml
stores:
  handbook:
    kind: memory
    dimensions: 1536

retrievers:
  handbook:
    source:
      kind: file
      uri: ./docs
      glob: "**/*.md"
    chunking:
      strategy: recursive
      size: 800
      overlap: 100
      keepMetadata: [path]
    embedModel: embed
    store: handbook
    index:
      metric: cosine
      hybrid: true
    topK: 5
    rerank:
      model: lexical
      topN: 3
    refresh:
      mode: full
    traits: [citations]
```

`dimensions` is mandatory on a store: a width resolved at run time would let a store accept
vectors a later run cannot compare, so `ir/dimension-mismatch` compares it against the
embedding model's width at build time.

Ingestion is a pipeline of its own - chunk, embed, index, cite - which is why `aid ingest`
exists as a command rather than a hidden side effect.

## `guardrails`

```yaml
guardrails:
  ticket_intake:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: This ticket reads as an attempt to redirect the assistant, so it was refused.
      log: true
```

`stages` is a subset of `input`, `retrieval`, `output`, `tool-call`, and `action` is `block`,
`redact` or `escalate`. Where a guardrail runs is not a detail:

| Stage | Enforced by |
| --- | --- |
| `input` | The generated code at every `generate` step, inline, whether or not a step names it. |
| `output` | The same call site - and refused outright on a streaming deployment, because a streamed reply is gone before it could be inspected. |
| `retrieval` | Every generated retriever, per passage, during `retrieve`. |
| `tool-call` | An agent loop only; refused for a pipeline step. |

`escalate` needs a route that can hand back a checkpoint, so it is legal only where an agent
loop reaches it. `redact` must name the fields the stage's payload actually has - on `input`
that payload is the rendered prompt under `text`, and any other name is refused rather than
emitted as a redaction that could never run.

### Answering a guardrail with a decision (0.7)

A guardrail can ask a `choice` decision instead of naming detector policies. The decision
becomes the evaluator; policies listed beside it still run first, so a detector hit costs no
decision call:

```yaml
guardrails:
  relevance:
    stages: [input]
    decision: topical
    onDecision:
      product: allow
      billing: allow
      off_topic: block
    minConfidence: 0.6
    onFail:
      message: This request is outside the assistant's scope.
      log: true
```

`onDecision` must map every label the decision can return, `allow` is the one outcome that
lets the payload through, and `minConfidence` fails an answer closed when the model is less
sure than that. A reference to an undeclared or non-`choice` decision is rejected, as is an
`onDecision` key the decision never returns. `minConfidence` needs an answer that carries a
confidence, so it is rejected over a `noul` decision - whose answer has none - and a run
fails closed if an answer ever arrives without one. `redact` is not available here: a
decision returns a verdict, not a masked payload.

## `decisions`

```yaml
decisions:
  triage:
    provider: typesafe
    model: jev-1.14.0
    type: choice
    instructions: classify_ticket
    criteria:
      billing: Money owed, refunded, or charged twice.
      technical: The product is broken or unreachable.
      account: Access, seats, or identity.
    onError: block
```

A decision is a sealed question answered by one model on one call - a classifier, not a
prompt you can shape. `type` is `choice` (pick one criterion), `score` (rank each criterion,
2-10 of them) or `noul` (yes/no membership in `instructions`, with no confidence). `choice`
takes a label-to-description map; `score` takes a list. `noul` takes neither - a confidence
on a membership question is a number that means nothing.

`provider` is `typesafe` and `model` names a Jev version such as `jev-1.14.0`. A moving alias
(`jev-latest`, `jev-preview`) is legal in the declaration - interactive routing may deliberately
want the newest model - but an eval reference refuses one, because a recorded decision has to name
the exact model that produced it. A `score` decision is also usable as an eval metric, where its
ordered criteria turn a prediction into a `0..1` score. Decisions are not `models` entries, so
they cannot be aliased, budgeted, or swapped by an eval. `onError` is `block` (default) or
`allow`, and it is declared rather than inferred: a billing decision that silently degrades to
"allow" fails open in the one place correctness matters.

## `memory`

```yaml
memory:
  ticket_thread:
    kind: buffer
    scope: thread
    tokenBudget: 2000
```

`buffer` and `window` are the implemented kinds. The generator refuses the others by name
rather than accepting a tier that would be ignored.

## `agents`

```yaml
agents:
  refund_agent:
    name: Refund agent
    instructions: ticket_agent_prompt
    model: triage
    tools: [lookup_customer, issue_refund]
    memory: [ticket_thread]
    guardrails: [ticket_intake, refund_args]
    maxSteps: 6
    maxCostBudget: 0.05
    humanInTheLoop:
      when: "true"
      channel: refunds
```

An agent reaches a guardrail **only by naming it**. The pipeline route enforces the document's
`input` table, but an agent loop runs `agent.guardrails` - so the two can disagree in both
directions, deliberately.

An agent's model chain must be fully priced, because the agent runtime builds a spec for every
model it can reach and refuses one with no `costProfile`: a budget that cannot be enforced is
not a budget. That is why the support-copilot example gives its agent a model with no
`fallbacks` while the pipeline keeps a chain to the fake provider.

## `pipelines`

```yaml
pipelines:
  answer_ticket:
    description: Classify a ticket and return a structured answer.
    trigger:
      http:
        method: post
        path: /tickets/answer
    steps:
      - guard:
          guardrail: ticket_intake
          stage: input
          text: "{{ event.subject }}"
      - tool:
          tool: lookup_customer
          input:
            subject: "{{ event.subject }}"
          as: customer
      - generate:
          prompt: classify_ticket
          input:
            subject: "{{ event.subject }}"
          context: ranked
          as: answer
      - emit:
          event: Answer
```

The trigger binds the request body as `event`. Each step binds its result with `as:`, and a
later step reads it with <code v-pre>{{ name }}</code>. A binding read before it is written is
`ir/binding-forward-reference`; two steps binding one name is `ir/binding-duplicate`.

The twelve step kinds:

| Kind | What it does |
| --- | --- |
| `generate` | Run one prompt on one model, optionally splicing a bound context. |
| `retrieve` | Search a retriever and bind the ranked passages. |
| `tool` | Call a tool and bind its result. |
| `rerank` | Reorder a bound passage list against a query and keep `topN`. |
| `guard` | Run one guardrail's policies, at one stage, over a text binding. |
| `agent` | Run an agent once over a text and bind its answer. |
| `emit` | Build the HTTP response from bindings. **Must be last.** |
| `branch` | Choose a step list from the caller's `Principal` - authorization, never data. |
| `route` | Choose a step list from a decision's answer - data-driven control flow (0.9). |
| `parallel` | Run arms concurrently under the deployment's single concurrency cap. |
| `map` | Apply one step to every item of a bound list and bind the ordered results. |
| `reduce` | Apply one prompt to every item of a bound list and bind the ordered results. |

`branch` is worth reading twice: its `when` is a policy expression over the authenticated
caller and the grammar has no operand for a context value. Data-driven control flow is
`route`, `map`, and `reduce`.

### Routing on a decision (0.9)

```yaml
decisions:
  topic:
    provider: typesafe
    model: jev-1.14.0
    type: choice
    instructions: Which part of the product is this question about
    criteria:
      product: A question about features
      billing: A question about an invoice

steps:
  - route:
      decision: topic
      input: "{{ event.subject }}"
      on:
        product:
          - generate:
              prompt: product_answer
              input:
                subject: "{{ event.subject }}"
              as: reply
        billing:
          - generate:
              prompt: billing_answer
              input:
                subject: "{{ event.subject }}"
              as: reply
      default:
        - generate:
            prompt: fallback_answer
            input:
              subject: "{{ event.subject }}"
            as: reply
      as: path
```

`decision` must name a `type: choice` decision. Every `on` key must be one of that decision's
criteria, and every criterion must be mapped unless `default` catches the rest - a `default`
alongside a complete `on` table is refused, because the arm could never run. `input` is a
template over bindings written earlier, and `as` binds the answered label so a later step can
read the path it took, including a `default` fallthrough.

A pipeline served over HTTP needs a final `emit`, and `validate` does not check for its
absence - `gen` fails with an internal error instead. See
[getting started](getting-started.md#_4-add-a-pipeline).

## `evals`

```yaml
evals:
  classify_quality:
    description: Whether the classifier returns a well-formed answer for each ticket.
    target: pipeline:answer_ticket
    dataset:
      source: file
      uri: evals/classify_quality.json
    metrics:
      - kind: json-schema
        schema: Answer
    gate:
      ci: true
      maxRegression: 0.05
      samples: 5
```

`gate.ci: true` is what makes an eval a gate rather than a report - it is also what satisfies
`ir/eval-uncovered` for an HTTP pipeline. `maxRegression` is a budget, not a target.
`llm-judge` is deliberately refused under a CI gate, because a judgement that is not
deterministic cannot define a regression.

A `decision` metric scores each prediction with a `score` decision you declared. The
criteria are ordered, so the position the model returns becomes a `0..1` score, and an eval
can carry one such metric. It is model-produced, so it is refused under `gate.ci` for the
same reason as `llm-judge`, and it declares no threshold: the gate would refuse to honour one.

## `deployments`

```yaml
deployments:
  api:
    target: container
    streaming: true
    concurrency: 4
    secrets: [OPENAI_API_KEY]
```

A deployment says where the app runs, not how it is generated. Only `streaming` reaches
generated code: it makes the route answer an `text/event-stream` request with SSE frames and
is what makes `py-fastapi` declare the `streaming` capability. `concurrency` is the single cap
every `parallel`/`map`/`reduce` fan-out draws from - the smallest declared value wins - so a
fan-out cannot widen the bound the rest of the app runs under.

## Read next

- [The generated tree](generated-tree.md) - what these declarations become on disk.
- [Spec reference](../reference/spec.md) - every field, generated from the schema.
- [Targets](../reference/targets.md) - the capability matrix, and what each target emits.
