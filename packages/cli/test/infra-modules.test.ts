/**
 * The provider modules: emitted only when a deployment asks for one, constant bytes, and a
 * fixture CI can `tofu validate`.
 *
 * These files are the one place in `infra gen` that emits provider code, so the tests hold
 * them to the reason that was allowed: the bytes must not vary with the plan. A module that
 * varied could not be validated once, and validated-once is the whole argument.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeployPlan } from '@aid-framework/ir';

import { afterAll, describe, expect, it } from 'vitest';

import { emitInfra } from '../src/infra/emit.js';
import {
  BATCH_MODULE_DIR,
  CLOUDRUN_MODULE_DIR,
  CONTAINER_MODULE_DIR,
  emitBatchModule,
  emitCloudRunModule,
  emitContainerModule,
  emitProviderModules,
  emitServerlessModule,
  envRoot,
  modulesOf,
  SERVERLESS_MODULE_DIR,
} from '../src/infra/modules/index.js';
import { aid, diagnosticsOf, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

afterAll(() => {
  for (const made of created) made.close();
});

function scratch(spec?: string) {
  const made = spec === undefined ? project() : project(spec);
  created.push(made);
  return made;
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'infra');

/** The env root the fixture commits: one that has to satisfy every AWS module. */
const BOTH = envRoot({ serverless: true, container: true, batch: true });

/** The GCP env root the fixture commits: Cloud Run is GCP's only module. */
const GCP = envRoot({ serverless: false, container: true }, 'gcp');

/** Enough of a `DeployPlan` to choose a target: the modules ignore everything else. */
function planOf(...targets: string[]): DeployPlan {
  return {
    services: targets.map((target, index) => ({ id: `svc${index}`, target })),
  } as unknown as DeployPlan;
}

/** A plan the spec compiler would produce, with one route and one secret env. */
const SERVING = {
  project: { name: 'ping', namespace: 'aid.test' },
  services: [
    {
      id: 'api',
      target: 'serverless',
      streaming: false,
      endpoints: [{ pipeline: 'ping', method: 'GET', path: '/ping' }],
      env: [
        { name: 'LOG_LEVEL', secret: false, from: 'spec', value: 'info' },
        { name: 'OPENAI_API_KEY', secret: true, from: 'deployment' },
      ],
      secrets: ['OPENAI_API_KEY'],
      providers: [],
      ingest: [],
    },
  ],
  stores: [],
  tasks: [],
  alarms: [],
} as unknown as DeployPlan;

const SERVERLESS = `specVersion: "0.2"
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

const CONTAINER = SERVERLESS.replace('target: serverless', 'target: container');

/** The same compiled plan, retargeted, so the container "constant bytes" test is real. */
const AS_CONTAINER = {
  ...SERVING,
  services: SERVING.services.map((service) => ({ ...service, target: 'container' })),
} as unknown as DeployPlan;

/** The same plan as a batch job: the pipeline it runs is the one thing batch adds. */
const AS_BATCH = {
  ...SERVING,
  services: SERVING.services.map((service) => ({
    ...service,
    target: 'batch',
    pipeline: 'ping',
  })),
} as unknown as DeployPlan;

/** A batch job naming a cloud-native model. */
const BATCH_BEDROCK = {
  ...AS_BATCH,
  services: AS_BATCH.services.map((service) => ({
    ...service,
    providers: ['bedrock'],
  })),
} as unknown as DeployPlan;

/** Both targets at once, so the cloud alone decides which modules exist. */
const MIXED = {
  ...SERVING,
  services: [...SERVING.services, { ...SERVING.services[0], id: 'web', target: 'container' }],
} as unknown as DeployPlan;

/** The same plan naming a cloud-native model, which is what earns an IAM grant. */
const AS_BEDROCK = {
  ...SERVING,
  services: SERVING.services.map((service) => ({ ...service, providers: ['bedrock'] })),
} as unknown as DeployPlan;

/** A serverless version of the same, streaming, so the grant adds the stream action. */
const AS_BEDROCK_STREAMING = {
  ...AS_BEDROCK,
  services: AS_BEDROCK.services.map((service) => ({
    ...service,
    streaming: true,
  })),
} as unknown as DeployPlan;

/** A container service naming a cloud-native model, which is what earns the grant. */
const CONTAINER_BEDROCK = {
  ...AS_CONTAINER,
  services: AS_CONTAINER.services.map((service) => ({
    ...service,
    providers: ['bedrock'],
  })),
} as unknown as DeployPlan;

/** The same, streaming, so the grant must include the streaming action. */
const CONTAINER_BEDROCK_STREAMING = {
  ...CONTAINER_BEDROCK,
  services: CONTAINER_BEDROCK.services.map((service) => ({
    ...service,
    streaming: true,
  })),
} as unknown as DeployPlan;

/** Biome reads a dollar-brace in a plain string as a botched template. */
const dollar = '$';

function mainOf(files: { path: string; contents: string }[]): string {
  return files.find((file) => file.path.endsWith('/main.tf'))?.contents ?? '';
}

function variableOf(files: { path: string; contents: string }[]): string {
  return files.find((file) => file.path.endsWith('/variables.tf'))?.contents ?? '';
}

describe('emitServerlessModule', () => {
  it('emits nothing when no deployment targets serverless', () => {
    expect(emitServerlessModule(planOf())).toEqual([]);
    expect(emitServerlessModule(planOf('container', 'batch', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitServerlessModule(planOf('serverless'));
    expect(files.map((file) => file.path)).toEqual([
      `${SERVERLESS_MODULE_DIR}/versions.tf`,
      `${SERVERLESS_MODULE_DIR}/variables.tf`,
      `${SERVERLESS_MODULE_DIR}/main.tf`,
      `${SERVERLESS_MODULE_DIR}/outputs.tf`,
    ]);
    expect(SERVERLESS_MODULE_DIR).toBe('infra/generated/modules/serverless');
  });

  it('is constant: two different plans yield identical bytes', () => {
    expect(emitServerlessModule(SERVING)).toEqual(emitServerlessModule(planOf('serverless')));
  });

  it('writes Terraform interpolation, not a half-substituted placeholder', () => {
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    expect(main).not.toContain('@{');
    expect(main).toContain(`${dollar}{var.project.namespace}`);
    // A secret is a dynamic reference, so its value never enters state or a plan file.
    expect(main).toContain(`{{resolve:secretsmanager:${dollar}{var.secret_arns`);
  });

  it('grants the function the permission its dynamic references need', () => {
    // Lambda resolves a dynamic reference with the function's own role, so a declared
    // secret is unusable without this statement.
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    expect(main).toContain('secretsmanager:GetSecretValue');
    expect(main).toContain('Resource = values(var.secret_arns)');
  });

  it('grants Bedrock only to the function that names it', () => {
    // The grant is keyed off `providers`, so an OpenAI-only build gets an empty map and
    // Terraform creates no policy at all. The stream action follows `streaming`.
    const main = mainOf(emitServerlessModule(AS_BEDROCK));
    expect(main).toContain('for_each = local.bedrock');
    expect(main).toContain('if contains(service.providers, "bedrock")');
    expect(main).toContain('AWS_REGION = local.bedrock_region');
    expect(main).toContain('each.value.streaming ? ["bedrock:InvokeModelWithResponseStream"] : []');
    // Scoped to foundation models and this account's inference profiles, not `*`.
    expect(main).toContain(':foundation-model/*');
    expect(main).toContain(':inference-profile/*');

    const streaming = mainOf(emitServerlessModule(AS_BEDROCK_STREAMING));
    expect(streaming).toContain('bedrock:InvokeModelWithResponseStream');
  });

  it('makes a legal function name out of a namespace that carries a dot', () => {
    // Lambda names allow letters, digits, hyphens and underscores only.
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    expect(main).toContain('replace(');
    expect(main).toContain('"/[^A-Za-z0-9-_]/"');
    expect(main).toContain('substr(');
  });

  it('refuses what it cannot deliver, in the plan rather than after deploy', () => {
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    // Each refusal is a precondition with a sentence naming the service.
    expect(main).toContain('contains(keys(var.image_uris), each.key)');
    expect(main).toContain('!each.value.streaming');
    expect(main).toContain('contains(keys(var.secret_arns), variable.name)');
    expect(main).toContain('ghcr.io');
  });
});

describe('emitContainerModule', () => {
  it('emits nothing when no deployment targets container', () => {
    expect(emitContainerModule(planOf())).toEqual([]);
    expect(emitContainerModule(planOf('serverless', 'batch', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitContainerModule(planOf('container'));
    expect(files.map((file) => file.path)).toEqual([
      `${CONTAINER_MODULE_DIR}/versions.tf`,
      `${CONTAINER_MODULE_DIR}/variables.tf`,
      `${CONTAINER_MODULE_DIR}/main.tf`,
      `${CONTAINER_MODULE_DIR}/outputs.tf`,
    ]);
    expect(CONTAINER_MODULE_DIR).toBe('infra/generated/modules/container');
  });

  it('is constant: two different plans yield identical bytes', () => {
    expect(emitContainerModule(AS_CONTAINER)).toEqual(emitContainerModule(planOf('container')));
  });

  it('writes Terraform interpolation, not a half-substituted placeholder', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).not.toContain('@{');
    expect(main).toContain(`${dollar}{var.project.namespace}`);
  });

  it('provisions Fargate behind a load balancer', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('aws_ecs_task_definition');
    expect(main).toContain('aws_ecs_service');
    expect(main).toContain('"FARGATE"');
    expect(main).toContain('aws_lb_target_group');
    expect(main).toContain('aws_lb_listener_rule');
    // The generated Dockerfile listens on 8080; the module must agree with it.
    expect(main).toContain('containerPort = 8080');
    expect(main).toContain('port        = 8080');
  });

  it('registers a routed task with its target group', () => {
    // Without this block the listener forwards to a group with no targets: the apply
    // succeeds and every request times out, which is the worst way to be wrong.
    // The block name is singular in the AWS provider; `load_balancers` does not exist.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('dynamic "load_balancer"');
    expect(main).not.toContain('dynamic "load_balancers"');
    expect(main).toContain('target_group_arn = aws_lb_target_group.service[each.key].arn');
    expect(main).toContain('container_name   = "app"');
    expect(main).toContain('container_port   = 8080');
  });

  it('lets the load balancer reach the task and nothing else', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('referenced_security_group_id');
  });

  it('refuses a path two services claim, since an ALB cannot route by method', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('length(local.route_pairs) == length(local.paths)');
    expect(main).toContain('routes by path, not by method');
    expect(main).toContain('contains(keys(var.image_uris), each.key)');
    expect(main).toContain('contains(keys(var.secret_arns), variable.name)');
    // Networking is the other thing an empty input makes invalid rather than absent.
    expect(main).toContain('length(local.public_subnet_ids) >= 2');
    expect(main).toContain('length(local.private_subnet_ids) >= 2');
    expect(main).toContain('var.vpc_cidr != ""');
  });

  it('refuses a load balancer with fewer than two subnets', () => {
    // AWS rejects a one-subnet ALB, so the refusal belongs in the plan, where the
    // message can name the input to fix.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('length(local.public_subnet_ids) >= 2');
  });

  it('refuses to guess a network range', () => {
    // A CIDR is an operator decision, so it is a required input whenever the module
    // builds the VPC -- and the module states no range of its own.
    const files = emitContainerModule(planOf('container'));
    expect(mainOf(files)).toContain('var.vpc_cidr != ""');

    const vars = files.find((file) => file.path.endsWith('/variables.tf'))?.contents ?? '';
    expect(vars).toMatch(/variable "vpc_cidr"[\s\S]{0,200}default\s+= ""/);
    expect(vars).not.toMatch(/variable "vpc_cidr"[\s\S]{0,200}\d+\.\d+\.\d+\.\d+/);
  });

  it('streams, which is the reason to choose a container over serverless', () => {
    // No streaming precondition here: a load balancer delivers a body incrementally.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).not.toContain('!each.value.streaming');
  });

  it('tolerates a service without a health route', () => {
    // The generated app answers 404 on an unknown path, and a 404 still proves the
    // task is serving, so the probe accepts any answer below 500.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('matcher = "200-499"');
  });

  it('grants Bedrock on the task role, where the SDK looks for credentials', () => {
    // The execution role resolves secrets for the agent; the task role is what the app
    // signs an AWS call with. A grant on the wrong one fails at invocation.
    const main = mainOf(emitContainerModule(CONTAINER_BEDROCK));
    expect(main).toContain('resource "aws_iam_role_policy" "bedrock"');
    expect(main).toContain('role     = aws_iam_role.task[each.key].id');
    expect(main).toContain('for_each = local.bedrock');
    expect(main).toContain('if contains(service.providers, "bedrock")');
    expect(main).toContain('AWS_REGION = local.bedrock_region');
    expect(main).toContain('each.value.streaming ? ["bedrock:InvokeModelWithResponseStream"] : []');

    const streaming = mainOf(emitContainerModule(CONTAINER_BEDROCK_STREAMING));
    expect(streaming).toContain('bedrock:InvokeModelWithResponseStream');
  });
});

describe('emitCloudRunModule', () => {
  it('emits nothing when no deployment targets container', () => {
    expect(emitCloudRunModule(planOf())).toEqual([]);
    expect(emitCloudRunModule(planOf('serverless', 'batch', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitCloudRunModule(planOf('container'));
    expect(files.map((file) => file.path)).toEqual([
      `${CLOUDRUN_MODULE_DIR}/versions.tf`,
      `${CLOUDRUN_MODULE_DIR}/variables.tf`,
      `${CLOUDRUN_MODULE_DIR}/main.tf`,
      `${CLOUDRUN_MODULE_DIR}/outputs.tf`,
    ]);
    expect(CLOUDRUN_MODULE_DIR).toBe('infra/generated/modules/cloudrun');
  });

  it('is constant: two different plans yield identical bytes', () => {
    expect(emitCloudRunModule(AS_CONTAINER)).toEqual(emitCloudRunModule(planOf('container')));
  });

  it('writes Terraform interpolation, not a half-substituted placeholder', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).not.toContain('@{');
    expect(main).toContain(`${dollar}{var.project.namespace}`);
  });

  it('runs the image it was given, on the port the Dockerfile reads', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('google_cloud_run_v2_service');
    expect(main).toContain('container_port = 8080');
    // `lookup` so a missing entry becomes the precondition below, not an index error.
    expect(main).toContain('lookup(var.image_uris, each.key, "")');
  });

  it('references a secret instead of inlining it', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('secret_key_ref');
    expect(main).toContain('version = "latest"');
  });

  it('grants the service account read on each secret the service declares', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('google_secret_manager_secret_iam_member');
    expect(main).toContain('roles/secretmanager.secretAccessor');
  });

  it('creates one registry for the images, not one per service', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('google_artifact_registry_repository');
    expect(main).toContain('length(local.container) > 0 ? { images = true } : {}');
  });

  it('makes a legal service name out of a namespace that carries a dot', () => {
    // Cloud Run names allow lowercase letters, digits and hyphens, at most 63 characters.
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('replace(');
    expect(main).toContain('"/[^a-z0-9-]/"');
    expect(main).toContain('substr(');
    expect(main).toContain('63');
  });

  it('streams, because Cloud Run forwards a streamed body', () => {
    const files = emitCloudRunModule(planOf('container'));
    expect(mainOf(files)).not.toContain('!each.value.streaming');
  });

  it('refuses what it cannot deliver, in the plan rather than after deploy', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('contains(keys(var.image_uris), each.key)');
    expect(main).toContain('contains(keys(var.secret_ids), variable.name)');
    expect(main).toContain('must start with a lowercase letter');
  });

  it('requires a region, because a region is an operator decision', () => {
    const variables =
      emitCloudRunModule(planOf('container')).find((file) => file.path.endsWith('/variables.tf'))
        ?.contents ?? '';
    expect(variables).toMatch(/variable "region"[\s\S]{0,160}type\s+= string\n\}/);
    expect(variables).not.toMatch(/variable "region"[\s\S]{0,200}default/);
  });

  it('grants Vertex AI only to a service that names the provider', () => {
    // Same bargain as the AWS modules' Bedrock grant: the service account is the
    // credential, so no key is stored, and the set of grantees is derived from the plan.
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('resource "google_project_iam_member" "vertex"');
    expect(main).toContain('role    = "roles/aiplatform.user"');
    expect(main).toContain('for_each = local.vertex');
    expect(main).toContain('if contains(service.providers, "google")');
  });

  it('tells the Vertex adapter where to call, because Cloud Run does not', () => {
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('GOOGLE_CLOUD_PROJECT = var.project_id');
    expect(main).toContain('GOOGLE_CLOUD_REGION  = var.region');
    // A missing entry means "no Vertex here", not an index error.
    expect(main).toContain('lookup(local.vertex_env, each.key, {})');
  });

  it('lets a declared variable win over the injected default', () => {
    // Pointing a service at another project is a decision; overwriting it is not ours.
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('if !contains([for variable in service.env : variable.name], name)');
  });

  it('requires the project id it has to name in a grant', () => {
    const variables = variableOf(emitCloudRunModule(planOf('container')));
    expect(variables).toMatch(/variable "project_id"[\s\S]{0,160}type\s+= string\n\}/);
    expect(variables).not.toMatch(/variable "project_id"[\s\S]{0,200}default/);
  });

  it('defaults to public invocation but does not grant it silently', () => {
    // Cloud Run authenticates every request unless allUsers is bound; the binding is a
    // separate resource gated on the input rather than something baked into the service.
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('var.allow_unauthenticated ? local.container : {}');
    expect(main).toContain('member   = "allUsers"');
  });
});

describe('envRoot', () => {
  it('declares only the business inputs a present module reads', () => {
    const serverless = envRoot({ serverless: true, container: false });
    expect(serverless.variables).toContain('variable "sizing"');
    expect(serverless.variables).not.toContain('variable "container_sizing"');
    expect(serverless.main).toContain('module "serverless"');
    expect(serverless.main).not.toContain('module "container"');

    const container = envRoot({ serverless: false, container: true });
    expect(container.variables).toContain('variable "container_sizing"');
    expect(container.variables).not.toContain('variable "sizing"');
    expect(container.main).toContain('module "container"');
    expect(container.main).not.toContain('module "serverless"');
  });

  it('calls every module a plan targets', () => {
    expect(BOTH.main).toContain('module "serverless"');
    expect(BOTH.main).toContain('module "container"');
    expect(BOTH.main).toContain('module "batch"');
    expect(BOTH.main).toContain('source = "../../generated/modules/serverless"');
    expect(BOTH.main).toContain('source = "../../generated/modules/container"');
    expect(BOTH.main).toContain('source = "../../generated/modules/batch"');
    expect(BOTH.main).not.toContain('@{');
  });

  it('declares the batch inputs only when a job needs them', () => {
    const batch = envRoot({ serverless: false, container: false, batch: true });
    expect(batch.variables).toContain('variable "batch_sizing"');
    expect(batch.variables).toContain('variable "batch_subnet_ids"');
    expect(batch.variables).toContain('variable "image_uris"');
    expect(batch.main).toContain('module "batch"');
    expect(batch.main).not.toContain('module "container"');
    // A subnet is an account fact: the module refuses an empty list rather than guessing
    // a default VPC, so the variable must not carry a default.
    expect(batch.variables).not.toMatch(/variable "batch_subnet_ids" \{[^}]*default/);
    expect(envRoot({ serverless: true, container: false }).variables).not.toContain(
      'variable "batch_sizing"',
    );
  });

  it('says so rather than inventing a module when neither target is present', () => {
    const none = envRoot({ serverless: false, container: false });
    expect(none.main).not.toContain('module "');
    expect(none.main).toContain('no provider module was');
    expect(none.variables).not.toContain('variable "image_uris"');
    expect(none.variables).not.toContain('variable "batch_sizing"');
  });

  it('separates blocks with one blank line, never two', () => {
    for (const rendered of [BOTH.main, BOTH.variables]) {
      expect(rendered).not.toMatch(/\n\n\n/);
      expect(rendered).not.toMatch(/\{\n\n/);
    }
    expect(BOTH.main).toContain('}\n\nmodule "container"');
    expect(BOTH.main).toContain('}\n\nmodule "batch"');
    expect(BOTH.main).toContain('}\n\noutput "serverless_endpoint"');
  });

  it('is pure: the same module set yields the same bytes', () => {
    expect(envRoot({ serverless: true, container: true, batch: true })).toEqual(BOTH);
  });

  it('configures the GCP provider once, and names no network inputs', () => {
    expect(GCP.main).toContain('provider "google"');
    expect(GCP.main).toContain('project = var.gcp_project');
    expect(GCP.main).toContain('module "cloudrun"');
    expect(GCP.main).toContain('source = "../../generated/modules/cloudrun"');
    // The module names the project in a grant, so the root passes it rather than the
    // module reaching for a default: the project is an account fact, not a spec fact.
    expect(GCP.main).toContain('project_id            = var.gcp_project');
    expect(GCP.variables).toContain('variable "gcp_project"');
    expect(GCP.variables).toContain('variable "region"');
    // Cloud Run terminates TLS and scales behind a managed frontend: no VPC, no CIDR.
    expect(GCP.variables).not.toContain('variable "vpc_id"');
    expect(GCP.variables).not.toContain('variable "vpc_cidr"');
    expect(GCP.variables).not.toContain('variable "public_subnet_ids"');
    expect(GCP.main).not.toContain('module "serverless"');
    expect(GCP.main).not.toContain('module "container"');
  });

  it("does not leak one cloud's variables into the other cloud's root", () => {
    expect(BOTH.variables).not.toContain('variable "gcp_project"');
    expect(GCP.variables).not.toContain('variable "secret_arns"');
    expect(BOTH.main).not.toContain('provider "google"');
  });

  it('keeps the GCP root to one blank line between blocks too', () => {
    for (const rendered of [GCP.main, GCP.variables]) {
      expect(rendered).not.toMatch(/\n\n\n/);
      expect(rendered).not.toMatch(/\{\n\n/);
    }
    expect(GCP.main).toContain('}\n\n# The Cloud Run module');
  });

  it('says what GCP is missing rather than inventing a module', () => {
    const none = envRoot({ serverless: true, container: false }, 'gcp');
    expect(none.main).not.toContain('module "');
    expect(none.main).toContain('only target a');
  });
});

describe('emitBatchModule', () => {
  it('emits nothing when no deployment targets batch', () => {
    expect(emitBatchModule(planOf())).toEqual([]);
    expect(emitBatchModule(planOf('serverless', 'container', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitBatchModule(planOf('batch'));
    expect(files.map((file) => file.path)).toEqual([
      `${BATCH_MODULE_DIR}/versions.tf`,
      `${BATCH_MODULE_DIR}/variables.tf`,
      `${BATCH_MODULE_DIR}/main.tf`,
      `${BATCH_MODULE_DIR}/outputs.tf`,
    ]);
    expect(BATCH_MODULE_DIR).toBe('infra/generated/modules/batch');
  });

  it('is constant: a real plan and a bare target list yield identical bytes', () => {
    expect(emitBatchModule(AS_BATCH)).toEqual(emitBatchModule(planOf('batch')));
  });

  it('names the pipeline as argv, because a job definition knows which job it is', () => {
    const main = mainOf(emitBatchModule(planOf('batch')));
    expect(main).toContain('"python", "-m", "app.generated.batch", coalesce(service.pipeline, "")');
    expect(main).not.toContain('@{');
  });

  it('runs on Fargate behind one managed compute environment and queue', () => {
    const main = mainOf(emitBatchModule(planOf('batch')));
    expect(main).toContain('resource "aws_batch_compute_environment" "fargate"');
    expect(main).toContain('type               = "FARGATE"');
    expect(main).toContain('platform_capabilities = ["FARGATE"]');
    expect(main).toContain('resource "aws_batch_job_queue" "queue"');
    expect(main).toContain('compute_environment = aws_batch_compute_environment.fargate[0].arn');
  });

  it('grants the execution role the secrets its job definitions resolve', () => {
    // A job definition `secrets` entry is resolved by the execution role, not the job, so
    // a declared secret is unusable without this policy.
    const main = mainOf(emitBatchModule(planOf('batch')));
    expect(main).toContain('secretsmanager:GetSecretValue');
    expect(main).toContain('Resource = values(var.secret_arns)');
    expect(main).toContain('secrets     = local.secret_env[each.key]');
  });

  it('gives the job a task role, since a job definition without one has no credentials', () => {
    // A Bedrock call signs with the task role; omitting `taskRoleArn` leaves the job with
    // no AWS credentials at all, and the failure surfaces at invocation, not at plan time.
    const main = mainOf(emitBatchModule(BATCH_BEDROCK));
    expect(main).toContain('resource "aws_iam_role" "task"');
    expect(main).toContain('taskRoleArn = aws_iam_role.task[0].arn');
    expect(main).toContain('resource "aws_iam_role_policy" "bedrock"');
    expect(main).toContain('role  = aws_iam_role.task[0].id');
    expect(main).toContain('anytrue([for service in local.bedrock : service.streaming])');
    expect(main).toContain('AWS_REGION');
  });

  it('refuses the four inputs it cannot guess, at plan time', () => {
    const main = mainOf(emitBatchModule(planOf('batch')));
    expect(main).toContain('precondition');
    expect(main).toContain('names no pipeline');
    expect(main).toContain('must name the image it runs');
    expect(main).toContain('secret with no secret_arns entry');
    expect(main).toContain('without at least one subnet');
  });

  it('exports what a submission needs and nothing more', () => {
    const outputs = emitBatchModule(planOf('batch')).find((file) =>
      file.path.endsWith('/outputs.tf'),
    );
    expect(outputs?.contents).toContain('output "job_queue_arn"');
    expect(outputs?.contents).toContain('output "job_definition_arns"');
    expect(outputs?.contents).toContain('output "log_groups"');
  });
});

describe('modulesOf, the seam emit.ts reads', () => {
  it('reports the platforms a plan targets', () => {
    expect(modulesOf(planOf())).toEqual({ serverless: false, container: false, batch: false });
    expect(modulesOf(planOf('serverless', 'container'))).toEqual({
      serverless: true,
      container: true,
      batch: false,
    });
    expect(modulesOf(planOf('batch'))).toEqual({
      serverless: false,
      container: false,
      batch: true,
    });
    // A target with no module yet must not be mistaken for one that has a module.
    expect(modulesOf(planOf('edge'))).toEqual({
      serverless: false,
      container: false,
      batch: false,
    });
  });

  it('reports what the cloud can emit, not what the target is called', () => {
    // On GCP only `container` has a module, so a serverless plan yields no module even
    // though AWS would have emitted one.
    expect(modulesOf(planOf('container'), 'gcp')).toEqual({
      serverless: false,
      container: true,
      batch: false,
    });
    expect(modulesOf(planOf('serverless'), 'gcp')).toEqual({
      serverless: false,
      container: false,
      batch: false,
    });
    expect(modulesOf(planOf('batch'), 'gcp')).toEqual({
      serverless: false,
      container: false,
      batch: false,
    });
    expect(modulesOf(planOf('container'))).toEqual({
      serverless: false,
      container: true,
      batch: false,
    });
  });

  it('emits every module a plan needs in one call', () => {
    const paths = emitProviderModules(planOf('serverless', 'container')).map((file) => file.path);
    expect(paths).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
    expect(paths).toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
    expect(paths).toHaveLength(8);

    const all = emitProviderModules(planOf('serverless', 'container', 'batch')).map(
      (file) => file.path,
    );
    expect(all).toContain(`${BATCH_MODULE_DIR}/main.tf`);
    expect(all).toHaveLength(12);
  });

  it('emits only the Cloud Run module for a GCP plan', () => {
    const paths = emitProviderModules(MIXED, 'gcp').map((file) => file.path);
    expect(paths).toEqual([
      `${CLOUDRUN_MODULE_DIR}/versions.tf`,
      `${CLOUDRUN_MODULE_DIR}/variables.tf`,
      `${CLOUDRUN_MODULE_DIR}/main.tf`,
      `${CLOUDRUN_MODULE_DIR}/outputs.tf`,
    ]);
  });
});

describe('infra gen with a serverless deployment', () => {
  it('writes the module, and the README points at it', () => {
    const made = scratch(SERVERLESS);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const walked = made.walk();
    for (const name of ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf']) {
      expect(walked, name).toContain(`${SERVERLESS_MODULE_DIR}/${name}`);
    }
    expect(made.read(`${SERVERLESS_MODULE_DIR}/main.tf`)).toContain('aws_lambda_function');
    expect(walked.filter((path) => path.includes('/modules/container/'))).toEqual([]);

    const readme = made.read('infra/generated/README.md');
    expect(readme).toContain('modules/serverless/');
    expect(readme).toContain('module "serverless"');
    expect(readme).not.toContain('modules/container/');
  });

  it('writes no module when the plan targets neither platform', () => {
    const made = scratch(`specVersion: "0.2"
project:
  name: tiny
  targets: [py-fastapi]
`);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(made.walk().filter((path) => path.includes('/modules/'))).toEqual([]);
    expect(made.read('infra/generated/README.md')).toContain('No provider module is generated');
  });

  it('treats a hand-edited module as drift', () => {
    const made = scratch(SERVERLESS);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const path = `${SERVERLESS_MODULE_DIR}/main.tf`;
    made.write(path, `${made.read(path)}# hand edit\n`);

    const check = aid(made, ['infra', 'gen', '--check', '--json']);
    expect(check.code).toBe(1);
    // A hand-edited module is a conflict, not merely an out-of-date file: the tool will
    // not overwrite it, which is the difference between a warning and a refusal.
    expect(diagnosticsOf(check).map((d) => d.code)).toContain('generator/generated-drift');
  });
});

describe('infra gen with a container deployment', () => {
  it('writes the container module and no serverless one', () => {
    const made = scratch(CONTAINER);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(made.walk()).toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
    expect(made.walk().filter((path) => path.includes('/modules/serverless/'))).toEqual([]);
    expect(made.read(`${CONTAINER_MODULE_DIR}/main.tf`)).toContain('aws_ecs_service');

    const readme = made.read('infra/generated/README.md');
    expect(readme).toContain('modules/container/');
    expect(readme).toContain('module "container"');
    expect(readme).not.toContain('variable "sizing"');
  });
});

describe('the validate fixture', () => {
  /** CI runs `tofu validate` here, so the fixture must be exactly what is emitted. */
  it('matches each emitted module byte for byte', () => {
    const cases = [
      { dir: SERVERLESS_MODULE_DIR, files: emitServerlessModule(planOf('serverless')) },
      { dir: CONTAINER_MODULE_DIR, files: emitContainerModule(planOf('container')) },
      { dir: CLOUDRUN_MODULE_DIR, files: emitCloudRunModule(planOf('container')) },
      { dir: BATCH_MODULE_DIR, files: emitBatchModule(planOf('batch')) },
    ];
    for (const { dir, files } of cases) {
      expect(files).toHaveLength(4);
      const platform = dir.slice(dir.lastIndexOf('/') + 1);
      for (const file of files) {
        const name = file.path.slice(dir.length + 1);
        const fixture = readFileSync(join(FIXTURE, 'generated', 'modules', platform, name), 'utf8');
        expect(fixture, `${platform}/${name}`).toBe(file.contents);
      }
    }
  });

  it('matches the documented env root byte for byte', () => {
    const variables = readFileSync(join(FIXTURE, 'envs', 'dev', 'variables.tf'), 'utf8');
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(variables).toBe(BOTH.variables);
    expect(main).toBe(BOTH.main);
  });

  it('matches the GCP env root byte for byte', () => {
    // A second root, not a variant of the AWS one: it is validated separately, because a
    // plan that is wrong on GCP fails for a reason no AWS fixture can reveal.
    const variables = readFileSync(join(FIXTURE, 'envs', 'gcp-dev', 'variables.tf'), 'utf8');
    const main = readFileSync(join(FIXTURE, 'envs', 'gcp-dev', 'main.tf'), 'utf8');
    expect(variables).toBe(GCP.variables);
    expect(main).toBe(GCP.main);
  });

  it('is wired to the modules the emitter writes', () => {
    // A fixture that pointed anywhere else would validate a module nobody gets.
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/serverless"');
    expect(main).toContain('source = "../../generated/modules/container"');
  });

  it('wires the GCP root to the Cloud Run module it ships beside', () => {
    const main = readFileSync(join(FIXTURE, 'envs', 'gcp-dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/cloudrun"');
    expect(main).toContain('provider "google"');
  });
});

describe('the whole derived tree', () => {
  it('keeps the module in the same single emission', () => {
    const files = emitInfra(SERVING);
    expect(files.map((file) => file.path)).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
  });

  it('emits the Cloud Run module, and no AWS module, for a GCP plan', () => {
    const paths = emitInfra(MIXED, { cloud: 'gcp' }).map((file) => file.path);
    expect(paths).toContain(`${CLOUDRUN_MODULE_DIR}/main.tf`);
    expect(paths).not.toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
    expect(paths).not.toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
  });

  it('keeps the AWS modules for an AWS plan of the same targets', () => {
    const paths = emitInfra(MIXED).map((file) => file.path);
    expect(paths).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
    expect(paths).toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
    expect(paths).not.toContain(`${CLOUDRUN_MODULE_DIR}/main.tf`);
  });
});
