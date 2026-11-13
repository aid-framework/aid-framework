/**
 * The facts `/features` renders that no compiler declaration states yet.
 *
 * The bands that describe a *mechanism* (`SERVED_PROVIDERS`, `CLOUD_TARGETS`,
 * `ADAPTER_CAPABILITIES`) are parsed in `support-data.mjs` and are never written
 * here. What is written here is the part the tree does not express: which release
 * first shipped a feature, and how to name the spec key that turns it on.
 *
 * Every `since` is the first tag that contains the commit which shipped the
 * feature. A claim that no release supports is a lie the page test catches.
 */

/**
 * The concrete service each cloud runs a target on.
 *
 * A target present in `CLOUD_TARGETS` must have an entry here, and an entry here
 * for a pair that cloud has no module for is a test failure: the page cannot
 * render a blank cell or invent a service.
 *
 * @type {Record<string, Record<string, string>>}
 */
export const CLOUD_SERVICES = {
  aws: {
    serverless: 'API Gateway + Lambda',
    container: 'ECS on Fargate',
    batch: 'AWS Batch',
    edge: 'Lambda@Edge on CloudFront',
  },
  gcp: {
    serverless: 'Cloud Run',
    container: 'Cloud Run',
    batch: 'Cloud Run job',
  },
};

/**
 * A pair the framework refuses, with the reason a reader is owed.
 *
 * The refusal is enforced by the diagnostic named in `code`, so this is a claim
 * about an existing boundary rather than an apology for missing work.
 *
 * @type {{ cloud: string, target: string, reason: string, code: string }[]}
 */
export const CLOUD_REFUSALS = [
  {
    cloud: 'gcp',
    target: 'edge',
    reason:
      'Cloud CDN serves static assets and cannot run the app, so there is no GCP resource to map `edge` to.',
    code: 'cli/infra-cloud-target-unsupported',
  },
];

/**
 * The columns of the provider matrix.
 *
 * `spec` is the spelling the spec's `capabilities` enum accepts; `member` is the
 * `Capability` member the adapter advertises. The test asserts the `spec` set is
 * exactly `SPEC_MODEL_CAPABILITY_MAP`, so a capability the spec cannot declare
 * never becomes a column that is a dash on every row.
 *
 * @type {{ spec: string, label: string, member: string }[]}
 */
export const CAPABILITY_AXES = [
  { spec: 'tools', label: 'Tools', member: 'TOOL_CALLING' },
  { spec: 'json-schema', label: 'Structured output', member: 'STRUCTURED_OUTPUT' },
  { spec: 'streaming', label: 'Streaming', member: 'STREAMING' },
  { spec: 'embeddings', label: 'Embeddings', member: 'EMBEDDINGS' },
];

/**
 * Managed AI infrastructure the generated OpenTofu provisions access to.
 *
 * `emits` is the resource or grant the module writes, `credential` is what the
 * runtime reads at call time. Both are read from the module source, not from a
 * provider's documentation.
 *
 * @type {{
 *   id: string, cloud: string, title: string, declares: string,
 *   emits: string, credential: string, since: string,
 * }[]}
 */
export const AI_INFRA = [
  {
    id: 'aws-bedrock',
    cloud: 'aws',
    title: 'Bedrock from the AWS module',
    declares: 'models[].provider: bedrock',
    emits:
      '`bedrock:InvokeModel`, plus `bedrock:InvokeModelWithResponseStream` when a service declares `streaming`, scoped to the foundation-model and inference-profile ARNs',
    credential: 'the IAM role the module creates for the service',
    since: '0.1.81',
  },
  {
    id: 'gcp-vertex',
    cloud: 'gcp',
    title: 'Vertex AI from the GCP modules',
    declares: 'models[].provider: google',
    emits:
      '`roles/aiplatform.user` on the project, plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_REGION` on the Cloud Run service or job, which Cloud Run does not set',
    credential: 'the service account the module creates',
    since: '0.1.83',
  },
  {
    id: 'bedrock-guardrails',
    cloud: 'aws',
    title: 'Bedrock Guardrails as the guardrail engine',
    declares: 'guardrails[].engine: bedrock',
    emits:
      'an `aws_bedrock_guardrail` and its numbered version from the `bedrock:` block, `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` on the service, and `bedrock:ApplyGuardrail` on that guardrail alone — the CDK construct mirrors all of it; omit the block and the app reads the two variables for a guardrail the operator owns',
    credential: 'the IAM role the module creates for the service',
    since: '0.1.98',
  },
  {
    id: 'model-armor',
    cloud: 'gcp',
    title: 'Vertex AI Model Armor as the guardrail engine',
    declares: 'guardrails[].engine: model-armor',
    emits:
      '`MODEL_ARMOR_TEMPLATE`, the full template name `projects/{project}/locations/{location}/templates/{id}` the runtime reads, and `sanitizeUserPrompt` / `sanitizeModelResponse` calls against it; a 0.15 `modelArmor:` block makes the module create a `google_model_armor_template` from the spec and hand its name to the service, and without one the app reads the variable for a template the operator owns',
    credential: 'a service account the operator grants `roles/modelarmor.user`',
    since: '0.1.109',
  },
  {
    id: 'bedrock-knowledge-base',
    cloud: 'aws',
    title: 'Bedrock knowledge bases',
    declares: 'knowledgeBases[].engine: aws-bedrock',
    emits:
      'an `aws_bedrockagent_knowledge_base` over an S3 prefix, its `aws_bedrockagent_data_source`, an OpenSearch Serverless collection with the data-access policy the base needs, and `bedrock:Retrieve` on the service that reads it — the base is created empty, so ingestion is a separate operator step',
    credential: 'the IAM role the module creates for the service',
    since: '0.1.99',
  },
  {
    id: 'vertex-rag',
    cloud: 'gcp',
    title: 'Vertex AI RAG corpora',
    declares: 'knowledgeBases[].engine: vertex-rag',
    emits:
      'a `google_vertex_ai_rag_corpus` on the RAG-managed store with the spec\u2019s embedding model, one `google_vertex_ai_rag_file` per object under the `gs://` prefix, `roles/storage.objectViewer` for the RAG service agent, and `VERTEX_RAG_CORPUS_<ID>` on the Cloud Run service or job',
    credential: 'the service account the module creates',
    since: '0.1.99',
  },
];

/**
 * What ships without the user writing code.
 *
 * `declaredBy` is what turns the feature on, and it is rendered as a link: a spec
 * key goes to the spec reference, a command to the CLI reference. `since` is the
 * first release that shipped it.
 *
 * @type {{
 *   id: string, title: string, detail: string, declaredBy: string,
 *   href: string, since: string,
 * }[]}
 */
export const SHIPPED_FEATURES = [
  {
    id: 'spec-versions',
    title: 'Versioned spec language',
    detail:
      'A construct that needs a later version is refused by name instead of being ignored, so a spec never silently means less than it says.',
    declaredBy: 'specVersion',
    href: './reference/spec.md#top-level-keys',
    since: '0.1.0',
  },
  {
    id: 'pinned-models',
    title: 'Pinned model ids',
    detail:
      'A model alias is what the rest of the spec refers to; the vendor id is pinned in one place and never floats to a vendor default.',
    declaredBy: 'models[].modelId',
    href: './reference/spec.md#model',
    since: '0.1.0',
  },
  {
    id: 'cost-profiles',
    title: 'Priced calls',
    detail:
      'A committed cost profile prices every call. An unpriced model is reported as unknown, never as free.',
    declaredBy: 'models[].costProfile',
    href: './reference/spec.md#model',
    since: '0.1.0',
  },
  {
    id: 'capability-gate',
    title: 'Capability refusal',
    detail:
      'A spec that asks a target for something it cannot serve is refused at plan time with a named diagnostic, not shipped and debugged in production.',
    declaredBy: 'deployments[].target',
    href: './reference/targets.md#capability-matrix',
    since: '0.1.2',
  },
  {
    id: 'eval-coverage',
    title: 'Eval coverage',
    detail:
      'An HTTP pipeline with no CI eval claiming it is a build error, so a prompt edit cannot ship unmeasured.',
    declaredBy: 'evals[].gate.ci',
    href: './reference/spec.md#eval',
    since: '0.1.2',
  },
  {
    id: 'retrieval-citations',
    title: 'Retrieval with citations',
    detail:
      'A retriever can require that retrieved items carry the source path and offsets a generated answer cites.',
    declaredBy: 'retrievers[].traits',
    href: './reference/spec.md#retriever',
    since: '0.1.6',
  },
  {
    id: 'provider-embeddings',
    title: 'Embeddings on Bedrock, Vertex AI and the Gemini API',
    detail:
      'A pinned embedding is routed by its provider, so Titan on Bedrock is signed with SigV4, `google` on Vertex AI is sent under the project and bearer token, and `gemini` is sent to the AI Studio `:batchEmbedContents` endpoint with `x-goog-api-key` — each instead of the OpenAI-compatible shape.',
    declaredBy: 'models[].capabilities',
    href: './reference/spec.md#model',
    since: '0.1.109',
  },
  {
    id: 'guardrails',
    title: 'Guardrail stages',
    detail:
      'Policies are evaluated at declared stages, and a failing policy has a declared action rather than a default.',
    declaredBy: 'guardrails[]',
    href: './reference/spec.md#guardrail',
    since: '0.1.18',
  },
  {
    id: 'security-gate',
    title: 'Unprotected routes are refused',
    detail:
      'A POST route that passes caller text to a prompt with no input guardrail fails the build before it can be exposed.',
    declaredBy: 'guardrails[].stages',
    href: './reference/spec.md#guardrail',
    since: '0.1.18',
  },
  {
    id: 'agents',
    title: 'Agents and handoffs',
    detail:
      'An agent declares its model, instructions, tools, retrievers and budget; a handoff cycle and an exhausted budget are plan-time errors.',
    declaredBy: 'agents[]',
    href: './reference/spec.md#agent',
    since: '0.1.19',
  },
  {
    id: 'human-in-the-loop',
    title: 'Step-level human approval',
    detail:
      'A tool that writes something pauses the run for a person, and the approved run continues from the same step instead of starting over; a side-effecting tool with no approval policy is refused under the enterprise profile.',
    declaredBy: 'agents[].humanInTheLoop, tools[].requiresConfirmation',
    href: './reference/spec.md#agent-humanintheloop',
    since: '0.1.27',
  },
  {
    id: 'memory',
    title: 'Memory tiers',
    detail: 'What is remembered, for how long, within what token budget, and where it lives.',
    declaredBy: 'memory[]',
    href: './reference/spec.md#memory',
    since: '0.1.19',
  },
  {
    id: 'semantic-cache',
    title: 'Semantic cache',
    detail:
      'The opt-in fuzzy layer beside exact-match caching, carrying its own similarity threshold rather than a global default.',
    declaredBy: 'models[].cache.semantic',
    href: './reference/spec.md#semanticcache',
    since: '0.1.25',
  },
  {
    id: 'traces',
    title: 'Local trace capture',
    detail:
      'A run writes JSONL spans to a directory you name, and `aid trace` prints the span tree from them. No collector to stand up.',
    declaredBy: 'aid trace',
    href: './reference/cli.md#trace',
    since: '0.1.56',
  },
  {
    id: 'infra',
    title: 'Infrastructure from the spec',
    detail:
      'A deployment plan derives OpenTofu modules for the chosen cloud, byte-asserted against fixtures and validated with `tofu` in CI.',
    declaredBy: 'deployments[]',
    href: './reference/spec.md#deployment',
    since: '0.1.54',
  },
  {
    id: 'cdk',
    title: 'A CDK backend',
    detail:
      'The same deployment plan can emit a CDK app instead, for a team already deploying with it.',
    declaredBy: 'aid infra --iac cdk',
    href: './reference/cli.md#infra',
    since: '0.1.57',
  },
  {
    id: 'eject',
    title: 'Eject',
    detail:
      'Take ownership of a generated file: it stops being regenerated and the app keeps booting, because it never depended on a control plane.',
    declaredBy: 'aid eject',
    href: './reference/cli.md#eject',
    since: '0.1.58',
  },
  {
    id: 'generated-ci',
    title: 'Generated project CI',
    detail:
      'Every generated project ships the workflow that runs its evals, so the gate travels with the code it gates.',
    declaredBy: 'aid gen',
    href: './reference/cli.md#gen',
    since: '0.1.59',
  },
  {
    id: 'cost-metric',
    title: 'Cost and latency ceilings in CI',
    detail:
      'A cost or latency budget is an eval metric the harness measures around every case, so the generated workflow exits non-zero when a run spends or takes more than the spec allowed.',
    declaredBy: 'evals[].metrics[].kind: cost',
    href: './reference/spec.md#kind-cost',
    since: '0.1.153',
  },
  {
    id: 'image',
    title: 'A Dockerfile and an image',
    detail:
      'A container deployment emits the Dockerfile and the release workflow that builds and pushes the image it deploys.',
    declaredBy: 'deployments[].image',
    href: './reference/spec.md#image',
    since: '0.1.70',
  },
  {
    id: 'decisions',
    title: 'Jev-backed decisions',
    detail:
      'A named question with its own reply shape, answered by TypeSafe AI Jev, and referenced by guardrails, routers and evals.',
    declaredBy: 'decisions[]',
    href: './reference/spec.md#decision',
    since: '0.1.88',
  },
  {
    id: 'guardrails-decision',
    title: 'A decision-backed guardrail',
    detail:
      'An input guardrail asks a declared decision and enforces a minimum confidence, so the check is a typed answer rather than free text.',
    declaredBy: 'guardrails[].decision',
    href: './reference/spec.md#guardrail',
    since: '0.1.90',
  },
  {
    id: 'evals-decision',
    title: 'A decision eval metric',
    detail:
      'An eval scores a decision on its own reply shape, so a guardrail change is measured like any other behaviour.',
    declaredBy: 'evals[].metrics[].kind: decision',
    href: './reference/spec.md#kind-decision',
    since: '0.1.91',
  },
  {
    id: 'retrieval-remote-sources',
    title: 'S3 and HTTP corpus sources',
    detail:
      'A retriever indexes an `s3://` prefix or one `http(s)://` document instead of a local directory, under the same glob grammar, with document ids relative to the prefix.',
    declaredBy: 'retrievers[].source.kind',
    href: './reference/spec.md#retriever',
    since: '0.1.134',
  },
  {
    id: 'retrieval-semantic-chunking',
    title: 'Semantic chunking',
    detail:
      'A retriever cuts a document where the cosine similarity between adjacent units dips, so a boundary follows the topic rather than a character count; the units are embedded before the chunks are, and that boundary pass is priced into the ingest report.',
    declaredBy: 'retrievers[].chunking.strategy: semantic',
    href: './reference/spec.md#retriever',
    since: '0.1.135',
  },
  {
    id: 'retrieval-refresh-schedule',
    title: 'Scheduled re-ingestion',
    detail:
      "A retriever the application ingests itself declares a five-field cron read as UTC, and the generated module emits a cloud scheduler that submits the job running that retriever's ingest.",
    declaredBy: 'retrievers[].refresh.schedule',
    href: './reference/spec.md#retriever',
    since: '0.1.136',
  },
  {
    id: 'agentcore-gateway',
    title: 'Tools federated behind a managed MCP endpoint',
    detail:
      'A `gateways` entry names an Amazon Bedrock AgentCore Gateway, its authorizer and the OpenAPI or MCP-server targets behind it, so a runtime reaches federated tools over one MCP endpoint instead of bundling every tool; an `aws-agentcore` runtime that names a gateway is handed its URL and the permission to invoke it.',
    declaredBy: 'gateways[], deployments[].runtime.gateway',
    href: './reference/spec.md#gateway',
    since: '0.1.139',
  },
  {
    id: 'profiles',
    title: 'Delivery profiles with a pinned placement and audit sink',
    detail:
      'A top-level `profile` names a bundle of required controls -- `standard` is the default and `enterprise` is the regulated one -- and a deployment can pin the `cloud`, `region` and `audit` sink it lands in, so the placement and the audit record are properties of the customer rather than of whoever ran the apply. The `profile` gate refuses an `enterprise` spec that omits a region pin, an audit sink, or a guardrail that runs on output.',
    declaredBy: 'profile, deployments[].cloud, deployments[].region, deployments[].audit',
    href: './reference/spec.md#top-level-keys',
    since: '0.1.142',
  },
  {
    id: 'observability-export',
    title: 'A declared place for the spans, and an exporter that reaches it',
    detail:
      'Spec 0.27 gives a document an `observability` block: whether to record spans, what to redact, and whether they belong somewhere other than the process (`export: otlp`, with `endpointEnv` naming the variable that holds the collector address). The `observability/export` gate refuses an `otlp` export beside `trace: false`, and an `enterprise` profile that exports nothing, because an audit trail whose spans stay in the process is not one. Generating with py-fastapi emits `tracing_export_status()` into `app/generated/observability.py`, which the app calls at startup to install an OTLP/HTTP exporter over a batched processor from `aid-runtime-python[otlp]`; nothing is installed on import, so embedding AID does not decide telemetry for you. A target that installs no exporter refuses `export: otlp` rather than accept a destination nothing is sent to.',
    declaredBy: 'observability',
    href: './reference/spec.md#observability',
    // The runtime installs the exporter only when the app calls it, and the generator emits
    // the helper rather than the call because the ASGI entrypoint is developer-owned. The
    // row says "an exporter that reaches it", not "traces arrive at your collector": the
    // collector is still yours to run.
    since: '0.1.150',
  },
  {
    id: 'redact-recording',
    title: 'A withheld field is removed from the text a trace keeps',
    detail:
      '`observability.redact` stopped being a declaration. A pipeline renders a prompt from named bindings, so the generated app knows which value went where and replaces the value of each named field in the text it records with `[redacted:<name>]`: the provider still receives the original, and the copy that outlives the request does not. An omitted list defaults to the field names the security gate already derives as sensitive, so a document that declares nothing is still covered. An agent run has no render -- it binds the same names somewhere else as of 0.1.165: every tool call arrives as a mapping keyed by declared argument names, the runner learns `name -> value` from them, and the gateway -- the only code that writes model text to a span -- redacts both the prompt it records and the answer it records with those bindings. `aid trace export` withholds the same union, reports it as `withheld`, and under `profile: enterprise` refuses a document that withholds nothing. The limit is stated rather than papered over: a value that enters only through the free text of a run request, never passed as a tool argument under its declared name, has no field name to match and is recorded as written. A document that runs an agent and declares no tool at all is refused by name, because its run has no structured record to bind.',
    declaredBy: 'observability.redact',
    href: './reference/spec.md#observability',
    // Honest about the two edges: the free-text channel is not covered, and a no-tool agent
    // document is refused rather than emitted with a guarantee nothing keeps. The row says
    // "the text a trace keeps" (the recorded copy), never "nothing leaks".
    since: '0.1.161',
  },
  {
    id: 'metrics-series',
    title: 'The series the alarms watch, recorded and exported',
    detail:
      'Four series -- `agent.cost`, `agent.tokens`, `eval.cost` and `eval.latency.p95` -- are recorded by `aid-runtime-python` and leave by the same opt-in export as the spans: `configure_metrics()` installs an OTLP/HTTP reader and the generated `metrics_export_status()` reports where it went. A run stopped by a guardrail or an exhausted ceiling publishes what it spent before the refusal propagates, and an eval suite publishes one `eval.cost` and one `eval.latency.p95` sample per case per run under the declared eval id, so the series an alarm filters on is the eval the spec declares. An alert over a series the target does not record is refused by `ir/alerts-unproduced` rather than shipped as an alarm that would never fire; ts-vercel records none and refuses all four.',
    declaredBy: 'observability',
    href: './reference/spec.md#observability',
    // The series are recorded only by py-fastapi, and the row says "recorded and exported"
    // rather than "your dashboard fills in": the collector and the dashboards stay yours.
    since: '0.1.152',
  },
  {
    id: 'fleet-report',
    title: 'A report across every deployment',
    detail:
      '`aid report <dir>` reads one directory of deployments -- each holding the `*.jsonl` files that deployment\'s trace sink wrote and any `*.baseline.json` it committed -- and prints spans, traces, measured cost, p95 latency, errors and baseline scores side by side, then a fleet total. A deployment with no trace files shows a dash rather than `$0.000000`, because "nothing was measured" and "measured zero" are different answers. Nothing is uploaded and nothing is joined to the repository, so the same command runs on a CI artifact download; `--budget` turns the total into a ceiling that fails the job.',
    declaredBy: 'aid report',
    href: './reference/cli.md#report',
    since: '0.1.148',
  },
  {
    id: 'feedback-signals',
    title: 'Declared feedback signals',
    detail:
      'Spec 0.28 lets a document say which feedback it collects (thumbs, corrections, escalations) and which fields may ride along. The `feedback` gate refuses a persistent store with no retention window, and refuses a correction store whose redaction list misses a field the spec already marks sensitive -- so a signal that could carry a customer name cannot be collected without a rule about it. AID routes and stores nothing; the declaration and its refusal are what exist.',
    declaredBy: 'observability.feedback',
    href: './reference/spec.md#observability',
    since: '0.1.146',
  },
  {
    id: 'promotion-gate',
    title: 'Promotion policy for a candidate',
    detail:
      'Spec 0.28 states what a candidate is allowed to cost in quality and in spend: `evals[].gate.promotion` names the baseline prompt version, the quality drop and cost increase it may not exceed, and -- under `enterprise` -- who records the approval. `aid eval --compare` judges a recorded candidate baseline against a recorded accepted one and exits non-zero on a regression. Nothing auto-deploys: promotion is a gate pass plus a file in the tree.',
    declaredBy: 'evals[].gate.promotion',
    href: './reference/spec.md#eval',
    since: '0.1.146',
  },
  {
    id: 'cost-allowance-judged',
    title: 'A spend allowance judged against recorded runs',
    detail:
      'A recorded baseline carries the model spend and wall-clock time of the run that produced it, next to its metric means. `aid eval --compare` computes the relative increase in spend between the accepted and candidate baselines and refuses a candidate above `gate.promotion.allowedCostIncrease`, printing both dollar figures and the move between them. The block is written only when the run metered it, so "spent nothing" and "did not measure" stay distinguishable: a baseline without spend is refused as unjudged rather than read as a zero.',
    declaredBy: 'aid eval --compare, evals[].gate.promotion.allowedCostIncrease',
    href: './reference/cli.md#eval',
    since: '0.1.162',
  },
  {
    id: 'overridable-contract',
    title: 'A stated list of what a customer may change',
    detail:
      'Spec 0.29 adds `overridable`: the base spec names every path an overlay may set and the bound each may move within -- a closed set of values (`from`) or a ceiling (`max`). A path that is not listed is not overridable, so "what may differ per customer" is a reviewable line in the base repo rather than a convention nobody wrote down. Listing a path does not open its children, and `allowWeaken` is a separate permission the base author grants per path.',
    declaredBy: 'overridable',
    href: './reference/spec.md#overridablerule',
    since: '0.1.147',
  },
  {
    id: 'overlay-resolution',
    title: 'One base spec, one file per customer',
    detail:
      'A per-customer overlay names its base and the paths it changes; `aid resolve` writes the concrete spec beside it, so the document that actually deploys is reviewed in the pull request like any other file. Six refusals stand between a customer file and a weakened control: an unlisted path, a relaxed guardrail action, a value outside its bound, a removed CI-gating eval, a profile that disagrees with the base, and a base that is not there. `aid resolve --check` fails in CI when the resolved artifact has drifted from its overlay.',
    declaredBy: 'aid resolve',
    href: './reference/cli.md#resolve',
    since: '0.1.147',
  },
  {
    id: 'fleet-summary',
    title: 'A fleet inventory computed from the tree',
    detail:
      '`aid fleet` discovers every overlay in the repository and reports one row per customer -- profile, pinned models, region, cost ceiling and whether the resolved document still passes every gate today -- with `--json` for a script. Discovery is by content rather than by a directory convention, and the gates are re-run rather than trusted, so `ok` means "passes now" and not "passed once". There is no service to keep warm and no state to drift.',
    declaredBy: 'aid fleet',
    href: './reference/cli.md#fleet',
    since: '0.1.147',
  },
  {
    id: 'golden-path-templates',
    title: 'Two shipped golden paths',
    detail:
      '`aid init --template` scaffolds a spec that already passes the gates instead of an empty one: `support-copilot` is the mid-size path (standard profile, managed services, default budgets) and `enterprise-approvals` is the regulated one (identity, private network, audit sink, and a pause for a human before the write tool). The test suite scaffolds and compiles both, so a template that stops passing a gate breaks the build rather than onboarding someone into a broken spec.',
    declaredBy: 'aid init',
    href: './reference/cli.md#init',
    since: '0.1.147',
  },
  {
    id: 'generated-alarms',
    title: 'Alarms as generated infrastructure',
    detail:
      'Spec 0.30 lets a document declare `observability.alerts`: a metric, a window, a reduction and a threshold, optionally scoped to one agent or eval. The infra planner turns each one into a real alarm -- a CloudWatch alarm in the Terraform env root, a Cloud Monitoring policy on GCP, a `CfnAlarm` in the CDK app -- that pages `alert_channel_ids` and treats missing data as `missing` rather than healthy. The metric list is closed to the four series the deploy plan already derives (`agent.cost`, `agent.tokens`, `eval.cost`, `eval.latency.p95`), so an alarm cannot watch a number nothing produces. The unit comes from the metric rather than the author, so the description and the threshold cannot disagree.',
    declaredBy: 'observability.alerts',
    href: './reference/spec.md#observability',
    // Alarms are emitted and byte-asserted; dashboards are not, and this row must not
    // imply them.
    since: '0.1.149',
  },
  {
    id: 'trace-export',
    title: 'A dataset from the runs you already have',
    detail:
      '`aid trace export --dataset <name>` turns a directory of traced runs into an eval dataset, so the first cases for a new agent come from production traffic instead of from someone guessing what people will ask. One run is one case: the prompt it was first given, the answer it last produced, and the calls, cost, wall time, model and tools beside it. The file is written in the same canonical form the Python `Dataset` writes, so a regenerated dataset diffs cleanly. The exit code separates the two failures that matter -- a run that recorded no payloads (the sink keeps text only when the application ran with `AID_TRACE_CONTENT=1`, and the refusal names that variable) and a file that already exists (refused without `--force`, because it may have been curated by hand since). Every case is tagged `unreviewed`, because `expected` is what the run happened to output: it is a record of behaviour, not a judgement about a good answer, and the honest next step is a person editing the file. The export reads the spec first and applies the policy it finds: it withholds the union of `observability.redact` and `observability.feedback.pii.redact`, reports that set as `withheld` in its JSON output, and under `profile: enterprise` refuses a document that withholds nothing, because nothing would have removed a value before the trace was written.',
    declaredBy: 'aid trace export',
    href: './reference/cli.md#trace',
    since: '0.1.154',
  },
  {
    id: 'eval-unreviewed',
    title: 'Unreviewed cases refuse a CI gate',
    detail:
      '`expected` in an exported case is what a run happened to output, so every case is tagged `unreviewed` and the tag is operative rather than advisory: a `gate.ci: true` eval refuses a dataset that still carries it, naming up to five of the cases and the two ways forward -- review each case and drop the tag, or take the eval out of the gate. A hand-curated dataset is unaffected, and so is an exported one until it is wired into a gate, which is exactly the moment an unexamined expectation would otherwise start deciding whether a change ships. The refusal lives in the runtime `Dataset` layer rather than in generated code, so a module edited by hand keeps it.',
    declaredBy: 'evals[].gate.ci',
    href: './reference/cli.md#trace',
    since: '0.1.160',
  },
  {
    id: 'agent-trajectory-evals',
    title: 'A trajectory eval that runs an agent',
    detail:
      'An eval can name an agent (`target: agent:<id>`) instead of a pipeline, and the `py-fastapi` target -- which declares `agent-evals` -- emits an offline evaluator that runs the agent against each case and scores the calls it made with `tool-trace`, beside the response metrics, within the step and cost ceiling the agent declares. The evaluator drives the agent with a scripted or recorded model, so a case verifies the policy and plumbing of a run -- which tools were reachable, in what order they were called, whether an approval was respected -- and not the quality of a model answer; model quality is what the prompt and pipeline evals measure. A target that does not declare the capability is refused by `ir/eval-trajectory` rather than shipping an eval nothing runs.',
    declaredBy: 'evals[].target',
    href: './reference/spec.md#eval',
    since: '0.1.158',
  },
  {
    id: 'trajectory-capture',
    title: 'A real run, captured so CI can replay it',
    detail:
      '`aid eval --record <path>` makes the recording `AID_EVAL_TRANSCRIPT` replays: it runs the agent against the provider the spec pins and writes each request and response to `<path>` in the same shape replay reads, so a trajectory can be captured once against a real model and then re-run offline. Every agent eval prints a `provenance:` line after its summary -- `scripted` when the agent is declared on the `fake` provider, `recorded` when the turns came from a transcript, `live` otherwise, with the capture path appended when one was written -- because a green gate means something different in each mode. Recording is never automatic: only a run that asked for it writes a transcript, and the combinations that would produce a misleading one are refused instead. The command refuses `--record` beside `--compare`, `--record` unless exactly one suite runs, and `--record` on a target that is not an `agent:`, all as `cli/eval-record-unsupported`; the generated evaluator refuses a capture while `AID_EVAL_TRANSCRIPT` is also set, a capture of a scripted agent, a path that already exists, and a run that made no model call. A captured run is still a check on policy and plumbing rather than on model quality: it describes what the model did when the capture was taken, so a stale recording is a statement about the model that was pinned then.',
    declaredBy: 'aid eval --record',
    href: './reference/cli.md#eval',
    since: '0.1.166',
  },
  {
    id: 'trajectory-metrics',
    title: 'Metrics that score the run, not the answer',
    detail:
      "Spec 0.31 adds three metrics for an agent run: `step-count` (how many model calls a case took, against a ceiling the case sets), `forbidden-tool` (whether the run reached for a tool it was told never to call) and `approval-respected` (whether it stopped at the pauses it was given and honoured the decision it was handed). Each reads the trajectory the offline agent evaluator already produces, so all three need an `agent:` target and a spec naming one elsewhere is refused. The `evals/metrics` gate then refuses a metric that could only ever pass: a `step-count` ceiling at or above the agent's own `maxSteps` is reached by the agent's budget first, and an `approval-respected` metric on an agent with no `humanInTheLoop` and no tool declaring `requiresConfirmation` has no decision to score.",
    declaredBy: 'evals[].metrics',
    href: './reference/spec.md#eval',
    since: '0.1.159',
  },
  {
    id: 'enterprise-eval-coverage',
    title: 'Coverage an enterprise document cannot waive',
    detail:
      'The coverage rule has always named the HTTP pipelines no CI-gating eval claims; from spec 0.31 an `enterprise` document is refused for one instead of warned about, and the same escalation covers a retrieval surface no eval measures. The rule and its diagnostic are unchanged -- what changes is the consequence, keyed to the profile rather than to a flag, so a document cannot claim the change control `enterprise` promises and still ship an unmeasured route. The escalation is version-gated, so a 0.30 document keeps the warning it was written against.',
    declaredBy: 'profile: enterprise',
    href: './reference/spec.md#top-level-keys',
    since: '0.1.159',
  },
];

/**
 * Constructs the spec declares and a gate enforces, that no generator emits.
 *
 * These are the row that makes the inventory honest: a `state` store, a token check and a
 * pause counter are things a document asks for and the build refuses to fake, so they are
 * listed with the declaration that carries them, the gate that enforces it, and what is
 * still the application's to write. They are **not** counted on the homepage band and not
 * rendered under "Out of the box", because neither surface may claim a generated artefact
 * that does not exist. Promote one of these to `SHIPPED_FEATURES` in the release that starts
 * emitting it, and delete its row here.
 *
 * @type {{
 *   id: string, title: string, declares: string, enforces: string,
 *   missing: string, href: string, since: string,
 * }[]}
 */
export const DECLARED_FEATURES = [
  {
    id: 'durable-state',
    title: 'Durable run state',
    declares: 'state, agents[].state',
    enforces: 'ir/agents-state-store',
    missing:
      "The declared store is used for one thing: the checkpoint nonce, claimed in the database the `state` block names so a replay across replicas is refused. The run itself is not persisted -- the generated resume route hands the checkpoint back to the caller -- so a paused run outlives the request, not the process, and resuming after a restart is the application's to arrange. The `state` gate refuses an agent that can write with no store at all.",
    href: './reference/spec.md#agentstate',
    since: '0.1.143',
  },
  {
    id: 'delivery-controls',
    title: 'Durable run state, deployment identity, private network and change approval',
    declares: 'state, deployments[].identity, deployments[].network, deployments[].approvals',
    enforces: 'ir/profile-identity, ir/identity-verified-by',
    missing:
      'What *is* generated: the region pin, the audit sink and the private-network setting reach the OpenTofu, the profile gate refuses an `enterprise` deployment missing any of them, `requiresApproval` reaches the generated tool step, the checkpoint is signed with the key `resume.signingKeyEnv` names, and a declared `state` store holds the checkpoint nonce. What is not: no generator verifies a token (`identity.verifiedBy` names who does), and no generated code persists the paused run itself, so the checkpoint still returns to the caller.',
    href: './reference/spec.md#top-level-keys',
    since: '0.1.143',
  },
];

/**
 * Boundaries the framework refuses, and the diagnostic that enforces each one.
 *
 * Naming a refusal is the same credibility argument the capability gate makes:
 * an unsupported pair is stated once, here, instead of being discovered during an
 * apply. The test asserts every `code` still exists in a diagnostic table.
 *
 * @type {{ id: string, title: string, reason: string, code: string }[]}
 */
export const REFUSALS = [
  {
    id: 'jev-as-generation-model',
    title: 'Jev as a generation model',
    reason:
      'Jev answers a declared decision. It is not in `SERVED_PROVIDERS`, so a `models[]` entry naming it has no adapter and is refused.',
    code: 'ir/provider-unsupported',
  },
  {
    id: 'embeddings-without-endpoint',
    title: 'Embeddings on a provider with no embeddings endpoint',
    reason:
      'The Anthropic Messages API serves chat only, so its adapter does not advertise `embeddings` and a spec that declares it is refused; Bedrock, Vertex AI and the Gemini API do advertise it, because each serves an embedding model over `invoke`, `:predict` and `:batchEmbedContents`.',
    code: 'ir/model-capability-missing',
  },
  {
    id: 'streaming-on-http-api',
    title: 'Streaming on an HTTP API',
    reason:
      'A deployment whose transport cannot stream is refused instead of buffering the response and calling it streaming.',
    code: 'ir/deploy-streaming',
  },
  {
    id: 'unknown-image-registry',
    title: 'An image registry the release workflow cannot log in to',
    reason:
      'A generated release workflow knows four credential paths: the workflow token `ghcr.io` accepts, the repository secret pair `docker.io` names, and the OIDC federation `aws.ecr` and `gcp.artifact-registry` use. A registry id outside that table has no login the emitter can write, so the schema admits no other value and the spec is refused rather than publishing a workflow that fails on the first tag. A cloud registry is named by its id, not its host: the account, region and project are separate fields, and the workflow derives the host from them.',
    code: 'ir/deploy-image-incomplete',
  },
  {
    id: 'image-credentials-not-named',
    title: 'A registry whose login secrets are not named',
    reason:
      'The spec holds the *names* of the repository secrets a login reads, never the values. A `docker.io` image that omits `usernameSecret` or `tokenSecret` is refused, because the emitted workflow would otherwise log in with an empty credential and fail on the first tag. A cloud image is refused the same way when its `roleArn`, `serviceAccount` or `workloadIdentityProvider` is missing, or when it declares a field its registry does not read.',
    code: 'ir/deploy-image-credentials',
  },
  {
    id: 'gcp-edge',
    title: '`edge` on GCP',
    reason:
      'Cloud CDN serves static assets and cannot run the app, so the infra planner refuses the plan instead of emitting part of a project.',
    code: 'cli/infra-cloud-target-unsupported',
  },
  {
    id: 'enterprise-profile-without-audit',
    title: 'An `enterprise` profile with a required control missing',
    reason:
      '`enterprise` is a promise that the controls a regulated deployment cannot go without are present, so a spec that declares it and then omits a region pin, an audit sink, or a guardrail that runs on output is refused by the `profile` gate. The three are reported separately -- `ir/profile-region`, `ir/profile-audit` and `ir/profile-guardrail` -- because each has its own fix, and the gate is what keeps the word `enterprise` from meaning nothing.',
    code: 'ir/profile-audit',
  },
  {
    id: 'enterprise-profile-without-identity',
    title: 'An `enterprise` profile with no identity reference',
    reason:
      "A regulated deployment has to say where a caller is authenticated, so an `enterprise` spec with no `deployments[].identity` is refused by the `profile` gate. The block carries an issuer, an audience and the claim names that become the runtime `Principal`; signature verification stays in `business/`, so AID never holds a tenant's signing key. `network`, `region` and `approvals` are refused separately -- `ir/profile-network` and `ir/profile-approvals` -- because each has its own fix.",
    code: 'ir/profile-identity',
  },
  {
    id: 'enterprise-profile-with-public-network',
    title: 'A private network that is not private, or not declared',
    reason:
      'The `network` block requires `private` to be stated, so a spec that omits it is refused rather than read as false -- silence is not a decision about whether traffic leaves a VPC. Under `enterprise`, `private: false` is refused too, because the profile promises otherwise.',
    code: 'ir/profile-network',
  },
  {
    id: 'enterprise-profile-without-approvals',
    title: 'An `enterprise` profile with no production approval policy',
    reason:
      "A change-control policy is what makes a production apply reviewable, so an `enterprise` spec that deploys to production with no `deployments[].approvals` is refused. The policy is emitted as infrastructure, not read from repository settings: AID writes `infra/approvals.json` and binds it to the plan workflow, and never reads or sets a repo's protection rules.",
    code: 'ir/profile-approvals',
  },
  {
    id: 'export-without-spans',
    title: 'An OTLP export with tracing turned off',
    reason:
      'A destination for spans that are not recorded is a contradiction, so `export: otlp` beside `trace: false` is refused by the `observability/export` gate. The exporter installs itself only when it is called, so the block names a destination the app may reach and the gate keeps the declaration from contradicting itself.',
    code: 'ir/observability-export',
  },
  {
    id: 'enterprise-profile-without-export',
    title: 'An `enterprise` profile whose spans never leave the process',
    reason:
      'The profile promises an audit trail, and a trail that stays inside the process disappears with the process. An `enterprise` document that records spans without exporting them to a collector is refused, which is the same argument the profile already makes about a missing audit sink.',
    code: 'ir/observability-export',
  },
  {
    id: 'agent-eval-target',
    title: 'An eval that targets an agent, on a generator that cannot run one',
    reason:
      'A target is judged by what it declares. `py-fastapi` declares `agent-evals` and emits an offline evaluator that runs the agent against a case and records the calls it made, so an `agent:` target builds there. `ts-vercel` does not declare it, so the gate refuses an `agent:` eval that targets it and names the generator, rather than shipping an eval nothing runs. `agents` alone is not the promise: a target can emit the agent loop without emitting anything that runs one offline.',
    code: 'ir/eval-trajectory',
  },
  {
    id: 'tool-trace-metric',
    title: 'A `tool-trace` metric on a target that returns a response',
    reason:
      'Comparing the tool calls a run made needs a run. A prompt or pipeline target returns one response, which has no trajectory to score, so the metric is refused there and the hint points at `target: agent:<id>`. The three `0.31` trajectory metrics — `step-count`, `forbidden-tool`, `approval-respected` — read the same run, so they are refused on the same targets and the message names the quantity each one asks about. On an agent target `tool-trace` is measured, not refused; `cost` and `latency` ceilings are measured everywhere and each also sets a budget the cost gate and the deploy plan check.',
    code: 'ir/eval-trajectory',
  },
  {
    id: 'unsatisfiable-approval-policy',
    title: 'An approval policy that names fewer reviewers than it requires',
    reason:
      '`approvals.require: [security, platform]` with `minApprovers: 3` is not stricter, it is dead: every change would wait forever. The profile gate refuses it and quotes both numbers back, rather than emitting a workflow binding that reads as governance and behaves as an outage.',
    code: 'ir/profile-approvals',
  },
  {
    id: 'enterprise-agent-writing-with-no-store',
    title: 'An agent that can write, with no durable store',
    reason:
      'An agent that can call a writing tool can be paused mid-write, and a paused run with no store dies with the process, leaving a write the operator cannot account for. So the `state` gate refuses an `enterprise` agent that reaches a `write` or `destructive` tool and declares no state.',
    code: 'ir/agents-state-store',
  },
  {
    id: 'approval-on-a-read',
    title: 'An approval pause in front of a read',
    reason:
      '`requiresApproval` on a tool with no side effects pauses a run to ask a human about a read; the operator learns to approve without reading, which is worse than no approval step at all. The `approvals` gate refuses it, and refuses a pause whose run has nowhere to wait.',
    code: 'ir/approval-step-tool',
  },
  {
    id: 'promotion-without-a-baseline',
    title: 'A promotion policy with no baseline to promote from',
    reason:
      'A promotion compares two named prompt versions, so `gate.promotion.baseline` is required rather than defaulted. Without it the gate could not tell a bump from a no-op, and the CLI would compare a candidate against whatever happened to be in the tree.',
    code: 'ir/prompt-version-stale',
  },
  {
    id: 'promotion-without-a-bump',
    title: 'A promotion of the version already in force',
    reason:
      'Promoting a prompt whose declared version is not greater than the baseline is refused: equal means nothing was bumped, so the candidate is the baseline and there is nothing to promote; behind means a rollback wearing the name of a promotion. Both are named, because the fix differs.',
    code: 'ir/prompt-version-stale',
  },
  {
    id: 'promotion-allowance-governs-nothing',
    title: 'A quality allowance that no metric can spend',
    reason:
      '`allowedQualityDrop` is a budget over a quality metric. An eval whose metrics are all `cost` or `latency` has no quality to spend it on, so the policy is refused rather than read as a looser cost ceiling -- a stale allowance is how a regression ships.',
    code: 'ir/promotion-regression',
  },
  {
    id: 'promotion-cost-ceiling-on-an-eval-with-no-cost',
    title: 'A cost ceiling on an eval that records no cost',
    reason:
      '`allowedCostIncrease` compares two cost measurements. An eval with no `cost` metric records none, so the ceiling would be checked against nothing; the gate refuses it and points at the `cost` metric that would make it real.',
    code: 'ir/promotion-cost',
  },
  {
    id: 'promotion-cost-no-target-measures-spend',
    title: 'A spend allowance no target in the build can measure',
    reason:
      'The allowance is judged against spend a runtime records. When every declared target lacks the `metrics` capability, no generated app will ever write that number, so the policy is refused rather than shipped as a promise nothing can keep. A mixed build still passes: one target that measures is enough.',
    code: 'ir/promotion-cost',
  },
  {
    id: 'enterprise-promotion-without-an-approver',
    title: 'An `enterprise` promotion nobody has to approve',
    reason:
      'The enterprise profile promises recorded change control. A promotion is a change to what production answers, so a `gate.promotion` with no `approval` block is refused under `enterprise` -- and `aid eval --compare` refuses to report a candidate as promotable until the approval record it names exists and is not empty.',
    code: 'ir/promotion-approval',
  },
  {
    id: 'feedback-persisted-forever',
    title: 'Feedback kept forever, or kept without a redaction rule',
    reason:
      'A persistent feedback store with no `retentionDays` is refused, and so is one that collects `correction` text while its `pii.redact` list misses a field the spec already marks sensitive. Collected free text is the most likely place for a customer identifier to end up, so the gate asks both questions at build time rather than at audit time.',
    code: 'ir/feedback-pii',
  },
  {
    id: 'overlay-path-not-overridable',
    title: 'A customer overlay that edits a path the base never opened',
    reason:
      'An overlay is a strict allowlist, not a merge patch: a path absent from the base `overridable` block is refused by name, so a customer file cannot quietly set a field the framework author never considered per-customer. Adding the path to the base is the fix, and it is a diff somebody reviews.',
    code: 'overlay/path-not-overridable',
  },
  {
    id: 'overlay-weakens-control',
    title: 'A customer overlay that relaxes a control',
    reason:
      'Lowering a guardrail from `block` to `flag`, shortening an audit retention, or deleting a path is refused unless the base author wrote `allowWeaken: true` on that exact path -- so a weakened control is a decision recorded in the base repo rather than an edit buried in a customer file.',
    code: 'overlay/weakens-control',
  },
  {
    id: 'overlay-removes-eval',
    title: 'A customer overlay that deletes the eval gating CI',
    reason:
      'No base can permit this one. `allowWeaken` buys a weaker value, never the absence of the check, so an overlay that removes an eval with `gate.ci: true` is refused before the value is even compared. Deleting the `gate.ci` flag and keeping the eval is refused the same way -- it removes the check, not a value.',
    code: 'overlay/removes-eval',
  },
  {
    id: 'overlay-value-out-of-bounds',
    title: 'A customer overlay that moves a value past its declared bound',
    reason:
      'A `from` list is a closed set of values and a `max` is a ceiling, so a cost budget above the ceiling is refused even when the path is overridable and even when weakening is permitted: the bound is the answer, and the hint says which bound was hit.',
    code: 'overlay/value-out-of-bounds',
  },
  {
    id: 'alert-without-an-export',
    title: 'An alarm whose series never leave the process',
    reason:
      'An alarm watches a metric, so the series has to be recorded and has to leave. A document that declares `observability.alerts` without `export: otlp` is refused by the `observability/alerts` gate, because the emitted alarm would watch a series that is recorded into a process that never sends it and stay silent forever -- which reads as health.',
    code: 'ir/alerts-unexported',
  },
  {
    id: 'alert-over-a-series-nothing-produces',
    title: 'An alarm over a series this build never writes',
    reason:
      'A series is only real where the generated runtime writes it, so an alarm over a metric the build does not record is refused by `ir/alerts-unproduced` rather than emitted as an alarm that reports no data forever. The diagnostic names the metric, the target that would have written nothing, and the capability plus `export: otlp` the document needs. py-fastapi records all four -- `agent.cost`, `agent.tokens`, `eval.cost` and `eval.latency.p95` -- while a target that records none refuses every alert in the document.',
    code: 'ir/alerts-unproduced',
  },
  {
    id: 'alert-aggregate-mismatch',
    title: 'An alarm whose reduction the series cannot answer',
    reason:
      'Alerts are limited to the four metrics the deploy plan derives, and each declares which reductions make sense for it. A `p95` over a cost total, or an `average` over a per-eval spend, is refused rather than emitted as an alarm that fires on a quantity nobody meant -- the diagnostic names the metric and the reductions it does support.',
    code: 'ir/alerts-aggregate',
  },
  {
    id: 'alert-naming-an-undeclared-source',
    title: 'An alarm scoped to a name the document does not declare',
    reason:
      'An alarm may name the agent or eval it watches; that name becomes a metric dimension, so a typo would emit an alarm that filters on a value nothing writes and never fires. The gate resolves the name against the document and refuses an unknown one instead of letting it become a permanently silent alarm.',
    code: 'ir/alerts-source',
  },
  {
    id: 'overlay-profile-mismatch',
    title: 'A customer overlay whose profile label disagrees with the spec it resolves to',
    reason:
      "An overlay's `profile` is a checked label, not a second source of truth: it must match what the resolved document actually declares, so a customer file cannot claim `enterprise` control over a base that imposes none. Raising one customer to `enterprise` means marking `profile` overridable in the base and setting it in the overlay, so the stronger controls are gated on the resolved document.",
    code: 'overlay/profile-mismatch',
  },
];

/**
 * The capability families the homepage sells, each claiming a slice of
 * `SHIPPED_FEATURES` by id.
 *
 * The homepage argues *why* the framework exists and `/features` enumerates *what* it
 * gives you, so the band between them is a summary, not a second inventory. Deriving it
 * from the registry is what keeps it a summary: the counts are computed, the rows are
 * rendered, and a family that claims nothing stops the build instead of shipping an
 * empty promise. The partition is asserted too -- every shipped feature belongs to
 * exactly one family -- so a new feature cannot land in the inventory without a family
 * on the page that sells it.
 *
 * @type {{
 *   id: string, title: string, pitch: string, declaredBy: string,
 *   href: string, featureIds: string[],
 * }[]}
 */
export const CAPABILITY_FAMILIES = [
  {
    id: 'models',
    title: 'Model routing and cost',
    pitch:
      'Every call is pinned and priced, so a budget is a number the build can enforce rather than a hope.',
    declaredBy: 'models[]',
    href: './reference/spec.md#model',
    featureIds: [
      'spec-versions',
      'pinned-models',
      'cost-profiles',
      'capability-gate',
      'provider-embeddings',
    ],
  },
  {
    id: 'retrieval',
    title: 'Retrieval and memory',
    pitch:
      'Answers cite the file and offset they came from, whether the source is a managed knowledge base, an object prefix or a local store.',
    declaredBy: 'retrievers[], stores[]',
    href: './reference/spec.md#retriever',
    featureIds: [
      'retrieval-citations',
      'retrieval-remote-sources',
      'retrieval-semantic-chunking',
      'retrieval-refresh-schedule',
      'memory',
      'semantic-cache',
      'bedrock-knowledge-base',
      'vertex-rag',
    ],
  },
  {
    id: 'guardrails',
    title: 'Guardrails and decisions',
    pitch:
      'An unprotected route is refused before it exists, and a judgement can be a checked decision instead of prose.',
    declaredBy: 'guardrails[], decisions[]',
    href: './reference/spec.md#guardrail',
    featureIds: [
      'guardrails',
      'security-gate',
      'bedrock-guardrails',
      'model-armor',
      'decisions',
      'guardrails-decision',
    ],
  },
  {
    id: 'quality',
    title: 'Quality gates',
    pitch:
      'A quality regression fails the build, and every route that reaches users has an eval claiming it.',
    declaredBy: 'evals[]',
    href: './reference/spec.md#eval',
    featureIds: [
      'eval-coverage',
      'evals-decision',
      'promotion-gate',
      'cost-allowance-judged',
      'feedback-signals',
      'trace-export',
      'eval-unreviewed',
      'agent-trajectory-evals',
      'trajectory-capture',
      'trajectory-metrics',
      'enterprise-eval-coverage',
    ],
  },
  {
    id: 'agents',
    title: 'Agents and tools',
    pitch:
      'The plumbing is generated and the tool bodies stay yours; a loop that could run unbounded or unpriced is refused.',
    declaredBy: 'agents[], tools[]',
    href: './reference/spec.md#agent',
    featureIds: ['agents', 'human-in-the-loop', 'durable-state', 'agentcore-gateway'],
  },
  {
    id: 'deploy',
    title: 'Deployment and infrastructure',
    pitch:
      'The Dockerfile, OpenTofu or CDK and CI your cloud needs, plus the profile, region, audit sink and approvals an enterprise review asks for.',
    declaredBy: 'deployments[], aid infra',
    href: './reference/targets.md#capability-matrix',
    featureIds: [
      'infra',
      'cdk',
      'aws-bedrock',
      'gcp-vertex',
      'generated-ci',
      'image',
      'eject',
      'profiles',
      'delivery-controls',
    ],
  },
  {
    id: 'observability',
    title: 'Observability and cost',
    pitch:
      'Traces and costs leave only for the collector your policy names, alarms are generated infrastructure, and one report compares every customer.',
    declaredBy: 'traces[], observability, aid cost, aid report',
    href: './reference/cli.md#trace',
    featureIds: [
      'traces',
      'cost-metric',
      'metrics-series',
      'observability-export',
      'redact-recording',
      'generated-alarms',
      'fleet-report',
    ],
  },
  {
    id: 'fleet',
    title: 'Fleet repeatability',
    pitch:
      'One reviewed base spec, one small overlay per customer: only paths the base opened can move, and the fleet is one command over git.',
    declaredBy: 'overridable, aid resolve, aid fleet',
    href: './reference/cli.md#fleet',
    featureIds: [
      'overridable-contract',
      'overlay-resolution',
      'fleet-summary',
      'golden-path-templates',
    ],
  },
];
