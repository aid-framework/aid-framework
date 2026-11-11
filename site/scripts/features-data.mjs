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
    title: 'A cost ceiling in CI',
    detail:
      'Cost is an eval metric, and the generated workflow exits non-zero when a run exceeds the recorded budget.',
    declaredBy: 'evals[].metrics[].kind: cost',
    href: './reference/spec.md#kind-cost',
    since: '0.1.65',
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
    id: 'delivery-controls',
    title: 'Durable run state, deployment identity, private network and change approval',
    detail:
      'Spec 0.26 declares the controls an enterprise delivery is held to: a `state` store that outlives the process, an `identity` reference (issuer, audience and claim names) that becomes the runtime `Principal`, a `network` block whose `private` pin is required, an `approvals` policy for production change, and `requiresApproval` on a pipeline tool step. The `state` and `approvals` gates refuse a document that declares a control it cannot honour -- an enterprise agent that can write with no store, an approval on a read, or a pause with nowhere to wait.',
    declaredBy: 'state, deployments[].identity, deployments[].network, deployments[].approvals',
    href: './reference/spec.md#top-level-keys',
    // Declared and gated at 0.26; the generators that emit the store, the identity check
    // and the pause land in their own release, so this row does not claim they exist yet.
    since: '0.1.143',
  },
  {
    id: 'observability-export',
    title: 'A declared place for the spans',
    detail:
      'Spec 0.27 gives a document an `observability` block: whether to record spans, what to redact, and whether they belong somewhere other than the process (`export: otlp`, with `endpointEnv` naming the variable that holds the collector address). The `observability/export` gate refuses an `otlp` export beside `trace: false`, and an `enterprise` profile that exports nothing, because an audit trail whose spans stay in the process is not one. AID installs no exporter, so the block states where spans belong; it does not yet send them.',
    declaredBy: 'observability',
    href: './reference/spec.md#observability',
    // `trace` and `redact` are emitted; the export intent is gated, not emitted. The row
    // must not read as "AID ships your traces".
    since: '0.1.145',
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
      'A destination for spans that are not recorded is a contradiction, so `export: otlp` beside `trace: false` is refused by the `observability/export` gate. AID also installs no exporter, so the block declares where spans belong rather than moving them -- and the gate is what keeps the declaration from contradicting itself while that stays true.',
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
    title: 'An eval that targets an agent',
    reason:
      'An agent run has no single response to score: the eval runner calls one prediction per case and hands the metric a string. An `agent:` target is therefore expressible and refused, with the missing runner named -- not reported as an undeclared agent, which would send the author looking for a typo in a name spelled correctly.',
    code: 'ir/eval-trajectory',
  },
  {
    id: 'tool-trace-metric',
    title: 'A `tool-trace` metric',
    reason:
      'Comparing the tool calls a run made needs a trajectory the eval runner does not carry, so the metric is refused rather than reported as unmeasured. `cost` and `latency` ceilings are still accepted, because each also sets a budget the cost gate and the deploy plan already check.',
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
      'An alias resolves to one pinned id, a cost profile prices every call, and a target that cannot serve a declared capability is refused before code is written.',
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
      'Retrieved items carry the path and offsets an answer cites, and a managed knowledge base, an S3 prefix, an HTTP document or a local store is the same declaration.',
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
      'A policy names its stages and its failing action, the security gate refuses an unguarded POST route, and a judgement can be a checked decision rather than prose.',
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
      'An eval declares a regression budget over a dataset, `aid eval` exits non-zero when it is exceeded, and a pipeline with no CI eval is a build error.',
    declaredBy: 'evals[]',
    href: './reference/spec.md#eval',
    featureIds: ['eval-coverage', 'evals-decision', 'promotion-gate', 'feedback-signals'],
  },
  {
    id: 'agents',
    title: 'Agents and tools',
    pitch:
      'A tool loop is generated from the spec while the tool bodies stay yours in `app/business/`, so the plumbing is owned and the logic is not.',
    declaredBy: 'agents[], tools[]',
    href: './reference/spec.md#agent',
    featureIds: ['agents', 'agentcore-gateway'],
  },
  {
    id: 'deploy',
    title: 'Deployment and infrastructure',
    pitch:
      'The same spec emits a Dockerfile, OpenTofu for AWS or GCP, a CDK app, and the project CI that re-runs every gate — then stops owning any of it.',
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
      'A trace records what each step did, a cost metric reports what it spent, and the `observability` block says whether those spans may leave the process at all.',
    declaredBy: 'traces[], observability, aid cost',
    href: './reference/cli.md#trace',
    featureIds: ['traces', 'cost-metric', 'observability-export'],
  },
  {
    id: 'fleet',
    title: 'Fleet repeatability',
    pitch:
      'One base spec serves many customers: an overlay may only touch the paths the base opened, the resolved document is a reviewed file, and the whole fleet is one command over git.',
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
