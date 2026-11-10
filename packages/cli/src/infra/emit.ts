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
  DeployAudit,
  DeployManagedGuardrail,
  DeployPlan,
  DeployTask,
  ModelArmorConfidence,
  ModelArmorGuardrailPolicy,
  ModelArmorRaiFilter,
} from '@aid-framework/ir';

import { TARGETS } from '../targets.js';
import { type Cloud, DEFAULT_CLOUD } from './cloud.js';
import { emitProviderModules, envRoot, modulesOf } from './modules/index.js';
import { INFRA_CDK_CONTEXT_PATH, INFRA_GENERATED_DIR, INFRA_PLAN_PATH } from './paths.js';
import { awsSchedulerCronExpression } from './schedule.js';

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

export function deployGuardrail(
  guardrail: Extract<DeployManagedGuardrail, { engine: 'bedrock' }>,
): DeployGuardrail {
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
 * A managed guardrail spelled for the Google provider.
 *
 * There is no message here: a Model Armor template carries filters only, and the refusal
 * users read is the guardrail declaration's `onFail.message`, which the generated app
 * already owns. An absent key means the spec said nothing about that filter, which is
 * different from `false`: `false` writes an explicit `DISABLED`.
 */
export interface DeployModelArmorTemplate {
  readonly rai: readonly { readonly type: string; readonly confidence: string }[];
  readonly prompt_injection?: { readonly confidence: string };
  readonly malicious_uri?: boolean;
  readonly sensitive_data?: boolean;
}

const MODEL_ARMOR_RAI_TYPES: Record<ModelArmorRaiFilter, string> = {
  sexual: 'SEXUALLY_EXPLICIT',
  hate: 'HATE_SPEECH',
  harassment: 'HARASSMENT',
  dangerous: 'DANGEROUS',
};

const MODEL_ARMOR_CONFIDENCE_LEVELS: Record<ModelArmorConfidence, string> = {
  'low-and-above': 'LOW_AND_ABOVE',
  'medium-and-above': 'MEDIUM_AND_ABOVE',
  high: 'HIGH',
};

export function deployModelArmorTemplate(
  policy: ModelArmorGuardrailPolicy,
): DeployModelArmorTemplate {
  return {
    rai: Object.entries(policy.rai ?? {}).map(([type, confidence]) => ({
      type: MODEL_ARMOR_RAI_TYPES[type as ModelArmorRaiFilter],
      confidence: MODEL_ARMOR_CONFIDENCE_LEVELS[confidence],
    })),
    ...(policy.promptInjection === undefined
      ? {}
      : {
          prompt_injection: {
            confidence: MODEL_ARMOR_CONFIDENCE_LEVELS[policy.promptInjection],
          },
        }),
    ...(policy.maliciousUri === undefined ? {} : { malicious_uri: policy.maliciousUri }),
    ...(policy.sensitiveData === undefined ? {} : { sensitive_data: policy.sensitiveData }),
  };
}

/**
 * One plan task in the spelling the modules read.
 *
 * `schedule` is the spec's five-field UTC cron, kept because a diagnostic quotes what the
 * person wrote. The three fields beside it are what a module cannot derive in HCL: the
 * AWS dialect of the same expression, the dotted ingest module a refresh runs, and the
 * batch deployment whose image and environment it borrows.
 */
export interface DeployTaskSpelling {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly schedule?: string;
  readonly schedule_aws?: string;
  readonly module?: string;
  readonly deployment?: string;
}

/**
 * The batch deployment that ingests `retrieverId`, if one does.
 *
 * A deployment's `ingest` lists every retriever in the build, so this is the deployment a
 * scheduled refresh shares an image and an environment with. Sorted, because two such
 * deployments must resolve to the same one on every run.
 */
function batchDeploymentIngesting(plan: DeployPlan, retrieverId: string): string | undefined {
  return plan.services
    .filter((service) => service.target === 'batch' && service.ingest.includes(retrieverId))
    .map((service) => service.id)
    .sort()[0];
}

/** The python target's ingest module path is the only one a batch job can run. */
const PYTHON_INGEST_MODULE = TARGETS.find(
  (target) => target.runner === 'python',
)?.retrievalIngestModule;

/**
 * `task`, plus the three facts a scheduler needs when it carries one.
 *
 * A task with no schedule is spelled exactly as before, so a plan that schedules nothing
 * yields the document it always did.
 */
function spellTask(plan: DeployPlan, task: DeployTask): DeployTaskSpelling {
  const spelled: DeployTaskSpelling = {
    id: task.id,
    kind: task.kind,
    source: task.source,
  };
  if (task.schedule === undefined) return spelled;

  const module = PYTHON_INGEST_MODULE?.(task.source);
  const deployment = batchDeploymentIngesting(plan, task.source);
  return {
    ...spelled,
    schedule: task.schedule,
    schedule_aws: awsSchedulerCronExpression(task.schedule),
    ...(module === undefined ? {} : { module }),
    ...(deployment === undefined ? {} : { deployment }),
  };
}

/**
 * A federated tool behind a gateway, in the spelling the module reads.
 *
 * One shape rather than one per kind: the API has no top-level schema target, so a
 * document-backed target is an MCP target whose `open_api_schema` is set. `kind` is
 * carried alongside so the module can pick the block and a reader can see which.
 */
export interface DeployGatewayTarget {
  readonly name: string;
  readonly kind: string;
  readonly description?: string;
  readonly open_api_schema?: {
    readonly uri?: string;
    readonly bucket_owner_account_id?: string;
    readonly inline?: string;
  };
  readonly mcp_server?: { readonly endpoint?: string };
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
        /**
         * The managed agent runtime that runs this service. Present only when the
         * deployment declared one, and then the compute modules skip the service: the
         * runtime module provisions it instead. Flat rather than the spec's nesting
         * because the module reads three scalars, not a document.
         */
        readonly runtime?: {
          readonly platform: string;
          readonly cloud: string;
          readonly memory_short_term: boolean;
          readonly ttl_minutes: number;
          /**
           * The gateway this runtime is handed, by id. Present only when the deployment
           * named one; the gateway module assigns the URL, so the module reads it from
           * the map it returns rather than from here.
           */
          readonly gateway?: string;
        };
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
  /**
   * The Model Armor template each service owns, keyed by service id like `guardrails`.
   *
   * GCP-only: a GCP plan is never rendered as CDK (`infra gen` refuses that combination),
   * so `cdkContext` drops this rather than carry a fact no stack could read.
   */
  readonly model_armor_templates: Readonly<Record<string, DeployModelArmorTemplate>>;
  /**
   * The managed knowledge bases, spelled the way the module reads them.
   *
   * `id` and `arn` are empty here on purpose: the module creates the base and returns
   * both, and the compute modules read that merged map rather than this one. They are
   * present because the module's `variable` gives every entry one shape, so a plan with
   * one base and a plan with none still validate against the same contract.
   */
  readonly knowledge_bases: Readonly<
    Record<
      string,
      {
        readonly id: string;
        readonly arn: string;
        readonly engine: string;
        readonly data_source: { readonly kind: string; readonly uri: string };
        readonly chunking: {
          readonly strategy: string;
          readonly size: number;
          readonly overlap: number;
        };
        /** The spec alias, kept so a tfvars diff reads in the author's own words. */
        readonly embed_model: string;
        /** The provider's identifier for that alias, which is what the engine accepts. */
        readonly embed_model_id: string;
        readonly env_name: string;
        readonly filterable: readonly string[];
        readonly vector_store: { readonly kind: string; readonly arn?: string };
        readonly retrievers: readonly string[];
      }
    >
  >;
  readonly gateways?: Readonly<
    Record<
      string,
      {
        readonly description?: string;
        /** The variable this gateway's URL is exported under; the runtime reads it. */
        readonly env_name: string;
        readonly authorizer: {
          readonly kind: string;
          readonly discovery_url?: string;
          readonly audience?: readonly string[];
        };
        readonly targets: readonly DeployGatewayTarget[];
      }
    >
  >;
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
  readonly tasks: readonly DeployTaskSpelling[];
  readonly alarms: readonly { id: string; metric: string; source: string }[];
  /**
   * The audit destination the document pinned, or absent when it pinned none. Spelled
   * with the module's snake_case key, like every other tfvar.
   */
  readonly audit?: { readonly sink: DeployAudit['sink']; readonly retention_days?: number };
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
        /** The same runtime as `DeployTfvars`, in the keys a TS project reads. */
        readonly runtime?: {
          readonly platform: string;
          readonly cloud: string;
          readonly memoryShortTerm: boolean;
          readonly ttlMinutes: number;
          readonly gateway?: string;
        };
      }
    >
  >;
  readonly guardrails: Readonly<Record<string, DeployGuardrail>>;
  /** The same bases as `DeployTfvars['knowledge_bases']`, in the keys a TS project reads. */
  readonly knowledgeBases: Readonly<
    Record<
      string,
      {
        readonly id: string;
        readonly arn: string;
        readonly engine: string;
        readonly dataSource: { readonly kind: string; readonly uri: string };
        readonly chunking: {
          readonly strategy: string;
          readonly size: number;
          readonly overlap: number;
        };
        readonly embedModel: string;
        readonly embedModelId: string;
        readonly envName: string;
        readonly filterable: readonly string[];
        readonly vectorStore: { readonly kind: string; readonly arn?: string };
        readonly retrievers: readonly string[];
      }
    >
  >;
  readonly gateways?: Readonly<
    Record<
      string,
      {
        readonly description?: string;
        readonly envName: string;
        readonly authorizer: {
          readonly kind: string;
          readonly discoveryUrl?: string;
          readonly audience?: readonly string[];
        };
        readonly targets: readonly {
          readonly name: string;
          readonly kind: string;
          readonly openApiSchema?: {
            readonly uri?: string;
            readonly bucketOwnerAccountId?: string;
            readonly inline?: string;
          };
          readonly mcpServer?: { readonly endpoint?: string };
        }[];
      }
    >
  >;
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
  readonly tasks: readonly DeployTaskSpelling[];
  readonly alarms: readonly { id: string; metric: string; source: string }[];
  /** The audit destination the document pinned, or absent when it pinned none. */
  readonly audit?: DeployAudit;
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
      ...(service.runtime === undefined
        ? {}
        : {
            runtime: {
              platform: service.runtime.platform,
              cloud: service.runtime.cloud,
              memory_short_term: service.runtime.memory.shortTerm,
              ttl_minutes: service.runtime.session.ttlMinutes,
              ...(service.runtime.gateway === undefined
                ? {}
                : { gateway: service.runtime.gateway }),
            },
          }),
    };
  }

  const guardrails: Record<string, DeployGuardrail> = {};
  const modelArmorTemplates: Record<string, DeployModelArmorTemplate> = {};
  for (const service of plan.services) {
    const managed = service.managedGuardrail;
    if (managed === undefined) continue;
    if (managed.engine === 'bedrock') {
      guardrails[service.id] = deployGuardrail(managed);
    } else {
      modelArmorTemplates[service.id] = deployModelArmorTemplate(managed.policy);
    }
  }

  const knowledgeBases: Record<string, DeployTfvars['knowledge_bases'][string]> = {};
  for (const base of plan.knowledgeBases) {
    knowledgeBases[base.id] = {
      id: '',
      arn: '',
      engine: base.engine,
      data_source: { kind: base.dataSource.kind, uri: base.dataSource.uri },
      chunking: {
        strategy: base.chunking.strategy,
        size: base.chunking.size,
        overlap: base.chunking.overlap,
      },
      embed_model: base.embedModel,
      embed_model_id: base.embedModelId,
      env_name: base.envName,
      filterable: [...base.filterable],
      vector_store: {
        kind: base.vectorStore.kind,
        ...(base.vectorStore.arn === undefined ? {} : { arn: base.vectorStore.arn }),
      },
      retrievers: [...base.retrievers],
    };
  }

  // Omitted entirely when the plan declares no gateway, so a project without one keeps
  // the tfvars it had. The env root only declares `variable "gateways"` when it emitted
  // the gateway module, so an absent key and an undeclared variable agree.
  const gateways: Record<string, NonNullable<DeployTfvars['gateways']>[string]> = {};
  for (const gateway of plan.gateways) {
    gateways[gateway.id] = {
      ...(gateway.description === undefined ? {} : { description: gateway.description }),
      env_name: gateway.envName,
      authorizer: {
        kind: gateway.authorizer.kind,
        ...(gateway.authorizer.kind === 'jwt'
          ? {
              discovery_url: gateway.authorizer.discoveryUrl,
              audience: [...gateway.authorizer.audience],
            }
          : {}),
      },
      targets: gateway.targets.map((target) =>
        target.source.kind === 'mcpServer'
          ? {
              name: target.id,
              kind: target.source.kind,
              ...(target.description === undefined ? {} : { description: target.description }),
              mcp_server: { endpoint: target.source.endpoint },
            }
          : {
              name: target.id,
              kind: target.source.kind,
              ...(target.description === undefined ? {} : { description: target.description }),
              open_api_schema: {
                ...('uri' in target.source.schema ? { uri: target.source.schema.uri } : {}),
                ...('uri' in target.source.schema &&
                target.source.schema.bucketOwnerAccountId !== undefined
                  ? { bucket_owner_account_id: target.source.schema.bucketOwnerAccountId }
                  : {}),
                ...('inline' in target.source.schema
                  ? { inline: target.source.schema.inline }
                  : {}),
              },
            },
      ),
    };
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
    model_armor_templates: modelArmorTemplates,
    knowledge_bases: knowledgeBases,
    ...(plan.gateways.length === 0 ? {} : { gateways }),
    data_stores: dataStores,
    tasks: plan.tasks.map((task) => spellTask(plan, task)),
    alarms: plan.alarms.map((alarm) => ({
      id: alarm.id,
      metric: alarm.metric,
      source: alarm.source,
    })),
    ...(plan.audit === undefined
      ? {}
      : {
          audit: {
            sink: plan.audit.sink,
            ...(plan.audit.retentionDays === undefined
              ? {}
              : { retention_days: plan.audit.retentionDays }),
          },
        }),
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
      ...(service.runtime === undefined
        ? {}
        : {
            runtime: {
              platform: service.runtime.platform,
              cloud: service.runtime.cloud,
              memoryShortTerm: service.runtime.memory_short_term,
              ttlMinutes: service.runtime.ttl_minutes,
              ...(service.runtime.gateway === undefined
                ? {}
                : { gateway: service.runtime.gateway }),
            },
          }),
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

  const knowledgeBases: Record<string, DeployContext['knowledgeBases'][string]> = {};
  for (const [id, base] of Object.entries(spelled.knowledge_bases)) {
    knowledgeBases[id] = {
      id: base.id,
      arn: base.arn,
      engine: base.engine,
      dataSource: { kind: base.data_source.kind, uri: base.data_source.uri },
      chunking: {
        strategy: base.chunking.strategy,
        size: base.chunking.size,
        overlap: base.chunking.overlap,
      },
      embedModel: base.embed_model,
      embedModelId: base.embed_model_id,
      envName: base.env_name,
      filterable: [...base.filterable],
      vectorStore: {
        kind: base.vector_store.kind,
        ...(base.vector_store.arn === undefined ? {} : { arn: base.vector_store.arn }),
      },
      retrievers: [...base.retrievers],
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

  const gateways: Record<string, NonNullable<DeployContext['gateways']>[string]> = {};
  for (const [id, gateway] of Object.entries(spelled.gateways ?? {})) {
    gateways[id] = {
      ...(gateway.description === undefined ? {} : { description: gateway.description }),
      envName: gateway.env_name,
      authorizer: {
        kind: gateway.authorizer.kind,
        ...(gateway.authorizer.discovery_url === undefined
          ? {}
          : { discoveryUrl: gateway.authorizer.discovery_url }),
        ...(gateway.authorizer.audience === undefined
          ? {}
          : { audience: [...gateway.authorizer.audience] }),
      },
      targets: gateway.targets.map((target) => ({
        name: target.name,
        kind: target.kind,
        ...(target.description === undefined ? {} : { description: target.description }),
        ...(target.open_api_schema === undefined
          ? {}
          : {
              openApiSchema: {
                ...(target.open_api_schema.uri === undefined
                  ? {}
                  : { uri: target.open_api_schema.uri }),
                ...(target.open_api_schema.bucket_owner_account_id === undefined
                  ? {}
                  : { bucketOwnerAccountId: target.open_api_schema.bucket_owner_account_id }),
                ...(target.open_api_schema.inline === undefined
                  ? {}
                  : { inline: target.open_api_schema.inline }),
              },
            }),
        ...(target.mcp_server === undefined ? {} : { mcpServer: { ...target.mcp_server } }),
      })),
    };
  }

  return {
    project: { name: spelled.project.name, namespace: spelled.project.namespace },
    services,
    guardrails,
    knowledgeBases,
    ...(spelled.gateways === undefined ? {} : { gateways }),
    stores,
    tasks: spelled.tasks.map((task) => ({ ...task })),
    alarms: spelled.alarms.map((alarm) => ({ ...alarm })),
    ...(spelled.audit === undefined
      ? {}
      : {
          audit: {
            sink: spelled.audit.sink,
            ...(spelled.audit.retention_days === undefined
              ? {}
              : { retentionDays: spelled.audit.retention_days }),
          },
        }),
  };
}

function readme(plan: DeployPlan, cloud: Cloud): string {
  const routes = plan.services.reduce((total, service) => total + service.endpoints.length, 0);
  const modules = modulesOf(plan, cloud);
  const active =
    modules.serverless ||
    modules.container ||
    modules.batch ||
    modules.edge ||
    modules.agentRuntime;
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
    ...(modules.agentRuntime
      ? [
          cloud === 'gcp'
            ? '| `modules/agent-runtime/` | The Vertex AI reasoning engine + service account a `gcp-agent-platform` deployment runs on, carrying a Memory Bank on the engine when `memory.shortTerm` is set. |'
            : '| `modules/agent-runtime/` | The Bedrock AgentCore runtime, AgentCore Memory and IAM role an `aws-agentcore` deployment runs on. |',
        ]
      : []),
    ...(modules.knowledgeBase
      ? [
          cloud === 'gcp'
            ? '| `modules/vertex-rag/` | The Vertex AI RAG corpus a `knowledgeBases:` entry of engine `vertex-rag` deploys into. |'
            : '| `modules/knowledge-base/` | The OpenSearch Serverless collection + Bedrock knowledge base a `knowledgeBases:` entry deploys into. |',
        ]
      : []),
    ...(modules.audit
      ? [
          cloud === 'gcp'
            ? '| `modules/audit/` | The audit destination a `deployment.audit` sink pins: a log sink into a GCS archive bucket or a BigQuery dataset. |'
            : '| `modules/audit/` | The audit destination a `deployment.audit` sink pins: a CloudWatch log group or an S3 archive bucket. |',
        ]
      : []),
    ...((modules.serverless ||
      modules.container ||
      modules.batch ||
      modules.edge ||
      modules.knowledgeBase ||
      modules.audit) &&
    cloud === 'aws'
      ? [
          ...(modules.serverless
            ? [
                '| `cdk/serverless.cjs` | The CDK construct a `serverless` service is added to (AWS only). |',
              ]
            : []),
          ...(modules.container
            ? [
                '| `cdk/container.cjs` | The CDK construct a `container` service is added to: ECS Fargate behind one load balancer (AWS only). |',
              ]
            : []),
          ...(modules.batch
            ? [
                '| `cdk/batch.cjs` | The CDK construct a `batch` deployment runs in: Fargate compute environment, queue and job definition (AWS only). |',
              ]
            : []),
          ...(modules.edge
            ? [
                '| `cdk/edge.cjs` | The CDK construct an `edge` deployment deploys into: a published Lambda@Edge function behind CloudFront (AWS only). |',
              ]
            : []),
          ...(modules.knowledgeBase
            ? [
                '| `cdk/knowledge-base.cjs` | The CDK construct an `aws-bedrock` knowledge base is created by (AWS only). |',
              ]
            : []),
          ...(modules.audit
            ? [
                '| `cdk/audit.cjs` | The CDK construct that creates the pinned audit destination: a CloudWatch log group or an S3 archive bucket (AWS only). |',
              ]
            : []),
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
          ...(modules.knowledgeBase
            ? cloud === 'gcp'
              ? [
                  '`knowledgeBases:` provisions a Vertex AI RAG corpus over a GCS prefix, on the',
                  "RAG-managed store, with the embedding endpoint pinned to the spec's",
                  '`embedModel`. Import is per object: the module lists the prefix and creates one',
                  '`google_vertex_ai_rag_file` per object, so a large corpus produces a large plan.',
                  'The imported files are processed asynchronously by the service, so an apply',
                  'returns before the corpus is queryable. `aid doctor` names the corpus and the',
                  'environment variable it is exported as; whether it is ready is decided by the',
                  'first retrieve, which fails naming the base rather than returning no context.',
                  '',
                  '`deletion_policy = "PREVENT"` and `prevent_destroy` are both set on the corpus.',
                  'Re-importing a corpus costs money and API calls, so `aid infra destroy` refuses',
                  'until that is removed deliberately.',
                  '',
                  'Vertex has only fixed-length chunking, so `chunking.strategy: recursive` or',
                  '`code` is refused at plan time rather than approximated. A `vector_store.kind`',
                  'of `existing` names an existing corpus instead of creating one.',
                  '',
                ]
              : [
                  '`knowledgeBases:` provisions a Bedrock knowledge base over an S3 prefix, with its',
                  'own role, an OpenSearch Serverless collection and a data source. The base is',
                  'created **empty**: nothing is ingested during `apply`, so a first apply does not',
                  'charge per document. Start ingestion with',
                  '`aws bedrock-agent start-ingestion-job --knowledge-base-id <id> --data-source-id <id>`',
                  'and poll it with `aws bedrock-agent get-ingestion-job`. Until a job succeeds,',
                  'retrieval returns no chunks rather than an error, which is why the runtime',
                  'refuses to query a base with no completed job instead of reporting it healthy.',
                  '',
                  '`prevent_destroy` is on for the base and the collection. Re-ingesting a corpus',
                  'costs money and API calls, so `aid infra destroy` refuses until that is removed',
                  'deliberately.',
                  '',
                ]
            : []),
          ...(modules.agentRuntime
            ? cloud === 'gcp'
              ? [
                  'A deployment with `runtime.platform: gcp-agent-platform` runs on a Vertex AI',
                  'reasoning engine instead of Cloud Run: the runtime module creates the engine,',
                  'its service account and the Artifact Registry and Secret Manager grants the',
                  'container needs, and the compute modules skip the service. The engine calls the',
                  'image itself on port 8080, so the Dockerfile starts',
                  '`app.generated.runtime_app`, which adds `/ping` and `/invocations` and replays',
                  'an invocation through `app.main:app` -- the same route, meter and trace an HTTP',
                  "caller gets. The adapter collects the app's response before returning it, so a",
                  'streaming route answers in one piece through the platform: streams stay',
                  'incremental only when the app is called directly over HTTP.',
                  'Each declared secret gets one `secretAccessor` grant on its',
                  'Secret Manager id. Managed memory is configured on the engine itself through',
                  '`context_spec.memory_bank_config`: a generation model, an embedding model and',
                  'a 30-day TTL, attached to the engine rather than created as a separate',
                  'resource, so there is no memory id to export. The engine name and service',
                  'account are exported as `reasoning_engines` and `service_accounts`.',
                  '',
                ]
              : [
                  'A deployment with `runtime.platform: aws-agentcore` runs on AgentCore instead of',
                  'ECS: the runtime module creates the agent runtime, its IAM role and, when',
                  '`memory.shortTerm` is set, a memory bank, and the compute modules skip the',
                  'service. The platform calls the image itself, so the Dockerfile starts',
                  '`app.generated.runtime_app`, which adds `/ping` and `/invocations` and replays',
                  'an invocation through `app.main:app` -- the same route, meter and trace an HTTP',
                  "caller gets. The adapter collects the app's response before returning it, so a",
                  'streaming route answers in one piece through the platform: streams stay',
                  'incremental only when the app is called directly over HTTP.',
                  'Sessions stop at `session.ttlMinutes`, which the spec caps at 480,',
                  'and the memory bank forgets an event after 30 days.',
                  '',
                  'AgentCore takes environment variables only, with no reference to a secret, so',
                  'the module refuses a deployment that declares `secrets:`; put the value in the',
                  'environment some other way, or move the key to a deployment that runs on',
                  'compute. The runtime ARNs are exported as `agent_runtimes`.',
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
          'constructs, account and region itself:',
          '',
          ...(modules.serverless
            ? [
                '- `generated/cdk/serverless.cjs` exports',
                '  `addServerless(scope, context, inputs)`, which adds every `serverless`',
                '  service.',
              ]
            : []),
          ...(modules.container
            ? [
                '- `generated/cdk/container.cjs` exports',
                '  `addContainer(scope, context, inputs)`: ECS Fargate services behind one load',
                '  balancer, plus the VPC when `vpcId` is empty. It returns',
                '  `{ endpoint, services, cluster }`, and `endpoint` is the URL the plan records.',
              ]
            : []),
          ...(modules.batch
            ? [
                '- `generated/cdk/batch.cjs` exports',
                '  `addBatch(scope, context, inputs)`: one Fargate compute environment and queue,',
                '  and one job definition per `batch` deployment, whose command names the',
                '  deployment pipeline. It needs `inputs.images` and `inputs.subnetIds`, and returns',
                '  `{ queue, jobDefinitions, logGroups }`.',
              ]
            : []),
          ...(modules.edge
            ? [
                '- `generated/cdk/edge.cjs` exports',
                '  `addEdge(scope, context, inputs)`: a published Lambda@Edge function and the',
                '  CloudFront distribution that answers every request from it. Call it from a stack',
                '  in `us-east-1`; it refuses any other region, because CloudFront associates only',
                '  versions that exist there. It needs `inputs.edgeZipPath`.',
              ]
            : []),
          ...(modules.knowledgeBase
            ? [
                '- `generated/cdk/knowledge-base.cjs` exports',
                "  `addKnowledgeBase(scope, context, inputs)`. It returns each base's id and ARN,",
                '  which are the `knowledgeBases` entry `addServerless` and `addContainer` read:',
                '  pass that return value through so a bound service gets the base id in its',
                '  environment and its role gets `bedrock:Retrieve`, the same two things the HCL',
                '  module grants.',
              ]
            : []),
          '',
          ...(!modules.serverless
            ? [
                'Constructs are emitted per target, so nothing appears that the plan cannot use:',
                'a plan with no `serverless` service emits no `serverless.cjs`, and one with no',
                '`batch` deployment emits no `batch.cjs`.',
                '',
              ]
            : []),
          ...(modules.agentRuntime
            ? [
                'A plan that declares a managed runtime emits no CDK construct, and `--iac cdk`',
                'is refused for it: this backend cannot express an AgentCore runtime, and an',
                'empty app would be worse than the refusal. Use `--iac tofu` until the construct',
                'exists.',
                '',
              ]
            : []),
          '```sh',
          'aid infra plan  --iac cdk --env dev',
          'aid infra apply --iac cdk --env dev',
          '```',
          '',
          ...(modules.agentRuntime
            ? [
                'For the same reason, `--iac tofu` is the only backend that can deploy this',
                'plan.',
                '',
              ]
            : [
                '`aid infra` defaults to `--iac tofu`; the generated bytes are identical either way,',
                'because both backends consume this one plan.',
                '',
              ]),
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
    `- Knowledge bases: ${plan.knowledgeBases.length}`,
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
