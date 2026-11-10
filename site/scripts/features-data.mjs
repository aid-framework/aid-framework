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
    since: '0.1.141',
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
    featureIds: ['eval-coverage', 'evals-decision'],
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
    ],
  },
  {
    id: 'observability',
    title: 'Observability and cost',
    pitch:
      'A trace records what each step did and a cost metric reports what it spent, both read from the same priced profiles the budget gate enforces.',
    declaredBy: 'traces[], aid cost',
    href: './reference/cli.md#trace',
    featureIds: ['traces', 'cost-metric'],
  },
];
