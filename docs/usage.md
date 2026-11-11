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
- A cost-ceiling job built from the same priced profiles, so a budget is enforced in CI
  rather than in a dashboard.

What is refused:

- An HTTP pipeline with no CI eval claiming it, because an uncovered route is a prompt edit
  nobody measures.
- An `llm-judge` metric under a CI gate, because a nondeterministic judge cannot be compared
  to a stored baseline.
- A decision-backed metric on an eval that declares no decision, instead of scoring nothing.

Covers:

- **Eval coverage**
- **A decision eval metric**

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
```

The `observability` block moves that decision into the spec: `trace`, `redact`, and — for a
service whose spans belong somewhere other than the process — `export: otlp` with `endpointEnv`
naming the variable that holds the collector address. AID installs no exporter, so the block
records where spans belong rather than moving them; what it buys today is that the destination is
declared, reviewable in a diff, and gated, instead of living in whoever's shell ran the deploy.

What comes out:

- `app/generated/observability.py`: the span writer each generated step calls, so a pipeline
  you add later is traced without wiring it.
- Per-call cost, from the same `costProfile` the gateway prices with and the eval budget gate
  enforces. There is one price table, not three.

What is refused:

- A cost metric on an eval whose model resolves no profile, because the ceiling would be
  computed from nothing.
- An `export: otlp` beside `trace: false`, because a destination for spans that are never
  recorded is a contradiction.
- An `enterprise` document whose spans stay inside the process, because the profile promises an
  audit trail and this one ends with the process.

Covers:

- **Local trace capture**
- **A cost ceiling in CI**
- **A declared place for the spans**

---

Each section above is a family on the [capability band](index.md#what-the-compiler-writes-for-you).
The inventory behind it, with the release that first shipped each entry and the diagnostic
that proves the refusal, is [Features](features.md).
