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
    adds: 'Adds the top-level `observability` block, whose `export: otlp` states where spans go and names the variable holding the collector address instead of leaving the destination to a shell; and widens `evals[].target` to accept `agent:<id>`, which names an agent run so a trajectory metric has a subject.',
  },
  {
    version: '0.28',
    adds: 'Adds `observability.feedback` (declared feedback signals, the fields they may carry and how long they are kept) and `evals[].gate.promotion` (a baseline prompt version, the quality drop and cost increase a candidate may not exceed, and who must record an approval) -- the parts of a self-improvement loop that can be gated from git alone.',
  },
  {
    version: '0.29',
    adds: 'Adds the top-level `overridable` block, which is the only set of paths a per-customer overlay may touch and the bounds each may move within -- so one base spec serves many customers without forking, and an overlay that widens a guardrail, drops a CI-gating eval or exceeds a declared bound is refused by name.',
  },
  {
    version: '0.30',
    adds: 'Adds `observability.alerts`, the metric alarms an operator wants to be paged on: each names one of the four series the deploy plan already derives, a window, an aggregate and a threshold, so the compiler emits the alarm resource instead of a dashboard nobody reads. It requires `observability.export: otlp`, because an alarm over a stream that never leaves the process can never fire.',
  },
  {
    version: '0.31',
    adds: 'Adds the `step-count`, `forbidden-tool` and `approval-respected` eval metrics, which score a run rather than an answer: how many model calls a case took, whether it reached for a tool it was told never to call, and whether it stopped at the pauses it was given and honoured the decision it was handed. Each is only meaningful on an `agent:` target, so a spec that declares one elsewhere is refused by name. From `0.31`, an `enterprise` document with a pipeline or retriever no eval covers is refused rather than warned about, which is the same coverage rule with the consequence an enterprise delivery needs.',
  },
  {
    version: '0.32',
    adds: 'Makes the checkpoint an agent hands back on a pause a signed, expiring capability, and adds `state.signingKeyEnv` (the variable the signing key is read from, a name and never a value) and `state.checkpointTtlMinutes` (how long an issued checkpoint may be presented, 15 minutes when omitted). The generated resume route refuses a checkpoint it did not sign, one past its deadline, and one the declared store has already spent, each as a `403` naming the reason. From `0.32`, an `enterprise` document whose agent can pause is refused by `ir/resume-unsigned` with no signing key and by `ir/resume-replay-weak` with no durable store, because a checkpoint nobody signs is a bearer capability over the call it holds and a nonce nobody remembers refuses nothing across a restart. `ir/resume-key-conflict` and `ir/resume-key-alias` keep the pair unambiguous: one key, one store, one deadline, and never a name another credential already holds.',
  },
  {
    version: '0.33',
    adds: 'Adds `deployments[].identity.verifiedBy`, the name of the component that turns a token into a principal. AID generates no token verification -- the signing keys belong to the customer identity provider -- so an `identity` block alone named an issuer and left the check to nobody in particular, while the docs read as though the generated app enforced it. `verifiedBy` is a declaration, not a generator: it is a module path, a gateway or a service, it never holds a secret, and `enterprise` refuses a deployment that declares `identity` without it (`ir/identity-verified-by`). The generated agent routes keep seeding the anonymous principal and exposing one `current_principal` dependency for the application to override, so a document that omits `verifiedBy` is unchanged and an `enterprise` one cannot ship the seam unexplained.',
  },
];
/**
 * Corrections to labels published outside this page.
 *
 * A release's notes and a merge commit are history: they cannot be rewritten here
 * and they are the first thing a reader who followed a link from them sees. So the
 * correction is rendered above the table, naming what was wrong and what holds.
 */
export const SPEC_VERSION_CORRECTIONS = [
  {
    lead: 'Two published labels were wrong',
    body: 'The merge commit `dfdae40` (PR #171) and the `v0.1.142` release notes both call their work "spec 0.19". It is `0.25`. The constructs they ship are the top-level `profile` and `deployments[].cloud`, `.region` and `.audit`, which this page lists under `0.25`, and `aid validate` refuses them below it: `SECTION_MIN_VERSION.profile` and `DEPLOYMENT_PLACEMENT_MIN_VERSION` are both `0.25`. `0.19` is the floor of an unrelated gate, `RETRIEVAL_INCREMENTAL_MIN_VERSION`, so a document that declared `0.19` on the strength of those labels is refused until it declares `0.25`.',
  },
  {
    lead: 'One row described a refusal that has been lifted',
    body: 'The `0.27` row used to end by saying the IR refuses `agent:<id>` because no generator emits an agent eval. That was true when it was written, and it is not true now. The `py-fastapi` target declares `agent-evals` and emits an offline agent evaluator that runs the agent against a case and records the calls it made, so `ir/eval-trajectory` no longer refuses an `agent:` target there; it refuses a target that does not declare the capability, which today is `ts-vercel`, and [Targets](./targets.md) records that in its matrix. Nothing in the spec language moved: `0.27` is still the version that first parses `agent:<id>`, so no document has to change. A trajectory eval scored this way runs the agent against a scripted or recorded model, so it verifies the policy and plumbing of a run, not the quality of a model.',
  },
  {
    lead: 'One construct was described as unapplied, and now is applied',
    body: 'The `0.27` row and the `observability.redact` reference used to say that no target applied the set, and `aid validate` refused the key with `unsupported-redact` on any document that declared it. That was true when it was written. A pipeline now honours the set: the generated app replaces the value of each named field in the text it records with `[redacted:<name>]`, while the provider still receives the original, so the guarantee is kept on the copy that outlives the request. The refusal survives in one narrowed place -- a document that runs an **agent** -- because the runner re-sends a transcript it assembled and no emitted code can strip a value back out of it; the diagnostic names the fields and points at serving the same work through a pipeline. Note: that correction described the surviving refusal too broadly, and a later release narrowed it further -- see the correction below. Nothing in the spec language moved, so no document has to change: `0.27` is still the version that first parses `redact`, and this is the release that made it real. See [Migrations](../migration.md#redaction-release).',
  },
  {
    lead: 'One correction was itself too broad, and is narrowed here',
    body: 'The correction above said the `unsupported-redact` refusal survives for "a document that runs an **agent**". That was true when it was written and it is not true now. An agent run binds the set where its values arrive named -- the arguments of the tool calls the model composes -- and withholds them from the copy a trace records while the model still receives the original. The refusal survives in a narrower place still: a document that runs an agent and declares no tool at all, which has no argument to bind. Declaring the tool whose arguments carry the fields is the fix, and serving the same work through a pipeline is the alternative; `aid validate` names both. The limit that has no fix in this release is stated rather than hidden: a value that enters a run only through prose has no field name to match, and is recorded as written. Nothing in the spec language moved, so no document has to change.',
  },
];
