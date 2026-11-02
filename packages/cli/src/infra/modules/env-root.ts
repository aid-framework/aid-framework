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
}

/** The plan-shaped variables every env root declares, so the generated tfvars binds. */
const PLAN_VARIABLES = [
  '# Declared so the generated tfvars binds without an "undeclared variable" warning.',
  'variable "project" {}',
  'variable "services" {}',
  'variable "data_stores" {}',
  'variable "tasks" {}',
  'variable "alarms" {}',
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

/** GCP: Secret Manager ids, not ARNs, and no network inputs -- Cloud Run needs none. */
const GCP_SECRET_IDS = [
  '',
  'variable "secret_ids" {',
  '  description = "Secret name -> Secret Manager secret id. The module resolves these at runtime."',
  '  type        = map(string)',
  '  default     = {}',
  '}',
];

const GCP_INPUTS = [
  '',
  '# Cloud Run needs a region it can name in a URL, and nothing else about the network: it',
  '# terminates TLS and scales behind a managed frontend the module creates.',
  'variable "region" {',
  '  description = "The region every resource is created in."',
  '  type        = string',
  '}',
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
  '',
  'variable "deletion_protection" {',
  '  description = "Leave on for anything real: destroying a protected service is refused."',
  '  type        = bool',
  '  default     = true',
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
  const any = modules.serverless || modules.container || modules.batch === true;

  const variables = [
    ...PLAN_VARIABLES,
    ...(any ? IMAGE_URIS : []),
    ...(any ? SECRET_ARNS : []),
    ...(any ? BEDROCK_INPUTS : []),
    ...(modules.serverless ? SERVERLESS_SIZING : []),
    ...(modules.container ? CONTAINER_INPUTS : []),
    ...(modules.batch === true ? BATCH_INPUTS : []),
    ...(any ? TAGS : []),
  ];

  const calls: string[][] = [];
  const outputs: string[][] = [];

  if (modules.serverless) {
    calls.push(
      moduleCall('serverless', [
        'project        = var.project',
        'services       = var.services',
        'image_uris     = var.image_uris',
        'secret_arns    = var.secret_arns',
        'sizing         = var.sizing',
        'bedrock_region = var.bedrock_region',
        'tags           = var.tags',
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
        'tags               = var.tags',
      ]),
    );
    outputs.push(['output "container_endpoint" {', '  value = module.container.api_endpoint', '}']);
  }

  if (modules.batch === true) {
    calls.push(
      moduleCall('batch', [
        'project                 = var.project',
        'services                = var.services',
        'image_uris              = var.image_uris',
        'secret_arns             = var.secret_arns',
        'batch_sizing            = var.batch_sizing',
        'subnet_ids              = var.batch_subnet_ids',
        'security_group_ids      = var.batch_security_group_ids',
        'assign_public_ip        = var.batch_assign_public_ip',
        'max_vcpus               = var.batch_max_vcpus',
        'log_retention_days      = var.batch_log_retention_days',
        'bedrock_region          = var.bedrock_region',
        'tags                    = var.tags',
      ]),
    );
    outputs.push(['output "batch_job_queue" {', '  value = module.batch.job_queue_arn', '}']);
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
        '# This plan targets none of `serverless`, `container` or `batch`, so no provider module was',
        '# generated. Point a module call at `../../generated/modules/<platform>` once one',
        '# exists for the targets you deploy.',
      ];

  return { variables: hcl(variables), main: hcl(main) };
}

/**
 * The GCP env root: one Cloud Run module call, and the inputs Cloud Run needs that the
 * spec cannot know. There is no VPC, subnet or certificate variable here because Cloud
 * Run provisions none of them -- which is why this root is much shorter than the AWS one.
 */
function gcpEnvRoot(modules: EnvRootModules): { variables: string; main: string } {
  const run = modules.container;

  const variables = [
    ...PLAN_VARIABLES,
    ...(run ? GCP_PROJECT : []),
    ...(run ? IMAGE_URIS : []),
    ...(run ? GCP_SECRET_IDS : []),
    ...(run ? GCP_INPUTS : []),
    ...(run ? TAGS : []),
  ];

  const main = run
    ? [
        '# The project a resource lands in is an account fact the spec cannot know, so the',
        '# env root configures the provider once instead of every resource naming it.',
        'provider "google" {',
        '  project = var.gcp_project',
        '  region  = var.region',
        '}',
        '',
        '# The Cloud Run module, fed from the generated tfvars and the inputs below. dev and',
        '# prod differ only in the values they supply, which is what lets one generated tree',
        '# deploy to a second GCP project unchanged.',
        '',
        ...moduleCall('cloudrun', [
          'project               = var.project',
          'services              = var.services',
          'image_uris            = var.image_uris',
          'secret_ids            = var.secret_ids',
          'cloudrun_sizing       = var.cloudrun_sizing',
          'project_id            = var.gcp_project',
          'region                = var.region',
          'allow_unauthenticated = var.allow_unauthenticated',
          'deletion_protection   = var.deletion_protection',
          'tags                  = var.tags',
        ]),
        '',
        'output "cloudrun_urls" {',
        '  value = module.cloudrun.service_urls',
        '}',
      ]
    : [
        '# This plan targets no `container` service, and on GCP that is the only target a',
        '# module exists for. `serverless` needs a Cloud Functions entrypoint, `batch` a',
        '# Google Cloud Batch module, and `edge` has no GCP counterpart.',
      ];

  return { variables: hcl(variables), main: hcl(main) };
}
