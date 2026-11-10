/**
 * The env root a project owns, rendered for the modules its plan actually needs.
 *
 * It is a function rather than a constant because a plan may target one platform or
 * both: a serverless-only project should not be handed container variables it will
 * never set. The output is still pure -- the same module set always yields the same
 * bytes -- so the committed fixture can be asserted equal to it and CI's `tofu validate`
 * then proves the exact text the README prints.
 *
 * The env root is never written by `aid infra gen`: it holds account ids, regions and
 * CIDRs, which are the operator's decisions, not the spec's.
 */

import { type Cloud, DEFAULT_CLOUD } from '../cloud.js';
import { hcl } from './hcl.js';

export interface EnvRootModules {
  readonly serverless: boolean;
  readonly container: boolean;
  /** Optional so a caller that predates the batch module keeps reading as "no batch". */
  readonly batch?: boolean;
  /** Optional for the same reason: "no edge" unless a caller says otherwise. */
  readonly edge?: boolean;
  /** Optional for the same reason: "no managed base" unless a caller says otherwise. */
  readonly knowledgeBase?: boolean;
  /** Optional for the same reason: "no managed MCP gateway" unless a caller says so. */
  readonly gateway?: boolean;
  /** Optional for the same reason: "no managed agent runtime" unless a caller says so. */
  readonly agentRuntime?: boolean;
  /** Optional for the same reason: "no managed guardrail template" unless a caller says so. */
  readonly modelArmor?: boolean;
  /** Optional for the same reason: "no audit destination" unless a caller says so. */
  readonly audit?: boolean;
}

/** The plan-shaped variables every env root declares, so the generated tfvars binds. */
const PLAN_VARIABLES = [
  '# Declared so the generated tfvars binds without an "undeclared variable" warning.',
  'variable "project" {}',
  'variable "services" {}',
  'variable "guardrails" {}',
  'variable "data_stores" {}',
  'variable "tasks" {}',
  'variable "alarms" {}',
  'variable "knowledge_bases" {}',
  'variable "model_armor_templates" {}',
];

/**
 * Declared only when the gateway module exists, unlike the plan-shaped variables above.
 * A project with no gateway omits the key from its tfvars, and a variable with no default
 * that the tfvars never sets fails the plan outright rather than merely warning.
 */
const GATEWAY_INPUT = [
  '',
  '# Every gateway in the plan, keyed by spec name. The module derives the platform name.',
  'variable "gateways" {}',
];

const IMAGE_URIS = [
  '',
  '# Business inputs. None of these is derivable from the spec, by design.',
  'variable "image_uris" {',
  '  description = "Service id -> the image it runs, pinned to a released tag."',
  '  type        = map(string)',
  '}',
];

const SECRET_ARNS = [
  '',
  'variable "secret_arns" {',
  '  description = "Secret name -> Secrets Manager ARN. The module resolves these at runtime."',
  '  type        = map(string)',
  '  default     = {}',
  '}',
];

const TAGS = ['', 'variable "tags" {', '  type    = map(string)', '  default = {}', '}'];

/**
 * The audit destination, declared only when the document pins one.
 *
 * `audit` is otherwise a plan-shaped variable and would be declared beside the rest, but a
 * project that names no sink must be handed no input it would never set -- and the README
 * prints the env root verbatim, so an unconditional block would change the generated tree
 * for every project that never asked for audit.
 */
const AUDIT_INPUTS = [
  '',
  'variable "audit" {',
  '  description = "The audit destination the document pins. Present exactly when the plan pinned one."',
  '  type = object({',
  '    sink           = string',
  '    retention_days = optional(number)',
  '  })',
  '}',
  '',
  'variable "audit_bucket_name" {',
  '  description = "Globally unique name for the audit archive. Required when the sink is s3 or gcs, ignored otherwise."',
  '  type        = string',
  '  default     = ""',
  '}',
];

/** GCP: Secret Manager ids, not ARNs, and no network inputs -- Cloud Run needs none. */
const GCP_SECRET_IDS = [
  '',
  'variable "secret_ids" {',
  '  description = "Secret name -> Secret Manager secret id. The module resolves these at runtime."',
  '  type        = map(string)',
  '  default     = {}',
  '}',
];

const GCP_REGION = [
  '',
  '# Cloud Run names the region in a URL, and a job is created in one; both are deployment',
  '# choices, not something the spec can infer.',
  'variable "region" {',
  '  description = "The region every resource is created in."',
  '  type        = string',
  '}',
];

const GCP_DELETION_PROTECTION = [
  '',
  'variable "deletion_protection" {',
  '  description = "Leave on for anything real: destroying a protected resource is refused."',
  '  type        = bool',
  '  default     = true',
  '}',
];

/** Cloud Run services: sizing and whether the internet may invoke them. */
const GCP_CLOUDRUN_INPUTS = [
  '',
  'variable "cloudrun_sizing" {',
  '  description = "Service id -> CPU, memory, instance bounds and concurrency."',
  '  type = map(object({',
  '    cpu           = optional(string)',
  '    memory_mb     = optional(number)',
  '    min_instances = optional(number)',
  '    max_instances = optional(number)',
  '    concurrency   = optional(number)',
  '  }))',
  '  default = {}',
  '}',
  '',
  'variable "allow_unauthenticated" {',
  '  description = "Whether the internet may invoke the services without a Google identity."',
  '  type        = bool',
  '  default     = true',
  '}',
];

/**
 * Cloud Run jobs: CPU, memory, attempts and a whole-run deadline. The same decisions the
 * AWS batch module asks for -- Cloud Run provisions the execution environment, so unlike
 * Fargate there is no subnet or security group to name.
 */
const GCP_JOB_INPUTS = [
  '',
  'variable "batch_sizing" {',
  '  description = "Deployment id -> CPU, memory, attempts and run timeout."',
  '  type = map(object({',
  '    cpu             = optional(string)',
  '    memory_mb       = optional(number)',
  '    attempts        = optional(number)',
  '    timeout_seconds = optional(number)',
  '  }))',
  '  default = {}',
  '}',
];

/**
 * The GCP project id is an account fact the spec cannot know, so the env root supplies it
 * once: the provider block uses it for every resource, and the module takes it for the
 * one grant that has to name a project (`roles/aiplatform.user`). It is not derived.
 */
const GCP_PROJECT = [
  '',
  'variable "gcp_project" {',
  '  description = "The GCP project id resources are created in. Not the aid project name."',
  '  type        = string',
  '}',
];

const SERVERLESS_SIZING = [
  '',
  'variable "sizing" {',
  '  description = "Service id -> memory and timeout. The module defaults are deliberately modest."',
  '  type = map(object({',
  '    memory_mb       = number',
  '    timeout_seconds = number',
  '  }))',
  '  default = {}',
  '}',
];

/**
 * Batch: a Fargate job needs a place to run and a ceiling to scale to. Nothing here is
 * derivable from the spec -- the subnets belong to the account, and the ceiling is a cost
 * decision -- which is why the module defaults are the only values it may assume.
 */
const BATCH_INPUTS = [
  '',
  'variable "batch_sizing" {',
  '  description = "Deployment id -> vCPU, memory, attempts and attempt timeout."',
  '  type = map(object({',
  '    vcpus           = optional(number)',
  '    memory_mb       = optional(number)',
  '    attempts        = optional(number)',
  '    timeout_seconds = optional(number)',
  '  }))',
  '  default = {}',
  '}',
  '',
  'variable "batch_subnet_ids" {',
  '  description = "Subnets a batch task runs in. At least one; the module refuses an empty list."',
  '  type        = list(string)',
  '}',
  '',
  'variable "batch_security_group_ids" {',
  '  description = "Security groups a batch task joins."',
  '  type        = list(string)',
  '  default     = []',
  '}',
  '',
  'variable "batch_assign_public_ip" {',
  '  description = "Give the task a public IP. A private subnet needs a NAT gateway instead."',
  '  type        = bool',
  '  default     = false',
  '}',
  '',
  'variable "batch_max_vcpus" {',
  '  description = "The ceiling the batch queue may scale to."',
  '  type        = number',
  '  default     = 16',
  '}',
  '',
  'variable "batch_log_retention_days" {',
  '  type    = number',
  '  default = 30',
  '}',
];

/**
 * Bedrock is regional and a model id is not portable across regions, but the deployment
 * region is already the provider's region and Lambda sets `AWS_REGION` itself. So this is
 * an override with an empty default, not a required input: it exists for the case where
 * the model lives somewhere other than the stack, and the modules decide the value.
 */
const BEDROCK_INPUTS = [
  '',
  'variable "bedrock_region" {',
  '  description = "Region for Bedrock model calls, when it differs from the region this stack deploys into."',
  '  type        = string',
  '  default     = ""',
  '}',
];

/**
 * Edge: a Lambda zip, a CloudFront distribution, and the two domain decisions CloudFront
 * will not make for you. None of it is derivable from the spec -- the zip is a build
 * artifact, and a custom domain is the operator's.
 */
const EDGE_INPUTS = [
  '',
  'variable "edge_zip_path" {',
  '  description = "Path to a zip of the app, resolved from this env root. Build it before planning."',
  '  type        = string',
  '  default     = "edge.zip"',
  '}',
  '',
  'variable "edge_sizing" {',
  '  description = "Deployment id -> memory and timeout. Lambda@Edge caps the timeout at 30s."',
  '  type = map(object({',
  '    memory_mb       = optional(number)',
  '    timeout_seconds = optional(number)',
  '  }))',
  '  default = {}',
  '}',
  '',
  'variable "edge_aliases" {',
  '  description = "Custom domain names the distribution answers on. Empty keeps the cloudfront.net name."',
  '  type        = list(string)',
  '  default     = []',
  '}',
  '',
  'variable "edge_certificate_arn" {',
  '  description = "ACM certificate in us-east-1 for edge_aliases. Required with aliases, ignored without."',
  '  type        = string',
  '  default     = ""',
  '}',
  '',
  'variable "edge_price_class" {',
  '  description = "Which CloudFront edge locations serve the app."',
  '  type        = string',
  '  default     = "PriceClass_100"',
  '}',
];

const CONTAINER_INPUTS = [
  '',
  'variable "container_sizing" {',
  '  description = "Service id -> CPU units, memory and task count."',
  '  type = map(object({',
  '    cpu           = optional(number)',
  '    memory_mb     = optional(number)',
  '    desired_count = optional(number)',
  '  }))',
  '  default = {}',
  '}',
  '',
  '# Networking. An empty vpc_id has the module build a two-AZ VPC; setting it, with both',
  '# subnet lists, deploys into a VPC you already run.',
  'variable "vpc_id" {',
  '  type    = string',
  '  default = ""',
  '}',
  '',
  'variable "public_subnet_ids" {',
  '  description = "Subnets the load balancer sits in. Two, in different AZs."',
  '  type        = list(string)',
  '  default     = []',
  '}',
  '',
  'variable "private_subnet_ids" {',
  '  description = "Subnets the tasks run in. They need egress to pull an image."',
  '  type        = list(string)',
  '  default     = []',
  '}',
  '',
  'variable "vpc_cidr" {',
  '  description = "Range for the VPC the module builds. Required when vpc_id is empty; ignored otherwise."',
  '  type        = string',
  '  default     = ""',
  '}',
  '',
  'variable "health_check_path" {',
  '  description = "Path the target group probes. Any 2xx-4xx counts as healthy."',
  '  type        = string',
  '  default     = "/"',
  '}',
  '',
  'variable "idle_timeout" {',
  '  description = "Load balancer idle timeout in seconds. Raise it for a long stream."',
  '  type        = number',
  '  default     = 300',
  '}',
  '',
  'variable "log_retention_days" {',
  '  type    = number',
  '  default = 30',
  '}',
];

/** One module call, with the inputs that module declares -- nothing it ignores. */
function moduleCall(name: string, inputs: readonly string[]): string[] {
  return [
    `module "${name}" {`,
    `  source = "../../generated/modules/${name}"`,
    '',
    ...inputs.map((input) => `  ${input}`),
    '}',
  ];
}

/** Blocks separated by one blank line, so a file reads as sections rather than a run of lines. */
function blocks(sections: readonly string[][]): string[] {
  return sections.flatMap((section, index) => (index === 0 ? section : ['', ...section]));
}

export function envRoot(
  modules: EnvRootModules,
  cloud: Cloud = DEFAULT_CLOUD,
): { variables: string; main: string } {
  return cloud === 'gcp' ? gcpEnvRoot(modules) : awsEnvRoot(modules);
}

function awsEnvRoot(modules: EnvRootModules): { variables: string; main: string } {
  const edge = modules.edge === true;
  const runtime = modules.agentRuntime === true;
  // An edge function is a zip, not an image, and its configuration is the secret the
  // module creates -- so an edge-only root needs none of the image or ARN inputs.
  const images = modules.serverless || modules.container || modules.batch === true || runtime;
  // Only the compute modules read `secret_arns`: AgentCore has no secret reference, so
  // the runtime module declares none and a runtime-only root does not ask for the map.
  const secrets = modules.serverless || modules.container || modules.batch === true;
  // A runtime may call Bedrock too, so the regional override is not tied to compute.
  const bedrock = secrets || runtime;
  const audit = modules.audit === true;
  // An audit-only root still needs the tag map, because the module tags the destination.
  const any = images || edge || modules.knowledgeBase === true || modules.gateway === true || audit;

  const variables = [
    ...PLAN_VARIABLES,
    ...(modules.gateway === true ? GATEWAY_INPUT : []),
    ...(images ? IMAGE_URIS : []),
    ...(secrets ? SECRET_ARNS : []),
    ...(bedrock ? BEDROCK_INPUTS : []),
    ...(modules.serverless ? SERVERLESS_SIZING : []),
    ...(modules.container ? CONTAINER_INPUTS : []),
    ...(modules.batch === true ? BATCH_INPUTS : []),
    ...(edge ? EDGE_INPUTS : []),
    ...(audit ? AUDIT_INPUTS : []),
    ...(any ? TAGS : []),
  ];

  const calls: string[][] = [];
  const outputs: string[][] = [];

  // One destination for the environment, so it is called once here rather than by every
  // module that reads the tfvar. No `region` input: on AWS the provider decides it.
  if (audit) {
    calls.push(
      moduleCall('audit', [
        'project           = var.project',
        'audit             = var.audit',
        'audit_bucket_name = var.audit_bucket_name',
        'tags              = var.tags',
      ]),
    );
    outputs.push(['output "audit_destination" {', '  value = module.audit.destination', '}']);
  }

  // A managed base is created by its own module, so the compute modules read the ids it
  // returned. Without one the plan's map passes straight through, which is the case that
  // keeps a project with no base byte-identical to the tree it generated before.
  const knowledgeBases =
    modules.knowledgeBase === true
      ? 'module.knowledge-base.knowledge_bases'
      : 'var.knowledge_bases';

  if (modules.knowledgeBase === true) {
    calls.push(
      moduleCall('knowledge-base', [
        'project         = var.project',
        'knowledge_bases = var.knowledge_bases',
        'tags            = var.tags',
      ]),
    );
    outputs.push([
      'output "knowledge_base_ids" {',
      '  value = module.knowledge-base.knowledge_base_ids',
      '}',
    ]);
  }

  // The gateway is created by its own module for the same reason a base is: the runtime
  // is handed a URL only the platform can assign, so the runtime module reads the map
  // this one returns rather than the plan's entry verbatim.
  if (modules.gateway === true) {
    calls.push(
      moduleCall('gateway', [
        'project  = var.project',
        'gateways = var.gateways',
        'tags     = var.tags',
      ]),
    );
    outputs.push(['output "gateway_urls" {', '  value = module.gateway.gateway_urls', '}']);
  }

  if (modules.serverless) {
    calls.push(
      moduleCall('serverless', [
        'project         = var.project',
        'services        = var.services',
        'guardrails      = var.guardrails',
        'image_uris      = var.image_uris',
        'secret_arns     = var.secret_arns',
        'sizing          = var.sizing',
        'bedrock_region  = var.bedrock_region',
        `knowledge_bases = ${knowledgeBases}`,
        'tags            = var.tags',
      ]),
    );
    outputs.push([
      'output "serverless_endpoint" {',
      '  value = module.serverless.api_endpoint',
      '}',
    ]);
  }

  if (modules.container) {
    calls.push(
      moduleCall('container', [
        'project            = var.project',
        'services           = var.services',
        'guardrails         = var.guardrails',
        'image_uris         = var.image_uris',
        'secret_arns        = var.secret_arns',
        'container_sizing   = var.container_sizing',
        'vpc_id             = var.vpc_id',
        'public_subnet_ids  = var.public_subnet_ids',
        'private_subnet_ids = var.private_subnet_ids',
        'vpc_cidr           = var.vpc_cidr',
        'health_check_path  = var.health_check_path',
        'idle_timeout       = var.idle_timeout',
        'log_retention_days = var.log_retention_days',
        'bedrock_region     = var.bedrock_region',
        `knowledge_bases    = ${knowledgeBases}`,
        'tags               = var.tags',
      ]),
    );
    outputs.push(['output "container_endpoint" {', '  value = module.container.api_endpoint', '}']);
  }

  // A runtime replaces the compute module for the services it owns, so this call sits
  // beside them rather than inside one: the same generated tree may run some services on
  // ECS and hand others to AgentCore.
  if (runtime) {
    calls.push(
      moduleCall('agent-runtime', [
        'project         = var.project',
        'services        = var.services',
        'guardrails      = var.guardrails',
        'image_uris      = var.image_uris',
        'bedrock_region  = var.bedrock_region',
        `knowledge_bases = ${knowledgeBases}`,
        ...(modules.gateway === true ? ['gateways        = module.gateway.gateways'] : []),
        'tags            = var.tags',
      ]),
    );
    outputs.push([
      'output "agent_runtimes" {',
      '  value = module.agent-runtime.agent_runtimes',
      '}',
    ]);
  }

  if (modules.batch === true) {
    calls.push(
      moduleCall('batch', [
        'project            = var.project',
        'services           = var.services',
        'guardrails         = var.guardrails',
        'image_uris         = var.image_uris',
        'secret_arns        = var.secret_arns',
        'batch_sizing       = var.batch_sizing',
        'subnet_ids         = var.batch_subnet_ids',
        'security_group_ids = var.batch_security_group_ids',
        'assign_public_ip   = var.batch_assign_public_ip',
        'max_vcpus          = var.batch_max_vcpus',
        'log_retention_days = var.batch_log_retention_days',
        'bedrock_region     = var.bedrock_region',
        `knowledge_bases    = ${knowledgeBases}`,
        'tasks              = var.tasks',
        'tags               = var.tags',
      ]),
    );
    outputs.push(['output "batch_job_queue" {', '  value = module.batch.job_queue_arn', '}']);
  }

  if (edge) {
    calls.push(
      moduleCall('edge', [
        'project              = var.project',
        'services             = var.services',
        'edge_zip_path        = var.edge_zip_path',
        'edge_sizing          = var.edge_sizing',
        'edge_aliases         = var.edge_aliases',
        'edge_certificate_arn = var.edge_certificate_arn',
        'edge_price_class     = var.edge_price_class',
        'tags                 = var.tags',
      ]),
    );
    outputs.push([
      'output "edge_domain_name" {',
      '  value = module.edge.distribution_domain_name',
      '}',
    ]);
  }

  const main = any
    ? [
        '# The one module call per platform this plan targets. dev and prod differ only in',
        '# the values they supply, which is what lets one generated tree run in more than one',
        '# account.',
        '',
        ...blocks(calls),
        '',
        ...blocks(outputs),
      ]
    : [
        '# This plan targets none of `serverless`, `container`, `batch`, `edge` or a managed',
        '# `runtime`, so no provider module was generated. Point a module call at',
        '# `../../generated/modules/<platform>` once one exists for the targets you deploy.',
      ];

  return { variables: hcl(variables), main: hcl(main) };
}

/**
 * The GCP env root: one Cloud Run module call per platform the plan targets, and the
 * inputs those modules need that the spec cannot know. There is no VPC, subnet or
 * certificate variable here because Cloud Run provisions none of them -- which is why this
 * root is much shorter than the AWS one.
 */
function gcpEnvRoot(modules: EnvRootModules): { variables: string; main: string } {
  // `serverless` is folded into `container` by `modulesOf`, but a caller that sets it
  // directly still lands on Cloud Run rather than on a module that does not exist.
  const run = modules.container || modules.serverless;
  const job = modules.batch === true;
  const corpus = modules.knowledgeBase === true;
  const runtime = modules.agentRuntime === true;
  const armor = modules.modelArmor === true;
  const audit = modules.audit === true;
  // A corpus-only root still needs the project, region, tags and provider, but no image
  // or secret inputs: nothing runs. `compute` keeps those tied to a module that reads them.
  const compute = run || job || runtime;
  const any = compute || corpus || armor || audit;

  const variables = [
    ...PLAN_VARIABLES,
    ...(any ? GCP_PROJECT : []),
    ...(compute ? IMAGE_URIS : []),
    ...(compute ? GCP_SECRET_IDS : []),
    ...(any ? GCP_REGION : []),
    ...(run ? GCP_CLOUDRUN_INPUTS : []),
    ...(job ? GCP_JOB_INPUTS : []),
    ...(run || job ? GCP_DELETION_PROTECTION : []),
    ...(audit ? AUDIT_INPUTS : []),
    ...(any ? TAGS : []),
  ];

  const calls: string[][] = [];
  const outputs: string[][] = [];

  if (audit) {
    calls.push(
      moduleCall('audit', [
        'project           = var.project',
        'audit             = var.audit',
        'audit_bucket_name = var.audit_bucket_name',
        'project_id        = var.gcp_project',
        'region            = var.region',
        'tags              = var.tags',
      ]),
    );
    outputs.push(['output "audit_destination" {', '  value = module.audit.destination', '}']);
  }

  // A managed corpus is created by its own module, so the compute modules read the name it
  // returned. Without one the plan's map passes straight through, which is the case that
  // keeps a project with no base byte-identical to the tree it generated before.
  const knowledgeBases = corpus ? 'module.vertex-rag.knowledge_bases' : 'var.knowledge_bases';

  // Same shape for the guardrail template: a plan that owns a Model Armor template has
  // one module create it, and every compute module reads the name it returned. A plan
  // that only names a template an operator created passes the map straight through.
  const armorTemplates = armor ? 'module.model-armor.templates' : 'var.model_armor_templates';

  if (armor) {
    calls.push(
      moduleCall('model-armor', [
        'project               = var.project',
        'project_id            = var.gcp_project',
        'region                = var.region',
        'model_armor_templates = var.model_armor_templates',
        'tags                  = var.tags',
      ]),
    );
    outputs.push([
      'output "model_armor_templates" {',
      '  value = module.model-armor.templates',
      '}',
    ]);
  }

  if (corpus) {
    calls.push(
      moduleCall('vertex-rag', [
        'project         = var.project',
        'project_id      = var.gcp_project',
        'region          = var.region',
        'knowledge_bases = var.knowledge_bases',
        'tags            = var.tags',
      ]),
    );
    outputs.push(['output "corpus_names" {', '  value = module.vertex-rag.corpus_names', '}']);
  }

  if (run) {
    calls.push(
      moduleCall('cloudrun', [
        'project               = var.project',
        'services              = var.services',
        'image_uris            = var.image_uris',
        'secret_ids            = var.secret_ids',
        'cloudrun_sizing       = var.cloudrun_sizing',
        'project_id            = var.gcp_project',
        'region                = var.region',
        'allow_unauthenticated = var.allow_unauthenticated',
        'deletion_protection   = var.deletion_protection',
        `knowledge_bases       = ${knowledgeBases}`,
        `model_armor_templates = ${armorTemplates}`,
        'tags                  = var.tags',
      ]),
    );
    outputs.push(['output "cloudrun_urls" {', '  value = module.cloudrun.service_urls', '}']);
  }

  if (job) {
    calls.push(
      moduleCall('cloudrunjob', [
        'project               = var.project',
        'services              = var.services',
        'image_uris            = var.image_uris',
        'secret_ids            = var.secret_ids',
        'batch_sizing          = var.batch_sizing',
        'project_id            = var.gcp_project',
        'region                = var.region',
        'deletion_protection   = var.deletion_protection',
        `knowledge_bases       = ${knowledgeBases}`,
        `model_armor_templates = ${armorTemplates}`,
        'tasks                 = var.tasks',
        'tags                  = var.tags',
      ]),
    );
    outputs.push(['output "batch_jobs" {', '  value = module.cloudrunjob.job_ids', '}']);
  }

  // A reasoning engine replaces Cloud Run for the services it owns, so it is a sibling
  // module rather than another target inside `cloudrun`.
  if (runtime) {
    calls.push(
      moduleCall('agent-runtime', [
        'project               = var.project',
        'services              = var.services',
        'image_uris            = var.image_uris',
        'project_id            = var.gcp_project',
        'region                = var.region',
        'secret_ids            = var.secret_ids',
        `model_armor_templates = ${armorTemplates}`,
        'tags                  = var.tags',
      ]),
    );
    outputs.push([
      'output "reasoning_engines" {',
      '  value = module.agent-runtime.reasoning_engines',
      '}',
    ]);
  }

  const main = any
    ? [
        '# The project a resource lands in is an account fact the spec cannot know, so the',
        '# env root configures the provider once instead of every resource naming it.',
        'provider "google" {',
        '  project = var.gcp_project',
        '  region  = var.region',
        '}',
        '',
        '# dev and prod differ only in the values they supply, which is what lets one',
        '# generated tree deploy to a second GCP project unchanged.',
        '',
        ...blocks(calls),
        '',
        ...blocks(outputs),
      ]
    : [
        '# This plan targets no service a module exists for. On GCP `container` and',
        '# `serverless` both deploy to Cloud Run, `batch` to a Cloud Run job, and a managed',
        '# `runtime` to a reasoning engine; `edge` has no GCP counterpart.',
      ];

  return { variables: hcl(variables), main: hcl(main) };
}
