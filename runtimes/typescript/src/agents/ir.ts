/**
 * The IR seam: an emitted document in, resolved agent definitions out.
 *
 * The pipeline runtime consumes the IR's *pipeline* shapes and is deliberately unaware of
 * agents; this module is the equivalent seam for them. It reads only the collections an
 * agent can reach -- `agents`, `models`, `prompts`, `tools`, `memory`, `guardrails` -- and
 * resolves every reference at load time, so a loop never runs against a dangling prompt id
 * or an unpriced model.
 *
 * Nothing here invents vocabulary. Field names are the IR's, `instructions` stays the
 * prompt *reference* the IR carries and is resolved to `prompt.template` here, and the
 * scopes are `thread`/`user`/`global`.
 */

import { ConfigurationError } from '../errors.js';
import { repr } from '../internal/json.js';
import { type Capability, CostProfile, ModelSpec } from '../types.js';

/** IR model capability -> runtime capability. */
const RUNTIME_CAPABILITY: Readonly<Record<string, Capability>> = {
  'tool-calling': 'tool-calling',
  'json-schema': 'structured-output',
  streaming: 'streaming',
  'long-context': 'long-context',
  embeddings: 'embeddings',
  rerank: 'rerank',
};

const ON_BUDGET_EXHAUSTED = new Set(['fail', 'degrade']);

/** The closed vocabularies from `packages/ir/src/shapes.ts`, repeated on purpose. */
export const GUARDRAIL_STAGES: ReadonlySet<string> = new Set([
  'input',
  'output',
  'retrieval',
  'tool-call',
]);
export const GUARDRAIL_ACTIONS: ReadonlySet<string> = new Set([
  'block',
  'redact',
  'flag',
  'escalate',
]);
export const GUARDRAIL_POLICIES: ReadonlySet<string> = new Set([
  'pii-detect',
  'pii-redact',
  'prompt-injection',
  'jailbreak',
  'moderation',
  'toxicity',
  'secret-scan',
]);

const SIDE_EFFECTS = new Set(['none', 'read', 'write', 'destructive']);

/** An IR tool, as the loop needs it: name, side effects, and its auth policy. */
export interface ToolSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiresConfirmation: boolean;
  readonly sideEffects: string;
  readonly auth: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One resolved guardrail: where it runs, what it detects, and what it does.
 *
 * `tools` holds tool *ids*, because that is how the IR scopes a tool-call guardrail; the
 * loop translates a model's tool *name* to the id before asking.
 */
export interface GuardrailDefinition {
  readonly id: string;
  readonly stages: readonly string[];
  readonly policies: readonly string[];
  readonly action: string;
  readonly redact: readonly string[];
  readonly tools: readonly string[];
  readonly message: string;
  readonly fallbackPrompt: string | undefined;
  readonly log: boolean;
}

/** One IR `memory` entry, resolved for the scope rules in `agents/memory`. */
export interface MemoryDefinition {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly tokenBudget: number;
  readonly backend: string | undefined;
  readonly store: string | undefined;
  readonly summarizeModel: string | undefined;
  readonly ttl: string | undefined;
  readonly redact: readonly string[];
}

/** The parsed `humanInTheLoop` block: a policy, and a channel to ask on. */
export interface HumanApproval {
  readonly when: Readonly<Record<string, unknown>>;
  readonly channel: string;
}

/** One agent, with every reference resolved. */
export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly memory: readonly MemoryDefinition[];
  readonly maxSteps: number;
  readonly maxTokensBudget: number | undefined;
  readonly maxCostBudget: number | undefined;
  readonly onBudgetExhausted: string;
  readonly handoffs: readonly string[];
  readonly delegates: readonly string[];
  readonly engine: string;
  /**
   * The pinned Deep Agents release, when the engine is `deepagents`. Empty for `native`;
   * the IR gate refuses `deepagents` without a pin, so an empty value here means the
   * document skipped the gate.
   */
  readonly engineVersion: string;
  readonly approval: HumanApproval | undefined;
  readonly guardrails: readonly GuardrailDefinition[];
}

/** Whether this agent may move control at all (transfer *or* delegate). */
export function hasControlTools(agent: AgentDefinition): boolean {
  return agent.handoffs.length > 0 || agent.delegates.length > 0;
}

/**
 * Every guardrail declared on this agent that runs at `stage`.
 *
 * Declaration order is the order of `guardrails` in the IR, and that is the order the
 * engine evaluates in. It has to come from the document: an order the runtime invented
 * would make the outcome of two conflicting guardrails depend on which version of the
 * runtime ran the spec.
 */
export function stageGuardrails(
  agent: AgentDefinition,
  stage: string,
): readonly GuardrailDefinition[] {
  return agent.guardrails.filter((guardrail) => guardrail.stages.includes(stage));
}

/** Everything the loop needs, resolved from one IR document. */
export class RuntimeSpec {
  readonly models: ReadonlyMap<string, ModelSpec>;
  readonly fallbacks: ReadonlyMap<string, readonly string[]>;
  readonly prompts: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, ToolSpec>;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly guardrails: ReadonlyMap<string, GuardrailDefinition>;
  /**
   * The single concurrency cap, read from the IR's `deployments[].concurrency`. `undefined`
   * means unbounded: the runtime only shares a limiter when a deployment declares one,
   * which keeps plain request/response usage free of surprises.
   */
  readonly concurrency: number | undefined;

  constructor(init: {
    readonly models: ReadonlyMap<string, ModelSpec>;
    readonly fallbacks: ReadonlyMap<string, readonly string[]>;
    readonly prompts: ReadonlyMap<string, string>;
    readonly tools: ReadonlyMap<string, ToolSpec>;
    readonly agents: ReadonlyMap<string, AgentDefinition>;
    readonly guardrails?: ReadonlyMap<string, GuardrailDefinition>;
    readonly concurrency?: number;
  }) {
    this.models = init.models;
    this.fallbacks = init.fallbacks;
    this.prompts = init.prompts;
    this.tools = init.tools;
    this.agents = init.agents;
    this.guardrails = init.guardrails ?? new Map();
    this.concurrency = init.concurrency;
  }

  agent(agentId: string): AgentDefinition {
    const found = this.agents.get(agentId);
    if (found === undefined) {
      throw new ConfigurationError(
        `no agent ${repr(agentId)} in the IR; declared agents: ${listRepr(sorted([...this.agents.keys()]))}`,
      );
    }
    return found;
  }

  systemPrompt(agent: AgentDefinition): string {
    const found = this.prompts.get(agent.instructions);
    if (found === undefined) {
      throw new ConfigurationError(
        `agent ${repr(agent.id)} names prompt ${repr(agent.instructions)}, ` +
          `which the IR does not declare; declared prompts: ${listRepr(sorted([...this.prompts.keys()]))}`,
      );
    }
    return found;
  }

  fallbacksFor(alias: string): readonly string[] {
    return this.fallbacks.get(alias) ?? [];
  }

  toolSpecs(agent: AgentDefinition): readonly ToolSpec[] {
    return agent.tools.map((toolId) => {
      const found = this.tools.get(toolId);
      if (found === undefined) throw new ConfigurationError(`no tool ${repr(toolId)} in the IR`);
      return found;
    });
  }

  /**
   * Combined price, the same number `agents/budget-degrade` compares.
   *
   * The gate compares `inputPerMTok + outputPerMTok`; keeping the identical sum here means
   * a spec the gate accepted cannot have the runtime pick a "cheaper" alias that the gate
   * would have called more expensive.
   */
  price(alias: string): number {
    const spec = this.models.get(alias);
    if (spec === undefined) {
      throw new ConfigurationError(
        `no model ${repr(alias)} in the IR; declared models: ${listRepr(sorted([...this.models.keys()]))}`,
      );
    }
    return spec.cost.inputPer1kUsd + spec.cost.outputPer1kUsd;
  }

  /**
   * The first declared fallback that is strictly cheaper than `alias`.
   *
   * One step, in the order the spec declared: this is the alias ladder's next rung, not a
   * search for the cheapest reachable model. `undefined` means there is nowhere to step,
   * which is what makes a `degrade` declaration fail closed instead of pretending to
   * degrade.
   */
  cheaperFallback(alias: string): string | undefined {
    const budget = this.price(alias);
    for (const candidate of this.fallbacksFor(alias)) {
      if (this.models.has(candidate) && this.price(candidate) < budget) return candidate;
    }
    return undefined;
  }
}

/** Resolve an emitted IR document into a {@link RuntimeSpec}. */
export function fromIr(document: Record<string, unknown>): RuntimeSpec {
  const rawModels = byId(document.models, 'models');
  const rawPrompts = byId(document.prompts, 'prompts');
  const rawTools = byId(document.tools, 'tools');
  const rawMemory = byId(document.memory, 'memory');
  const rawAgents = byId(document.agents, 'agents');

  const prompts = new Map<string, string>();
  for (const [promptId, entry] of rawPrompts) {
    prompts.set(promptId, requiredStr(entry, 'template', `prompt ${repr(promptId)}`));
  }

  const tools = new Map<string, ToolSpec>();
  for (const [toolId, entry] of rawTools) {
    tools.set(toolId, {
      id: toolId,
      name: requiredStr(entry, 'name', `tool ${repr(toolId)}`),
      description: str(entry.description) || '',
      requiresConfirmation: entry.requiresConfirmation === true,
      sideEffects: sideEffects(toolId, entry.sideEffects),
      auth: policyExpr(entry.auth, `tool ${repr(toolId)} auth`),
    });
  }

  const memory = new Map<string, MemoryDefinition>();
  for (const [memoryId, entry] of rawMemory) {
    memory.set(memoryId, memoryDefinition(memoryId, entry));
  }

  const guardrails = new Map<string, GuardrailDefinition>();
  for (const [guardrailId, entry] of byId(document.guardrails, 'guardrails')) {
    guardrails.set(guardrailId, guardrailDefinition(guardrailId, entry, tools));
  }

  const fallbacks = new Map<string, readonly string[]>();
  for (const [modelId, entry] of rawModels) {
    fallbacks.set(modelId, strList(entry.fallbacks, `model ${repr(modelId)}`));
  }

  const agents = new Map<string, AgentDefinition>();
  for (const [agentId, entry] of rawAgents) {
    agents.set(agentId, agentDefinition(agentId, entry, prompts, tools, memory, guardrails));
  }
  checkControlTargets(agents);

  const reachable = [...reachableModels(agents, fallbacks)].sort();
  const models = new Map<string, ModelSpec>();
  for (const modelId of reachable) {
    const entry = rawModels.get(modelId);
    if (entry === undefined) {
      throw new ConfigurationError(`no model ${repr(modelId)} in the IR`);
    }
    models.set(modelId, modelDefinition(modelId, entry));
  }
  const reachableFallbacks = new Map<string, readonly string[]>();
  for (const alias of models.keys()) reachableFallbacks.set(alias, fallbacks.get(alias) ?? []);

  return new RuntimeSpec({
    models,
    fallbacks: reachableFallbacks,
    prompts,
    tools,
    agents,
    guardrails,
    concurrency: concurrencyCap(document.deployments),
  });
}

function agentDefinition(
  agentId: string,
  entry: Record<string, unknown>,
  prompts: ReadonlyMap<string, string>,
  tools: ReadonlyMap<string, ToolSpec>,
  memory: ReadonlyMap<string, MemoryDefinition>,
  guardrails: ReadonlyMap<string, GuardrailDefinition>,
): AgentDefinition {
  const where = `agent ${repr(agentId)}`;
  const instructions = str(entry.instructions) || '';
  if (!prompts.has(instructions)) {
    throw new ConfigurationError(
      `${where} names prompt ${repr(instructions)}, which the IR does not declare; ` +
        `declared prompts: ${listRepr(sorted([...prompts.keys()]))}`,
    );
  }
  const toolIds = strList(entry.tools, `${where} tools`);
  const missingTools = sorted(toolIds.filter((id) => !tools.has(id)));
  if (missingTools.length > 0) {
    throw new ConfigurationError(`${where} names undeclared tools: ${listRepr(missingTools)}`);
  }
  const memoryIds = strList(entry.memory, `${where} memory`);
  const missingMemory = sorted(memoryIds.filter((id) => !memory.has(id)));
  if (missingMemory.length > 0) {
    throw new ConfigurationError(`${where} names undeclared memory: ${listRepr(missingMemory)}`);
  }
  const guardrailIds = strList(entry.guardrails, `${where} guardrails`);
  const missingGuardrails = sorted(guardrailIds.filter((id) => !guardrails.has(id)));
  if (missingGuardrails.length > 0) {
    throw new ConfigurationError(
      `${where} names undeclared guardrails: ${listRepr(missingGuardrails)}`,
    );
  }

  const engine = str(entry.engine) || 'native';
  const engineVersion = str(entry.engineVersion) || '';
  const onBudget = str(entry.onBudgetExhausted) || 'fail';
  if (!ON_BUDGET_EXHAUSTED.has(onBudget)) {
    throw new ConfigurationError(
      `${where} has onBudgetExhausted ${repr(onBudget)}; expected one of ` +
        `${listRepr(sorted([...ON_BUDGET_EXHAUSTED]))}`,
    );
  }
  const maxSteps = entry.maxSteps;
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new ConfigurationError(`${where} needs a positive maxSteps, got ${valueRepr(maxSteps)}`);
  }

  return {
    id: agentId,
    name: str(entry.name) || agentId,
    instructions,
    model: str(entry.model) || '',
    tools: toolIds,
    memory: memoryIds.map((id) => {
      const found = memory.get(id);
      if (found === undefined) throw new ConfigurationError(`no memory ${repr(id)} in the IR`);
      return found;
    }),
    maxSteps,
    maxTokensBudget: optionalInt(entry.maxTokensBudget),
    maxCostBudget: optionalFloat(entry.maxCostBudget),
    onBudgetExhausted: onBudget,
    handoffs: strList(entry.handoffs, `${where} handoffs`),
    delegates: strList(entry.delegates, `${where} delegates`),
    engine,
    engineVersion,
    approval: approval(where, entry.humanInTheLoop),
    guardrails: guardrailIds.map((id) => {
      const found = guardrails.get(id);
      if (found === undefined) throw new ConfigurationError(`no guardrail ${repr(id)} in the IR`);
      return found;
    }),
  };
}

function guardrailDefinition(
  guardrailId: string,
  entry: Record<string, unknown>,
  tools: ReadonlyMap<string, ToolSpec>,
): GuardrailDefinition {
  const where = `guardrail ${repr(guardrailId)}`;
  const stages = strList(entry.stages, `${where} stages`);
  const unknownStages = sorted(stages.filter((stage) => !GUARDRAIL_STAGES.has(stage)));
  if (unknownStages.length > 0) {
    throw new ConfigurationError(
      `${where} names unknown stages ${listRepr(unknownStages)}; expected a subset of ` +
        `${listRepr(sorted([...GUARDRAIL_STAGES]))}`,
    );
  }
  const policies = strList(entry.policies, `${where} policies`);
  const unknownPolicies = sorted(policies.filter((policy) => !GUARDRAIL_POLICIES.has(policy)));
  if (unknownPolicies.length > 0) {
    throw new ConfigurationError(
      `${where} names unknown policies ${listRepr(unknownPolicies)}; expected a subset of ` +
        `${listRepr(sorted([...GUARDRAIL_POLICIES]))}`,
    );
  }
  const action = str(entry.action) || '';
  if (!GUARDRAIL_ACTIONS.has(action)) {
    throw new ConfigurationError(
      `${where} has action ${repr(action)}; expected one of ` +
        `${listRepr(sorted([...GUARDRAIL_ACTIONS]))}`,
    );
  }
  const redact = strList(entry.redact, `${where} redact`);
  if (action === 'redact' && redact.length === 0) {
    throw new ConfigurationError(
      `${where} uses action 'redact' with no redact fields; a redaction that names ` +
        'no field cannot redact anything',
    );
  }
  const toolIds = strList(entry.tools, `${where} tools`);
  const missing = sorted(toolIds.filter((id) => !tools.has(id)));
  if (missing.length > 0) {
    throw new ConfigurationError(`${where} names undeclared tools: ${listRepr(missing)}`);
  }

  const onFail = entry.onFail;
  if (!isObject(onFail)) throw new ConfigurationError(`${where} needs an onFail object`);
  return {
    id: guardrailId,
    stages,
    policies,
    action,
    redact,
    tools: toolIds,
    message: requiredStr(onFail, 'message', `${where} onFail`),
    fallbackPrompt: str(onFail.fallbackPrompt) || undefined,
    log: onFail.log === true,
  };
}

function sideEffects(toolId: string, raw: unknown): string {
  if (raw === undefined || raw === null) return 'none';
  const value = str(raw);
  if (value === undefined || !SIDE_EFFECTS.has(value)) {
    throw new ConfigurationError(
      `tool ${repr(toolId)} has sideEffects ${valueRepr(raw)}; expected one of ` +
        `${listRepr(sorted([...SIDE_EFFECTS]))}`,
    );
  }
  return value;
}

function policyExpr(raw: unknown, where: string): Readonly<Record<string, unknown>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) throw new ConfigurationError(`${where} must be a parsed policy object`);
  return raw;
}

function approval(where: string, raw: unknown): HumanApproval | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) throw new ConfigurationError(`${where} humanInTheLoop must be an object`);
  const when = raw.when;
  const channel = str(raw.channel) || '';
  if (!isObject(when)) {
    throw new ConfigurationError(`${where} humanInTheLoop needs a parsed 'when' policy`);
  }
  if (channel === '') {
    throw new ConfigurationError(
      `${where} declares humanInTheLoop with no channel; without a channel there ` +
        'is nowhere to ask, so the loop refuses to run it',
    );
  }
  return { when, channel };
}

function checkControlTargets(agents: ReadonlyMap<string, AgentDefinition>): void {
  for (const agent of agents.values()) {
    for (const [field, targets] of [
      ['handoffs', agent.handoffs],
      ['delegates', agent.delegates],
    ] as const) {
      const unknown = sorted(targets.filter((target) => !agents.has(target)));
      if (unknown.length > 0) {
        throw new ConfigurationError(
          `agent ${repr(agent.id)} ${field} undeclared agents: ${listRepr(unknown)}`,
        );
      }
      if (targets.includes(agent.id)) {
        throw new ConfigurationError(
          `agent ${repr(agent.id)} ${field} itself; a control edge must leave the agent`,
        );
      }
    }
    const both = sorted(agent.handoffs.filter((target) => agent.delegates.includes(target)));
    if (both.length > 0) {
      throw new ConfigurationError(
        `agent ${repr(agent.id)} lists ${listRepr(both)} in both handoffs and delegates; ` +
          'transfer and delegation are different semantics, so a target is one or the other',
      );
    }
  }
}

function reachableModels(
  agents: ReadonlyMap<string, AgentDefinition>,
  fallbacks: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [...agents.values()].map((agent) => agent.model);
  while (queue.length > 0) {
    const alias = queue.pop() as string;
    if (reachable.has(alias)) continue;
    reachable.add(alias);
    queue.push(...(fallbacks.get(alias) ?? []));
  }
  return reachable;
}

function modelDefinition(modelId: string, entry: Record<string, unknown>): ModelSpec {
  const where = `model ${repr(modelId)}`;
  const cost = entry.costProfile;
  if (!isObject(cost)) {
    throw new ConfigurationError(
      `${where} has no resolved costProfile; a budget cannot be enforced against ` +
        'an unpriced model',
    );
  }
  const limits = entry.limits;
  if (!isObject(limits)) throw new ConfigurationError(`${where} has no limits`);
  const contextTokens = limits.contextTokens;
  if (typeof contextTokens !== 'number' || !Number.isInteger(contextTokens) || contextTokens < 1) {
    throw new ConfigurationError(`${where} has no positive limits.contextTokens`);
  }
  let maxOutput: number = typeof limits.maxOutputTokens === 'number' ? limits.maxOutputTokens : 0;
  if (!Number.isInteger(maxOutput) || maxOutput < 1) {
    // The IR treats an output ceiling as optional; the runtime must still have one, so
    // the context window is the only ceiling the IR guarantees.
    maxOutput = contextTokens;
  }

  const capabilities: Capability[] = [];
  for (const name of strList(entry.capabilities, `${where} capabilities`)) {
    const mapped = RUNTIME_CAPABILITY[name];
    if (mapped !== undefined) capabilities.push(mapped);
  }

  return new ModelSpec({
    name: requiredStr(entry, 'modelId', where),
    provider: requiredStr(entry, 'provider', where),
    cost: new CostProfile({
      inputPer1kUsd: numeric(cost.inputPerMTok) / 1000,
      outputPer1kUsd: numeric(cost.outputPerMTok) / 1000,
    }),
    contextWindow: contextTokens,
    maxOutputTokens: maxOutput,
    capabilities,
  });
}

function concurrencyCap(raw: unknown): number | undefined {
  if (!Array.isArray(raw)) return undefined;
  const declared: number[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const value = entry.concurrency;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
      declared.push(value);
    }
  }
  return declared.length > 0 ? Math.max(...declared) : undefined;
}

function memoryDefinition(memoryId: string, entry: Record<string, unknown>): MemoryDefinition {
  const where = `memory ${repr(memoryId)}`;
  const tokenBudget = entry.tokenBudget;
  if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget < 1) {
    throw new ConfigurationError(`${where} needs a positive tokenBudget`);
  }
  return {
    id: memoryId,
    kind: str(entry.kind) || 'buffer',
    scope: str(entry.scope) || 'thread',
    tokenBudget,
    backend: str(entry.backend),
    store: str(entry.store),
    summarizeModel: str(entry.summarizeModel),
    ttl: str(entry.ttl),
    redact: strList(entry.redact, `${where} redact`),
  };
}

function byId(raw: unknown, collection: string): Map<string, Record<string, unknown>> {
  const resolved = new Map<string, Record<string, unknown>>();
  if (raw === undefined || raw === null) return resolved;
  if (!Array.isArray(raw)) throw new ConfigurationError(`IR ${collection} must be an array`);
  for (const entry of raw) {
    if (!isObject(entry)) {
      throw new ConfigurationError(`IR ${collection} contains a non-object entry`);
    }
    const entryId = str(entry.id);
    if (!entryId) {
      throw new ConfigurationError(`IR ${collection} contains an entry with no id`);
    }
    resolved.set(entryId, entry);
  }
  return resolved;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredStr(entry: Record<string, unknown>, key: string, where: string): string {
  const value = str(entry[key]);
  if (!value) throw new ConfigurationError(`${where} has no ${repr(key)}`);
  return value;
}

function strList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${where} must be an array of strings`);
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function optionalFloat(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Ascending sort, matching Python's `sorted()` on the same strings. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** A Python-style list literal for a diagnostic, e.g. `['a', 'b']`. */
function listRepr(values: readonly string[]): string {
  return `[${values.map((value) => repr(value)).join(', ')}]`;
}

/** Python's `repr()` for a scalar that may be absent or non-string. */
function valueRepr(value: unknown): string {
  if (typeof value === 'string') return repr(value);
  if (value === undefined || value === null) return 'None';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
