/**
 * `aid infra`: what the spec derives, what it refuses to overwrite, and what it will not
 * pretend to have run.
 *
 * The tests are grouped by the three promises that matter, and each is asserted as a
 * property rather than a golden file:
 *
 * 1. Derivation is a function of the spec -- two runs, two projects, same bytes.
 * 2. The generated tree holds derived *shape* only. No account id, region, CIDR, domain
 *    or sizing number can appear, because none of them is a spec fact.
 * 3. Driving OpenTofu never fabricates success. A missing binary and an unconfirmed prod
 *    apply are diagnostics with a non-zero exit, and in both the tool is never invoked.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Spawn } from '../src/context.js';
import { destroyedKnowledgeBases, tofuPlanPath } from '../src/infra/tofu.js';

import { aid, diagnosticsOf, project, recordingSpawn, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

function scratchSpec(spec: string) {
  const made = project(spec);
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

const GENERATED = 'infra/generated';
const TFVARS = `${GENERATED}/deploy.auto.tfvars.json`;
const CDK_CONTEXT = `${GENERATED}/deploy.cdk-context.json`;
const PLAN = `${GENERATED}/deploy.plan.json`;
const MANIFEST = 'infra/aid.infra.manifest.json';

/** Files the emitter owns, as a path-to-content map. */
function emitted(made: ReturnType<typeof project>): Record<string, string> {
  return {
    [PLAN]: made.read(PLAN),
    [TFVARS]: made.read(TFVARS),
    [CDK_CONTEXT]: made.read(CDK_CONTEXT),
    [`${GENERATED}/README.md`]: made.read(`${GENERATED}/README.md`),
  };
}

/** A minimal spec: enough to compile, with no deployments, stores or tasks. */
const TINY = `specVersion: "0.2"
project:
  name: tiny
  targets:
    - py-fastapi
`;

/** A 0.5 document: a manual pipeline and the batch deployment that names it. */
const BATCH_SPEC = `specVersion: "0.5"
project:
  name: nightly
  namespace: aid.test.nightly
  targets: [py-fastapi]
models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
prompts:
  draft:
    version: 1
    model: fast
    template: "Summarise {{ subject }}."
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text
pipelines:
  brief:
    trigger:
      manual: true
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: brief
deployments:
  nightly:
    target: batch
    pipeline: brief
    secrets: []
`;

/**
 * A managed guardrail: the spec names the policy, the provider names the enums, and
 * `emit.ts` is the one seam between them.
 */
const MANAGED_SPEC = `specVersion: "0.11"
project:
  name: shielded
  namespace: aid.test.shielded
  targets: [py-fastapi]
models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
prompts:
  draft:
    version: 1
    model: fast
    template: "Summarise {{ subject }}."
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text
guardrails:
  inbound:
    engine: bedrock
    stages: [input, output]
    action: block
    bedrock:
      content:
        prompt-attack: high
        hate: medium
      pii: [email, credit-card]
      words: [swordfish]
    onFail:
      message: Request rejected.
      log: true
pipelines:
  brief:
    trigger:
      manual: true
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: brief
deployments:
  api:
    target: serverless
    secrets: []
`;

/** The same guardrail, but with the policy left to the operator: no `bedrock:` block. */
const OPERATOR_OWNED_SPEC = `specVersion: "0.11"
project:
  name: shielded
  namespace: aid.test.shielded
  targets: [py-fastapi]
models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
prompts:
  draft:
    version: 1
    model: fast
    template: "Summarise {{ subject }}."
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text
guardrails:
  inbound:
    engine: bedrock
    stages: [input, output]
    action: block
    onFail:
      message: Request rejected.
      log: true
pipelines:
  brief:
    trigger:
      manual: true
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: brief
deployments:
  api:
    target: serverless
    secrets: []
`;

/** Two compute targets in one plan, so both spellings of the role reference are emitted. */
const MANAGED_MULTI_TARGET_SPEC = `specVersion: "0.11"
project:
  name: shielded
  namespace: aid.test.shielded
  targets: [py-fastapi]
models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
prompts:
  draft:
    version: 1
    model: fast
    template: "Summarise {{ subject }}."
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text
guardrails:
  inbound:
    engine: bedrock
    stages: [input, output]
    action: block
    bedrock:
      content:
        hate: medium
    onFail:
      message: Request rejected.
      log: true
pipelines:
  brief:
    trigger:
      manual: true
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: brief
deployments:
  api:
    target: container
    secrets: []
  nightly:
    target: batch
    pipeline: brief
    secrets: []
`;

/** A managed knowledge base and the retriever that reads it. */
const KNOWLEDGE_BASE_SPEC = `specVersion: "0.12"
project:
  name: handbook
  namespace: aid.test.handbook
  targets: [py-fastapi]
models:
  answer:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
  embed:
    provider: bedrock
    modelId: amazon.titan-embed-text-v2:0
    capabilities: [embeddings]
knowledgeBases:
  handbook:
    engine: aws-bedrock
    dataSource:
      kind: s3
      uri: s3://acme-handbook/corpus
    chunking:
      strategy: fixed
      size: 1000
      overlap: 200
    embedModel: embed
    filterable: [tenant]
retrievers:
  docs:
    knowledgeBase: handbook
    topK: 8
prompts:
  reply:
    version: 1
    model: answer
    template: "Answer from the excerpts: {{ context }}"
    variables:
      context:
        type: string
        required: true
    output:
      kind: text
pipelines:
  answer:
    trigger:
      manual: true
    steps:
      - retrieve:
          retriever: docs
          query: "{{ event.question }}"
          as: context
      - generate:
          prompt: reply
          input:
            context: "{{ context }}"
          as: reply
evals:
  retrieval_quality:
    description: Chunk quality for the managed retriever.
    target: pipeline:answer
    dataset:
      source: file
      uri: datasets/handbook.jsonl
    metrics:
      - kind: retrieval
        expectDocs: [intro.md]
        k: 3
    gate:
      ci: true
      maxRegression: 0.05
      samples: 3
deployments:
  api:
    target: serverless
    secrets: []
`;

/**
 * The same plan on GCP. Derived by substitution so the two bases cannot drift: every
 * field the corpus cares about is shared, and only the engine, the bucket and the
 * embedding model differ.
 */
const GCP_KNOWLEDGE_BASE_SPEC = KNOWLEDGE_BASE_SPEC.replace(
  'engine: aws-bedrock',
  'engine: vertex-rag',
)
  .replace('kind: s3', 'kind: gcs')
  .replace('uri: s3://acme-handbook/corpus', 'uri: gs://acme-handbook/corpus')
  .replace(
    `    provider: bedrock
    modelId: amazon.titan-embed-text-v2:0`,
    `    provider: google
    modelId: text-embedding-005`,
  );

/** Everything a derived file must never contain, because the spec does not say it. */
function assertDerivedOnly(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    expect(text, `${path} carries an account id`).not.toMatch(/\b\d{12}\b/);
    expect(text, `${path} carries a CIDR`).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/);
    expect(text, `${path} carries a URL`).not.toMatch(/https?:\/\//);
    for (const key of [
      'account_id',
      'region',
      'cidr',
      'instance_class',
      'min_size',
      'max_size',
      'autoscale',
      'concurrency',
    ]) {
      expect(text, `${path} carries "${key}"`).not.toContain(`"${key}"`);
    }
  }
}

describe('infra gen', () => {
  it('derives the deployment wiring from the example spec', () => {
    const made = scratch();
    const run = aid(made, ['infra', 'gen', '--json']);

    expect(run.code).toBe(0);
    expect(made.walk()).toContain(TFVARS);
    expect(made.walk()).toContain(PLAN);
    expect(made.walk()).toContain(MANIFEST);

    const tfvars = JSON.parse(made.read(TFVARS));
    expect(Object.keys(tfvars.services)).toEqual(['api']);
    expect(tfvars.services.api.target).toBe('container');
    expect(tfvars.services.api.streaming).toBe(true);
    // The example's only HTTP pipeline: `answer_ticket` at post /tickets/answer.
    expect(tfvars.services.api.routes).toEqual([
      { pipeline: 'answer_ticket', method: 'post', path: '/tickets/answer' },
    ]);
    // The deployment's secret is declared; the model's key env may add to it, never
    // subtract, so the assertion is containment rather than equality.
    expect(tfvars.services.api.secret_names).toContain('OPENAI_API_KEY');
    // A container deployment names no pipeline: the key appears only when a job does.
    expect(tfvars.services.api.pipeline).toBeUndefined();
    expect(tfvars.project).toEqual({ name: 'support-copilot', namespace: 'aid.examples.support' });
  });

  it('wires a batch job to the module that runs it', () => {
    const made = scratchSpec(BATCH_SPEC);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const tfvars = JSON.parse(made.read(TFVARS));
    expect(tfvars.services.nightly.target).toBe('batch');
    expect(tfvars.services.nightly.pipeline).toBe('brief');
    expect(tfvars.services.nightly.routes).toEqual([]);

    expect(made.walk()).toContain(`${GENERATED}/modules/batch/main.tf`);
    expect(made.walk()).not.toContain(`${GENERATED}/modules/container/main.tf`);
    expect(made.read(`${GENERATED}/README.md`)).toContain('modules/batch/');
  });

  it('spells a managed guardrail with the provider identifiers, not the spec vocabulary', () => {
    const made = scratchSpec(MANAGED_SPEC);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const tfvars = JSON.parse(made.read(TFVARS));
    expect(tfvars.services.api.guardrail_engines).toEqual(['bedrock']);
    expect(tfvars.guardrails.api).toEqual({
      id: 'inbound',
      message: 'Request rejected.',
      // Content keys are canonicalised, so this is a sorted map to an AWS enum.
      content: [
        { type: 'HATE', strength: 'MEDIUM' },
        { type: 'PROMPT_ATTACK', strength: 'HIGH' },
      ],
      topics: [],
      words: ['swordfish'],
      // Declared order, and BLOCK because the action blocks rather than redacts.
      pii: [
        { type: 'EMAIL', action: 'BLOCK' },
        { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
      ],
    });

    const context = JSON.parse(made.read(CDK_CONTEXT));
    expect(context.guardrails).toEqual(tfvars.guardrails);
    expect(context.services.api.guardrailEngines).toEqual(['bedrock']);
  });

  it('provisions the managed guardrail beside the compute and grants only the runtime call', () => {
    const made = scratchSpec(MANAGED_SPEC);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const main = made.read(`${GENERATED}/modules/serverless/main.tf`);
    expect(main).toContain('resource "aws_bedrock_guardrail" "managed"');
    expect(main).toContain('resource "aws_bedrock_guardrail_version" "managed"');
    expect(main).toContain('resource "aws_iam_role_policy" "guardrail"');
    // Evaluating a guardrail is the app's job; provisioning it is the module's. The role
    // therefore carries the runtime action and none of the provisioning ones.
    expect(main).toContain('"bedrock:ApplyGuardrail"');
    expect(main).not.toContain('bedrock:CreateGuardrail');
    // A live deployment is pinned to a numbered version. `DRAFT` moves with every edit,
    // so wiring the app to it would let a policy change without a plan.
    expect(main).not.toContain('"DRAFT"');
    expect(main).not.toContain('aws_bedrock_guardrail.managed[id].version');
    // The app learns where the guardrail is from the resources, not from a tfvar.
    expect(main).toContain('BEDROCK_GUARDRAIL_ID');
    expect(main).toContain('BEDROCK_GUARDRAIL_VERSION');
    expect(main).toContain('aws_bedrock_guardrail_version.managed[id].version');
  });

  it('attaches the grant to the role each target actually runs under', () => {
    const made = scratchSpec(MANAGED_MULTI_TARGET_SPEC);
    const run = aid(made, ['infra', 'gen', '--json']);
    expect(run.code).toBe(0);

    // ECS keys its task role by service, so the grant does too.
    expect(made.read(`${GENERATED}/modules/container/main.tf`)).toContain(
      'role     = aws_iam_role.task[each.key].id',
    );
    // Batch runs every job under one count-indexed task role. `[each.key]` would not
    // resolve here, and `tofu validate` would reject the module.
    expect(made.read(`${GENERATED}/modules/batch/main.tf`)).toContain(
      'role     = aws_iam_role.task[0].id',
    );
  });

  it('gives a batch job both roles, since only one of them can pull the image', () => {
    const made = scratchSpec(BATCH_SPEC);
    expect(aid(made, ['infra', 'gen', '--json']).code).toBe(0);

    const job = made.read(`${GENERATED}/modules/batch/main.tf`);
    // The task role is what the job's code runs as; the execution role is what Fargate
    // uses to pull the image, write logs and resolve `secrets`. Without the second, the
    // job never starts -- so a job definition that names only the first is not enough.
    expect(job).toContain('taskRoleArn = aws_iam_role.task[0].arn');
    expect(job).toContain('executionRoleArn = aws_iam_role.execution[0].arn');
  });

  it('provisions nothing when the spec names the engine but leaves the policy to its operator', () => {
    // `engine: bedrock` without a `bedrock:` block is the "I already own a guardrail"
    // form. The app still calls Bedrock, but the deployment must not create a second one.
    const made = scratchSpec(OPERATOR_OWNED_SPEC);
    const run = aid(made, ['infra', 'gen', '--json']);
    expect(run.code).toBe(0);

    const tfvars = JSON.parse(made.read(TFVARS));
    expect(tfvars.services.api.guardrail_engines).toEqual(['bedrock']);
    expect(tfvars.guardrails).toEqual({});

    // The module is plan-independent, so it still carries the resources -- but they loop
    // over a local that this plan leaves empty, which is what provisions nothing.
    const main = made.read(`${GENERATED}/modules/serverless/main.tf`);
    expect(main).toContain('for_each = local.managed_guardrails');
    expect(main).toContain('contains(local.serverless[id].guardrail_engines, "bedrock")');
  });

  it('spells a managed knowledge base with the provider identifier, not the alias', () => {
    const made = scratchSpec(KNOWLEDGE_BASE_SPEC);
    const run = aid(made, ['infra', 'gen', '--json']);
    expect(run.code).toBe(0);

    const tfvars = JSON.parse(made.read(TFVARS));
    expect(tfvars.knowledge_bases.handbook).toEqual({
      // Filled by the module after apply: the plan cannot know an id it has not created.
      id: '',
      arn: '',
      engine: 'aws-bedrock',
      data_source: { kind: 's3', uri: 's3://acme-handbook/corpus' },
      chunking: { strategy: 'fixed', size: 1000, overlap: 200 },
      embed_model: 'embed',
      // The provider's identifier, resolved through the alias. Ingestion accepts this
      // string, not the author's alias.
      embed_model_id: 'amazon.titan-embed-text-v2:0',
      env_name: 'BEDROCK_KNOWLEDGE_BASE_HANDBOOK',
      filterable: ['tenant'],
      vector_store: { kind: 'provisioned' },
      retrievers: ['docs'],
    });

    const context = JSON.parse(made.read(CDK_CONTEXT));
    expect(context.knowledgeBases.handbook.embedModel).toBe('embed');
    expect(context.knowledgeBases.handbook.envName).toBe('BEDROCK_KNOWLEDGE_BASE_HANDBOOK');
    // The plan variable list is Terraform's vocabulary; the CDK app must read camelCase.
    expect(made.read(CDK_CONTEXT)).not.toContain('knowledge_bases');
  });

  it('provisions the base beside the compute and grants only the retrieve call', () => {
    const made = scratchSpec(KNOWLEDGE_BASE_SPEC);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    // The module that owns the collection, the base and the data source is emitted once.
    expect(made.walk()).toContain(`${GENERATED}/modules/knowledge-base/main.tf`);
    const base = made.read(`${GENERATED}/modules/knowledge-base/main.tf`);
    expect(base).toContain('resource "aws_opensearchserverless_collection"');
    expect(base).toContain('resource "aws_bedrockagent_knowledge_base"');
    expect(base).toContain('resource "aws_bedrockagent_data_source"');
    // The manifest endpoint requires an OpenSearch Serverless data-access policy, which
    // is what the emitter writes; a base without it plans and then cannot index.
    expect(base).toContain('aws_opensearchserverless_access_policy');
    // Both the collection and the base refuse to be destroyed: re-ingesting a corpus
    // costs API calls and money, so a rename must not be a teardown.
    expect(base.match(/prevent_destroy = true/gu)).toHaveLength(2);

    // The env root wires the module to the compute, but `infra gen` does not write it:
    // it is the user's file. That wiring is held byte-for-byte by
    // `infra-modules.test.ts`, which emits the root with `knowledgeBase: true`.
    const compute = made.read(`${GENERATED}/modules/serverless/main.tf`);
    expect(compute).toContain('resource "aws_iam_role_policy" "knowledge_base"');
    // Retrieval only: generation stays in this project, where the model gate and cost
    // ledger see it.
    expect(compute).toContain('"bedrock:Retrieve"');
    expect(compute).not.toContain('bedrock:StartIngestionJob');
    expect(compute).not.toContain('bedrock:DeleteKnowledgeBase');
    expect(compute).toContain('local.knowledge_base_env[id]');
  });

  it('provisions nothing for a base whose cloud is not the one being generated', () => {
    // A `--cloud gcp` run cannot render an AWS base, and silently dropping it would
    // deploy a service that points at a corpus that does not exist.
    const made = scratchSpec(KNOWLEDGE_BASE_SPEC);
    const run = aid(made, ['infra', 'gen', '--cloud', 'gcp', '--json']);
    expect(run.code).not.toBe(0);
    expect(diagnosticsOf(run).map((d) => d.code)).toContain('cli/infra-knowledge-base-unsupported');
    expect(
      diagnosticsOf(run)
        .map((d) => d.message)
        .join(' '),
    ).toContain('aws-bedrock');
    // Refused before anything is written, so no half-tree is left to `tofu apply`.
    expect(made.walk()).not.toContain(`${GENERATED}/modules/knowledge-base/main.tf`);
    expect(made.walk()).not.toContain(`${GENERATED}/modules/vertex-rag/main.tf`);
  });

  it('refuses a Vertex corpus on AWS, which has nothing to create it', () => {
    const made = scratchSpec(GCP_KNOWLEDGE_BASE_SPEC);
    const run = aid(made, ['infra', 'gen', '--json']);
    expect(run.code).not.toBe(0);
    expect(diagnosticsOf(run).map((d) => d.code)).toContain('cli/infra-knowledge-base-unsupported');
    expect(
      diagnosticsOf(run)
        .map((d) => d.message)
        .join(' '),
    ).toContain('vertex-rag');
  });

  it('provisions a Vertex corpus and imports the prefix on GCP', () => {
    const made = scratchSpec(GCP_KNOWLEDGE_BASE_SPEC);
    expect(aid(made, ['infra', 'gen', '--cloud', 'gcp']).code).toBe(0);

    const corpus = made.read(`${GENERATED}/modules/vertex-rag/main.tf`);
    expect(corpus).toContain('resource "google_vertex_ai_rag_corpus"');
    expect(corpus).toContain('resource "google_vertex_ai_rag_file"');
    // The API-level guard, not only `prevent_destroy`: a plan that removed the resource
    // would still be refused by the provider.
    expect(corpus).toContain('deletion_policy = "PREVENT"');
    expect(corpus).toContain('prevent_destroy');
    // Vertex takes one object per file, so the module lists the prefix and imports each.
    expect(corpus).toContain('data "google_storage_bucket_objects" "source"');
    expect(corpus).toContain('for_each = local.files');
    // The spec's chunking reaches the API rather than being approximated. The numbers
    // come from the plan, not the module bytes, because a module must not vary with a
    // plan -- so this asserts the wiring, and the plan carries the size itself.
    expect(corpus).toContain('fixed_length_chunking');
    expect(corpus).toContain('chunk_size    = local.bases[each.value.base].chunking.size');
    expect(corpus).toContain('chunk_overlap = local.bases[each.value.base].chunking.overlap');

    // One module per engine: the Bedrock module is not emitted for a Vertex base.
    expect(made.walk()).not.toContain(`${GENERATED}/modules/knowledge-base/main.tf`);

    // The compute module receives the base, so retrieval reads the corpus it was given.
    const compute = made.read(`${GENERATED}/modules/cloudrun/main.tf`);
    expect(compute).toContain('knowledge_bases');

    // The runtime reads this name, so the plan must spell it the way the client does.
    expect(made.read(TFVARS)).toContain('VERTEX_RAG_CORPUS_HANDBOOK');
  });

  it('emits derived shape only', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    assertDerivedOnly(emitted(made));
    // Non-vacuity: the spec really does declare `concurrency: 4` and `secrets`, so the
    // scan above is not passing because there was nothing to leak.
    expect(made.read(SPEC_PATH)).toContain('concurrency: 4');
  });

  it('is byte-identical across two projects generated from the same spec', () => {
    const first = scratch();
    const second = scratch();
    expect(aid(first, ['infra', 'gen']).code).toBe(0);
    expect(aid(second, ['infra', 'gen']).code).toBe(0);

    expect(emitted(second)).toEqual(emitted(first));
  });

  it('spells the same plan for both backends', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const tfvars = JSON.parse(made.read(TFVARS));
    const context = JSON.parse(made.read(CDK_CONTEXT));

    expect(context.project).toEqual(tfvars.project);
    expect(Object.keys(context.services)).toEqual(Object.keys(tfvars.services));
    expect(Object.keys(context.services).length).toBeGreaterThan(0);
    for (const id of Object.keys(tfvars.services)) {
      // Routes and env are the facts a backend could silently drop; secrets are renamed
      // rather than re-derived, so this asserts the rename kept every name.
      expect(context.services[id].routes).toEqual(tfvars.services[id].routes);
      expect(context.services[id].env).toEqual(tfvars.services[id].env);
      expect(context.services[id].secrets).toEqual(tfvars.services[id].secret_names);
    }
    expect(Object.keys(context.stores)).toEqual(Object.keys(tfvars.data_stores));
    for (const id of Object.keys(tfvars.data_stores)) {
      expect(context.stores[id].kind).toBe(tfvars.data_stores[id].kind);
    }
    expect(context.tasks).toEqual(tfvars.tasks);
    expect(context.alarms).toEqual(tfvars.alarms);
    // The spelling really is camelCase: a snake_case key left behind would mean the
    // CDK app is reading Terraform's vocabulary and the two could drift.
    expect(made.read(CDK_CONTEXT)).not.toContain('secret_names');
    expect(made.read(CDK_CONTEXT)).not.toContain('data_stores');
  });

  it('is idempotent: a second run changes nothing', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const before = made.snapshot();

    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    expect(made.snapshot()).toEqual(before);
  });

  it('refuses to overwrite a hand edit, and --force discards it', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const edited = `${made.read(TFVARS)}/* hand edit */\n`;
    made.write(TFVARS, edited);

    const refused = aid(made, ['infra', 'gen', '--json']);
    expect(refused.code).toBe(1);
    expect(made.read(TFVARS)).toBe(edited);
    expect(made.exists(`${TFVARS}.aid-rej`)).toBe(true);

    const forced = aid(made, ['infra', 'gen', '--force', '--json']);
    expect(forced.code).toBe(0);
    expect(made.read(TFVARS)).not.toContain('hand edit');
  });

  it('--check reports an ungenerated tree and writes nothing', () => {
    const made = scratch();
    const run = aid(made, ['infra', 'gen', '--check', '--json']);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-generated-outdated']);
    // Nothing was written, including the manifest: a check cannot create the tree it judges.
    expect(made.walk()).toEqual([SPEC_PATH]);
  });

  it('--check passes once the tree is generated', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const before = made.snapshot();

    expect(aid(made, ['infra', 'gen', '--check']).code).toBe(0);
    expect(made.snapshot()).toEqual(before);
  });

  it('handles a spec with no deployments, stores or tasks', () => {
    const made = project(TINY);
    created.push(made);

    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const tfvars = JSON.parse(made.read(TFVARS));
    expect(tfvars.services).toEqual({});
    expect(tfvars.guardrails).toEqual({});
    expect(tfvars.data_stores).toEqual({});
    expect(tfvars.tasks).toEqual([]);
    expect(tfvars.alarms).toEqual([]);
    // The README is still written: a generated tree a reader can open, not an empty dir.
    expect(made.read(`${GENERATED}/README.md`)).toContain('Services: 0');
    assertDerivedOnly(emitted(made));
  });

  it('rejects an unknown subcommand and a missing one', () => {
    const made = scratch();

    const missing = aid(made, ['infra', '--json']);
    expect(missing.code).toBe(2);
    expect(diagnosticsOf(missing).map((d) => d.code)).toEqual(['cli/infra-subcommand-required']);

    const unknown = aid(made, ['infra', 'deploy', '--json']);
    expect(unknown.code).toBe(2);
    expect(diagnosticsOf(unknown).map((d) => d.code)).toEqual(['cli/infra-unknown-subcommand']);
  });
});

describe('infra plan, apply and drift', () => {
  function generated(): ReturnType<typeof project> {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    made.write('infra/envs/dev/.keep', '');
    return made;
  }

  it('refuses to run before the wiring exists, and does not invoke tofu', () => {
    const made = scratch();
    const spawn = recordingSpawn();
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-not-generated']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('runs plan in the env root with the generated var file', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls).toHaveLength(1);
    const [call] = spawn.calls;
    expect(call?.command).toBe('tofu');
    expect(call?.args).toEqual([
      'plan',
      `-out=${tofuPlanPath('dev')}`,
      '-var-file=../../generated/deploy.auto.tfvars.json',
      '-input=false',
      '-no-color',
    ]);
    // The var file is relative to the env root, so that is where the tool must run.
    expect(call?.cwd?.split(/[\\/]/).slice(-3).join('/')).toBe('infra/envs/dev');
  });

  it('warns when the plan would destroy a managed knowledge base', () => {
    const made = generated();
    const planFile = tofuPlanPath('dev');
    const spawn: Spawn = (_command, args) => {
      if (args[0] === 'plan') {
        writeFileSync(planFile, 'saved plan');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'show') {
        return {
          status: 0,
          stdout: JSON.stringify({
            resource_changes: [
              {
                address: 'module.knowledge_base.aws_bedrockagent_knowledge_base.this["handbook"]',
                type: 'aws_bedrockagent_knowledge_base',
                change: { actions: ['delete'] },
              },
              {
                address:
                  'module.knowledge_base.aws_opensearchserverless_collection.vectors["handbook"]',
                type: 'aws_opensearchserverless_collection',
                change: { actions: ['delete'] },
              },
              {
                address: 'module.knowledge_base.aws_bedrockagent_knowledge_base.this["guide"]',
                type: 'aws_bedrockagent_knowledge_base',
                change: { actions: ['delete', 'create'] },
              },
            ],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    // A warning does not change the outcome: a teardown is still allowed.
    expect(run.code).toBe(0);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-knowledge-base-destroy']);
    expect(diagnosticsOf(run)[0]?.severity).toBe('warning');
    // A replacement rebuilds the corpus, so it is not reported as a destroy.
    expect(diagnosticsOf(run)[0]?.message).toContain('handbook');
    expect(diagnosticsOf(run)[0]?.message).not.toContain('guide');
    expect(run.json<{ destroyingKnowledgeBases?: string[] }>().destroyingKnowledgeBases).toEqual([
      'module.knowledge_base.aws_bedrockagent_knowledge_base.this["handbook"]',
    ]);
    // The plan is one command's artifact, so the warning path removes it.
    expect(existsSync(planFile)).toBe(false);
  });

  it('keeps the plan file inside its own directory whatever the env is spelled', () => {
    const planFile = tofuPlanPath('../../etc');
    expect(dirname(planFile)).toBe(dirname(tofuPlanPath('dev')));
    expect(planFile.split(/[\\/]/).pop()).toBe('aws-.._.._etc.tfplan');
  });

  it('reads no destroy out of a plan it cannot parse', () => {
    expect(destroyedKnowledgeBases('not json')).toEqual([]);
    expect(destroyedKnowledgeBases('{}')).toEqual([]);
    expect(destroyedKnowledgeBases(JSON.stringify({ resource_changes: 'nope' }))).toEqual([]);
    expect(destroyedKnowledgeBases(JSON.stringify({ resource_changes: [null, 1, {}] }))).toEqual(
      [],
    );
  });

  it('reports a missing binary as a usage error rather than a passing plan', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: null });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-tofu-missing']);
    expect(run.json<{ status?: number }>().status).toBeUndefined();
  });

  it('refuses to apply to prod without --confirm-prod, before invoking tofu', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--env', 'prod', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-confirm-prod-required']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('applies to prod once confirmed, with auto-approve', () => {
    const made = generated();
    made.write('infra/envs/prod/.keep', '');
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--env', 'prod', '--confirm-prod', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls[0]?.args).toContain('-auto-approve');
  });

  it('distinguishes drift from a failed plan by exit status', () => {
    const made = generated();

    const drifted = aid(made, ['infra', 'drift', '--json'], recordingSpawn({ status: 2 }));
    expect(drifted.code).toBe(1);
    expect(diagnosticsOf(drifted).map((d) => d.code)).toEqual(['cli/infra-drift-detected']);

    const clean = aid(made, ['infra', 'drift', '--json'], recordingSpawn({ status: 0 }));
    expect(clean.code).toBe(0);
    expect(diagnosticsOf(clean)).toEqual([]);
  });

  it('uses -detailed-exitcode only for drift', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 0 });
    aid(made, ['infra', 'drift', '--json'], spawn);
    expect(spawn.calls[0]?.args).toContain('-detailed-exitcode');

    const planSpawn = recordingSpawn({ status: 0 });
    aid(made, ['infra', 'plan', '--json'], planSpawn);
    expect(planSpawn.calls[0]?.args).not.toContain('-detailed-exitcode');
  });

  it('reports a missing env root instead of planning against nothing', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-env-root-missing']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('reports a failing tool with its stderr', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 1, stderr: 'Error: bad reference' });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/infra-tofu-failed');
    expect(diagnostic?.hint).toContain('bad reference');
  });
});

describe('infra on a second cloud', () => {
  /** A plan whose only service is a `serverless` function, which GCP runs on Cloud Run. */
  const SERVERLESS_ONLY = `specVersion: "0.2"
project:
  name: ping
  namespace: aid.test
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: serverless
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      http:
        method: get
        path: /ping
    steps:
      - generate:
          prompt: answer
          as: reply
`;

  /** The same project as a job; GCP runs it as a Cloud Run job. */
  const BATCH_ONLY = `specVersion: "0.5"
project:
  name: ping
  namespace: aid.test
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: batch
    pipeline: ping
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      manual: true
    steps:
      - generate:
          prompt: answer
          as: reply
`;

  /** An edge deployment, which neither cloud has an infra module for. */
  const EDGE_ONLY = `specVersion: "0.5"
project:
  name: ping
  namespace: aid.test
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: edge
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      http:
        method: get
        path: /ping
    steps:
      - generate:
          prompt: answer
          as: reply
`;

  /** An edge deployment whose guardrail asks Bedrock to evaluate it. */
  const MANAGED_EDGE = `specVersion: "0.11"
project:
  name: ping
  namespace: aid.test
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    engine: bedrock
    stages: [input]
    action: block
    bedrock:
      content:
        prompt-attack: high
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: edge
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      http:
        method: get
        path: /ping
    steps:
      - generate:
          prompt: answer
          as: reply
`;

  it('rejects an unknown cloud before writing anything', () => {
    const made = scratch();
    const run = aid(made, ['infra', 'gen', '--cloud', 'mars', '--json']);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-unknown-cloud']);
    expect(made.walk()).not.toContain(TFVARS);
  });

  it('refuses cdk on gcp rather than emitting a tree that cannot synth', () => {
    const made = scratch();
    const run = aid(made, ['infra', 'gen', '--iac', 'cdk', '--cloud', 'gcp', '--json']);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-cloud-backend-unsupported']);
    expect(made.walk()).not.toContain(TFVARS);
  });

  it('emits Cloud Run for the example, and no AWS module', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen', '--cloud', 'gcp']).code).toBe(0);

    const walked = made.walk();
    expect(walked).toContain('infra/generated/modules/cloudrun/main.tf');
    expect(walked.filter((path) => path.includes('/modules/serverless/'))).toEqual([]);
    expect(walked.filter((path) => path.includes('/modules/container/'))).toEqual([]);

    const readme = made.read(`${GENERATED}/README.md`);
    expect(readme).toContain('modules/cloudrun/');
    expect(readme).toContain('infra/envs/gcp-dev');
  });

  it('runs a batch deployment as a Cloud Run job, and no AWS batch module', () => {
    const made = project(BATCH_ONLY);
    created.push(made);

    const run = aid(made, ['infra', 'gen', '--cloud', 'gcp', '--json']);
    expect(run.code).toBe(0);
    const walked = made.walk();
    expect(walked).toContain('infra/generated/modules/cloudrunjob/main.tf');
    expect(walked.filter((path) => path.includes('/modules/batch/'))).toEqual([]);
    expect(walked.filter((path) => path.includes('/modules/cloudrun/'))).toEqual([]);

    const readme = made.read(`${GENERATED}/README.md`);
    expect(readme).toContain('modules/cloudrunjob/');
    // Cloud Batch has no resource in the stable provider, so the README has to name the
    // thing that actually runs the job rather than a resource that does not exist.
    expect(readme).toContain('gcloud run jobs execute');
  });

  it('names the services a cloud cannot deploy rather than silently dropping them', () => {
    const made = project(EDGE_ONLY);
    created.push(made);

    const run = aid(made, ['infra', 'gen', '--cloud', 'gcp', '--json']);
    expect(run.code).toBe(1);
    const refused = diagnosticsOf(run).map((d) => d.code);
    expect(refused).toEqual(['cli/infra-cloud-target-unsupported']);
    // The message has to say which service, or the operator cannot act on it.
    expect(diagnosticsOf(run)[0]?.message).toContain('api');
    expect(made.walk()).not.toContain(TFVARS);
  });

  it('refuses a Bedrock guardrail on GCP, which has nothing to evaluate it', () => {
    const made = project(MANAGED_SPEC);
    created.push(made);

    const run = aid(made, ['infra', 'gen', '--cloud', 'gcp', '--json']);
    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/infra-guardrail-unsupported');
    expect(diagnostic?.message).toContain('api');
    expect(made.walk()).not.toContain(TFVARS);
  });

  it('refuses a Bedrock guardrail on an edge function, which has no environment', () => {
    const made = project(MANAGED_EDGE);
    created.push(made);

    const run = aid(made, ['infra', 'gen', '--json']);
    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/infra-guardrail-unsupported');
    expect(diagnostic?.message).toContain('edge');
    expect(made.walk()).not.toContain(TFVARS);
  });

  it('deploys a serverless service to Cloud Run, since gen2 takes no image', () => {
    const made = project(SERVERLESS_ONLY);
    created.push(made);

    const run = aid(made, ['infra', 'gen', '--cloud', 'gcp', '--json']);
    expect(run.code).toBe(0);
    const walked = made.walk();
    expect(walked).toContain('infra/generated/modules/cloudrun/main.tf');
    expect(walked.filter((path) => path.includes('/modules/serverless/'))).toEqual([]);
    // One image-based packaging model on GCP: the same Dockerfile image serves both, and
    // the generated README says so rather than leaving the operator to guess.
    expect(made.read(`${GENERATED}/README.md`)).toContain(
      'A `serverless` service also lands on Cloud Run',
    );
  });

  it('keeps aws the default, so an existing invocation is unchanged', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    expect(made.walk()).toContain('infra/generated/modules/container/main.tf');
    expect(made.read(`${GENERATED}/README.md`)).toContain('infra/envs/dev');
  });
});

describe('infra with cdk', () => {
  /** One edge service, the smallest plan that still needs a construct. */
  const EDGE_SPEC = `specVersion: "0.5"
project:
  name: ping
  namespace: aid.test.ping
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  ping:
    target: edge
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      http:
        method: get
        path: /ping
    steps:
      - generate:
          prompt: answer
          as: reply
`;

  const RUNTIME_SPEC = `specVersion: "0.13"
project:
  name: runtime
  namespace: aid.test.runtime
  targets: [py-fastapi]
models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
prompts:
  draft:
    version: 1
    model: fast
    template: "Hello."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
pipelines:
  chat:
    trigger:
      http:
        method: post
        path: /chat
    steps:
      - generate:
          prompt: draft
          as: reply
deployments:
  api:
    target: container
    runtime:
      platform: aws-agentcore
    secrets: []
`;

  function cdkGenerated(): ReturnType<typeof project> {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    made.write('infra/cdk/dev/.keep', '');
    return made;
  }

  it('drives the cdk app root with its own argv', () => {
    const made = cdkGenerated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls).toHaveLength(1);
    const [call] = spawn.calls;
    expect(call?.command).toBe('cdk');
    expect(call?.args).toEqual(['diff', '--no-color']);
    // CDK resolves its app from the nearest cdk.json, so the app root is the cwd.
    expect(call?.cwd?.split(/[\\/]/).slice(-3).join('/')).toBe('infra/cdk/dev');
  });

  it('uses --fail only for drift, so plan mirrors tofu plan', () => {
    const made = cdkGenerated();

    const driftSpawn = recordingSpawn({ status: 0 });
    aid(made, ['infra', 'drift', '--iac', 'cdk', '--json'], driftSpawn);
    expect(driftSpawn.calls[0]?.args).toContain('--fail');

    // `cdk diff` exits 0 for a non-empty plan without --fail, exactly as `tofu plan` does
    // without -detailed-exitcode. `plan` reports that the plan ran; `drift` is the gate.
    const planSpawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], planSpawn);
    expect(planSpawn.calls[0]?.args).not.toContain('--fail');
    expect(run.code).toBe(0);
  });

  it('never leaves an apply waiting for an interactive approval', () => {
    const made = cdkGenerated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls[0]?.args).toEqual(['deploy', '--require-approval', 'never', '--no-color']);
  });

  it('keeps the prod confirmation in front of the cdk binary', () => {
    const made = cdkGenerated();
    made.write('infra/cdk/prod/.keep', '');
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--iac', 'cdk', '--env', 'prod', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-confirm-prod-required']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('reads a cdk drift exit as drift, and everything else as a failure', () => {
    const made = cdkGenerated();

    const drifted = aid(
      made,
      ['infra', 'drift', '--iac', 'cdk', '--json'],
      recordingSpawn({ status: 1 }),
    );
    expect(drifted.code).toBe(1);
    expect(diagnosticsOf(drifted).map((d) => d.code)).toEqual(['cli/infra-drift-detected']);

    // CDK has no -detailed-exitcode, so a crash that exits 2 must not read as clean.
    const broken = aid(
      made,
      ['infra', 'drift', '--iac', 'cdk', '--json'],
      recordingSpawn({ status: 2, stderr: 'boom' }),
    );
    expect(broken.code).toBe(1);
    expect(diagnosticsOf(broken).map((d) => d.code)).toEqual(['cli/infra-cdk-failed']);
    expect(diagnosticsOf(broken)[0]?.hint).toContain('boom');
  });

  it('reports a missing cdk as usage, not as a passing plan', () => {
    const made = cdkGenerated();
    const run = aid(
      made,
      ['infra', 'plan', '--iac', 'cdk', '--json'],
      recordingSpawn({ status: null }),
    );

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-cdk-missing']);
    expect(run.json<{ status?: number }>().status).toBeUndefined();
  });

  it('requires the cdk app root rather than running from the project root', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-env-root-missing']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('rejects an unknown backend before spawning anything', () => {
    const made = cdkGenerated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'pulumi', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-unknown-iac']);
    expect(spawn.calls).toHaveLength(0);
  });

  // Every target now has a construct, so the gate admits each one and emits the module
  // that renders it. A `gen` that exits 0 while omitting the module would deploy a
  // partial app, so assert the file rather than the exit code alone.
  it.each([
    ['batch', BATCH_SPEC, 'batch.cjs'],
    ['edge', EDGE_SPEC, 'edge.cjs'],
  ])('emits the %s construct rather than refusing the plan', (_label, spec, file) => {
    const made = scratchSpec(spec);
    const run = aid(made, ['infra', 'gen', '--iac', 'cdk', '--json']);

    expect(run.code).toBe(0);
    expect(made.walk()).toContain(`${GENERATED}/cdk/${file}`);
  });

  it('refuses a managed agent runtime, which has no construct either', () => {
    const made = scratchSpec(RUNTIME_SPEC);
    const run = aid(made, ['infra', 'gen', '--iac', 'cdk', '--json']);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/infra-cloud-backend-unsupported');
    expect(diagnosticsOf(run)[0]?.message).toContain('managed agent runtime');
    expect(made.walk()).not.toContain(TFVARS);
  });

  // `plan` and `apply` read the emitted plan, not the spec, so a `gen` run without
  // `--iac cdk` would otherwise let a partial app be driven.
  it('refuses a saved plan the gate cannot express before spawning cdk', () => {
    const made = scratchSpec(RUNTIME_SPEC);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    made.write('infra/cdk/dev/.keep', '');
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-cloud-backend-unsupported']);
    expect(diagnosticsOf(run)[0]?.message).toContain('managed agent runtime');
    expect(spawn.calls).toHaveLength(0);
  });
});
