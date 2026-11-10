/**
 * `deployment.audit`: the one destination an environment's audit record is written to.
 *
 * The claim these tests protect is narrower than "the sink exists". It is that the sink is
 * *environment-scoped and operator-named*:
 *
 * 1. One module call in the env root, not one per service, because a deployment shares the
 *    destination with its neighbours.
 * 2. Nothing is emitted when the document pins none, so a project that never asked for
 *    audit stays byte-identical to the tree it generated before `audit` existed -- the
 *    env root is embedded in the generated README, so an ungated line would move every
 *    existing hash.
 * 3. The archive bucket's name is an input, never a derivation: an S3 or GCS name is
 *    globally unique, so a derived one can collide and fail at apply.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { aid, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

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
const PLAN = `${GENERATED}/deploy.plan.json`;
const README_PATH = `${GENERATED}/README.md`;
const AUDIT_MAIN = `${GENERATED}/modules/audit/main.tf`;

/**
 * The env root is the operator's file: AID documents it in the generated README rather
 * than writing `infra/envs/*`, so the README is where the module call is asserted.
 */
function readme(made: ReturnType<typeof project>): string {
  return made.read(README_PATH);
}

/** The smallest enterprise document: a region, a sink, an output guardrail, an eval. */
function spec(audit: string, cloud = 'aws'): string {
  const region = cloud === 'gcp' ? 'europe-west1' : 'eu-central-1';
  return `specVersion: "0.25"
project:
  name: ledger
  namespace: aid.test
  targets: [py-fastapi]
profile: enterprise
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
  both:
    engine: ${cloud === 'gcp' ? 'model-armor' : 'bedrock'}
    stages: [input, output]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: container
    cloud: ${cloud}
    region: ${region}
    secrets: [OPENAI_API_KEY]
${audit}
evals:
  answers:
    target: pipeline:ledger
    dataset:
      source: file
      uri: datasets/ledger.jsonl
    metrics:
      - kind: contains
        field: reply
        value: ok
    gate:
      ci: true
pipelines:
  ledger:
    trigger:
      http:
        method: get
        path: /ledger
    steps:
      - generate:
          prompt: answer
          as: reply
`;
}

const CLOUDWATCH = `    audit:
      sink: cloudwatch
      retentionDays: 400`;

const S3 = `    audit:
      sink: s3
      retentionDays: 2555`;

const GCS = `    audit:
      sink: gcs`;

describe('the audit destination', () => {
  it('is carried from the document onto the plan and the tfvars', () => {
    const made = scratchSpec(spec(CLOUDWATCH));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(JSON.parse(made.read(PLAN)).audit).toEqual({
      sink: 'cloudwatch',
      retentionDays: 400,
    });
    // Two spellings of one document: the tfvars keeps snake_case, the CDK context does
    // not. `infra.test.ts` asserts that parity for every other section; this is the one
    // section whose shape is a choice rather than a list.
    expect(JSON.parse(made.read(TFVARS)).audit).toEqual({
      sink: 'cloudwatch',
      retention_days: 400,
    });
    expect(JSON.parse(made.read(`${GENERATED}/deploy.cdk-context.json`)).audit).toEqual({
      sink: 'cloudwatch',
      retentionDays: 400,
    });
  });

  it('is called once by the env root, not once per service', () => {
    const made = scratchSpec(spec(CLOUDWATCH));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const env = readme(made);
    expect(env.match(/module "audit"/g)).toHaveLength(1);
    expect(env).toContain('module.audit.destination');
  });

  it('names the archive bucket as an operator input, because a derived name can collide', () => {
    const made = scratchSpec(spec(S3));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(readme(made)).toContain('variable "audit_bucket_name"');
    expect(readme(made)).toContain(
      'Globally unique name for the audit archive. Required when the sink is s3 or gcs, ignored otherwise.',
    );
  });

  it('asks for no bucket name when the sink needs none', () => {
    // A CloudWatch log group is unique within an account and region, which the derived
    // name already satisfies, so the plan must not make the operator invent one.
    const made = scratchSpec(spec(CLOUDWATCH));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const main = made.read(AUDIT_MAIN);
    expect(main).toContain('resource "aws_cloudwatch_log_group" "audit"');
    // `0` is the provider's spelling of "never expire" for an omitted retention.
    expect(main).toContain('retention_in_days = var.audit.retention_days == null ? 0 :');
  });

  it('turns a declared retention into the sink that can express it', () => {
    const aws = scratchSpec(spec(S3));
    expect(aid(aws, ['infra', 'gen']).code).toBe(0);
    const s3Main = aws.read(AUDIT_MAIN);
    expect(s3Main).toContain('resource "aws_s3_bucket" "audit"');
    expect(s3Main).toContain('bucket = var.audit_bucket_name');
    // An audit archive is never public and never left unversioned.
    expect(s3Main).toContain('resource "aws_s3_bucket_public_access_block" "audit"');
    expect(s3Main).toContain('resource "aws_s3_bucket_versioning" "audit"');
    expect(s3Main).toContain('days = var.audit.retention_days');

    const gcp = scratchSpec(spec(GCS, 'gcp'));
    expect(aid(gcp, ['infra', 'gen']).code).toBe(0);
    const gcsMain = gcp.read(AUDIT_MAIN);
    expect(gcsMain).toContain('resource "google_storage_bucket" "audit"');
    expect(gcsMain).toContain('resource "google_logging_project_sink" "audit"');
    expect(gcsMain).toContain('location                    = var.region');
  });

  it('creates a BigQuery dataset, which is the only GCP sink that can express a retention', () => {
    const made = scratchSpec(
      spec(`    audit:\n      sink: bigquery\n      retentionDays: 365`, 'gcp'),
    );
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const main = made.read(AUDIT_MAIN);
    expect(main).toContain('resource "google_bigquery_dataset" "audit"');
    expect(main).toContain('default_partition_expiration_ms');
    expect(main).toContain('var.audit.retention_days * 86400000');
  });

  it('takes the region from the env root on GCP, never from the pin', () => {
    const made = scratchSpec(spec(GCS, 'gcp'));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const env = readme(made);
    expect(env).toContain('infra/envs/gcp-dev');
    expect(env.match(/module "audit"/g)).toHaveLength(1);
    expect(env).toContain('project_id        = var.gcp_project');
    expect(env).toContain('module.audit.destination');
  });

  it('emits no module at all when the document pins no sink', () => {
    // The standard profile promises no audit sink, so this is the document that must
    // generate exactly what it generated before `audit` existed.
    const made = scratchSpec(spec('').replace('profile: enterprise\n', 'profile: standard\n'));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(made.walk()).not.toContain(AUDIT_MAIN);
    expect(made.walk()).not.toContain(`${GENERATED}/cdk/audit.cjs`);
    expect(JSON.parse(made.read(PLAN))).not.toHaveProperty('audit');
    expect(JSON.parse(made.read(TFVARS))).not.toHaveProperty('audit');
    expect(JSON.parse(made.read(`${GENERATED}/deploy.cdk-context.json`))).not.toHaveProperty(
      'audit',
    );
    // The README embeds the env root, so an ungated row here would rewrite a file every
    // existing project already has.
    const generated = readme(made);
    expect(generated).not.toContain('modules/audit/');
    expect(generated).not.toContain('cdk/audit.cjs');
    expect(generated).not.toContain('module "audit"');
  });

  it('emits the CDK construct beside the module, so both backends provision the sink', () => {
    const made = scratchSpec(spec(CLOUDWATCH));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const construct = made.read(`${GENERATED}/cdk/audit.cjs`);
    expect(construct).toContain('function addAudit(');
    expect(construct).toContain("require('../deploy.cdk-context.json')");
    expect(construct).toContain('CfnDeletionPolicy.RETAIN');
    expect(made.read(README_PATH)).toContain('cdk/audit.cjs');
  });

  it('refuses an s3 sink at synth when no bucket name is supplied', () => {
    const made = scratchSpec(spec(S3));
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    // Same sentence the HCL module's precondition carries: an unnamed archive is
    // refused rather than named on the operator's behalf.
    expect(made.read(`${GENERATED}/cdk/audit.cjs`)).toContain('inputs.auditBucketName is empty');
    expect(made.read(AUDIT_MAIN)).toContain('precondition');
  });
});
