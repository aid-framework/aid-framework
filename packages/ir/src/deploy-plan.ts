/**
 * The provider-neutral deployment plan.
 *
 * This is the seam between what a spec knows and what an infrastructure emitter
 * renders. It derives *shape* — services, endpoints, env references, stores, tasks,
 * alarms — and never *scale*: a size, a region, an account id, a CIDR, or a secret
 * value is a business decision, so it cannot appear here (design §12.3). Both the
 * OpenTofu and the CDK backend render this one document, which is what keeps them
 * from becoming two truths.
 */

import type {
  AgentRuntimePlatform,
  BedrockGuardrailPolicy,
  DeploymentTarget,
  GuardrailEngine,
  GuardrailShape,
  IR,
  KnowledgeBaseEngine,
  Provider,
  VectorStoreKind,
} from './shapes.js';
import { isManagedRetriever, RUNTIME_CLOUDS } from './shapes.js';

/**
 * Bumped when the plan's shape changes incompatibly. Independent of `irVersion`:
 * the IR can change without changing what a deployment needs, and vice versa.
 */
export const DEPLOY_PLAN_VERSION = '1';

/**
 * The environment name a deployment exports a knowledge base's service id under.
 *
 * This is a contract with the runtime, not a convenience: `aid_runtime.retrieval`
 * computes the same name from the base id and reads it at first retrieve. The spelling
 * is duplicated rather than derived twice, so `knowledge-base-env.test.ts` can pin the
 * two computations to each other -- a plan that spelled it differently would deploy a
 * retriever that raises "no service id" while the resource sits created beside it.
 *
 * The prefix carries the engine because the two engines publish a different kind of
 * name: Bedrock hands back a service id, Vertex a corpus resource name. One shared
 * prefix would let a Bedrock id be read as a corpus path.
 */
export function knowledgeBaseEnvName(id: string, engine: KnowledgeBaseEngine): string {
  const prefix = engine === 'aws-bedrock' ? 'BEDROCK_KNOWLEDGE_BASE' : 'VERTEX_RAG_CORPUS';
  return `${prefix}_${environmentSlug(id)}`;
}

/**
 * Turn a base id into the upper-case fragment of an environment name.
 *
 * This is one pass over the id on purpose: a regular expression over a caller-supplied
 * string invites backtracking alerts, and the runtime computes the same fragment so the
 * two spellings have to agree. A run of separators collapses to a single `_`, runs at
 * either end are dropped, and anything not in `[A-Za-z0-9]` is a separator.
 */
function environmentSlug(id: string): string {
  let slug = '';
  let separatorPending = false;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    const alphanumeric =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a); // a-z
    if (alphanumeric) {
      if (separatorPending) slug += '_';
      slug += id[i];
      separatorPending = false;
    } else if (slug.length > 0) {
      separatorPending = true;
    }
  }
  return slug.toUpperCase();
}

/**
 * One environment variable a service needs. A `secret` entry names a reference the
 * platform must resolve; it never carries the value, which is why the plan is safe
 * to commit and to diff in a pull request.
 */
export interface DeployEnvVar {
  name: string;
  secret: boolean;
  /** Only ever set for a non-secret declaration made in the spec. */
  value?: string;
  /** Which IR collection supplied the name, so a plan diff explains itself. */
  from: 'deployment' | 'store' | 'model' | 'decision';
}

export interface DeployEndpoint {
  /** Pipeline id that serves this route. */
  pipeline: string;
  method: string;
  path: string;
}

/** The managed agent runtime a service is deployed onto, from spec 0.13. */
export interface DeployRuntime {
  platform: AgentRuntimePlatform;
  /** The cloud the platform runs on; a `--cloud` that disagrees is refused. */
  cloud: 'aws' | 'gcp';
  memory: { shortTerm: boolean };
  session: { ttlMinutes: number };
}

export interface DeployService {
  /** Deployment id. */
  id: string;
  target: DeploymentTarget;
  streaming: boolean;
  endpoints: DeployEndpoint[];
  env: DeployEnvVar[];
  /** Logical secret names, sorted. Never values. */
  secrets: string[];
  /**
   * The pipeline a `target: batch` job runs once, by id, from spec 0.5.
   *
   * Optional because only a batch deployment names one, and because a job definition has
   * to be given the pipeline: the entrypoint resolves it only when the build deploys
   * exactly one. Absent on every other target, so an existing plan document is unchanged.
   */
  pipeline?: string;
  /** Providers the service may call, for an emitter to reason about egress. */
  providers: Provider[];
  /** Guardrail engines the service evaluates with, so an emitter can grant access. */
  guardrailEngines: GuardrailEngine[];
  /**
   * The managed guardrail this service wires, when the spec owns its policy. Absent means
   * either no managed guardrail or one the operator already owns, which the deployment
   * names through environment variables instead of provisioning.
   */
  managedGuardrail?: DeployManagedGuardrail;
  /** The managed agent runtime that runs this container service, when it declares one. */
  runtime?: DeployRuntime;
  /** Retriever ids whose corpus must exist before this service serves traffic. */
  ingest: string[];
}

/** The managed policy a service's `bedrock`-engine guardrail owns, spelled spec-side. */
export interface DeployManagedGuardrail {
  /** The guardrail declaration id; the provisioned resource carries it in its name. */
  id: string;
  action: GuardrailShape['action'];
  message: string;
  policy: BedrockGuardrailPolicy;
}

export interface DeployStore {
  id: string;
  kind: VectorStoreKind;
  /** Logical name from the store's `env:NAME` uri. Never the uri itself. */
  secretRef?: string;
  /** A managed PostgreSQL needs `CREATE EXTENSION vector` from an app-run migration. */
  requiresExtension?: 'vector';
  /** Retriever ids reading from this store. */
  retrievers: string[];
}

export interface DeployKnowledgeBase {
  id: string;
  engine: KnowledgeBaseEngine;
  dataSource: { kind: 's3' | 'gcs'; uri: string };
  chunking: { strategy: 'fixed' | 'recursive' | 'code'; size: number; overlap: number };
  /** The spec's model alias, which the runtime config also uses. */
  embedModel: string;
  /**
   * The provider's own model id for `embedModel`, resolved from the build's models.
   * The infra needs it because a knowledge base names an embedding model by the
   * provider's identifier -- an alias is a spec word, and no cloud has ever heard of
   * it. Resolved here, once, so a backend cannot invent a second mapping.
   */
  embedModelId: string;
  /**
   * The environment name the deployment exports this base's service id under. Computed
   * here so every backend spells it the one way the runtime reads it.
   */
  envName: string;
  filterable: string[];
  vectorStore: { kind: 'provisioned' | 'existing'; arn?: string };
  /** Retriever ids that read this base. */
  retrievers: string[];
  /**
   * Delete protection is on by default for both engines. A knowledge base holds the
   * indexed corpus, and re-ingesting it costs money and API calls; a `destroy` that
   * removes it should be a deliberate change to the module, not a side effect of an
   * upstream rename. The emitter renders this as `prevent_destroy`.
   */
  preventDestroy: true;
}

export interface DeployTask {
  id: string;
  kind: 'ingest' | 'eval';
  /** Retriever or eval id. */
  source: string;
  schedule?: string;
}

/**
 * An alarm hook. Deliberately carries the metric and not the threshold: the budget
 * value is a cost decision, and the IR already enforces it at runtime.
 */
export interface DeployAlarm {
  id: string;
  metric: 'agent.cost' | 'agent.tokens' | 'eval.cost' | 'eval.latency.p95';
  /** Agent or eval id. */
  source: string;
}

export interface DeployPlan {
  planVersion: string;
  project: { name: string; namespace: string };
  services: DeployService[];
  stores: DeployStore[];
  knowledgeBases: DeployKnowledgeBase[];
  tasks: DeployTask[];
  alarms: DeployAlarm[];
}

/**
 * Derives the plan from a built IR. Pure and deterministic: the same IR always
 * produces the same plan, and every collection is sorted so a diff is meaningful.
 */
export function buildDeployPlan(ir: IR): DeployPlan {
  const endpoints = httpEndpoints(ir);
  const providers = uniqueSorted(ir.models.map((model) => model.provider));
  const ingest = uniqueSorted(ir.retrievers.map((retriever) => retriever.id));
  const guardrailEngines = uniqueSorted(
    (ir.guardrails ?? []).map((guardrail) => guardrail.engine),
  ) as GuardrailEngine[];
  const managed = (ir.guardrails ?? []).find(
    (guardrail) => guardrail.engine === 'bedrock' && guardrail.bedrock !== undefined,
  );

  const services: DeployService[] = ir.deployments.map((deployment) => {
    const service: DeployService = {
      id: deployment.id,
      target: deployment.target,
      streaming: deployment.streaming,
      endpoints: endpoints.map((endpoint) => ({ ...endpoint })),
      env: serviceEnv(ir, deployment.env),
      secrets: serviceSecrets(ir, deployment),
      providers,
      guardrailEngines,
      ingest,
    };
    if (deployment.pipeline !== undefined) service.pipeline = deployment.pipeline;
    if (deployment.runtime !== undefined) {
      service.runtime = {
        ...deployment.runtime,
        cloud: RUNTIME_CLOUDS[deployment.runtime.platform],
      };
    }
    if (managed?.bedrock !== undefined) {
      service.managedGuardrail = {
        id: managed.id,
        action: managed.action,
        message: managed.onFail.message,
        policy: managed.bedrock,
      };
    }
    return service;
  });

  const stores: DeployStore[] = ir.stores
    .map((store) => {
      const plan: DeployStore = {
        id: store.id,
        kind: store.kind,
        retrievers: uniqueSorted(
          ir.retrievers
            .filter((retriever) => !isManagedRetriever(retriever))
            .filter((retriever) => retriever.store === store.id)
            .map((retriever) => retriever.id),
        ),
      };
      const secretRef = envName(store.uri);
      if (secretRef !== undefined) plan.secretRef = secretRef;
      if (store.kind === 'pgvector') plan.requiresExtension = 'vector';
      return plan;
    })
    .sort((left, right) => compare(left.id, right.id));

  const modelsByAlias = new Map(ir.models.map((model) => [model.id, model]));
  const knowledgeBases: DeployKnowledgeBase[] = ir.knowledgeBases
    .map((base) => {
      // The knowledge-base gate has already refused an alias nothing resolves, so a
      // miss here means the plan was built from an ungated IR. Emitting the alias as
      // the provider's model id would be worse than stopping: every engine would
      // refuse it at apply time, far from the spec that caused it.
      const embedding = modelsByAlias.get(base.embedModel);
      if (embedding === undefined) {
        throw new Error(
          `knowledge base "${base.id}" embeds with "${base.embedModel}", which is not a model alias`,
        );
      }
      return {
        id: base.id,
        engine: base.engine,
        dataSource: { ...base.dataSource },
        chunking: { ...base.chunking },
        embedModel: base.embedModel,
        embedModelId: embedding.modelId,
        envName: knowledgeBaseEnvName(base.id, base.engine),
        filterable: [...base.filterable],
        vectorStore: { ...base.vectorStore },
        retrievers: uniqueSorted(
          ir.retrievers
            .filter(isManagedRetriever)
            .filter((retriever) => retriever.knowledgeBase === base.id)
            .map((retriever) => retriever.id),
        ),
        preventDestroy: true as const,
      };
    })
    .sort((left, right) => compare(left.id, right.id));

  const tasks: DeployTask[] = [
    // A managed base ingests inside the engine, so it schedules nothing here. Left in
    // this list it would become a local job that embeds the corpus a second time.
    ...ir.retrievers
      .filter((retriever) => !isManagedRetriever(retriever))
      .map((retriever) => {
        const task: DeployTask = {
          id: `ingest-${retriever.id}`,
          kind: 'ingest',
          source: retriever.id,
        };
        if (retriever.refresh.schedule !== undefined) task.schedule = retriever.refresh.schedule;
        return task;
      }),
    ...ir.evals.map((evalSuite) => ({
      id: `eval-${evalSuite.id}`,
      kind: 'eval' as const,
      source: evalSuite.id,
    })),
  ].sort((left, right) => compare(left.id, right.id));

  return {
    planVersion: DEPLOY_PLAN_VERSION,
    project: { name: ir.project.name, namespace: ir.project.namespace },
    services,
    stores,
    knowledgeBases,
    tasks,
    alarms: alarms(ir),
  };
}

/** Routes the app serves, taken from HTTP-triggered pipelines only. */
function httpEndpoints(ir: IR): DeployEndpoint[] {
  const endpoints: DeployEndpoint[] = [];
  for (const pipeline of ir.pipelines) {
    if (pipeline.trigger.kind !== 'http') continue;
    endpoints.push({
      pipeline: pipeline.id,
      method: pipeline.trigger.method,
      path: pipeline.trigger.path,
    });
  }
  return endpoints.sort(
    (left, right) => compare(left.path, right.path) || compare(left.method, right.method),
  );
}

/**
 * The service's environment, in precedence order: what the deployment declared,
 * then what a store's uri implies, then a model's API-key name. The first source to
 * claim a name wins, so a spec can always override a derived variable explicitly.
 */
function serviceEnv(
  ir: IR,
  declared: { name: string; value?: string; secret?: boolean }[],
): DeployEnvVar[] {
  const byName = new Map<string, DeployEnvVar>();

  for (const entry of declared) {
    const variable: DeployEnvVar = {
      name: entry.name,
      secret: entry.secret === true,
      from: 'deployment',
    };
    if (entry.value !== undefined) variable.value = entry.value;
    byName.set(entry.name, variable);
  }

  for (const store of ir.stores) {
    const name = envName(store.uri);
    if (name !== undefined && !byName.has(name)) {
      byName.set(name, { name, secret: true, from: 'store' });
    }
  }

  for (const model of ir.models) {
    const name = model.apiKeyEnv;
    if (name !== undefined && !byName.has(name)) {
      byName.set(name, { name, secret: true, from: 'model' });
    }
  }

  for (const name of decisionSecrets(ir)) {
    if (!byName.has(name)) byName.set(name, { name, secret: true, from: 'decision' });
  }

  return [...byName.values()].sort((left, right) => compare(left.name, right.name));
}

/**
 * The key a guardrail's decision model reads.
 *
 * A decision has no `apiKeyEnv` of its own -- the runtime client reads one fixed name --
 * so a guardrail answered by one needs the platform to resolve it, or the check fails
 * closed at the first request with a provider the deployment never provisioned.
 */
const DECISION_KEY_ENV = 'TYPESAFE_API_KEY';

function decisionSecrets(ir: IR): string[] {
  return ir.guardrails.some((guardrail) => guardrail.decision !== undefined)
    ? [DECISION_KEY_ENV]
    : [];
}

/** Every name the platform must resolve, from all four sources. */
function serviceSecrets(
  ir: IR,
  deployment: { secrets: string[]; env: { name: string; secret?: boolean }[] },
): string[] {
  const names = new Set<string>(deployment.secrets);
  // An `env` entry flagged secret is a reference, not a literal, so it belongs here
  // and not only in `env` — otherwise the emitter would look for a plain value.
  for (const entry of deployment.env) {
    if (entry.secret === true) names.add(entry.name);
  }
  for (const store of ir.stores) {
    const name = envName(store.uri);
    if (name !== undefined) names.add(name);
  }
  for (const model of ir.models) {
    if (model.apiKeyEnv !== undefined) names.add(model.apiKeyEnv);
  }
  for (const name of decisionSecrets(ir)) names.add(name);
  return uniqueSorted([...names]);
}

function alarms(ir: IR): DeployAlarm[] {
  const found: DeployAlarm[] = [];
  for (const agent of ir.agents) {
    if (agent.maxCostBudget !== undefined) {
      found.push({ id: `alarm-${agent.id}-cost`, metric: 'agent.cost', source: agent.id });
    }
    if (agent.maxTokensBudget !== undefined) {
      found.push({ id: `alarm-${agent.id}-tokens`, metric: 'agent.tokens', source: agent.id });
    }
  }
  for (const evalSuite of ir.evals) {
    if (evalSuite.costBudget !== undefined) {
      found.push({ id: `alarm-${evalSuite.id}-cost`, metric: 'eval.cost', source: evalSuite.id });
    }
    if (evalSuite.latencyBudgetP95Ms !== undefined) {
      found.push({
        id: `alarm-${evalSuite.id}-latency`,
        metric: 'eval.latency.p95',
        source: evalSuite.id,
      });
    }
  }
  return found.sort((left, right) => compare(left.id, right.id));
}

/** `env:NAME` -> `NAME`. Any other uri is a literal the plan must not copy. */
function envName(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const prefix = 'env:';
  if (!uri.startsWith(prefix)) return undefined;
  const name = uri.slice(prefix.length);
  return name.length > 0 ? name : undefined;
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort(compare);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
