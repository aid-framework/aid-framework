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

import type { DeploymentTarget, IR, Provider, VectorStoreKind } from './shapes.js';

/**
 * Bumped when the plan's shape changes incompatibly. Independent of `irVersion`:
 * the IR can change without changing what a deployment needs, and vice versa.
 */
export const DEPLOY_PLAN_VERSION = '1';

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
  from: 'deployment' | 'store' | 'model';
}

export interface DeployEndpoint {
  /** Pipeline id that serves this route. */
  pipeline: string;
  method: string;
  path: string;
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
  /** Retriever ids whose corpus must exist before this service serves traffic. */
  ingest: string[];
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

  const services: DeployService[] = ir.deployments.map((deployment) => {
    const service: DeployService = {
      id: deployment.id,
      target: deployment.target,
      streaming: deployment.streaming,
      endpoints: endpoints.map((endpoint) => ({ ...endpoint })),
      env: serviceEnv(ir, deployment.env),
      secrets: serviceSecrets(ir, deployment),
      providers,
      ingest,
    };
    if (deployment.pipeline !== undefined) service.pipeline = deployment.pipeline;
    return service;
  });

  const stores: DeployStore[] = ir.stores
    .map((store) => {
      const plan: DeployStore = {
        id: store.id,
        kind: store.kind,
        retrievers: uniqueSorted(
          ir.retrievers
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

  const tasks: DeployTask[] = [
    ...ir.retrievers.map((retriever) => {
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

  return [...byName.values()].sort((left, right) => compare(left.name, right.name));
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
