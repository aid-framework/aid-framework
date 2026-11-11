/**
 * What each spec language version adds.
 *
 * The versions and their order mirror `properties.specVersion.enum` in
 * `packages/spec/src/schema/spec.schema.json`; `spec-changelog.test.mjs` fails if the two lists
 * drift. The wording is the history that used to live in that property's description, moved
 * here so `/reference/spec` can name the type instead of rendering 24 versions in a table cell.
 */
export const SPEC_VERSIONS = [
  { version: '0.1', adds: 'The original surface.' },
  {
    version: '0.2',
    adds: 'Adds the closed `agents`, `guardrails`, `memory` and `deployments` sections.',
  },
  {
    version: '0.3',
    adds: 'Adds the `models[].cache` construct (prompt and semantic caching).',
  },
  {
    version: '0.4',
    adds: 'Adds `deployments[].image`, the registry and repository a container image is published to.',
  },
  {
    version: '0.5',
    adds: 'Adds `pipelines[].trigger.manual` and `deployments[].pipeline`, the pair that lets a `target: batch` deployment run one pipeline once to completion.',
  },
  {
    version: '0.6',
    adds: 'Adds the `google` provider (Vertex AI) and the `decisions` section (TypeSafe AI Jev).',
  },
  {
    version: '0.7',
    adds: 'Lets a `guardrails` entry name a decision (`decision` + `onDecision`).',
  },
  {
    version: '0.8',
    adds: 'Adds the `decision` metric kind, which scores an eval prediction with a `score` decision.',
  },
  {
    version: '0.9',
    adds: "Adds the `route` pipeline step, which runs the arm a `choice` decision's answer names.",
  },
  {
    version: '0.10',
    adds: 'Adds the `gemini` provider, which calls the Gemini API with an API key instead of Google Cloud credentials.',
  },
  {
    version: '0.11',
    adds: "Adds `guardrails[].engine` and the `bedrock` policy block, which move a guardrail's policy into a managed AWS Bedrock guardrail.",
  },
  {
    version: '0.12',
    adds: 'Adds `knowledgeBases` and `retrievers[].knowledgeBase`, which bind a retriever to a managed knowledge base (Bedrock Knowledge Bases or Vertex AI RAG) instead of a local source, chunker, embedder and store.',
  },
  {
    version: '0.13',
    adds: 'Adds `deployments[].runtime`, which moves a `container` service onto a managed agent runtime (Amazon Bedrock AgentCore or the Gemini Enterprise Agent Platform) instead of a compute module AID keeps warm.',
  },
  {
    version: '0.14',
    adds: "Adds `engine: model-armor`, which hands a guardrail's policy to Vertex AI Model Armor, the Google Cloud counterpart to a managed Bedrock guardrail.",
  },
  {
    version: '0.15',
    adds: 'Adds the `modelArmor` policy block, which lets the spec own the Model Armor template instead of naming one the operator already created.',
  },
  {
    version: '0.16',
    adds: 'Lets `deployments[].image` name a registry other than `ghcr.io` by naming the repository secrets its login reads, rather than holding a credential value in the spec.',
  },
  {
    version: '0.17',
    adds: "Adds `aws.ecr`, which derives its host from the account and region and assumes an IAM role through GitHub's OIDC provider.",
  },
  {
    version: '0.18',
    adds: 'Adds `gcp.artifact-registry`, which federates through Workload Identity and prefixes the repository path with the project.',
  },
  {
    version: '0.19',
    adds: 'Lets a retriever declare `refresh.mode: incremental`, which embeds only chunks the index does not already hold and deletes the vectors of documents the corpus no longer contains.',
  },
  {
    version: '0.20',
    adds: 'Lets a retriever declare `filters`, the field/operator/value expressions that narrow a query to the passages a tenant or classification allows; a filter is never copied into the generated code as data, so a filter narrows candidates rather than replacing a policy check.',
  },
  {
    version: '0.21',
    adds: 'Adds the `s3` and `http` retriever sources, which load a corpus from an object store or a single URL; `db` and `mcp` remain reserved.',
  },
  {
    version: '0.22',
    adds: 'Implements `chunking.strategy: semantic`, which cuts a document where adjacent-unit embedding similarity dips rather than at a fixed size.',
  },
  {
    version: '0.23',
    adds: "Implements `retrievers[].refresh.schedule`, the UTC five-field cron the compiler turns into a scheduler (`aws_scheduler_schedule` or `google_cloud_scheduler_job`) that submits the batch job running that retriever's ingest.",
  },
  {
    version: '0.24',
    adds: 'Adds `gateways` and `deployments[].runtime.gateway`, which federate tools behind a managed Amazon Bedrock AgentCore Gateway endpoint a runtime reaches over MCP instead of bundling them.',
  },
  {
    version: '0.25',
    adds: "Adds the top-level `profile` -- a named bundle of required controls, `standard` by default -- and `deployments[].cloud`, `.region` and `.audit`, which put the placement and the audit record in the spec instead of in whoever's shell ran the apply.",
  },
  {
    version: '0.26',
    adds: 'Adds the durable `state` store, `deployments[].identity`, `.network` and `.approvals`, and `requiresApproval` on a pipeline tool step -- the control surface an enterprise delivery needs before a run can pause, be audited and be resumed.',
  },
  {
    version: '0.27',
    adds: 'Adds the top-level `observability` block, whose `export: otlp` states where spans go and names the variable holding the collector address instead of leaving the destination to a shell; and widens `evals[].target` to accept `agent:<id>`, which the spec language parses and the IR refuses until a runner carries a trajectory.',
  },
];
