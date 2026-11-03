/**
 * The deployment wiring, derived from the deployment plan.
 *
 * This emits the *derived* layer only: the plan itself, the two spellings an env root
 * consumes (Terraform tfvars, CDK context), a README that says who owns what, and the
 * constant provider modules behind `modules/index.ts` -- which include the one CDK
 * construct, validated once by `cdk synth`. Env roots and CDK stacks are not emitted:
 * they carry the account, region and sizing decisions the plan deliberately omits.
 *
 * The load-bearing rule is enforced by construction: nothing in this file accepts an
 * account id, a region, a CIDR, a domain, or a sizing number, so none can appear in the
 * output (design §12.2). An env root is the same for dev and prod; only its inputs differ.
 */

import type {
  BedrockContentFilter,
  BedrockContentStrength,
  BedrockPiiEntity,
  DeployManagedGuardrail,
  DeployPlan,
} from '@aid-framework/ir';

import { type Cloud, DEFAULT_CLOUD } from './cloud.js';
import { emitProviderModules, envRoot, modulesOf } from './modules/index.js';
import { INFRA_CDK_CONTEXT_PATH, INFRA_GENERATED_DIR, INFRA_PLAN_PATH } from './paths.js';

export {
  INFRA_CDK_CONTEXT_PATH,
  INFRA_GENERATED_DIR,
  INFRA_MANIFEST_PATH,
  INFRA_PLAN_PATH,
} from './paths.js';

export interface InfraFile {
  /** Repository-relative, POSIX-separated. */
  readonly path: string;
  readonly contents: string;
}

/**
 * A managed guardrail spelled for the AWS provider: the spec's vocabulary mapped to the
 * vendor's once, here, so neither the plan nor a generated app carries AWS enums.
 */
export interface DeployGuardrail {
  readonly id: string;
  readonly message: string;
  readonly content: readonly { readonly type: string; readonly strength: string }[];
  readonly topics: readonly { readonly name: string; readonly definition: string }[];
  readonly words: readonly string[];
  readonly pii: readonly { readonly type: string; readonly action: 'ANONYMIZE' | 'BLOCK' }[];
}

const BEDROCK_CONTENT_TYPES: Record<BedrockContentFilter, string> = {
  sexual: 'SEXUAL',
  violence: 'VIOLENCE',
  hate: 'HATE',
  insults: 'INSULTS',
  misconduct: 'MISCONDUCT',
  'prompt-attack': 'PROMPT_ATTACK',
};

const BEDROCK_CONTENT_STRENGTHS: Record<BedrockContentStrength, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};

const BEDROCK_PII_TYPES: Record<BedrockPiiEntity, string> = {
  email: 'EMAIL',
  phone: 'PHONE',
  name: 'NAME',
  address: 'ADDRESS',
  ssn: 'US_SOCIAL_SECURITY_NUMBER',
  'credit-card': 'CREDIT_DEBIT_CARD_NUMBER',
  'bank-account': 'US_BANK_ACCOUNT_NUMBER',
  passport: 'PASSPORT_NUMBER',
  'drivers-license': 'DRIVERS_LICENSE_NUMBER',
  'ip-address': 'IP_ADDRESS',
  url: 'URL',
  'aws-access-key': 'AWS_ACCESS_KEY',
  'aws-secret-key': 'AWS_SECRET_KEY',
};

export function deployGuardrail(guardrail: DeployManagedGuardrail): DeployGuardrail {
  return {
    id: guardrail.id,
    message: guardrail.message,
    content: Object.entries(guardrail.policy.content ?? {}).map(([type, strength]) => ({
      type: BEDROCK_CONTENT_TYPES[type as BedrockContentFilter],
      strength: BEDROCK_CONTENT_STRENGTHS[strength],
    })),
    topics: Object.entries(guardrail.policy.topics ?? {}).map(([name, definition]) => ({
      name,
      definition,
    })),
    words: [...(guardrail.policy.words ?? [])],
    pii: (guardrail.policy.pii ?? []).map((entity) => ({
      type: BEDROCK_PII_TYPES[entity],
      action: guardrail.action === 'redact' ? ('ANONYMIZE' as const) : ('BLOCK' as const),
    })),
  };
}

/**
 * A tfvars document: the plan in the spelling an env root reads. Keys are snake_case
 * because that is what a Terraform variable is called; values are the plan's, unchanged.
 *
 * Deliberately absent: any value a person must choose. `instance_class`, `min_size`,
 * `region`, `domain` and `account_id` are business inputs, and an env root supplies them
 * from its own `business/` file.
 */
export interface DeployTfvars {
  readonly project: { readonly name: string; readonly namespace: string };
  readonly services: Readonly<
    Record<
      string,
      {
        readonly target: string;
        readonly streaming: boolean;
        readonly routes: readonly { pipeline: string; method: string; path: string }[];
        readonly env: readonly {
          name: string;
          secret: boolean;
          from: string;
          value?: string;
        }[];
        readonly secret_names: readonly string[];
        /** Only a `batch` service sets this: the pipeline its job runs once. */
        readonly pipeline?: string;
        readonly providers: readonly string[];
        readonly ingest: readonly string[];
        /** Engines the service's guardrails use; `bedrock` needs the managed grant. */
        readonly guardrail_engines: readonly string[];
      }
    >
  >;
  /**
   * The managed guardrail each service owns, spelled with the provider's identifiers.
   *
   * Keyed by service id because a deployment wires one managed guardrail. The mapping
   * from the spec's vocabulary (`prompt-attack`, `credit-card`) to AWS's lives here and
   * only here: `emit.ts` is the seam that knows it emits AWS, while the plan and the
   * spec must not name an enum a different cloud would read differently.
   */
  readonly guardrails: Readonly<Record<string, DeployGuardrail>>;
  readonly data_stores: Readonly<
    Record<
      string,
      {
        readonly kind: string;
        readonly secret_ref?: string;
        readonly requires_extension?: string;
        readonly retrievers: readonly string[];
      }
    >
  >;
  readonly tasks: readonly { id: string; kind: string; source: string; schedule?: string }[];
  readonly alarms: readonly { id: string; metric: string; source: string }[];
}

/**
 * The plan spelled for a CDK app: the same facts as `DeployTfvars`, keyed the way a
 * TypeScript project reads them. Two spellings of one document are worth it because a
 * CDK app cannot read HCL and a module tree cannot read JSON; what must not differ is
 * the facts, and `infra.test.ts` asserts exactly that.
 *
 * Deliberately absent, as in the tfvars: any value a person must choose.
 */
export interface DeployContext {
  readonly project: { readonly name: string; readonly namespace: string };
  readonly services: Readonly<
    Record<
      string,
      {
        readonly target: string;
        readonly streaming: boolean;
        readonly routes: readonly { pipeline: string; method: string; path: string }[];
        readonly env: readonly {
          name: string;
          secret: boolean;
          from: string;
          value?: string;
        }[];
        readonly secrets: readonly string[];
        /** Only a `batch` service sets this: the pipeline its job runs once. */
        readonly pipeline?: string;
        readonly providers: readonly string[];
        readonly ingest: readonly string[];
        readonly guardrailEngines: readonly string[];
      }
    >
  >;
  readonly guardrails: Readonly<Record<string, DeployGuardrail>>;
  readonly stores: Readonly<
    Record<
      string,
      {
        readonly kind: string;
        readonly secretRef?: string;
        readonly requiresExtension?: string;
        readonly retrievers: readonly string[];
      }
    >
  >;
  readonly tasks: readonly { id: string; kind: string; source: string; schedule?: string }[];
  readonly alarms: readonly { id: string; metric: string; source: string }[];
}

/**
 * Every derived file, in a stable order. Pure: the same plan always yields the same bytes,
 * so `aid infra gen --check` can compare content instead of trusting a timestamp.
 */
export function emitInfra(plan: DeployPlan, options: { cloud?: Cloud } = {}): InfraFile[] {
  const cloud = options.cloud ?? DEFAULT_CLOUD;
  return [
    { path: INFRA_PLAN_PATH, contents: json(plan) },
    { path: `${INFRA_GENERATED_DIR}/deploy.auto.tfvars.json`, contents: json(tfvars(plan)) },
    { path: INFRA_CDK_CONTEXT_PATH, contents: json(cdkContext(plan)) },
    { path: `${INFRA_GENERATED_DIR}/README.md`, contents: readme(plan, cloud) },
    ...emitProviderModules(plan, cloud),
  ];
}

export function tfvars(plan: DeployPlan): DeployTfvars {
  const services: Record<string, DeployTfvars['services'][string]> = {};
  for (const service of plan.services) {
    services[service.id] = {
      target: service.target,
      streaming: service.streaming,
      routes: service.endpoints.map((endpoint) => ({
        pipeline: endpoint.pipeline,
        method: endpoint.method,
        path: endpoint.path,
      })),
      env: service.env.map((variable) => ({
        name: variable.name,
        secret: variable.secret,
        from: variable.from,
        ...(variable.value === undefined ? {} : { value: variable.value }),
      })),
      secret_names: [...service.secrets],
      providers: [...service.providers],
      ingest: [...service.ingest],
      guardrail_engines: [...(service.guardrailEngines ?? [])],
      ...(service.pipeline === undefined ? {} : { pipeline: service.pipeline }),
    };
  }

  const guardrails: Record<string, DeployGuardrail> = {};
  for (const service of plan.services) {
    if (service.managedGuardrail === undefined) continue;
    guardrails[service.id] = deployGuardrail(service.managedGuardrail);
  }

  const dataStores: Record<string, DeployTfvars['data_stores'][string]> = {};
  for (const store of plan.stores) {
    dataStores[store.id] = {
      kind: store.kind,
      ...(store.secretRef === undefined ? {} : { secret_ref: store.secretRef }),
      ...(store.requiresExtension === undefined
        ? {}
        : { requires_extension: store.requiresExtension }),
      retrievers: [...store.retrievers],
    };
  }

  return {
    project: { name: plan.project.name, namespace: plan.project.namespace },
    services,
    guardrails,
    data_stores: dataStores,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      source: task.source,
      ...(task.schedule === undefined ? {} : { schedule: task.schedule }),
    })),
    alarms: plan.alarms.map((alarm) => ({
      id: alarm.id,
      metric: alarm.metric,
      source: alarm.source,
    })),
  };
}

/**
 * The CDK spelling of the same document.
 *
 * It renames `tfvars(plan)` rather than re-deriving from the plan: two loops over the
 * same plan would drift, and the backend that drifted would be silently missing a fact.
 * Renaming keeps one source and makes parity structural instead of asserted.
 */
export function cdkContext(plan: DeployPlan): DeployContext {
  const spelled = tfvars(plan);

  const services: Record<string, DeployContext['services'][string]> = {};
  for (const [id, service] of Object.entries(spelled.services)) {
    services[id] = {
      target: service.target,
      streaming: service.streaming,
      routes: service.routes.map((route) => ({ ...route })),
      env: service.env.map((variable) => ({
        name: variable.name,
        secret: variable.secret,
        from: variable.from,
        ...(variable.value === undefined ? {} : { value: variable.value }),
      })),
      secrets: [...service.secret_names],
      providers: [...service.providers],
      ingest: [...service.ingest],
      guardrailEngines: [...service.guardrail_engines],
      ...(service.pipeline === undefined ? {} : { pipeline: service.pipeline }),
    };
  }

  const guardrails: Record<string, DeployGuardrail> = {};
  for (const [id, guardrail] of Object.entries(spelled.guardrails ?? {})) {
    guardrails[id] = {
      id: guardrail.id,
      message: guardrail.message,
      content: guardrail.content.map((filter) => ({ ...filter })),
      topics: guardrail.topics.map((topic) => ({ ...topic })),
      words: [...guardrail.words],
      pii: guardrail.pii.map((entity) => ({ ...entity })),
    };
  }

  const stores: Record<string, DeployContext['stores'][string]> = {};
  for (const [id, store] of Object.entries(spelled.data_stores)) {
    stores[id] = {
      kind: store.kind,
      ...(store.secret_ref === undefined ? {} : { secretRef: store.secret_ref }),
      ...(store.requires_extension === undefined
        ? {}
        : { requiresExtension: store.requires_extension }),
      retrievers: [...store.retrievers],
    };
  }

  return {
    project: { name: spelled.project.name, namespace: spelled.project.namespace },
    services,
    guardrails,
    stores,
    tasks: spelled.tasks.map((task) => ({ ...task })),
    alarms: spelled.alarms.map((alarm) => ({ ...alarm })),
  };
}

function readme(plan: DeployPlan, cloud: Cloud): string {
  const routes = plan.services.reduce((total, service) => total + service.endpoints.length, 0);
  const modules = modulesOf(plan, cloud);
  const active = modules.serverless || modules.container || modules.batch || modules.edge;
  const root = envRoot(modules, cloud);
  const envDir = cloud === 'gcp' ? 'infra/envs/gcp-dev' : 'infra/envs/dev';
  return [
    '# Generated infrastructure',
    '',
    'Derived from the spec by `aid infra gen`. Do not edit: the next run compares content',
    'and refuses to overwrite a file you changed by hand (`--force` overrides).',
    '',
    '| File | What it is |',
    '| --- | --- |',
    '| `deploy.plan.json` | The provider-neutral deployment plan both backends render. |',
    '| `deploy.auto.tfvars.json` | The same plan spelled as Terraform inputs. |',
    '| `deploy.cdk-context.json` | The same plan spelled for a CDK app, with camelCase keys. |',
    ...(modules.serverless
      ? [
          '| `modules/serverless/` | The Lambda + HTTP API module a `serverless` service deploys into. |',
        ]
      : []),
    ...(modules.container && cloud === 'aws'
      ? [
          '| `modules/container/` | The ECS Fargate + load balancer module a `container` service deploys into. |',
        ]
      : []),
    ...(modules.container && cloud === 'gcp'
      ? [
          '| `modules/cloudrun/` | The Cloud Run v2 + service account + Artifact Registry module a `container` or `serverless` service deploys into. |',
        ]
      : []),
    ...(modules.batch && cloud === 'aws'
      ? [
          '| `modules/batch/` | The AWS Batch Fargate + job queue module a `batch` deployment runs in. |',
        ]
      : []),
    ...(modules.batch && cloud === 'gcp'
      ? [
          '| `modules/cloudrunjob/` | The Cloud Run job + service account module a `batch` deployment runs in. |',
        ]
      : []),
    ...(modules.edge
      ? [
          '| `modules/edge/` | The Lambda@Edge + CloudFront module an `edge` deployment deploys into. |',
        ]
      : []),
    ...(modules.serverless && cloud === 'aws'
      ? [
          '| `cdk/serverless.cjs` | The CDK construct a `serverless` service is added to (AWS only). |',
        ]
      : []),
    '',
    '## Using it',
    '',
    'With OpenTofu, an env root consumes the tfvars directly, so dev and prod share one',
    'module tree:',
    '',
    '```sh',
    `tofu -chdir=${envDir} plan -var-file=../../generated/deploy.auto.tfvars.json`,
    '```',
    '',
    ...(active
      ? [
          `The env root is yours, not generated. \`${envDir}/variables.tf\` declares the`,
          'business inputs alongside the plan-shaped ones the tfvars already supplies:',
          '',
          '```hcl',
          ...root.variables.trimEnd().split('\n'),
          '```',
          '',
          `and \`${envDir}/main.tf\` calls the module:`,
          '',
          '```hcl',
          ...root.main.trimEnd().split('\n'),
          '```',
          '',
          ...(modules.serverless
            ? [
                'The serverless module refuses a `streaming` service, since an HTTP API cannot',
                'deliver a streamed body.',
                '',
              ]
            : []),
          ...(modules.container && cloud === 'aws'
            ? [
                'The container module refuses two services that claim one path, since a load',
                'balancer routes by path rather than by method.',
                '',
              ]
            : []),
          ...(modules.container && cloud === 'gcp'
            ? [
                'On GCP the env root also takes `gcp_project`: a namespace and name are spec',
                'facts, but the project id is an account fact, so the root supplies it once -- to',
                'the provider, and to the module, which has to name it in one grant.',
                '',
                'A service whose models name the `google` provider gets `roles/aiplatform.user`',
                'on that project and `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_REGION` in its',
                'environment, so Vertex authenticates as the service account with no key in',
                'state. A service that declares either variable itself keeps its own value.',
                '',
                'The Cloud Run module does not refuse a `streaming` service: Cloud Run forwards a',
                'streamed body, so the same service that needs the container target on AWS needs',
                'no change here. It does refuse a service name Cloud Run cannot route.',
                '',
                'A `serverless` service also lands on Cloud Run: the gen2 Functions API accepts',
                'only a source zip and builds it, while this project deploys the image the',
                'generator already produces, which Cloud Run runs directly. It scales to zero and',
                'serves one request per instance unless `cloudrun_sizing` says otherwise, so the',
                'function model is kept.',
                '',
              ]
            : []),
          ...(modules.batch && cloud === 'aws'
            ? [
                'The batch module runs a job definition as `python -m app.generated.batch` with',
                "the deployment's pipeline as its argument, so one image serves both a route and",
                'a job. It refuses a deployment that names no pipeline, a job with no image URI, a',
                'secret with no ARN, and an empty `batch_subnet_ids` (Fargate has nowhere to run).',
                'Submit a run with `aws batch submit-job --job-queue <arn> --job-definition <arn>`.',
                '',
              ]
            : []),
          ...(modules.batch && cloud === 'gcp'
            ? [
                'The Cloud Run jobs module runs a job as `python -m app.generated.batch` with the',
                "deployment's pipeline as its argument, so one image serves both a route and a",
                'job. It refuses a deployment that names no pipeline, a job with no image URI, a',
                'secret with no Secret Manager id, and a name Cloud Run cannot accept. Defining a',
                'job does not run it: start an execution with',
                '`gcloud run jobs execute <name> --region <region> --wait`.',
                '',
                'Cloud Run jobs is the mapping for `batch` because the `hashicorp/google` provider',
                'has no resource for Google Cloud Batch; a job takes the same image and has the',
                'same run-to-completion model, on the provider this tree already requires.',
                '',
              ]
            : []),
          ...(modules.edge
            ? [
                'The edge module serves the app from Lambda@Edge: one published function in',
                'us-east-1 and one CloudFront distribution whose default behaviour answers every',
                'request. It refuses more than one `edge` deployment (one distribution serves the',
                'whole app), a `streaming` deployment, a timeout over 30 seconds, and a missing',
                '`edge.zip` -- the plan hashes that archive, so build it first.',
                '',
                'Lambda@Edge takes no environment variables, so the module creates an empty secret',
                'named after the function and the handler reads it at boot. Populate it with a',
                'JSON object of environment names to values before the first request, and keep it',
                'out of tfvars: a variable would land in state. `AID_EDGE_SECRET` cannot be set',
                'there either, so the handler falls back to its own function name.',
                '',
                "Only the app's HTTP pipeline routes are served from the edge. An agent route",
                'keeps its route through `app.main:app`, so a project that exposes one needs a',
                '`serverless` or `container` deployment as well.',
                '',
              ]
            : []),
        ]
      : [
          cloud === 'gcp'
            ? 'No provider module is generated for this plan: on GCP `container` and `serverless` both deploy to Cloud Run, and `batch` to a Cloud Run job, so only `edge` (no GCP counterpart) is missing. The plan document and tfvars above are still the contract to write it against.'
            : 'No provider module is generated for this plan: every runnable target (`serverless`, `container`, `batch`, `edge`) has an AWS module, so the plan declares none of them. The plan document and tfvars above are still the contract to write one against.',
          '',
        ]),
    ...(cloud === 'aws'
      ? [
          'With CDK, an app in `infra/cdk/<env>` reads the context file and supplies the',
          'constructs, account and region itself. `generated/cdk/serverless.cjs` exports',
          '`addServerless(scope, context, inputs)`; call it from the stack:',
          '',
          '```sh',
          'aid infra plan  --iac cdk --env dev',
          'aid infra apply --iac cdk --env dev',
          '```',
          '',
          '`aid infra` defaults to `--iac tofu`; the generated bytes are identical either way,',
          'because both backends consume this one plan.',
          '',
        ]
      : [
          'CDK is not emitted for GCP: no constructs exist for these resources yet, and',
          '`--iac cdk --cloud gcp` is refused rather than emitting a tree that cannot synth.',
          'Use `--iac tofu`, or write the CDK app yourself against `deploy.cdk-context.json`.',
          '',
        ]),
    '## What is here, and what is not',
    '',
    `- Services: ${plan.services.length}`,
    `- Routes: ${routes}`,
    `- Data stores: ${plan.stores.length}`,
    `- Tasks: ${plan.tasks.length}`,
    `- Alarm hooks: ${plan.alarms.length}`,
    '',
    'This directory holds derived *shape* only. Sizing, regions, accounts, domains, CIDRs',
    'and secret values are business inputs and live in your env root, never here — which is',
    'what lets one generated set run in more than one account.',
    '',
  ].join('\n');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
