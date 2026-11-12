---
description: "One worked example per capability family: the spec fragment, the files it generates, and the refusal that proves the capability is enforced rather than advertised."
---

# Usage, by capability

[Features](features.md) says what ships. This page says how to use it: for each capability
family, the spec fragment you write, the files `aid gen` and `aid infra` produce from it, and
the refusal that fires when the fragment is wrong.

Every example is a fragment, not a whole spec. Each one is drawn from a spec in
`examples/`, so the shapes below are the shapes the compiler accepts today.

## Models, embeddings and cost

<!-- capability-family: models -->

One alias per role, and the alias is what the rest of the spec names. The pinned `modelId`
is what the generated gateway calls; `capabilities` is what the IR is allowed to promise.

```yaml
models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools, streaming]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 512
  embed:
    provider: gemini
    modelId: gemini-embedding-001
    apiKeyEnv: GEMINI_API_KEY
    capabilities: [embeddings]
```

`capabilities: [embeddings]` is what makes a model an embedding model: the IR has no
`embeddings` section, an entry exists per model that declares it, and the store that
consumes it declares the width the vectors must have.

What comes out, in `app/generated/gateway/models.py`:

- One client per alias, with the pinned id baked in, so a provider's default moving does
  not move your app.
- The priced call path, from the alias's `costProfile`, which is what `aid cost` and the
  eval budget gate read.
- The fallback chain in declaration order, refused when a fallback cannot serve the
  capabilities the alias declared.

What is refused:

- An alias whose `costProfile` does not resolve, because a budget cannot be enforced
  against an unpriced model.
- A target that cannot serve a declared capability, such as `streaming` on a backend with
  no SSE surface. The gate names the alias, the capability, and the target.
- A spec written against an older `specVersion` than the construct it uses, instead of
  quietly reading that construct as absent.

Covers:

- **Versioned spec language**
- **Pinned model ids**
- **Priced calls**
- **Capability refusal**
- **Embeddings on Bedrock, Vertex AI and the Gemini API**

## Retrieval and memory

<!-- capability-family: retrieval -->

A retriever names its corpus, its chunking, its embedding alias and its store. A managed
knowledge base and an in-process store are the same declaration with a different `kind`,
which is what makes the local path testable and the hosted path a config change.

```yaml
stores:
  handbook:
    kind: memory
    dimensions: 1536

retrievers:
  handbook:
    source: { kind: file, uri: ./docs, glob: "**/*.md" }
    chunking:
      strategy: recursive
      size: 800
      overlap: 100
      keepMetadata: [path]
    embedModel: embed
    store: handbook
    topK: 5
    traits: [citations]
```

`traits: [citations]` is the whole difference between a passage the model is shown and a
passage the caller can check: each returned hit carries its document path and the offsets it
was cut from, and the generated contract exposes them on the response.

What comes out:

- The retrieval call wired into the pipeline that declares a `retrieve` step, with chunking
  and top-k applied at the point the prompt is rendered.
- `aid ingest` to index the corpus on demand and `aid migrate` to emit the SQL a vector
  store needs, so neither is a hand-run script.
- The managed variants, `knowledgeBase` on Bedrock and Vertex AI RAG, selected by `kind`
  rather than by a second pipeline shape.

What is refused:

- A retriever whose store and embedding disagree on width, because a vector resolved at run
  time would let a later run compare two incomparable vectors.
- A managed knowledge base on a cloud whose module does not exist for it.
- A `glob` on an `http` source, because a `glob` describes a set and an `http` source is one
  document; and a `uri` whose scheme does not match its `kind`.

A corpus does not have to be a directory. `source.kind: s3` reads an `s3://bucket/prefix`,
matching object keys against the same `glob` grammar a file source uses, and
`source.kind: http` reads one absolute url as exactly one document. Both need
`specVersion: "0.21"`; `db` and `mcp` remain reserved.

```yaml
retrievers:
  handbook:
    source:
      kind: s3
      uri: s3://acme-handbook/guides
      glob: "**/*.md"
```

A document's id stays relative to the source - the key with the prefix stripped - so an
eval's `expectDocs` and a citation name the same thing whichever kind indexed it. The `s3`
loader signs with SigV4 from the AWS environment variables and refuses a missing region by
name rather than defaulting one.

`chunking.strategy: semantic` cuts a document where its topic changes instead of at a character
count, and needs `specVersion: "0.22"`. The retriever's own embedder does the work, so no second
model, field or call path appears: the source is split into units at paragraph, newline and
sentence boundaries, the units are embedded, and a boundary goes wherever the cosine similarity
between neighbouring units dips below 0.72. That boundary pass embeds the whole source before
the chunks are embedded, so its tokens and cost are counted in the ingest report rather than
left out. `fixed`, `recursive` and `code` still cut by size and produce the same chunks and ids
they did before.

Re-ingestion can run on a clock. A retriever the application ingests itself declares
`refresh.schedule` as a five-field cron read as UTC, and the generated module emits a
scheduler that submits the job running that retriever's ingest - `aws_scheduler_schedule`
against the AWS Batch queue, `google_cloud_scheduler_job` against the Cloud Run job. It needs
`specVersion: "0.23"`, and the retriever must be named in a `target: batch` deployment, since
that deployment supplies the image and environment the refresh runs in.

Covers:

- **Retrieval with citations**
- **S3 and HTTP corpus sources**
- **Semantic chunking**
- **Scheduled re-ingestion**
- **Memory tiers**
- **Semantic cache**
- **Bedrock knowledge bases**
- **Vertex AI RAG corpora**

## Guardrails and decisions

<!-- capability-family: guardrails -->

A guardrail names the stages it runs at and what happens when it fails. Naming the stage is
the enforcement: the security gate is document-global, so a POST route that reaches a prompt
is inspected whether or not the route mentions a guardrail.

```yaml
guardrails:
  ticket_intake:
    stages: [input]
    policies:
      - kind: prompt-injection
    onFail: block
  refund_args:
    stages: [tool-input]
    policies:
      - kind: decision
        decision: refund_policy
    onFail: escalate
```

```yaml
decisions:
  refund_policy:
    cases:
      - when: "amount <= 50 and order_status == 'delivered'"
        then: approve
    default: escalate
```

A `decision` is the escape hatch from "guardrail as a regex": a judgement the model is not
asked to make, evaluated by the runtime, with `escalate` available because the outcome is
checked rather than guessed.

What comes out:

- `app/generated/guardrails.py`: the policy engine, with the stage tables the routes and the
  agent runtime consult.
- `aid guard` against a red-team corpus, so the policies are measured rather than assumed.
- The managed engines when declared: Bedrock Guardrails and Vertex AI Model Armor replace
  the local policy pass and keep the same stages.

What is refused:

- A POST route that hands caller text to a prompt with no input-stage guardrail. This is the
  gate that runs on the first `aid validate`, not on the first incident.
- `onFail: escalate` on an input-stage guardrail, because escalation needs a pause the
  request path cannot offer.

Covers:

- **Guardrail stages**
- **Unprotected routes are refused**
- **Bedrock Guardrails as the guardrail engine**
- **Vertex AI Model Armor as the guardrail engine**
- **Jev-backed decisions**
- **A decision-backed guardrail**

## Evals and quality gates

<!-- capability-family: quality -->

An eval declares a dataset, the metrics that score it, and the budget a regression may not
exceed. `gate.ci: true` is what turns the report into a gate.

```yaml
evals:
  classify_quality:
    target: pipeline:answer_ticket
    dataset: { source: file, uri: evals/classify_quality.json }
    metrics:
      - kind: json-schema
        schema: Answer
    gate:
      ci: true
      maxRegression: 0.05
      samples: 5
```

What comes out:

- `aid eval --baseline` writes the baseline; `aid eval` exits non-zero when the run drops below
  `maxRegression` against it, so the exit code is the contract CI reads.
- `.github/workflows/evals.yml`, scaffolded for exactly the evals that gate CI.
- A cost-and-latency ceiling built from the same priced profiles and the same measured runs,
  so a budget is enforced in CI rather than in a dashboard.

What is refused:

- An HTTP pipeline with no CI eval claiming it, because an uncovered route is a prompt edit
  nobody measures.
- An `llm-judge` metric under a CI gate, because a nondeterministic judge cannot be compared
  to a stored baseline.
- A decision-backed metric on an eval that declares no decision, instead of scoring nothing.

**Promotion policy for a candidate.** An eval may declare what a replacement must prove before it
takes over from the version already in force.

```yaml
evals:
  classify_quality:
    gate:
      promotion:
        allowedQualityDrop: 0.01
        allowedCostIncrease: 0.1
        baseline: { prompt: classify_quality, version: 1 }
        approval: { by: [platform-lead], record: app/approvals/quality.md }
```

`aid eval --compare accepted.json --candidate candidate.json` reads the policy, compares two
recorded baselines and prints `verdict: promotable` or `verdict: refused`; exit `2` means nothing
was judged, which is not the same as a pass. Nothing promotes itself: the merge that carries the
bumped prompt version is the promotion, and under `profile: enterprise` the policy must name a
committed approval record that exists and has content.

What is refused:

- A policy whose `baseline.version` is not below the version the document declares, because an
  unchanged version means nothing has been bumped and a lower one is a rollback.
- `allowedQualityDrop` on an eval that scores no quality metric, so the allowance governs nothing.
- `allowedCostIncrease` on an eval with no `cost` metric, so there is no baseline cost to rise.

**Declared feedback signals.** What the app takes back from the people who use it, and what
happens to the text they send.

```yaml
observability:
  feedback:
    signals:
      rating: { kind: thumbs }
      correction: { kind: correction }
    pii:
      redact: [subject]
    retentionDays: 90
    persistent: true
```

`correction` is the only kind that stores prose, so it is the only kind the redaction rule
applies to: the gate refuses a persistent store whose `pii.redact` misses a field the spec
already marks sensitive, and refuses `persistent: true` with no `retentionDays`, because keeping
every signal forever is not a policy a spec may leave unstated. This build declares the intake
and gates it; it generates no feedback route and stores nothing.

**A dataset from the runs you already have.** The first eval set for a new agent is easier to
find in the traffic the agent already served than in a guess about what people will ask.

```sh
AID_TRACE_DIR=traces AID_TRACE_CONTENT=1 python -m app.main   # run it, keeping the text
aid trace export --dataset support_quality --from traces
```

One run is one case: `input` is the prompt the run was first given, `expected` the answer it last
produced, and `metadata` carries the calls, cost, wall time, model and tools beside them. The file
is written in the form the Python `Dataset` reads, so setting `evals[].dataset.uri` at it is the
only wiring left.

The capture is opt-in. The sink records timing, model, tokens and cost always, but keeps prompts
and completions only when `AID_TRACE_CONTENT` is truthy — so no service starts recording what its
users typed because a trace directory happened to be configured. Nothing here redacts; the
operator who sets the variable owns what it collects.

What comes out:

- A dataset file, plus a printed next step naming the `evals[].dataset.uri` to set.

What is refused:

- A run set that recorded no payloads, naming `AID_TRACE_CONTENT=1` as the fix rather than
  writing a dataset with no `input` in it.
- A `--filter` that is not `agent=<id>`, or one that matches no run.
- An existing dataset file without `--force`, because it may have been curated by hand since it
  was generated. Bump `--version` when the cases change, since the eval gate will not compare
  across versions.
- A spec that cannot be read, or does not pass its own gates — an export applies the policy the
  document declares, so there is nothing to export from an unreadable one.
- A spec that names a field a trace must never carry, or one under `profile: enterprise`, because
  the export writes recorded prompts verbatim and nothing in the runtime redacts a named field out
  of prose yet. The refusal goes away when trace redaction ships.

Every exported case is tagged `unreviewed`. `expected` is what the run happened to output, so
`exact-match` against it measures stability rather than quality — a better-worded answer fails.

**Unreviewed cases refuse a CI gate**. The tag is operative rather than advisory: an eval with
`gate.ci: true` refuses a dataset that still carries it, naming the cases and the two ways forward
— review each case and drop the tag, or take the eval out of the gate. A hand-curated dataset is
unaffected, and so is an exported one until it is wired into a gate. The check lives in the
runtime `Dataset` layer, so a module edited by hand keeps it.

**A trajectory eval that runs an agent.** A pipeline eval scores a route; an agent needs its
*calls* scored, so the eval names the agent as its target.

```yaml
evals:
  refund_trajectory:
    target: agent:refund_agent
    dataset: { source: file, uri: evals/refund_trajectory.json }
    metrics:
      - kind: tool-trace
        expect: [lookup_customer, issue_refund]
    gate:
      ci: true
      maxRegression: 0.05
```

What comes out:

- An offline evaluator in the `py-fastapi` target — the generator that declares `agent-evals` —
  which replays each case through the generated loop and reports the calls it made and the
  response metrics, under the agent's own step and cost ceiling.

What is refused:

- `target: agent:<id>` on a target that does not declare `agent-evals`, as `ir/eval-trajectory`,
  rather than shipping an evaluator nothing runs.
- `tool-trace` on a pipeline target, with a hint naming `target: agent:<id>` as the fix, because
  a route's own calls are not a trajectory.

The evaluator drives the agent with a scripted or recorded model, so a case verifies the policy
and plumbing of a run — which tools were reachable, in what order they were called, whether an
approval was respected — and not the quality of a model answer. Model quality is what the prompt
and pipeline evals measure; a trajectory case that passes while the wording is poor is working as
designed.

**Metrics that score the run, not the answer.** A trajectory eval already reports the calls a
case made. Three metrics turn that report into something a regression can fail on.

```yaml
evals:
  refund_policy:
    target: agent:refund_agent
    dataset: { source: file, uri: evals/refund_policy.json }
    metrics:
      - kind: step-count
        maxSteps: 4
      - kind: forbidden-tool
        forbid: [delete_customer]
      - kind: approval-respected
    gate:
      ci: true
```

`step-count` fails a case whose run took more model calls than the ceiling it declares,
`forbidden-tool` fails a case that reached for a tool it must never call, and
`approval-respected` passes only when the run asked for every decision the case scripted, paused
nowhere else, and did nothing a reviewer rejected. All three read the trajectory, so all three
need `target: agent:<id>`.

What is refused:

- A `step-count` ceiling at or above the agent's own `maxSteps`, as `ir/eval-metric-vacuous`:
  the agent's budget stops the run before the ceiling can be exceeded, so the metric could only
  ever pass.
- An `approval-respected` metric on an agent that declares no `humanInTheLoop` and calls no tool
  with `requiresConfirmation`, because such a run never pauses and there is no decision to score.
- A `forbid` entry no `tools` declaration names, as `ir/metric-tool-unresolved`.

A trajectory metric declared on a pipeline target is still the `ir/eval-trajectory` refusal
above, with the same hint.

**Coverage an enterprise document cannot waive.** `profile: enterprise` promises change control,
and a route no CI-gating eval measures has nothing to hold a change against. From spec 0.31 an
HTTP pipeline — or a retrieval surface with no `retrieval` metric — that no CI-gating eval covers
is an error under `enterprise` rather than a warning. `profile: standard` keeps the warning, and
the escalation is version-gated, so a 0.30 document keeps what it was written against.

Covers:

- **Eval coverage**
- **A decision eval metric**
- **Promotion policy for a candidate**
- **Declared feedback signals**
- **A dataset from the runs you already have**
- **A trajectory eval that runs an agent**
- **Metrics that score the run, not the answer**
- **Coverage an enterprise document cannot waive**

## Agents and tools

<!-- capability-family: agents -->

An agent declares its instructions, its model, its tools, its step and cost ceilings, and
whether a run may pause for a human. The loop is generated; the tool bodies are yours.

```yaml
agents:
  refund_agent:
    name: Refund agent
    instructions: ticket_agent_prompt
    model: triage
    tools: [lookup_customer, issue_refund]
    guardrails: [ticket_intake, refund_args]
    maxSteps: 6
    maxCostBudget: 0.05
    humanInTheLoop:
      when: "true"
      channel: refunds
```

What comes out:

- The tool loop, its step and cost ceilings, and the resume route a paused run returns to.
  `refund_agent` above is what creates `POST /agents/resume`.
- `app/business/tools/` for the bodies, created once and never overwritten, so the generated
  loop calls your function rather than a stub.
- Guardrails run per tool call, which is why `refund_args` can inspect arguments that no
  request-time filter ever saw.

What is refused:

- An agent whose model reaches an unpriced fallback, rather than dropping the fallback behind
  the reader's back.
- An agent declaring `humanInTheLoop` where a pipeline step runs it, because a step has no
  checkpoint to hand back.

The two controls that keep a run accountable are worth naming separately, because they are
what an enterprise review asks for:

- **Step-level human approval**: a tool marked `requiresConfirmation` pauses the run where it
  stands, and the approval resumes from that step rather than replaying the ones before it.
  Under the enterprise profile a side-effecting tool without one is refused.
- **Durable run state**: the checkpoint goes to the store the spec names, so a paused run
  outlives the process that started it. An agent that can call a tool with side effects is
  refused when it declares no store, because the approval would otherwise wait nowhere.

A gateway federates tools that already exist behind one managed MCP endpoint: the platform
hosts the endpoint, each target keeps owning its own tool list, and the app reaches a single
URL instead of bundling every tool (spec `0.24`, AWS only).

```yaml
gateways:
  partner_tools:
    description: Partner order and search APIs
    authorizer:
      kind: jwt
      discoveryUrl: https://auth.partner.example/.well-known/openid-configuration
      audience: [acme-gateway]
    targets:
      - name: orders
        kind: openApiSchema
        openApiSchema:
          uri: s3://acme-tools/orders.openapi.json
      - name: search
        kind: mcpServer
        mcpServer:
          endpoint: https://search.partner.example/mcp
```

Every target kind is one target under the gateway's `Mcp` configuration, which is why `kind`
selects which of the two sources is required instead of naming two resource shapes: a target
carrying both, or neither, is refused. `authorizer` is either `awsIam`, which signs with
SigV4, or `jwt`, which reads an OIDC discovery document and accepts one of the listed
audiences.

A runtime on `aws-agentcore` names the gateway it reaches; its own fields are unchanged,
aside from the platform and this one name:

```yaml
      platform: aws-agentcore
      gateway: partner_tools
```

What comes out:

- `infra/modules/gateway/`, one AgentCore Gateway with one `GatewayTarget` per entry, and its
  URL as an output.
- `AID_GATEWAY_PARTNER_TOOLS_URL` in that runtime's environment, read from the gateway's
  `GatewayUrl`, plus an `InvokeGateway` grant on the runtime role — emitted only for a runtime
  that names the gateway.
- Nothing in the tool registry: `tools:` is untouched, because a gateway is a tool the app
  does not run and reaches through an MCP client.

What is refused:

- `gateways` on `--cloud gcp`, and `deployments[].runtime.gateway` on `gcp-agent-platform`,
  because an AgentCore Gateway is an AWS resource with no Google Cloud counterpart.
- A `runtime.gateway` naming a gateway the document does not declare.
- One gateway declaring the same target name twice, which would collide at apply time.

Covers:

- **Agents and handoffs**
- **Tools federated behind a managed MCP endpoint**

## Deployment and infrastructure

<!-- capability-family: deploy -->

A deployment says where the app runs. `target` picks the shape, and the placement — cloud,
region, audit sink — may be pinned in the spec or left to the flag.

```yaml
deployments:
  api:
    target: container
    streaming: true
    concurrency: 4
    secrets: [OPENAI_API_KEY]
    image:
      registry: ghcr.io
      name: acme/support-copilot
```

A registry other than `ghcr.io` names the credential its login reads, because the spec
holds names and identifiers and never secret values. Docker Hub takes the names of two
repository secrets (spec `0.16`):

```yaml
    image:
      registry: docker.io
      name: acme/support-copilot
      usernameSecret: DOCKERHUB_USERNAME
      tokenSecret: DOCKERHUB_TOKEN
```

`ghcr.io` needs neither field: the release workflow logs in with the `GITHUB_TOKEN` it
already holds and asks only for `packages: write`. A spec that names a credential on
`ghcr.io`, or omits one on `docker.io`, is refused rather than emitting a login that
cannot work.

A cloud registry is named by an id, not a host, because the host is account-specific. ECR
derives it from the account and region and assumes a role with OIDC (spec `0.17`), so no
access key is stored:

```yaml
    image:
      registry: aws.ecr
      name: acme/support-copilot
      accountId: "123456789012"
      region: eu-west-1
      roleArn: arn:aws:iam::123456789012:role/publisher
```

Artifact Registry federates through Workload Identity and prefixes the repository path
with the project (spec `0.18`):

```yaml
    image:
      registry: gcp.artifact-registry
      name: acme/support-copilot
      project: acme-prod
      region: europe-west1
      workloadIdentityProvider: projects/123456789/locations/global/workloadIdentityPools/gh/providers/main
      serviceAccount: publisher@acme-prod.iam.gserviceaccount.com
```

Both cloud paths ask for `id-token: write` and nothing else; the emitted workflow carries
the derived host and the identity per matrix entry, so two accounts publishing in one
project do not share a login.

A top-level `profile` says which
class of customer the app is built for. `standard` is the default, and it is what an absent
`profile` means, so a document written before `0.25` reads exactly as it did. `enterprise`
requires the three controls `0.25` can generate — a region pin, an audit sink, and at least one
`output`-stage guardrail — because a gate that asks for a control the schema cannot express is a
gate nobody can pass. Identity, private networking and production approval policy are the next
increments, and the reference says so rather than implying they are enforced today.

```yaml
profile: enterprise

deployments:
  api:
    target: container
    streaming: true
    secrets: [OPENAI_API_KEY]

    cloud: aws             # aws | gcp
    region: eu-central-1   # placement, and the residency pin
    audit:
      sink: cloudwatch     # cloudwatch | s3 | gcs | bigquery
      retentionDays: 365
```

`cloud` is optional. Absent, `aid infra` keeps taking `--cloud` and defaulting to `aws`, which is
why adding the key changes no existing output. Pinned, it wins: a spec that says `gcp` and a
command that says `--cloud aws` is refused, because planning somewhere the spec did not say is
the one mistake a placement field exists to prevent. `region` is checked against the region set
of that cloud. `audit` is one environment-scoped sink rather than one per service, because the
record covers the placement, not a process.

```sh
aid infra gen --cloud aws
aid infra plan --cloud aws --iac tofu
```

What comes out:

- `infra/envs/<name>` for AWS, `infra/envs/gcp-<name>` for GCP, or `infra/cdk/<name>` when
  `--iac cdk` names the CDK backend instead of OpenTofu.
- The cloud wiring for what the spec declared: Bedrock from the AWS module, Vertex AI from
  the GCP modules, and the managed runtime when `deployments[].runtime` names one.
- `.github/workflows/infra-plan.yml` for every project, because it detects its own inputs
  rather than assuming an `infra/` directory exists, and `release.yml` when `image` names a
  registry to publish to.
- `.github/workflows/ci.yml`, which re-runs every gate this page describes.

What is refused:

- An unknown cloud, or a cloud and target pair with no module, such as `edge` on GCP, rather
  than emitting half a project.
- Streaming on an HTTP API target that cannot carry SSE.
- An image on a registry the release workflow has no login for, a cloud image missing the
  account, role or provider its login federates with, or one whose credential names the
  registry does not read.
- An enterprise profile with no region pin, no audit sink, or no `output`-stage guardrail; a
  region the deployment's cloud does not offer; a deployment whose cloud or audit sink
  disagrees with its sibling's; and a spec that pins one cloud while the command asks for
  another.

`aid eject` moves a generated file into `business/` and stops generating it. After that the
file is yours, and the manifest says so instead of re-reporting it as drift.

Covers:

- **Infrastructure from the spec**
- **A CDK backend**
- **Bedrock from the AWS module**
- **Vertex AI from the GCP modules**
- **Generated project CI**
- **A Dockerfile and an image**
- **Delivery profiles with a pinned placement and audit sink**
- **Durable run state, deployment identity, private network and change approval**
- **Eject**

## Observability and cost

<!-- capability-family: observability -->

Tracing is on by default and local by design: a run writes spans to a local sink, so the
first thing you can answer is "what did this request do", with no collector to stand up.

```sh
aid trace <run-id>      # span tree, timings, models, tokens, cost
aid cost                # cost and latency from the local trace sink
aid report traces/      # the same numbers for every deployment, side by side
```

A report is a directory of directories: one child per deployment, holding the `.jsonl` files
that deployment's sink wrote and any `*.baseline.json` it committed. One row per customer, then
a total, so twenty customers are one screen instead of twenty commands. It is files in and text
out — no upload, no backend, and nothing joined to the repository — so the same command runs
against a CI artifact download. `--budget` turns the total into a ceiling that fails the job,
which is the only way a report can fail a build.

The `observability` block moves that decision into the spec: `trace`, `redact`, and — for a
service whose spans belong somewhere other than the process — `export: otlp` with `endpointEnv`
naming the variable that holds the collector address. Where the spans go is then declared,
reviewable in a diff, and gated, instead of living in whoever's shell ran the deploy.

With py-fastapi the spans actually leave. `aid gen` emits `tracing_export_status()` into
`app/generated/observability.py`, and your own `main.py` calls it once at startup:

```python
from app.generated.observability import tracing_export_status

tracing_export_status("support-copilot")
```

That installs an OTLP/HTTP exporter over a batched processor, reading the address from the variable
`endpointEnv` names. Install the extra to get it — `pip install "aid-runtime-python[otlp]"` — since
not every deployment exports. Nothing is installed on import and nothing is installed if you never
call it, so embedding AID does not decide telemetry for you; the call is in your entrypoint because
the entrypoint is yours. `ts-vercel` records spans but installs no exporter, so it refuses
`export: otlp` with `observability-export-unsupported` rather than accept a destination nothing is
sent to.

The same block declares who should be woken up. An `alerts` entry names a metric, a window, a
reduction and a threshold, and the deploy plan turns each one into a real alarm resource:

```yaml
profile: enterprise
observability:
  export: otlp
  alerts:
    - id: daily_spend
      metric: agent.cost
      window: 24h
      aggregate: sum
      threshold: 250
```

```sh
tofu plan      # the same YAML produces aws_cloudwatch_metric_alarm.this["daily_spend"]
```

The alarm is infrastructure, so it is reviewed in the same diff as the rest of the plan, and the
unit on the page (`250 usd`) comes from the metric rather than from the author, so the number and
its label cannot disagree. The metric list is closed to four series — `agent.cost`, `agent.tokens`,
`eval.cost` and `eval.latency.p95` — so an alarm cannot watch a number nothing produces.

Those four are recorded, not assumed. `aid-runtime-python` writes all of them: a run stopped by a
guardrail or an exhausted ceiling publishes what it spent before the refusal propagates, and an
eval suite publishes one `eval.cost` and one `eval.latency.p95` sample per case per run under the
eval id the spec declares. They leave by the same `export` switch as the spans — `aid gen` emits
`metrics_export_status()` beside `tracing_export_status()`, and `configure_metrics()` installs the
OTLP/HTTP reader — so an alarm filters on the same eval the spec names. An alarm over a series this
build cannot record is refused by `ir/alerts-unproduced` instead of shipping an alarm that would
never fire; `ts-vercel` records none of the four and so refuses all of them.

What comes out:

- `app/generated/observability.py`: the span writer each generated step calls, so a pipeline
  you add later is traced without wiring it.
- Per-call cost, from the same `costProfile` the gateway prices with and the eval budget gate
  enforces. There is one price table, not three.
- `modules/alerts/` in the OpenTofu tree, or `alerts.cjs` in the CDK app: one alarm per declared
  entry, wired to `alert_channel_ids`, which defaults to empty so a generated alarm notifies
  nobody until an operator names a channel.

What is refused:

- A cost metric on an eval whose model resolves no profile, because the ceiling would be
  computed from nothing.
- An `export: otlp` beside `trace: false`, because a destination for spans that are never
  recorded is a contradiction.
- An `enterprise` document whose spans stay inside the process, because the profile promises an
  audit trail and this one ends with the process.
- An `alerts` entry with no `export: otlp`, because a metric nobody publishes is an alarm that
  stays silent and reads as health.
- A reduction the declared metric cannot answer, such as a `p95` over a cost total.
- An alarm scoped to an agent or eval name the document does not declare, because the typo would
  become a dimension nothing writes.

Covers:

- **Local trace capture**
- **Cost and latency ceilings in CI**
- **A declared place for the spans, and an exporter that reaches it**
- **Alarms as generated infrastructure**
- **The series the alarms watch, recorded and exported**
- **A report across every deployment**

## Fleet repeatability

<!-- capability-family: fleet -->

One agent definition, many customers. The alternative -- a fork per customer -- is how a fleet
becomes twenty subtly different products that nobody can diff. AID splits the document in two: a
**base spec** that holds the behaviour, and a small **overlay** per customer that holds the
variables, with the base naming in advance which paths an overlay may touch.

```yaml
# base.spec.yaml
specVersion: '0.29'
profile: standard
overridable:
  deployments.main.region: { from: [us-east-1, eu-central-1] }
  evals.answer.gate.promotion.allowedCostIncrease: { max: 0.1 }
  observability.trace: { allowWeaken: true }
```

```yaml
# customers/acme.yaml
base: ../base.spec.yaml
customer: acme
profile: standard
overrides:
  deployments.main.region: eu-central-1
```

`overridable` is a closed allowlist, matched by exact path: a path that is not listed is not
overridable, and listing a path does not open its children. The forms are a closed set of values
(`from`), a ceiling (`max`), or `true` for any value of the right type. `allowWeaken` is a separate
permission the base author grants, because "may differ per customer" and "may be made looser per
customer" are different decisions.

Resolution is a build step, not a runtime one:

```sh
aid resolve customers/acme.yaml            # writes acme.spec.yaml beside it
aid resolve customers/acme.yaml --check    # non-zero if the artifact is stale
aid fleet customers/                       # every customer, one table
```

The resolved document is a reviewed file, so `--check` in CI catches a base that moved without the
customer artifacts following. `aid fleet` re-runs the gates over every resolved spec rather than
trusting a cached verdict, so `ok` means "passes today". Nothing here contacts a server; the
inventory is computed from the tree.

`aid init <dir> --template support-copilot` and `--template enterprise-approvals` are the two
shipped golden paths -- the first is a managed-retrieval support agent, the second an agent whose
side-effecting tool stops for a human before it runs.

What comes out:

- `customers/acme.spec.yaml`: the base with the overlay applied, in the same schema `aid validate`
  already reads, so no new tooling stands between a reviewer and the deploy.
- An `aid fleet` row per customer: profile, pinned models, regions, cost ceiling, how many
  overrides applied, and the gate verdict.

What is refused:

- An override at a path the base never opened, because an allowlist that silently grew would not
  be an allowlist.
- An override that relaxes a control at a path without `allowWeaken`, whichever form the value
  takes -- including `null`, which is the only way to delete a base key.
- A value outside its `from` set or above its `max`, even with `allowWeaken`: the bound is the more
  specific answer, and a hint that suggested a permission that cannot help would be a lie.
- The removal of an eval that `gate.ci` requires, under every form: no base can permit a customer
  to buy their way out of a CI gate.
- An overlay whose `profile` label disagrees with what the resolved document declares, because the
  label is what `aid fleet` groups by and a wrong one under-sells the controls that apply.

Covers:

- **A stated list of what a customer may change**
- **One base spec, one file per customer**
- **A fleet inventory computed from the tree**
- **Two shipped golden paths**

---

Each section above is a family on the [capability band](index.md#what-the-compiler-writes-for-you).
The inventory behind it, with the release that first shipped each entry and the diagnostic
that proves the refusal, is [Features](features.md).
