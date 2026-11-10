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
  AGENT_RUNTIME_MODULE_DIR,
  BATCH_MODULE_DIR,
  CDK_BATCH_MODULE,
  CDK_CONTAINER_MODULE,
  CDK_DIR,
  CDK_EDGE_MODULE,
  CDK_GATEWAY_MODULE,
  CDK_KNOWLEDGE_BASE_MODULE,
  CDK_SERVERLESS_MODULE,
  CLOUDRUN_MODULE_DIR,
  CLOUDRUNJOB_MODULE_DIR,
  CONTAINER_MODULE_DIR,
  EDGE_MODULE_DIR,
  emitAgentRuntimeModule,
  emitBatchModule,
  emitCdkModules,
  emitCloudRunJobModule,
  emitCloudRunModule,
  emitContainerModule,
  emitEdgeModule,
  emitGatewayModule,
  emitKnowledgeBaseModule,
  emitProviderModules,
  emitServerlessModule,
  emitVertexRagModule,
  envRoot,
  GATEWAY_MODULE_DIR,
  KNOWLEDGE_BASE_MODULE_DIR,
  modulesOf,
  SERVERLESS_MODULE_DIR,
  VERTEX_RAG_MODULE_DIR,
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
const BOTH = envRoot({
  serverless: true,
  container: true,
  batch: true,
  edge: true,
  agentRuntime: true,
  gateway: true,
});

/** The GCP env root the fixture commits: Cloud Run and a Cloud Run job. */
const GCP = envRoot({ serverless: false, container: true, batch: true }, 'gcp');

/**
 * A plan with one managed base, one per engine. The two emitters select by engine, so a
 * calibration that only ever saw one engine's plan would let the other emit nothing and
 * still pass.
 */
function managedPlan(engine: 'aws-bedrock' | 'vertex-rag'): DeployPlan {
  const gcp = engine === 'vertex-rag';
  return {
    project: { name: 'kb', namespace: 'aid.test' },
    services: [{ id: 'api', target: gcp ? 'container' : 'serverless' }],
    knowledgeBases: [
      {
        id: 'docs',
        engine,
        dataSource: {
          kind: gcp ? 'gcs' : 's3',
          uri: gcp ? 'gs://aid-kb/docs' : 's3://aid-kb/docs',
        },
        chunking: { strategy: 'fixed', size: 800, overlap: 0 },
        embedModel: 'embed',
        embedModelId: gcp ? 'text-embedding-005' : 'amazon.titan-embed-text-v2:0',
        envName: gcp ? 'VERTEX_RAG_CORPUS_DOCS' : 'BEDROCK_KNOWLEDGE_BASE_DOCS',
        filterable: [],
        vectorStore: { kind: 'provisioned' },
        retrievers: ['docs'],
        preventDestroy: true,
      },
    ],
    gateways: [],
  } as unknown as DeployPlan;
}

const AWS_KB = managedPlan('aws-bedrock');
const GCP_KB = managedPlan('vertex-rag');

/**
 * One gateway with both target kinds, so the module is exercised with the JWT authorizer
 * block and with each branch of the `Mcp` target union. The group also uses a gateway the
 * way a spec would: a snake_case spec name the module has to reduce to a legal CFN name.
 */
const GW = {
  project: { name: 'gw', namespace: 'aid.test' },
  services: [{ id: 'api', target: 'serverless' }],
  knowledgeBases: [],
  gateways: [
    {
      id: 'tools',
      description: 'Federated tools',
      authorizer: {
        kind: 'jwt',
        discoveryUrl: 'https://issuer.example.com/.well-known/openid-configuration',
        audience: ['aid-gateway'],
      },
      targets: [
        {
          id: 'orders',
          source: {
            kind: 'openApiSchema',
            schema: { uri: 's3://aid-gw/orders.json', bucketOwnerAccountId: '123456789012' },
          },
        },
        { id: 'search', source: { kind: 'mcpServer', endpoint: 'https://mcp.example.com/mcp' } },
      ],
      envName: 'AID_GATEWAY_TOOLS_URL',
      runtimes: [],
      cloud: 'aws',
    },
  ],
} as unknown as DeployPlan;

/** The env roots that carry a managed base, so the base modules are validated too. */
const AWS_KB_ROOT = envRoot({
  serverless: true,
  container: true,
  batch: true,
  edge: true,
  knowledgeBase: true,
});
const GCP_KB_ROOT = envRoot(
  { serverless: false, container: true, batch: true, knowledgeBase: true },
  'gcp',
);

/**
 * One service handed to a managed runtime. Container-only, as the spec layer enforces,
 * with short-term memory on so the platform resource and its env var are exercised.
 */
function runtimePlan(cloud: 'aws' | 'gcp'): DeployPlan {
  return {
    project: { name: 'agent', namespace: 'aid.test' },
    services: [
      {
        id: 'api',
        target: 'container',
        streaming: true,
        endpoints: [{ pipeline: 'answer', method: 'POST', path: '/answer' }],
        env: [{ name: 'LOG_LEVEL', secret: false, from: 'spec', value: 'info' }],
        secrets: [],
        providers: ['bedrock'],
        ingest: [],
        guardrailEngines: [],
        runtime: {
          platform: cloud === 'gcp' ? 'gcp-agent-platform' : 'aws-agentcore',
          cloud,
          memory: { shortTerm: true },
          session: { ttlMinutes: 60 },
        },
      },
    ],
    stores: [],
    tasks: [],
    alarms: [],
    knowledgeBases: [],
    gateways: [],
  } as unknown as DeployPlan;
}

const AWS_RUNTIME = runtimePlan('aws');
const GCP_RUNTIME = runtimePlan('gcp');

/**
 * A root with nothing but the runtime: the compute modules are mutually exclusive with it,
 * so this is the only shape in which tofu validates the platform resources alone.
 */
const GCP_RUNTIME_ROOT = envRoot(
  { serverless: false, container: false, batch: false, agentRuntime: true },
  'gcp',
);

/** Enough of a `DeployPlan` to choose a target: the modules ignore everything else. */
function planOf(...targets: string[]): DeployPlan {
  return {
    services: targets.map((target, index) => ({ id: `svc${index}`, target })),
    knowledgeBases: [],
    gateways: [],
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
  knowledgeBases: [],
  gateways: [],
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

/** The same compiled plan, retargeted to Lambda@Edge, so "constant bytes" is real. */
const AS_EDGE = {
  ...SERVING,
  services: SERVING.services.map((service) => ({ ...service, target: 'edge' })),
} as unknown as DeployPlan;

/** The edge plan naming a cloud-native model, which is what earns the Bedrock grant. */
const EDGE_BEDROCK = {
  ...AS_EDGE,
  services: AS_EDGE.services.map((service) => ({ ...service, providers: ['bedrock'] })),
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
    // The image refusal names the tag, not a registry: three now ship, and the private ECR
    // repository in this account is pullable by the role policy the module attaches.
    expect(main).toContain('the spec names a repository, not a tag.');
    expect(main).not.toContain('ghcr.io');
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
  it('emits nothing when no deployment targets container or serverless', () => {
    expect(emitCloudRunModule(planOf())).toEqual([]);
    expect(emitCloudRunModule(planOf('batch', 'edge'))).toEqual([]);
  });

  it('runs a serverless service too, because GCP needs no second packaging model', () => {
    // The gen2 Functions API takes only a source zip; Cloud Run takes the image, and it
    // is what gen2 builds on -- so both targets share one module.
    const files = emitCloudRunModule(planOf('serverless'));
    expect(files).toHaveLength(4);
    const main = mainOf(files);
    expect(main).toContain('service.target == "container" || service.target == "serverless"');
    // The function model is kept: one request per instance unless sizing says otherwise.
    expect(main).toContain('each.value.target == "serverless" ? 1 : 80');
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
    expect(main).toContain('length(local.app) > 0 ? { images = true } : {}');
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

  it('grants Vertex to a serverless service too, since the same loop covers both targets', () => {
    const google = {
      ...SERVING,
      services: SERVING.services.map((service) => ({ ...service, providers: ['google'] })),
    } as unknown as DeployPlan;
    const main = mainOf(emitCloudRunModule(google));
    expect(main).toContain('resource "google_project_iam_member" "vertex"');
    expect(main).toContain('roles/aiplatform.user');
  });

  it('defaults to public invocation but does not grant it silently', () => {
    // Cloud Run authenticates every request unless allUsers is bound; the binding is a
    // separate resource gated on the input rather than something baked into the service.
    const main = mainOf(emitCloudRunModule(planOf('container')));
    expect(main).toContain('var.allow_unauthenticated ? local.app : {}');
    expect(main).toContain('member   = "allUsers"');
  });
});

describe('emitCloudRunJobModule', () => {
  it('emits nothing when no deployment targets batch', () => {
    expect(emitCloudRunJobModule(planOf())).toEqual([]);
    expect(emitCloudRunJobModule(planOf('serverless', 'container', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitCloudRunJobModule(planOf('batch'));
    expect(files.map((file) => file.path)).toEqual([
      `${CLOUDRUNJOB_MODULE_DIR}/versions.tf`,
      `${CLOUDRUNJOB_MODULE_DIR}/variables.tf`,
      `${CLOUDRUNJOB_MODULE_DIR}/main.tf`,
      `${CLOUDRUNJOB_MODULE_DIR}/outputs.tf`,
    ]);
    expect(CLOUDRUNJOB_MODULE_DIR).toBe('infra/generated/modules/cloudrunjob');
  });

  it('is constant: a real plan and a bare target list yield identical bytes', () => {
    expect(emitCloudRunJobModule(AS_BATCH)).toEqual(emitCloudRunJobModule(planOf('batch')));
  });

  it('runs the same entrypoint and pipeline argv as the AWS job definition', () => {
    // The entrypoint is the one thing both clouds must agree on; only the resource that
    // invokes it differs.
    const main = mainOf(emitCloudRunJobModule(planOf('batch')));
    expect(main).toContain('"python", "-m", "app.generated.batch"');
    expect(main).toContain('args    = [coalesce(each.value.pipeline, "")]');
    expect(main).not.toContain('@{');
  });

  it('creates a Cloud Run job, since the provider has no Google Cloud Batch resource', () => {
    const main = mainOf(emitCloudRunJobModule(planOf('batch')));
    expect(main).toContain('resource "google_cloud_run_v2_job" "job"');
    expect(main).not.toContain('google_batch_job');
    // One pipeline run per execution, so a retry cannot double a model call.
    expect(main).toContain('task_count  = 1');
    expect(main).toContain('parallelism = 1');
  });

  it('grants the service account read on each secret, and the log writer it starts without', () => {
    const main = mainOf(emitCloudRunJobModule(planOf('batch')));
    expect(main).toContain('google_secret_manager_secret_iam_member');
    expect(main).toContain('roles/secretmanager.secretAccessor');
    expect(main).toContain('roles/logging.logWriter');
  });

  it('grants Vertex only to a job that names the provider', () => {
    const main = mainOf(emitCloudRunJobModule(planOf('batch')));
    expect(main).toContain('resource "google_project_iam_member" "vertex"');
    expect(main).toContain('if contains(service.providers, "google")');
    expect(main).toContain('GOOGLE_CLOUD_PROJECT = var.project_id');
  });

  it('refuses what it cannot run, in the plan rather than after submission', () => {
    const main = mainOf(emitCloudRunJobModule(planOf('batch')));
    expect(main).toContain('names no pipeline');
    expect(main).toContain('must name the image it runs');
    expect(main).toContain('secret with no secret_ids entry');
    expect(main).toContain('cannot be a Cloud Run name');
  });

  it('exports what an execution needs and nothing more', () => {
    const outputs = emitCloudRunJobModule(planOf('batch')).find((file) =>
      file.path.endsWith('/outputs.tf'),
    );
    expect(outputs?.contents).toContain('output "job_ids"');
    expect(outputs?.contents).toContain('output "job_names"');
    expect(outputs?.contents).toContain('output "service_accounts"');
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

  it('wires an edge-only root without any image input', () => {
    const edge = envRoot({ serverless: false, container: false, edge: true });
    expect(edge.variables).toContain('variable "edge_zip_path"');
    expect(edge.variables).toContain('variable "edge_sizing"');
    expect(edge.main).toContain('module "edge"');
    expect(edge.main).toContain('source = "../../generated/modules/edge"');
    expect(edge.main).toContain('edge_certificate_arn = var.edge_certificate_arn');
    // A Lambda@Edge function is a zip, not an image, and takes no VPC or secret ARN.
    expect(edge.variables).not.toContain('variable "image_uris"');
    expect(edge.variables).not.toContain('variable "secret_arns"');
    expect(edge.variables).not.toContain('variable "batch_subnet_ids"');
    expect(edge.main).toContain('output "edge_domain_name"');
  });

  it('says so rather than inventing a module when neither target is present', () => {
    const none = envRoot({ serverless: false, container: false });
    expect(none.main).not.toContain('module "');
    expect(none.main).toContain('module was generated');
    expect(none.variables).not.toContain('variable "image_uris"');
    expect(none.variables).not.toContain('variable "batch_sizing"');
    expect(none.variables).not.toContain('variable "edge_zip_path"');
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
    expect(
      envRoot({
        serverless: true,
        container: true,
        batch: true,
        edge: true,
        agentRuntime: true,
        gateway: true,
      }),
    ).toEqual(BOTH);
  });

  it('configures the GCP provider once, and names no network inputs', () => {
    expect(GCP.main).toContain('provider "google"');
    expect(GCP.main).toContain('project = var.gcp_project');
    expect(GCP.main).toContain('module "cloudrun"');
    expect(GCP.main).toContain('module "cloudrunjob"');
    expect(GCP.main).toContain('source = "../../generated/modules/cloudrun"');
    expect(GCP.main).toContain('source = "../../generated/modules/cloudrunjob"');
    // The module names the project in a grant, so the root passes it rather than the
    // module reaching for a default: the project is an account fact, not a spec fact.
    expect(GCP.main).toContain('project_id            = var.gcp_project');
    expect(GCP.variables).toContain('variable "gcp_project"');
    expect(GCP.variables).toContain('variable "region"');
    expect(GCP.variables).toContain('variable "batch_sizing"');
    // Cloud Run terminates TLS and scales behind a managed frontend: no VPC, no CIDR. A
    // Cloud Run job needs no network either, so GCP still has no subnet input.
    expect(GCP.variables).not.toContain('variable "vpc_id"');
    expect(GCP.variables).not.toContain('variable "vpc_cidr"');
    expect(GCP.variables).not.toContain('variable "public_subnet_ids"');
    expect(GCP.variables).not.toContain('variable "batch_subnet_ids"');
    expect(GCP.main).not.toContain('module "serverless"');
    expect(GCP.main).not.toContain('module "container"');
    expect(GCP.main).not.toContain('module "batch"');
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
    expect(GCP.main).toContain('\n\nmodule "cloudrun"');
    expect(GCP.main).toContain('\n\nmodule "cloudrunjob"');
  });

  it('says what GCP is missing rather than inventing a module', () => {
    const none = envRoot({ serverless: false, container: false }, 'gcp');
    expect(none.main).not.toContain('module "');
    expect(none.main).toContain('no service a module exists for');
    expect(none.main).toContain('`edge` has');
  });

  it('runs a directly-passed serverless flag on Cloud Run on GCP', () => {
    // `modulesOf` folds serverless into container on this cloud, but a caller that sets
    // the flag directly must still get the module rather than the "nothing generated"
    // message.
    const serverless = envRoot({ serverless: true, container: false }, 'gcp');
    expect(serverless.main).toContain('module "cloudrun"');
    expect(serverless.variables).toContain('variable "cloudrun_sizing"');
    expect(serverless.variables).not.toContain('variable "batch_sizing"');
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

describe('emitEdgeModule', () => {
  it('emits nothing when no deployment targets edge', () => {
    expect(emitEdgeModule(planOf())).toEqual([]);
    expect(emitEdgeModule(planOf('serverless', 'container', 'batch'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitEdgeModule(planOf('edge'));
    expect(files.map((file) => file.path)).toEqual([
      `${EDGE_MODULE_DIR}/versions.tf`,
      `${EDGE_MODULE_DIR}/variables.tf`,
      `${EDGE_MODULE_DIR}/main.tf`,
      `${EDGE_MODULE_DIR}/outputs.tf`,
    ]);
    expect(EDGE_MODULE_DIR).toBe('infra/generated/modules/edge');
  });

  it('is constant: a real plan and a bare target list yield identical bytes', () => {
    expect(emitEdgeModule(AS_EDGE)).toEqual(emitEdgeModule(planOf('edge')));
  });

  it('publishes a numbered version, which is what CloudFront associates', () => {
    const main = mainOf(emitEdgeModule(planOf('edge')));
    expect(main).toContain('handler          = "app.generated.edge.handler"');
    // `$LATEST` and an alias are both refused by CloudFront; publish makes the version.
    expect(main).toContain('publish = true');
    expect(main).toContain('qualified_arn');
    expect(main).toContain('event_type   = "origin-request"');
    expect(main).toContain('include_body = true');
    expect(main).not.toContain('@{');
  });

  it('puts the function in us-east-1 wherever the stack lives', () => {
    const main = mainOf(emitEdgeModule(planOf('edge')));
    expect(main).toContain('alias  = "us_east_1"');
    expect(main).toContain('region = "us-east-1"');
    // A resource left on the root provider would follow the stack's region, and a
    // CloudFront association only accepts a function from us-east-1.
    expect(main.match(/provider\s+= aws\.us_east_1/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it('trusts the edge service as well as Lambda, since a replica assumes the role', () => {
    const main = mainOf(emitEdgeModule(planOf('edge')));
    expect(main).toContain('lambda.amazonaws.com');
    expect(main).toContain('edgelambda.amazonaws.com');
    expect(main).toContain('AWSLambdaBasicExecutionRole');
  });

  it('carries configuration in a secret, because the function has no environment', () => {
    const main = mainOf(emitEdgeModule(planOf('edge')));
    expect(main).toContain('resource "aws_secretsmanager_secret" "edge"');
    expect(main).toContain('name        = local.name[each.key]');
    // Zero so a destroy/recreate cycle does not hold the name for 30 days.
    expect(main).toContain('recovery_window_in_days = 0');
    expect(main).toContain('secretsmanager:GetSecretValue');
    expect(main).not.toContain('environment {');
  });

  it('refuses what Lambda@Edge cannot do, at plan time', () => {
    const main = mainOf(emitEdgeModule(planOf('edge')));
    expect(main).toContain('precondition');
    expect(main).toContain('one CloudFront distribution serves the app');
    expect(main).toContain('fileexists(var.edge_zip_path)');
    expect(main).toContain('declares streaming');
    expect(main).toContain('at most 30 seconds');
    expect(main).toContain('128 to 3008 MB');
  });

  it('grants Bedrock only to the deployment that names it', () => {
    const main = mainOf(emitEdgeModule(EDGE_BEDROCK));
    expect(main).toContain('resource "aws_iam_role_policy" "edge_bedrock"');
    expect(main).toContain('bedrock:InvokeModel');
    expect(main).toContain('for_each = local.bedrock');
    expect(main).toContain('if contains(service.providers, "bedrock")');
  });

  it('exports the distribution, the versions and the secret a deploy populates', () => {
    const outputs = emitEdgeModule(planOf('edge')).find((file) =>
      file.path.endsWith('/outputs.tf'),
    );
    expect(outputs?.contents).toContain('output "distribution_domain_name"');
    expect(outputs?.contents).toContain('output "function_versions"');
    expect(outputs?.contents).toContain('output "secret_arns"');
  });
});

describe('emitAgentRuntimeModule', () => {
  const gcp = emitAgentRuntimeModule(GCP_RUNTIME, 'gcp');
  const gcpMain = mainOf(gcp);

  it('configures managed memory on the GCP engine through context_spec', () => {
    expect(gcpMain).toContain('dynamic "context_spec"');
    expect(gcpMain).toContain('memory_bank_config');
    expect(gcpMain).toContain('local.memory_generation_model_uri');
    expect(gcpMain).toContain('local.memory_embedding_model_uri');
    expect(gcpMain).toContain('"2592000s"');
    // The GA provider sends `contextSpec` as a top-level sibling of `spec`, so the block
    // is indented to the resource, not nested inside the engine's `spec`.
    expect(gcpMain).toContain('\n  dynamic "context_spec" {');
    expect(gcpMain).toContain('for_each = each.value.runtime.memory_short_term ? [1] : []');
  });

  it('no longer refuses managed memory on the GCP engine', () => {
    expect(gcpMain).not.toContain('asks for managed memory');
    expect(gcpMain).not.toContain('!each.value.runtime.memory_short_term');
  });

  it('defaults the Memory Bank models to the ones the provider documents', () => {
    const variables = variableOf(gcp);
    expect(variables).toContain('default     = "gemini-3.5-flash"');
    expect(variables).toContain('default     = "text-embedding-005"');
  });

  it('keeps AgentCore Memory a resource of its own on AWS', () => {
    const aws = emitAgentRuntimeModule(AWS_RUNTIME, 'aws');
    expect(mainOf(aws)).toContain('aws_bedrockagentcore_memory');
    expect(mainOf(aws)).toContain('BEDROCK_AGENTCORE_MEMORY_ID');
    expect(variableOf(aws)).not.toContain('memory_generation_model');
  });
});

describe('modulesOf, the seam emit.ts reads', () => {
  it('reports the platforms a plan targets', () => {
    expect(modulesOf(planOf())).toEqual({
      serverless: false,
      container: false,
      batch: false,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    expect(modulesOf(planOf('serverless', 'container'))).toEqual({
      serverless: true,
      container: true,
      batch: false,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    expect(modulesOf(planOf('batch'))).toEqual({
      serverless: false,
      container: false,
      batch: true,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    expect(modulesOf(planOf('edge'))).toEqual({
      serverless: false,
      container: false,
      batch: false,
      edge: true,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    // A runtime service belongs to the runtime module, not the compute module: the flag
    // is exclusive so the two never both claim the same service.
    expect(modulesOf(AWS_RUNTIME)).toEqual({
      serverless: false,
      container: false,
      batch: false,
      edge: false,
      agentRuntime: true,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
  });

  it('reports what the cloud can emit, not what the target is called', () => {
    // On GCP `container` and `serverless` both run on Cloud Run, so either one needs the
    // cloudrun module; `serverless` is an AWS-only module. `batch` is reported on both
    // clouds and the cloud decides which module renders it. `edge` is AWS-only: on GCP
    // the command refuses it before a plan is rendered.
    expect(modulesOf(planOf('container'), 'gcp')).toEqual({
      serverless: false,
      container: true,
      batch: false,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    expect(modulesOf(planOf('serverless'), 'gcp')).toEqual({
      serverless: false,
      container: true,
      batch: false,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    expect(modulesOf(planOf('batch'), 'gcp')).toEqual({
      serverless: false,
      container: false,
      batch: true,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    expect(modulesOf(planOf('edge'), 'gcp')).toEqual({
      serverless: false,
      container: false,
      batch: false,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
    // The runtime's cloud decides, not the target it happens to share with Cloud Run.
    expect(modulesOf(GCP_RUNTIME, 'gcp').agentRuntime).toBe(true);
    expect(modulesOf(GCP_RUNTIME, 'gcp').container).toBe(false);
    expect(modulesOf(AWS_RUNTIME, 'gcp').agentRuntime).toBe(false);
    expect(modulesOf(planOf('container'))).toEqual({
      serverless: false,
      container: true,
      batch: false,
      edge: false,
      agentRuntime: false,
      knowledgeBase: false,
      gateway: false,
      modelArmor: false,
    });
  });

  it('reports a managed base only when the cloud can provision it', () => {
    // The engine names the cloud: a `vertex-rag` base on AWS is not a module that exists,
    // so the flag follows the cloud and the engine, not "some plan has a base".
    expect(modulesOf(AWS_KB).knowledgeBase).toBe(true);
    expect(modulesOf(AWS_KB, 'gcp').knowledgeBase).toBe(false);
    expect(modulesOf(GCP_KB, 'gcp').knowledgeBase).toBe(true);
    expect(modulesOf(GCP_KB).knowledgeBase).toBe(false);
  });

  it('reports a gateway only on the cloud that hosts one', () => {
    // AgentCore Gateway has no GCP counterpart at any layer, so the flag follows the cloud
    // alone: a plan can declare a gateway, but only an AWS deploy can create one.
    expect(modulesOf(GW).gateway).toBe(true);
    expect(modulesOf(GW, 'gcp').gateway).toBe(false);
    expect(modulesOf(planOf('serverless')).gateway).toBe(false);
  });

  it('emits the gateway module and no GCP module for it', () => {
    const aws = emitProviderModules(GW).map((file) => file.path);
    expect(aws).toContain(`${GATEWAY_MODULE_DIR}/main.tf`);
    expect(aws).toContain(CDK_GATEWAY_MODULE);

    const gcp = emitProviderModules(GW, 'gcp').map((file) => file.path);
    expect(gcp).not.toContain(`${GATEWAY_MODULE_DIR}/main.tf`);
    expect(gcp).not.toContain(CDK_GATEWAY_MODULE);
  });

  it('emits the base module the plan names and nothing for the other cloud', () => {
    const aws = emitProviderModules(AWS_KB).map((file) => file.path);
    expect(aws).toContain(`${KNOWLEDGE_BASE_MODULE_DIR}/main.tf`);
    expect(aws).not.toContain(`${VERTEX_RAG_MODULE_DIR}/main.tf`);

    const gcp = emitProviderModules(GCP_KB, 'gcp').map((file) => file.path);
    expect(gcp).toContain(`${VERTEX_RAG_MODULE_DIR}/main.tf`);
    expect(gcp).not.toContain(`${KNOWLEDGE_BASE_MODULE_DIR}/main.tf`);
  });

  it('emits every module a plan needs in one call', () => {
    const paths = emitProviderModules(planOf('serverless', 'container')).map((file) => file.path);
    expect(paths).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
    expect(paths).toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
    // Two provider modules, plus one construct for each runnable target.
    expect(paths).toContain(CDK_SERVERLESS_MODULE);
    expect(paths).toContain(CDK_CONTAINER_MODULE);
    expect(paths).toHaveLength(10);

    const all = emitProviderModules(planOf('serverless', 'container', 'batch', 'edge')).map(
      (file) => file.path,
    );
    expect(all).toContain(`${BATCH_MODULE_DIR}/main.tf`);
    expect(all).toContain(`${EDGE_MODULE_DIR}/main.tf`);
    // Four provider modules (16 files) plus one construct for each of the four targets.
    expect(all).toHaveLength(20);
  });

  it('emits only the Cloud Run module for a GCP plan with no job', () => {
    const paths = emitProviderModules(MIXED, 'gcp').map((file) => file.path);
    expect(paths).toEqual([
      `${CLOUDRUN_MODULE_DIR}/versions.tf`,
      `${CLOUDRUN_MODULE_DIR}/variables.tf`,
      `${CLOUDRUN_MODULE_DIR}/main.tf`,
      `${CLOUDRUN_MODULE_DIR}/outputs.tf`,
    ]);
  });

  it('emits the Cloud Run job module beside Cloud Run for a GCP batch plan', () => {
    const job = emitProviderModules(planOf('batch'), 'gcp').map((file) => file.path);
    expect(job).toEqual([
      `${CLOUDRUNJOB_MODULE_DIR}/versions.tf`,
      `${CLOUDRUNJOB_MODULE_DIR}/variables.tf`,
      `${CLOUDRUNJOB_MODULE_DIR}/main.tf`,
      `${CLOUDRUNJOB_MODULE_DIR}/outputs.tf`,
    ]);

    const both = emitProviderModules(planOf('container', 'batch'), 'gcp').map((file) => file.path);
    expect(both).toContain(`${CLOUDRUN_MODULE_DIR}/main.tf`);
    expect(both).toContain(`${CLOUDRUNJOB_MODULE_DIR}/main.tf`);
    expect(both).toHaveLength(8);
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

/** The one file a plan declares, by path; a different count is itself the failure. */
function cdkModule(
  plan: DeployPlan = planOf('serverless'),
  cloud: 'aws' | 'gcp' = 'aws',
  path: string = CDK_SERVERLESS_MODULE,
) {
  const files = emitCdkModules(plan, cloud);
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`expected ${path} for ${cloud}, got ${files.map((f) => f.path).join()}`);
  }
  return file;
}

describe('the validate fixture', () => {
  /** CI runs `tofu validate` here, so the fixture must be exactly what is emitted. */
  it('matches each emitted module byte for byte', () => {
    const cases: {
      dir: string;
      files: readonly { path: string; contents: string }[];
      root?: string;
      platform?: string;
    }[] = [
      { dir: SERVERLESS_MODULE_DIR, files: emitServerlessModule(planOf('serverless')) },
      { dir: CONTAINER_MODULE_DIR, files: emitContainerModule(planOf('container')) },
      { dir: CLOUDRUN_MODULE_DIR, files: emitCloudRunModule(planOf('container')) },
      { dir: CLOUDRUNJOB_MODULE_DIR, files: emitCloudRunJobModule(planOf('batch')) },
      { dir: BATCH_MODULE_DIR, files: emitBatchModule(planOf('batch')) },
      { dir: EDGE_MODULE_DIR, files: emitEdgeModule(planOf('edge')) },
      { dir: KNOWLEDGE_BASE_MODULE_DIR, files: emitKnowledgeBaseModule(AWS_KB) },
      { dir: VERTEX_RAG_MODULE_DIR, files: emitVertexRagModule(GCP_KB) },
      { dir: GATEWAY_MODULE_DIR, files: emitGatewayModule(GW) },
      { dir: AGENT_RUNTIME_MODULE_DIR, files: emitAgentRuntimeModule(AWS_RUNTIME, 'aws') },
      {
        dir: AGENT_RUNTIME_MODULE_DIR,
        files: emitAgentRuntimeModule(GCP_RUNTIME, 'gcp'),
        // Both platforms share one module path, so GCP keeps its own tree beside its root;
        // one directory cannot hold two clouds' bytes and validate either one.
        root: 'gcp-runtime',
        platform: 'agent-runtime',
      },
    ];
    for (const { dir, files, root, platform: named } of cases) {
      expect(files).toHaveLength(4);
      const platform = named ?? dir.slice(dir.lastIndexOf('/') + 1);
      const modules =
        root === undefined
          ? join(FIXTURE, 'generated', 'modules')
          : join(FIXTURE, root, 'generated', 'modules');
      for (const file of files) {
        const name = file.path.slice(dir.length + 1);
        const fixture = readFileSync(join(modules, platform, name), 'utf8');
        expect(fixture, `${root ?? ''}${platform}/${name}`).toBe(file.contents);
      }
    }
  });

  it('matches the documented env root byte for byte', () => {
    for (const [env, root] of [
      ['dev', BOTH],
      ['aws-kb', AWS_KB_ROOT],
      ['gcp-kb', GCP_KB_ROOT],
    ] as const) {
      const variables = readFileSync(join(FIXTURE, 'envs', env, 'variables.tf'), 'utf8');
      const main = readFileSync(join(FIXTURE, 'envs', env, 'main.tf'), 'utf8');
      expect(variables, `${env}/variables.tf`).toBe(root.variables);
      expect(main, `${env}/main.tf`).toBe(root.main);
    }
  });

  it('matches the GCP env root byte for byte', () => {
    // A second root, not a variant of the AWS one: it is validated separately, because a
    // plan that is wrong on GCP fails for a reason no AWS fixture can reveal.
    const variables = readFileSync(join(FIXTURE, 'envs', 'gcp-dev', 'variables.tf'), 'utf8');
    const main = readFileSync(join(FIXTURE, 'envs', 'gcp-dev', 'main.tf'), 'utf8');
    expect(variables).toBe(GCP.variables);
    expect(main).toBe(GCP.main);
  });

  it('matches the GCP runtime root byte for byte', () => {
    const { variables, main } = GCP_RUNTIME_ROOT;
    const base = join(FIXTURE, 'gcp-runtime', 'envs', 'dev');
    expect(readFileSync(join(base, 'variables.tf'), 'utf8')).toBe(variables);
    expect(readFileSync(join(base, 'main.tf'), 'utf8')).toBe(main);
  });

  it('is wired to the modules the emitter writes', () => {
    // A fixture that pointed anywhere else would validate a module nobody gets.
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/serverless"');
    expect(main).toContain('source = "../../generated/modules/container"');
    expect(main).toContain('source = "../../generated/modules/agent-runtime"');
    expect(main).toContain('output "agent_runtimes"');
  });

  it('wires the GCP runtime root to the module beside it', () => {
    // This tree is separate because an agent-runtime module holds one cloud's bytes, so
    // the GCP root must resolve its own copy rather than the AWS one under `infra/`.
    const main = readFileSync(join(FIXTURE, 'gcp-runtime', 'envs', 'dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/agent-runtime"');
    expect(main).toContain('output "reasoning_engines"');
    expect(main).toContain('provider "google"');
  });

  it('wires the GCP root to the modules it ships beside', () => {
    const main = readFileSync(join(FIXTURE, 'envs', 'gcp-dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/cloudrun"');
    expect(main).toContain('source = "../../generated/modules/cloudrunjob"');
    expect(main).toContain('provider "google"');
  });

  it('wires each base root to the base module it validates', () => {
    // The base modules are only reachable through these roots, so a root that named the
    // wrong source would leave the module in the tree validated by nothing.
    const aws = readFileSync(join(FIXTURE, 'envs', 'aws-kb', 'main.tf'), 'utf8');
    expect(aws).toContain('source = "../../generated/modules/knowledge-base"');
    expect(aws).toContain('knowledge_bases = var.knowledge_bases');

    const gcp = readFileSync(join(FIXTURE, 'envs', 'gcp-kb', 'main.tf'), 'utf8');
    expect(gcp).toContain('source = "../../generated/modules/vertex-rag"');
    expect(gcp).toContain('knowledge_bases = var.knowledge_bases');
  });

  it('wires the gateway module into the AWS root and nowhere on GCP', () => {
    // `tofu validate` reaches the gateway only through the root that calls it, so the dev
    // root is where its module is validated. A GCP root must not name it at all: nothing
    // would provision it, and validating a module the deploy cannot create is noise.
    const aws = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(aws).toContain('source = "../../generated/modules/gateway"');
    expect(aws).toContain('gateways = var.gateways');
    expect(aws).toContain('gateways        = module.gateway.gateways');
    expect(aws).toContain('output "gateway_urls"');

    for (const env of ['gcp-dev', 'gcp-kb'] as const) {
      const main = readFileSync(join(FIXTURE, 'envs', env, 'main.tf'), 'utf8');
      expect(main, env).not.toContain('modules/gateway');
    }
  });

  it('matches the emitted CDK construct byte for byte', () => {
    // CI runs `cdk synth` here, so this file must be exactly what `aid infra gen` writes.
    const [construct] = emitCdkModules(planOf('serverless'), 'aws');
    if (construct === undefined) {
      throw new Error('the CDK construct was not emitted');
    }
    const fixture = readFileSync(join(FIXTURE, 'generated', 'cdk', 'serverless.cjs'), 'utf8');
    expect(fixture).toBe(construct.contents);
  });

  it('matches the emitted knowledge base construct byte for byte', () => {
    const files = emitCdkModules(AWS_KB, 'aws');
    const base = files.find((file) => file.path === CDK_KNOWLEDGE_BASE_MODULE);
    if (base === undefined) {
      throw new Error('the knowledge base construct was not emitted');
    }
    const fixture = readFileSync(join(FIXTURE, 'generated', 'cdk', 'knowledge-base.cjs'), 'utf8');
    expect(fixture).toBe(base.contents);
  });

  it('matches the emitted gateway construct byte for byte', () => {
    // A gateway is emitted for the CDK backend only when the plan has no runtime, so this
    // construct creates the endpoint and its targets and stops there.
    const files = emitCdkModules(GW, 'aws');
    const gateway = files.find((file) => file.path === CDK_GATEWAY_MODULE);
    if (gateway === undefined) {
      throw new Error('the gateway construct was not emitted');
    }
    const fixture = readFileSync(join(FIXTURE, 'generated', 'cdk', 'gateway.cjs'), 'utf8');
    expect(fixture).toBe(gateway.contents);
  });

  it('matches the emitted container construct byte for byte', () => {
    const files = emitCdkModules(planOf('container'), 'aws');
    const container = files.find((file) => file.path === CDK_CONTAINER_MODULE);
    if (container === undefined) {
      throw new Error('the container construct was not emitted');
    }
    const fixture = readFileSync(join(FIXTURE, 'generated', 'cdk', 'container.cjs'), 'utf8');
    expect(fixture).toBe(container.contents);
  });

  it('matches the emitted batch construct byte for byte', () => {
    const files = emitCdkModules(planOf('batch'), 'aws');
    const construct = files.find((file) => file.path === CDK_BATCH_MODULE);
    if (construct === undefined) {
      throw new Error('the batch construct was not emitted');
    }
    const fixture = readFileSync(join(FIXTURE, 'generated', 'cdk', 'batch.cjs'), 'utf8');
    expect(fixture).toBe(construct.contents);
  });

  it('matches the emitted edge construct byte for byte', () => {
    const files = emitCdkModules(planOf('edge'), 'aws');
    const construct = files.find((file) => file.path === CDK_EDGE_MODULE);
    if (construct === undefined) {
      throw new Error('the edge construct was not emitted');
    }
    const fixture = readFileSync(join(FIXTURE, 'generated', 'cdk', 'edge.cjs'), 'utf8');
    expect(fixture).toBe(construct.contents);
  });

  it('refuses what the container module refuses, in the same words', () => {
    // A long sentence is split across two JS literals for line width, so the source has
    // `' +` between its halves; joining those back gives the words a caller would read.
    const construct = cdkModule(planOf('container'), 'aws', CDK_CONTAINER_MODULE).contents.replace(
      /' \+\r?\n\s*'/g,
      '',
    );
    const module = emitContainerModule(planOf('container'))
      .map((file) => file.contents)
      .join('\n');

    for (const sentence of [
      'Name the released tag this service runs; the spec names a repository, not a tag.',
      'Add name -> ARN for every secret it declares.',
      'must name the range it should use.',
      'Tasks need two private subnets in different availability zones. Supply ',
      'A load balancer needs at least two subnets in different availability zones. Supply ',
      'Two container services declare the same path. An ALB routes by path, not by method, ' +
        'so one path must belong to one service.',
    ]) {
      expect(construct, sentence).toContain(sentence);
      expect(module, sentence).toContain(sentence);
    }

    // The map names differ because one backend reads HCL variables and the other JSON.
    expect(construct).toContain('No images entry for');
    expect(module).toContain('No image_uris entry for');
    expect(construct).toContain('references a secret with no secretArns entry.');
    expect(module).toContain('references a secret with no secret_arns entry.');
    expect(construct).toContain('privateSubnetIds alongside vpcId');
    expect(module).toContain('private_subnet_ids alongside vpc_id');
  });

  it('mirrors every container resource the HCL module renders', () => {
    const contents = cdkModule(planOf('container'), 'aws', CDK_CONTAINER_MODULE).contents;
    for (const kind of [
      'CfnVPC', // aws_vpc
      'CfnSubnet', // aws_subnet, split by an 8-bit step like cidrsubnet
      'CfnNatGateway', // aws_nat_gateway
      'CfnCluster', // aws_ecs_cluster
      'CfnTaskDefinition', // aws_ecs_task_definition
      'CfnService', // aws_ecs_service
      'CfnTargetGroup', // aws_lb_target_group
      'CfnLoadBalancer', // aws_lb
      'CfnListener', // aws_lb_listener
      'CfnListenerRule', // aws_lb_listener_rule
      'CfnLogGroup', // aws_cloudwatch_log_group
      'CfnSecurityGroup', // aws_security_group
      'CfnGuardrail', // aws_bedrock_guardrail
      'PolicyStatement', // aws_iam_role_policy
    ]) {
      expect(contents, kind).toContain(kind);
    }
  });

  it('refuses what the batch module refuses, in the same words', () => {
    // A long sentence is split across two JS literals for line width, so the source has
    // `' +` between its halves; joining those back gives the words a caller would read.
    const construct = cdkModule(planOf('batch'), 'aws', CDK_BATCH_MODULE).contents.replace(
      /' \+\r?\n\s*'/g,
      '',
    );
    const module = emitBatchModule(planOf('batch'))
      .map((file) => file.contents)
      .join('\n');

    for (const sentence of [
      'Fargate has nowhere to run a task without at least one subnet; name the subnets this job may use.',
      'A job definition must name the image it runs.',
      'targets batch but names no pipeline. Set deployments.',
      'Add name -> ARN for every secret it declares.',
    ]) {
      expect(construct, sentence).toContain(sentence);
      expect(module, sentence).toContain(sentence);
    }

    // The map names differ because one backend reads HCL variables and the other JSON.
    expect(construct).toContain('No subnetIds were supplied.');
    expect(module).toContain('No subnet_ids were supplied.');
    expect(construct).toContain('No images entry for');
    expect(module).toContain('No image_uris entry for');
    expect(construct).toContain('references a secret with no secretArns entry.');
    expect(module).toContain('references a secret with no secret_arns entry.');
  });

  it('mirrors every batch resource the HCL module renders', () => {
    const contents = cdkModule(planOf('batch'), 'aws', CDK_BATCH_MODULE).contents;
    for (const kind of [
      'CfnComputeEnvironment', // aws_batch_compute_environment
      'CfnJobQueue', // aws_batch_job_queue
      'CfnJobDefinition', // aws_batch_job_definition
      'CfnLogGroup', // aws_cloudwatch_log_group
      'Role', // aws_iam_role, service and execution and task
      'PolicyStatement', // aws_iam_role_policy
      'CfnGuardrail', // aws_bedrock_guardrail
      'CfnGuardrailVersion', // aws_bedrock_guardrail_version
    ]) {
      expect(contents, kind).toContain(kind);
    }

    // The execution role pulls the image and resolves secrets; the task role is what the
    // job assumes. A job definition with only one of them deploys a task with no image
    // credentials or no Bedrock grant.
    expect(contents).toContain('jobRoleArn: taskRole.roleArn');
    expect(contents).toContain('executionRoleArn: executionRole.roleArn');
  });

  it('refuses what the edge module refuses, in the same words', () => {
    const construct = cdkModule(planOf('edge'), 'aws', CDK_EDGE_MODULE).contents.replace(
      /' \+\r?\n\s*'/g,
      '',
    );
    const module = emitEdgeModule(planOf('edge'))
      .map((file) => file.contents)
      .join('\n');

    for (const sentence of [
      'one CloudFront distribution serves the app, so keep one edge deployment and let it own every HTTP route.',
      'Build the app into that file before planning; the function deploys that archive.',
      'declares streaming, which a CloudFront response cannot deliver. Serve it from a container target.',
      'Lambda@Edge allows at most 30 seconds for a request; deployment ',
      'Lambda@Edge accepts 128 to 3008 MB; deployment ',
    ]) {
      expect(construct, sentence).toContain(sentence);
      expect(module, sentence).toContain(sentence);
    }

    // The map names differ because one backend reads HCL variables and the other JSON.
    expect(construct).toContain('edgeZipPath');
    expect(module).toContain('edge_zip_path');
  });

  it('mirrors every edge resource the HCL module renders', () => {
    const contents = cdkModule(planOf('edge'), 'aws', CDK_EDGE_MODULE).contents;
    for (const kind of [
      'Function', // aws_lambda_function
      'addPermission', // aws_lambda_permission
      'CfnSecret', // aws_secretsmanager_secret
      'Distribution', // aws_cloudfront_distribution
      'Role', // aws_iam_role
      'PolicyStatement', // aws_iam_role_policy
      'CompositePrincipal', // the edgelambda.amazonaws.com trust too
    ]) {
      expect(contents, kind).toContain(kind);
    }

    // CloudFront associates a numbered version, never $LATEST, and the caching and origin
    // request policies are the CachingDisabled and AllViewer ids the HCL module pins.
    expect(contents).toContain('fn.currentVersion');
    expect(contents).toContain('cloudfront.CachePolicy.CACHING_DISABLED');
    expect(contents).toContain('cloudfront.OriginRequestPolicy.ALL_VIEWER');
    expect(contents).toContain('includeBody: true');
  });

  it('wires the CDK app to the construct it synthesises', () => {
    const app = readFileSync(join(FIXTURE, 'cdk', 'bin', 'app.js'), 'utf8');
    expect(app).toContain("require('../../generated/cdk/serverless.cjs')");
    expect(app).toContain("require('../../generated/cdk/container.cjs')");
    expect(app).toContain("require('../../generated/cdk/batch.cjs')");
    expect(app).toContain("require('../../generated/cdk/edge.cjs')");
    expect(app).toContain("require('../../generated/cdk/knowledge-base.cjs')");
    expect(app).toContain("path.join(here, 'context.json')");
  });

  it('keeps the CDK dependencies at the fixture root', () => {
    // Node resolves `aws-cdk-lib` from the construct's directory upward. `generated/cdk`
    // is a sibling of `cdk/`, so a package.json beside the app would never be found.
    //
    // The property that matters is that both are *exact* pins -- CDK constructs are
    // version-sensitive and a range would let the synth flip under a lockfile refresh.
    // Asserting the numbers themselves only duplicated the emitter's constants and made
    // every Dependabot bump fail here for no behavioural reason.
    const pkg = JSON.parse(readFileSync(join(FIXTURE, 'package.json'), 'utf8'));
    expect(pkg.dependencies['aws-cdk-lib']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies['aws-cdk']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('synthesises the serverless app, not an empty stack', () => {
    const app = readFileSync(join(FIXTURE, 'cdk', 'bin', 'app.js'), 'utf8');
    // `cdk synth` exits 0 for an empty stack, so the fixture asserts the shape itself.
    expect(app).toContain('expected one container-image Lambda function');
    expect(app).toContain('expected one HTTP API route');
    // The batch and edge constructs are in the same stack; asserting their resources
    // separately catches a construct that returns an object but renders nothing.
    expect(app).toContain('expected one batch job definition');
    expect(app).toContain('expected one batch compute environment');
    expect(app).toContain('expected one Lambda@Edge zip function');
    expect(app).toContain('expected one CloudFront distribution');
    expect(app).toContain('expected the execution role on the job definition');
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

describe('the CDK construct', () => {
  it('is a constant, so `cdk synth` can validate it once', () => {
    const file = cdkModule();
    expect(file.path).toBe(CDK_SERVERLESS_MODULE);
    // The construct loops over the context at synth time, so its bytes cannot depend on
    // the plan. A construct that baked in services could not be validated once.
    expect(cdkModule(planOf('serverless', 'serverless')).contents).toBe(file.contents);
  });

  it('is not emitted on GCP', () => {
    expect(emitCdkModules(planOf('serverless', 'container', 'batch', 'edge'), 'gcp')).toEqual([]);
  });

  it('is not emitted for a plan with no deployment and no Bedrock base', () => {
    expect(emitCdkModules(planOf(), 'aws')).toEqual([]);
  });

  it('adds a batch and an edge construct for the deployments that use them', () => {
    expect(emitCdkModules(planOf('batch'), 'aws').map((file) => file.path)).toEqual([
      CDK_BATCH_MODULE,
    ]);
    expect(emitCdkModules(planOf('edge'), 'aws').map((file) => file.path)).toEqual([
      CDK_EDGE_MODULE,
    ]);
    expect(
      emitCdkModules(planOf('edge', 'batch', 'serverless'), 'aws').map((file) => file.path),
    ).toEqual([CDK_SERVERLESS_MODULE, CDK_BATCH_MODULE, CDK_EDGE_MODULE]);
  });

  it('adds the container construct beside the serverless one', () => {
    const paths = emitCdkModules(planOf('serverless', 'container'), 'aws').map((file) => file.path);
    expect(paths).toEqual([CDK_SERVERLESS_MODULE, CDK_CONTAINER_MODULE]);
  });

  it('emits the container construct alone for a container-only plan', () => {
    expect(emitCdkModules(planOf('container'), 'aws').map((file) => file.path)).toEqual([
      CDK_CONTAINER_MODULE,
    ]);
  });

  it('keeps one order however the plan lists its services', () => {
    const forward = emitCdkModules(planOf('serverless', 'container', 'batch', 'edge'), 'aws').map(
      (f) => f.path,
    );
    const reverse = emitCdkModules(planOf('edge', 'batch', 'container', 'serverless'), 'aws').map(
      (f) => f.path,
    );
    expect(reverse).toEqual(forward);
  });

  it('adds the knowledge base construct beside the serverless one', () => {
    const paths = emitCdkModules(AWS_KB, 'aws').map((file) => file.path);
    expect(paths).toEqual([CDK_SERVERLESS_MODULE, CDK_KNOWLEDGE_BASE_MODULE]);
  });

  it('emits the knowledge base construct on its own for a base without a runnable service', () => {
    const bare = { ...AWS_KB, services: [] } as DeployPlan;
    expect(emitCdkModules(bare, 'aws').map((file) => file.path)).toEqual([
      CDK_KNOWLEDGE_BASE_MODULE,
    ]);
  });

  it('emits nothing for a Vertex base on AWS, which it cannot provision', () => {
    expect(emitCdkModules({ ...GCP_KB, services: [] } as DeployPlan, 'aws')).toEqual([]);
  });

  it('refuses what the HCL module refuses, in the same words', () => {
    const construct = cdkModule().contents;
    const module = emitServerlessModule(planOf('serverless'))
      .map((file) => file.contents)
      .join('\n');

    // A refusal that drifted from the module would fail at synth for a different reason
    // than `tofu plan`, and the two backends would stop being interchangeable.
    for (const sentence of [
      'declares streaming, which an HTTP API cannot deliver on AWS.',
      'Cloud Run streams.',
      'Name the released tag this service runs;',
      'the spec names a repository, not a tag.',
      'Add name -> ARN for every secret it declares.',
    ]) {
      expect(construct, sentence).toContain(sentence);
      expect(module, sentence).toContain(sentence);
    }

    // The map names differ because one backend reads HCL variables and the other JSON.
    expect(construct).toContain('No images entry for');
    expect(module).toContain('No image_uris entry for');
    expect(construct).toContain('references a secret with no secretArns entry.');
    expect(module).toContain('references a secret with no secret_arns entry.');
  });

  it('mirrors every resource the HCL module renders', () => {
    const contents = cdkModule().contents;
    for (const kind of [
      'CfnFunction', // aws_lambda_function
      'CfnApi', // aws_apigatewayv2_api
      'CfnStage', // aws_apigatewayv2_stage
      'CfnIntegration', // aws_apigatewayv2_integration
      'CfnRoute', // aws_apigatewayv2_route
      'CfnPermission', // aws_lambda_permission
      'CfnGuardrail', // aws_bedrock_guardrail
      'CfnGuardrailVersion', // aws_bedrock_guardrail_version
      'Role', // aws_iam_role
      'PolicyStatement', // aws_iam_role_policy
    ]) {
      expect(contents, kind).toContain(kind);
    }
  });

  it('lets a container-image function pull from ECR on both backends', () => {
    const module = emitServerlessModule(planOf('serverless'))
      .map((file) => file.contents)
      .join('\n');
    const construct = cdkModule().contents;

    // The release workflow can push to ECR (spec 0.17) and an ECR repository is private by
    // default, so a function that runs that image needs the pull grant. A public registry
    // image does not use it, so the grant is unconditional rather than derived from a fact
    // the module cannot see.
    expect(module).toContain('aws_iam_role_policy_attachment" "ecr"');
    expect(module).toContain('arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly');
    expect(construct).toContain("'AmazonEC2ContainerRegistryReadOnly'");

    // Neither backend may still claim ghcr.io is the only registry. Three now ship, so a
    // message that names a retired limitation is worse than no message at all.
    expect(module).not.toContain('ghcr.io');
    expect(construct).not.toContain('ghcr.io');
  });

  it('provisions the guardrail, and only when the plan names one', () => {
    const contents = cdkModule().contents;

    // A service that names the engine but owns no policy block leaves its guardrail to
    // its operator, so the construct must return before the resources rather than
    // provisioning an empty one.
    expect(contents).toContain('const policy = (context.guardrails || {})[id];');
    expect(contents).toContain('if (!policy) return undefined;');

    // Evaluating a guardrail is the app's job; provisioning it is the construct's.
    expect(contents).toContain("actions: ['bedrock:ApplyGuardrail']");
    expect(contents).not.toContain('bedrock:CreateGuardrail');
    // The app is wired to the immutable version the construct publishes, not to the
    // mutable guardrail resource itself.
    expect(contents).toContain('guardrailIdentifier: guardrail.attrGuardrailId');

    // The app learns where the guardrail is from the resources, not from an input.
    expect(contents).toContain('variables.BEDROCK_GUARDRAIL_ID');
    expect(contents).toContain('variables.BEDROCK_GUARDRAIL_VERSION');
    expect(contents).toContain('guardrail.attrGuardrailId');
    expect(contents).toContain('version.attrVersion');
  });

  it('fires the guardrail assertions the fixture app makes', () => {
    // `cdk synth` exits 0 for a stack with no guardrail, so the fixture asserts the
    // resource itself. The assertion is only meaningful if the context asks for one.
    const context = JSON.parse(readFileSync(join(FIXTURE, 'cdk', 'context.json'), 'utf8'));
    expect(context.services.api.guardrailEngines).toEqual(['bedrock']);
    expect(context.guardrails.api.content).toHaveLength(1);

    const app = readFileSync(join(FIXTURE, 'cdk', 'bin', 'app.js'), 'utf8');
    expect(app).toContain('expected one managed guardrail');
    expect(app).toContain('expected one guardrail version');
  });

  it('is .cjs, because a generated project may be an ES module', () => {
    // `packages/cli` is `"type": "module"`; a `.js` construct is parsed as ESM and
    // `require` throws before synth starts. The fixture caught exactly that.
    expect(CDK_SERVERLESS_MODULE.startsWith(CDK_DIR)).toBe(true);
    expect(CDK_SERVERLESS_MODULE.endsWith('.cjs')).toBe(true);
  });
});

describe('the whole derived tree, CDK included', () => {
  it('emits the construct beside the module it mirrors', () => {
    const paths = emitInfra(SERVING).map((file) => file.path);
    expect(paths).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
    expect(paths).toContain(CDK_SERVERLESS_MODULE);
  });

  it('emits no construct on GCP', () => {
    const paths = emitInfra(SERVING, { cloud: 'gcp' }).map((file) => file.path);
    expect(paths).not.toContain(CDK_SERVERLESS_MODULE);
  });
});
