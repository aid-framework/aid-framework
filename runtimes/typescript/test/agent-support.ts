/**
 * Builders for the IR documents and runtimes the agent tests drive.
 *
 * Mirrors `tests/agent_support.py` in the Python runtime, so both suites describe the same
 * system: the agent tests all start from an emitted IR document rather than from
 * `RuntimeSpec` directly, because the seam *is* part of what the layer delivers. A runtime
 * that only worked on hand-built specs would prove nothing about the documents the compiler
 * emits.
 *
 * Prices here are the IR's USD per million tokens. The gateway divides by 1000, so a test
 * that reasons about money reads the gateway's own projection (`Harness.projections`)
 * instead of re-deriving it.
 */

import {
  AgentRuntime,
  type CompletionRequest,
  type CostLedger,
  FakeProvider,
  type MemoryStore,
  Message,
  type ScriptedTurn,
  Tool,
  type ToolParameters,
} from '../src/index.js';

export const PROVIDER = 'fake';

/** Mutable JSON, so a test can adjust one field of a built document. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/**
 * USD per million tokens. `STRONG` is 20x `CHEAP`, which leaves room to place a budget
 * strictly between two projections.
 */
export const STRONG_COST = { inputPerMTok: 10.0, outputPerMTok: 30.0 } as const;
export const CHEAP_COST = { inputPerMTok: 0.5, outputPerMTok: 1.5 } as const;

export const SEARCH_SCHEMA: ToolParameters = {
  type: 'object',
  properties: { query: { type: 'string' } },
  additionalProperties: false,
};

/** The `hasRole("admin")` policy: a HITL fixture that only one principal satisfies. */
export const ADMIN_ONLY: JsonObject = {
  kind: 'call',
  name: 'hasRole',
  args: [{ kind: 'string', value: 'admin' }],
};

/** `isAuthenticated()`. The security gate rejects a mutating tool with no `auth`. */
export const AUTHENTICATED: JsonObject = { kind: 'call', name: 'isAuthenticated', args: [] };

/** Side effects the runtime treats as mutations. Mirrors the loop's `SIDE_EFFECTING`. */
export const MUTATING: ReadonlySet<string> = new Set(['write', 'destructive']);

export function modelDef(
  modelId: string,
  options: {
    readonly cost?: Readonly<Record<string, number>>;
    readonly fallbacks?: readonly string[];
    readonly capabilities?: readonly string[];
  } = {},
): JsonObject {
  return {
    id: modelId,
    modelId: `${modelId}-1`,
    provider: PROVIDER,
    capabilities: [...(options.capabilities ?? ['tool-calling'])],
    limits: { contextTokens: 128_000, maxOutputTokens: 4_096 },
    costProfile: { ...(options.cost ?? CHEAP_COST) },
    fallbacks: [...(options.fallbacks ?? [])],
  };
}

export function promptDef(promptId: string, template: string): JsonObject {
  return { id: promptId, version: 1, template, variables: {} };
}

export function toolDef(
  toolId: string,
  name: string,
  options: {
    readonly requiresConfirmation?: boolean;
    readonly sideEffects?: string;
    readonly auth?: JsonObject | null;
    readonly description?: string;
  } = {},
): JsonObject {
  const requiresConfirmation = options.requiresConfirmation ?? false;
  const effects = options.sideEffects ?? (requiresConfirmation ? 'write' : 'read');
  const entry: JsonObject = {
    id: toolId,
    name,
    description: options.description ?? `${name} tool`,
    requiresConfirmation,
    sideEffects: effects,
  };
  // A mutating entry gets `isAuthenticated()` unless the caller names another policy,
  // because the security gate rejects a mutating tool with no `auth`: producing such a
  // document here would let a test drive a spec the compiler cannot emit.
  const policy =
    options.auth === undefined ? (MUTATING.has(effects) ? AUTHENTICATED : null) : options.auth;
  if (policy !== null) entry.auth = { ...policy };
  return entry;
}

export function guardrailDef(
  guardrailId: string,
  options: {
    readonly stages?: readonly string[];
    readonly policies?: readonly string[];
    readonly action?: string;
    readonly redact?: readonly string[];
    readonly tools?: readonly string[];
    readonly message?: string;
    readonly fallbackPrompt?: string;
    readonly log?: boolean;
  } = {},
): JsonObject {
  const onFail: JsonObject = {
    message: options.message ?? 'blocked by a guardrail',
    log: options.log ?? true,
  };
  if (options.fallbackPrompt !== undefined) onFail.fallbackPrompt = options.fallbackPrompt;
  return {
    id: guardrailId,
    stages: [...(options.stages ?? ['input'])],
    policies: [...(options.policies ?? ['prompt-injection'])],
    action: options.action ?? 'block',
    redact: [...(options.redact ?? [])],
    tools: [...(options.tools ?? [])],
    onFail,
    traits: [],
  };
}

export function memoryDef(
  memoryId: string,
  options: {
    readonly kind?: string;
    readonly scope?: string;
    readonly tokenBudget?: number;
    readonly backend?: string;
    readonly summarizeModel?: string;
    readonly ttl?: string;
    readonly redact?: readonly string[];
  } = {},
): JsonObject {
  const entry: JsonObject = {
    id: memoryId,
    kind: options.kind ?? 'buffer',
    scope: options.scope ?? 'thread',
    tokenBudget: options.tokenBudget ?? 200,
    redact: [...(options.redact ?? [])],
  };
  if (options.backend !== undefined) entry.backend = options.backend;
  if (options.summarizeModel !== undefined) entry.summarizeModel = options.summarizeModel;
  if (options.ttl !== undefined) entry.ttl = options.ttl;
  return entry;
}

export function agentDef(
  agentId: string,
  options: {
    readonly prompt?: string;
    readonly model?: string;
    readonly maxSteps?: number;
    readonly tools?: readonly string[];
    readonly handoffs?: readonly string[];
    readonly delegates?: readonly string[];
    readonly memory?: readonly string[];
    readonly maxCostBudget?: number;
    readonly maxTokensBudget?: number;
    readonly onBudgetExhausted?: string;
    readonly engine?: string;
    readonly engineVersion?: string;
    readonly hitl?: JsonObject;
    readonly guardrails?: readonly string[];
  } = {},
): JsonObject {
  const entry: JsonObject = {
    id: agentId,
    name: agentId,
    instructions: options.prompt ?? 'main',
    model: options.model ?? 'cheap',
    maxSteps: options.maxSteps ?? 4,
    tools: [...(options.tools ?? [])],
    handoffs: [...(options.handoffs ?? [])],
    delegates: [...(options.delegates ?? [])],
    memory: [...(options.memory ?? [])],
    guardrails: [...(options.guardrails ?? [])],
    engine: options.engine ?? 'native',
  };
  if (options.maxCostBudget !== undefined) entry.maxCostBudget = options.maxCostBudget;
  if (options.engineVersion !== undefined) entry.engineVersion = options.engineVersion;
  if (options.maxTokensBudget !== undefined) entry.maxTokensBudget = options.maxTokensBudget;
  if (options.onBudgetExhausted !== undefined) {
    entry.onBudgetExhausted = options.onBudgetExhausted;
  }
  if (options.hitl !== undefined) entry.humanInTheLoop = { ...options.hitl };
  return entry;
}

export function document(init: {
  readonly models: readonly JsonObject[];
  readonly prompts: readonly JsonObject[];
  readonly agents: readonly JsonObject[];
  readonly tools?: readonly JsonObject[];
  readonly memory?: readonly JsonObject[];
  readonly guardrails?: readonly JsonObject[];
}): JsonObject {
  return {
    version: '0.2.0',
    models: init.models.map((entry) => ({ ...entry })),
    prompts: init.prompts.map((entry) => ({ ...entry })),
    tools: (init.tools ?? []).map((entry) => ({ ...entry })),
    memory: (init.memory ?? []).map((entry) => ({ ...entry })),
    guardrails: (init.guardrails ?? []).map((entry) => ({ ...entry })),
    agents: init.agents.map((entry) => ({ ...entry })),
  };
}

/**
 * A one-agent document: prompt `main`, agent `solo`.
 *
 * `memory` and `guardrailSpecs` are the document's collections; the agent references every
 * entry in each, because a one-agent document has nothing else to reference them.
 */
export interface SoloOptions {
  readonly prompt?: string;
  readonly alias?: string;
  readonly toolSpecs?: readonly JsonObject[];
  readonly memory?: readonly JsonObject[];
  readonly guardrailSpecs?: readonly JsonObject[];
  readonly models?: readonly JsonObject[];
  readonly tools?: readonly string[];
  readonly maxSteps?: number;
  readonly maxCostBudget?: number;
  readonly maxTokensBudget?: number;
  readonly onBudgetExhausted?: string;
  readonly engine?: string;
  readonly engineVersion?: string;
  readonly hitl?: JsonObject;
}

export function solo(options: SoloOptions = {}): JsonObject {
  const memorySpecs = options.memory ?? [];
  const guardrailSpecs = options.guardrailSpecs ?? [];
  return document({
    models: options.models ?? [modelDef(options.alias ?? 'cheap')],
    prompts: [promptDef('main', options.prompt ?? 'You are a helpful assistant.')],
    tools: options.toolSpecs ?? [],
    memory: memorySpecs,
    guardrails: guardrailSpecs,
    agents: [
      agentDef('solo', {
        model: options.alias ?? 'cheap',
        memory: memorySpecs.map((entry) => String(entry.id)),
        guardrails: guardrailSpecs.map((entry) => String(entry.id)),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.maxCostBudget === undefined ? {} : { maxCostBudget: options.maxCostBudget }),
        ...(options.maxTokensBudget === undefined
          ? {}
          : { maxTokensBudget: options.maxTokensBudget }),
        ...(options.onBudgetExhausted === undefined
          ? {}
          : { onBudgetExhausted: options.onBudgetExhausted }),
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(options.engineVersion === undefined ? {} : { engineVersion: options.engineVersion }),
        ...(options.hitl === undefined ? {} : { hitl: options.hitl }),
      }),
    ],
  });
}

/** Narrow one document collection entry, so a test can adjust it in place. */
export function at(document: JsonObject, collection: string, index = 0): JsonObject {
  const list = document[collection];
  if (!Array.isArray(list)) throw new TypeError(`document has no ${collection} collection`);
  const entry = list[index];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(`${collection}[${index}] is not an object`);
  }
  return entry;
}

/** What a tool handler actually received. Empty means it never ran. */
export class Recorder {
  readonly queries: string[] = [];

  get calls(): number {
    return this.queries.length;
  }
}

/**
 * A tool that records its executions, so "did not run" is observable.
 *
 * Whether the call needs a human is an IR property of the tool entry, not of the registered
 * `Tool`, so it is declared in the document instead.
 */
export function recordingTool(
  name = 'search',
  options: { readonly answer?: string } = {},
): { tool: Tool; recorder: Recorder } {
  const recorder = new Recorder();
  const answer = options.answer ?? 'sunny';
  const tool = Tool.of({
    name,
    description: `${name} tool`,
    parameters: SEARCH_SCHEMA,
    handler: (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      recorder.queries.push(query);
      return `${answer}:${query}`;
    },
  });
  return { tool, recorder };
}

/** One runtime plus the fakes it was built with. */
export class Harness {
  readonly runtime: AgentRuntime;
  readonly provider: FakeProvider;
  readonly ledger: CostLedger;

  constructor(runtime: AgentRuntime, provider: FakeProvider) {
    this.runtime = runtime;
    this.provider = provider;
    this.ledger = runtime.gateway.ledger;
  }

  get gateway() {
    return this.runtime.gateway;
  }

  /**
   * The gateway's own prompt projection for each alias of this document.
   *
   * Tests place a dollar ceiling between two aliases with this rather than multiplying
   * prices by token counts: the number a budget is compared to must be the number the
   * gateway computes, or the test is measuring its own arithmetic.
   */
  projections(init: { readonly prompt: string; readonly text: string }): Record<string, number> {
    const request = { messages: [Message.system(init.prompt), Message.user(init.text)] };
    const result: Record<string, number> = {};
    for (const alias of [...this.runtime.spec.models.keys()].sort()) {
      result[alias] = this.gateway.projectedCostUsd(alias, request as unknown as CompletionRequest);
    }
    return result;
  }

  aliasesCharged(): string[] {
    return this.ledger.entries.map((entry) => entry.alias);
  }
}

export function build(
  doc: JsonObject,
  options: {
    readonly script?: readonly ScriptedTurn[];
    readonly tools?: readonly Tool[];
    readonly stores?: Readonly<Record<string, MemoryStore>>;
    readonly memoryStore?: MemoryStore;
    readonly ledger?: CostLedger;
    readonly provider?: FakeProvider;
  } = {},
): Harness {
  const provider =
    options.provider ?? new FakeProvider({ name: PROVIDER, script: options.script ?? [] });
  const runtime = AgentRuntime.fromIr(doc as unknown as Record<string, unknown>, {
    providers: { [PROVIDER]: provider },
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.stores === undefined ? {} : { stores: options.stores }),
    ...(options.memoryStore === undefined ? {} : { memoryStore: options.memoryStore }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
  });
  return new Harness(runtime, provider);
}
