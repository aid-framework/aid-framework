/**
 * The golden-path templates `aid init --template <name>` scaffolds.
 *
 * A template is a whole spec, not a fragment. `aid init` lowers it and runs every gate
 * before it writes anything, so a template that ships here is one `aid validate` and
 * `aid gen` accept on the day it ships; `templates.test.ts` re-checks both.
 *
 * The two differ by profile, and that difference is the point. `support-copilot` is the
 * mid-size golden path: managed defaults, one model, one prompt, one eval whose gate can
 * fail, and no infrastructure to name. `enterprise-approvals` is the enterprise one: an
 * identity provider, a private placement with declared-only egress, an audit sink with a
 * retention floor, durable state, and a human in the loop before the write.
 *
 * Both carry an `overridable` block, because a template is the base half of the overlay
 * workflow: `aid fleet` reads the block as the contract a per-customer overlay may move,
 * and refuses an overlay that exercises anything it does not list.
 */

import { SPEC_VERSION_LATEST } from '@aid-framework/spec';

export const TEMPLATE_NAMES = ['support-copilot', 'enterprise-approvals'] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateSummary {
  readonly name: TemplateName;
  readonly profile: 'standard' | 'enterprise';
  readonly summary: string;
}

export const TEMPLATE_SUMMARIES: readonly TemplateSummary[] = [
  {
    name: 'support-copilot',
    profile: 'standard',
    summary:
      'A support copilot on managed defaults: one model, one reply prompt, guardrails on both sides, and an eval gate.',
  },
  {
    name: 'enterprise-approvals',
    profile: 'enterprise',
    summary:
      'An enterprise claims desk: OIDC, private networking, audit, durable state, and a human approval before a write.',
  },
];

export function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(value);
}

function supportCopilotSpec(projectName: string): string {
  return `specVersion: "${SPEC_VERSION_LATEST}"

project:
  name: ${projectName}
  namespace: acme.support
  description: A support copilot on managed defaults - one triage agent, one reply prompt, guardrails on both sides, and an eval whose gate refuses a quality regression.
  targets:
    - py-fastapi

profile: standard

overridable:
  deployments.api.region:
    from: [us-east-1, eu-west-1]
  models.fast.modelId:
    from: [gpt-4o-mini, gpt-4.1-mini]
  agents.triage_agent.maxCostBudget:
    max: 0.05
  evals.reply_quality.gate.maxRegression:
    max: 0.1

types:
  Reply:
    kind: struct
    fields:
      text:
        type: string
        required: true

models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]
    params:
      temperature: 0.2
      maxTokens: 256
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 256

prompts:
  triage_message:
    version: 1
    model: fast
    template: |
      You summarise one inbound support message in a single sentence.
    output:
      kind: text
  reply_to_message:
    version: 1
    model: fast
    template: |
      You reply to one inbound customer message for the ACME support desk.
      Message: {{ message }}
    variables:
      message:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply

agents:
  triage_agent:
    name: Triage agent
    instructions: triage_message
    model: fast
    guardrails: [message_injection]
    maxSteps: 4
    maxCostBudget: 0.02

guardrails:
  message_injection:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: The message looked like an attempt to override the assistant's instructions.
      log: true
  reply_pii:
    stages: [output]
    policies: [pii-detect]
    action: block
    onFail:
      message: The drafted reply carried contact details, so it was not sent.
      log: true

evals:
  reply_quality:
    target: pipeline:answer_message
    dataset:
      source: file
      uri: evals/reply.jsonl
    metrics:
      - kind: json-schema
        schema: Reply
    gate:
      ci: true
      maxRegression: 0.05

pipelines:

  answer_message:
    description: Reply to one message, refusing a draft that leaks contact details.
    trigger:
      http:
        method: post
        path: /reply
    steps:
      - generate:
          prompt: reply_to_message
          input:
            message: "{{ event.message }}"
          as: reply
      - emit:
          event: Reply

deployments:
  api:
    target: container
    cloud: aws
    region: us-east-1
    streaming: false
    secrets: [OPENAI_API_KEY]`;
}

function enterpriseApprovalsSpec(projectName: string): string {
  return `specVersion: "${SPEC_VERSION_LATEST}"

project:
  name: ${projectName}
  namespace: acme.claims
  description: An enterprise claims desk that names its identity provider, its private placement, the reviewers a change needs, and the humans who approve a write before it happens.
  targets:
    - py-fastapi

profile: enterprise

overridable:
  deployments.prod.region:
    from: [eu-central-1, us-east-1, ap-southeast-2]
  models.triage.modelId:
    from: [gpt-4o-mini, gpt-4.1-mini]
  agents.triage_agent.maxCostBudget:
    max: 2.5
  deployments.prod.audit.retentionDays:
    max: 730

types:
  TicketClassification:
    kind: struct
    fields:
      category:
        type: string
        required: true
  RefundReceipt:
    kind: struct
    fields:
      claim:
        type: string
        required: true
      amount:
        type: number
        required: true

models:
  triage:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema, tools]
    apiKeyEnv: OPENAI_API_KEY
    costProfile: openai-gpt-4o-mini

prompts:
  classify_claim:
    version: 2
    model: triage
    template: |
      Classify the claim below.
      Subject: {{subject}}
    variables:
      subject:
        type: string
        required: true
    output:
      kind: structured
      schema: TicketClassification
  adjudicate_claim:
    version: 1
    model: triage
    template: |
      You adjudicate one insurance claim for the ACME claims desk.
    output:
      kind: text

tools:
  issue_refund:
    description: Issue a refund against a claim.
    input: RefundReceipt
    output: RefundReceipt
    handler:
      kind: business
      symbol: issue_refund
    sideEffects: write
    requiresConfirmation: true
    auth: "isAuthenticated() and hasScope('claims:write')"

state:
  kind: postgres
  urlEnv: DATABASE_URL
  ttlHours: 168
  signingKeyEnv: AID_CHECKPOINT_KEY
  checkpointTtlMinutes: 30
agents:
  triage_agent:
    name: Claims adjudicator
    instructions: adjudicate_claim
    model: triage
    tools: [issue_refund]
    guardrails: [inbound]
    maxSteps: 8
    maxCostBudget: 2.5
    state:
      kind: postgres
      urlEnv: DATABASE_URL
      ttlHours: 24
      signingKeyEnv: AID_CHECKPOINT_KEY
      checkpointTtlMinutes: 30
    humanInTheLoop:
      when: "not hasRole('auto_approver')"
      channel: claims-review

guardrails:
  inbound:
    stages: [input]
    policies: [pii-detect, prompt-injection]
    action: block
    onFail:
      message: The request was rejected by the input guardrail.
      log: true
  outbound:
    stages: [output]
    policies: [pii-detect]
    action: block
    onFail:
      message: The response was rejected by the output guardrail.
      log: true
  tool_calls:
    stages: [tool-call]
    policies: [pii-detect]
    action: block
    tools: [issue_refund]
    onFail:
      message: The tool call was rejected by the tool-call guardrail.
      log: true

observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
  feedback:
    signals:
      rating:
        kind: thumbs
        description: Was this answer useful
      correction:
        kind: correction
        description: The label the agent should have produced
      handoff:
        kind: escalation
        description: The ticket was escalated to a human
    pii:
      redact:
        - subject
    retentionDays: 90
    persistent: true

evals:
  triage_regression:
    target: pipeline:triage
    dataset:
      source: file
      uri: evals/triage.jsonl
    metrics:
      - kind: json-schema
        schema: TicketClassification
    gate:
      ci: true
      maxRegression: 0.05
      minMean: 0.8
      promotion:
        allowedQualityDrop: 0.01
        baseline:
          prompt: classify_claim
          version: 1
        approval:
          by: [platform-lead]
          record: app/approvals/triage.md

deployments:
  prod:
    target: container
    cloud: aws
    region: eu-central-1
    audit:
      sink: cloudwatch
      retentionDays: 400
    identity:
      kind: oidc
      issuer: https://login.example.com
      audience: aid-claims
    network:
      private: true
      egress: declared-only
    approvals:
      require: [security, platform]
      minApprovers: 2
    secrets: [OPENAI_API_KEY]

pipelines:
  triage:
    description: Classify one inbound claim so a human adjudicator can pick it up.
    trigger:
      http:
        method: post
        path: /triage
    steps:
      - generate:
          prompt: classify_claim
          input:
            subject: "{{event.subject}}"
          as: classification
      - emit:
          event: TicketClassification`;
}

function supportCopilotReadme(projectName: string): string {
  return [
    `# ${projectName}`,
    '',
    'A support copilot scaffolded from the `support-copilot` template. It runs on',
    '`profile: standard`, which is the mid-size golden path: managed services, one model,',
    'and nothing to configure that the defaults can answer.',
    '',
    '## What it declares, and why',
    '',
    '- **One model, pinned.** `models.fast` names `gpt-4o-mini` and a `costProfile`, so the',
    '  cost gate has a price to multiply rather than a guess to make.',
    '- **Guardrails on both sides.** `message_injection` screens the input of the agent route,',
    '  and `reply_pii` screens the output of the reply route. Both are enforced inline by the',
    '  generated routes; no step has to name them.',
    '- **An agent with a budget.** `triage_agent` stops at `maxSteps: 4` and `maxCostBudget:',
    '  0.02`, so an unbounded loop is a build error rather than a surprise invoice.',
    '- **An eval whose gate can fail.** `reply_quality` scores the reply against `Reply` with a',
    '  `json-schema` metric and refuses a regression larger than 0.05.',
    '- **An `overridable` contract.** Region, model, the agent budget, and the regression',
    '  ceiling are the only paths a per-customer overlay may move.',
    '',
    '## Two calls the entrypoint makes',
    '',
    '`aid gen` writes `tracing_export_status()` and `metrics_export_status()` into',
    '`app/generated/observability.py`. It cannot call them: the ASGI entrypoint, `app/main.py`,',
    'belongs to you. Call both at startup. This document declares no `observability.export`, so',
    'both calls report `declared=none` and install nothing -- which is the reason the call sits',
    'in the entrypoint rather than in the library: what turns telemetry on is the document, and',
    'the entrypoint only has to be ready for the day one turns it on.',
    '',
    '## Next',
    '',
    '```bash',
    'aid validate        # every gate, with the fix named in each refusal',
    'aid gen             # compile into app/generated/, leaving app/business/ to you',
    'aid eval            # run the eval gate',
    '```',
    '',
    'This project ships one customer already, `customers/acme-eu.yaml`, and it moves only a',
    'region and a spend ceiling:',
    '',
    '```yaml',
    'base: ../app/app.spec.yaml',
    'customer: acme-eu',
    'overrides:',
    '  deployments.api.region: eu-west-1',
    '  agents.triage_agent.maxCostBudget: 0.01',
    '```',
    '',
    'A second customer is that file with a different name, a different region and the same',
    '`base`. Keep `base: ../app/app.spec.yaml` unchanged: the path is relative to the overlay',
    'file, not to the project root, which is the one mistake `aid resolve` cannot guess.',
    '',
    '`aid resolve customers/acme-eu.yaml --out customers/acme-eu.spec.yaml` writes the',
    'resolved spec, and `aid fleet` lists every overlay with its profile, models, region,',
    'ceiling and gate status. An overlay that weakens a control the base does not mark',
    '`allowWeaken` is refused.',
    '',
  ].join('\n');
}

function enterpriseApprovalsReadme(projectName: string): string {
  return [
    `# ${projectName}`,
    '',
    'An enterprise claims desk scaffolded from the `enterprise-approvals` template. It runs',
    'on `profile: enterprise`, and the profile gate is what makes the rest of this list a',
    'requirement rather than a suggestion.',
    '',
    '## What the enterprise profile requires here',
    '',
    '- **Identity.** `deployments.prod.identity` names an OIDC issuer and audience.',
    '- **Private networking.** `network.private: true` with `egress: declared-only`.',
    '- **Audit.** `audit.sink` and a `retentionDays` floor.',
    '- **Approvals on a production change.** `deployments.prod.approvals` requires two',
    '  reviewers from `security` and `platform`.',
    '- **Guardrails on both sides.** `inbound` and `outbound` both exist; an enterprise spec',
    '  with only one of them is refused.',
    '- **Trace export.** `observability.export: otlp` with `endpointEnv`, so spans and the',
    '  cost and latency series leave for a collector. `observability.redact` stays empty on',
    '  purpose: no target applies a redaction set yet, so a non-empty one is refused.',
    '- **Feedback declared, not routed.** `observability.feedback` names three signals, the',
    '  one field (`subject`) their redaction list must cover, a 90-day retention and a',
    '  persistent store. AID generates no feedback endpoint yet: what exists is the',
    '  declaration and the gates that refuse a persistent store with no retention window, or',
    '  a correction store whose redaction list misses a sensitive field.',
    '',
    '## The write, and the human in front of it',
    '',
    '`issue_refund` is `sideEffects: write`, so three gates apply at once: it needs an `auth`',
    'policy, it needs a `tool-call` stage guardrail, and it needs a confirmation flow.',
    '`triage_agent.humanInTheLoop` supplies the last one, and `state` supplies the record of',
    'which checkpoints have already been spent, so a replayed resume is refused. Because the',
    'agent can pause, it is served only over `/agents/triage_agent/run`; a pipeline step has',
    'no checkpoint to return to, and the generator refuses one that would need it.',
    '',
    '## The checkpoint is signed, and it expires',
    '',
    'A pause hands the caller a checkpoint, and a checkpoint replays a conversation and its',
    'pending tool calls. So `state.signingKeyEnv` names an HMAC key in the environment —',
    '`AID_CHECKPOINT_KEY`, never inline — and `state.checkpointTtlMinutes: 30` bounds how long',
    'a checkpoint is worth anything. The generated route refuses a checkpoint it did not sign,',
    'one past its deadline, and one the store has already spent, each as a `403` whose',
    '`detail.reason` says which. Set the key before you deploy: it is required on every agent',
    'run, not only the one that pauses.',
    '',
    'A signature proves the app issued a checkpoint. It does not prove the caller should hold',
    'one, so `/agents/resume` still wants your authentication in front of it.',
    '',
    '## Promotion is gated, never automatic',
    '',
    '`evals.triage_regression.gate.promotion` pins a baseline prompt version and names the',
    'reviewer who must record an approval before a candidate replaces it. A candidate that',
    'drops quality by more than 0.01 is refused.',
    '',
    '## Two calls the entrypoint makes',
    '',
    '`aid gen` writes `tracing_export_status()` and `metrics_export_status()` into',
    '`app/generated/observability.py`. It cannot call them: the ASGI entrypoint, `app/main.py`,',
    'belongs to you. This document declares `export: otlp`, so both install an exporter and both',
    'read `OTEL_EXPORTER_OTLP_ENDPOINT`. Call both: an entrypoint that installed only the tracer',
    'would export spans and publish no cost or latency series, which is the half of the document',
    'the alarm hooks are derived from. Neither call raises, so an unset endpoint leaves the',
    'service serving instead of crash-looping.',
    '',
    '## Next',
    '',
    '```bash',
    'aid validate        # the profile gate names every missing enterprise control',
    'aid gen',
    'aid eval --compare  # score a candidate against the pinned baseline',
    '```',
    '',
    'A per-customer overlay may move a region, a model, an agent budget, or an audit',
    'retention, and nothing else: `aid resolve` refuses a path the base does not list.',
    'This project ships one at `customers/contoso-us.yaml`, which moves only the region, so',
    '`aid fleet` already reports a customer whose profile, region, ceiling and gate status',
    'you can read at a glance.',
    '',
  ].join('\n');
}

export function templateSpec(name: TemplateName, projectName: string): string {
  return name === 'support-copilot'
    ? supportCopilotSpec(projectName)
    : enterpriseApprovalsSpec(projectName);
}

export function templateReadme(name: TemplateName, projectName: string): string {
  return name === 'support-copilot'
    ? supportCopilotReadme(projectName)
    : enterpriseApprovalsReadme(projectName);
}

/** A file a template scaffolds beside the spec, as a project-relative POSIX path. */
export interface TemplateFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The files a template writes besides its spec and README.
 *
 * Both templates ship one customer overlay, because a template is the base half of the
 * multi-customer workflow and a base with no overlay is a demo that stops one command
 * short: `aid fleet` over a fresh scaffold had nothing to read and failed with a hint
 * telling the reader to run the command they had just run. The overlay stays inside the
 * base's own `overridable` block -- it moves a region, and for the mid-size template
 * tightens a budget -- so it resolves on the day it ships and doubles as the worked
 * example the `overridable` contract is explained with.
 */
export function templateFiles(name: TemplateName, specPath: string): readonly TemplateFile[] {
  // An overlay at `customers/<name>.yaml` reaches the spec the same way a reader does, by
  // one level up from the overlay's own directory.
  const base = `../${specPath}`;
  const customer = name === 'support-copilot' ? 'acme-eu' : 'contoso-us';
  const overlay =
    name === 'support-copilot'
      ? [
          `# One customer on the standard template: a different region for data residency`,
          `# and a tighter spend ceiling. Nothing else moves, because nothing else is`,
          `# listed under \`overridable\` in the base spec.`,
          `base: ${base}`,
          `customer: ${customer}`,
          'overrides:',
          '  deployments.api.region: eu-west-1',
          '  agents.triage_agent.maxCostBudget: 0.01',
        ]
      : [
          `# One enterprise customer on its own placement. The region is the only path`,
          `# moved, so the identity, network, audit and approval controls the profile`,
          `# requires stay exactly as the base declares them.`,
          `base: ${base}`,
          `customer: ${customer}`,
          'profile: enterprise',
          'overrides:',
          '  deployments.prod.region: us-east-1',
        ];
  return [{ path: `customers/${customer}.yaml`, text: `${overlay.join('\n')}\n` }];
}
