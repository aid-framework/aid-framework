/**
 * `generated/agents.ts`: the spec's agents, and the runtime built over them.
 *
 * The runtime ships the loop (`@aid/runtime`'s `AgentRuntime`); this module is wiring,
 * not semantics. It carries two things and nothing else:
 *
 * 1. `DOCUMENT` -- the slice of the IR the agent runtime reads, as a TypeScript literal.
 *    `fromIr` is the only consumer, so the projection is written by hand here rather
 *    than by dumping the whole IR: a reader can see exactly which declarations cross the
 *    boundary, and a field the runtime does not read cannot sneak across. A field the
 *    runtime *does* read and this module omits is a refusal in `validate.ts`, not a
 *    silent default -- `retrievers` and `structuredOutput` are the two today.
 * 2. `buildAgentRuntime` -- one constructor over the app's own gateway and tools, so a
 *    pipeline's `agent` step prices against the same ledger and calls the same tool
 *    objects as every other step in the request.
 *
 * ## No routes, deliberately
 *
 * The Python target publishes `POST /agents/{id}/run` and `/agents/resume`. This target
 * emits neither: `managedRoots` is `app/generated`, `app/business` and
 * `app/aid.manifest.json`, so `app/api/**` is unowned and a route emitted there would
 * break `validatePlan` on the next `aid gen`. The pause/resume surface is its own design
 * slice; until it lands, an agent is reachable only through an `agent` step, and the
 * validator refuses a step whose agent can pause, so nothing here can enter a state that
 * would need a resume.
 *
 * ## Why `models` is every model, not the agents' closure
 *
 * The Python emitter narrows this list to what the agent routes can reach, because its
 * `from_ir` builds a `ModelSpec` for every entry and refuses an unpriced one. This
 * runtime's `fromIr` builds `ModelSpec`s only for the *reachable* closure -- it reads
 * every entry's `fallbacks` and nothing else -- so an unpriced pipeline-only embedder or
 * reranker never reaches `modelDefinition`. Emitting the whole table is therefore both
 * safe and simpler, and it keeps the document a projection of the IR rather than a
 * second computation over it.
 *
 * ## Why `prompts` is assembled at wiring time
 *
 * The Python emitter reads the generated `TEMPLATES` literal. This target's equivalent is
 * module-private in `prompts/index.ts`, and `deps.prompts` is the seam a business
 * override replaces. Projecting the registry instead of the generated text is what keeps
 * an override from being honoured by a pipeline and missed by an agent.
 */

import type { AgentShape, GuardrailShape, IR, MemoryShape, ModelShape, ToolShape } from '@aid/ir';

import { type EmittedFile, generated, paths } from './file.js';
import { orderedGuardrails } from './guardrails.js';
import { importStatement, moduleText, tsValue } from './text.js';

/** The agents this app declares, in id order. */
export function orderedAgents(ir: IR): AgentShape[] {
  return [...(ir.agents ?? [])].sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** The memory declarations this app makes, in id order. */
export function orderedMemory(ir: IR): MemoryShape[] {
  return [...(ir.memory ?? [])].sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** Whether this app declares an agent at all. */
export function hasAgents(ir: IR): boolean {
  return orderedAgents(ir).length > 0;
}

/**
 * An entry with its `undefined` fields dropped.
 *
 * `tsValue` renders `undefined` as `null`, and a `null` where `fromIr` expects a list
 * (`redact`, `tools`, `fallbacks`) is a configuration error rather than an absent field.
 * Omitting the key is what the runtime's own readers treat as "not declared".
 */
function entry(fields: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

function modelEntry(model: ModelShape): Record<string, unknown> {
  const cost = model.costProfile;
  return entry({
    id: model.id,
    modelId: model.modelId,
    provider: model.provider,
    capabilities: [...model.capabilities],
    limits: entry({
      contextTokens: model.limits.contextTokens,
      // The same fallback the generated gateway uses, so the document's ModelSpec and
      // the gateway's agree on one ceiling for one model.
      maxOutputTokens: model.limits.maxOutputTokens ?? model.params.maxTokens ?? 1024,
    }),
    costProfile:
      cost === undefined
        ? undefined
        : entry({ inputPerMTok: cost.inputPerMTok, outputPerMTok: cost.outputPerMTok }),
    fallbacks: [...model.fallbacks],
  });
}

function toolEntry(tool: ToolShape): Record<string, unknown> {
  return entry({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    sideEffects: tool.sideEffects,
    requiresConfirmation: tool.requiresConfirmation,
    auth: tool.auth,
  });
}

function memoryEntry(memory: MemoryShape): Record<string, unknown> {
  return entry({
    id: memory.id,
    kind: memory.kind,
    scope: memory.scope,
    tokenBudget: memory.tokenBudget,
    backend: memory.backend,
    store: memory.store,
    summarizeModel: memory.summarizeModel,
    ttl: memory.ttl,
    redact: [...memory.redact],
  });
}

/**
 * One guardrail, in the *nested* IR shape.
 *
 * The runtime's `guardrailDefinition` reads `onFail.message`/`fallbackPrompt`/`log` from
 * the entry, so the projection here is the IR's own shape rather than the flat
 * `GuardrailDefinition` that `guardrails.ts` builds for a pipeline call site. The two are
 * deliberately different: that module is a declaration the engine evaluates directly,
 * this is input to the runtime's parser.
 */
function guardrailEntry(guardrail: GuardrailShape): Record<string, unknown> {
  return entry({
    id: guardrail.id,
    stages: [...guardrail.stages],
    policies: [...guardrail.policies],
    action: guardrail.action,
    redact: [...guardrail.redact],
    tools: [...guardrail.tools],
    onFail: entry({
      message: guardrail.onFail.message,
      fallbackPrompt: guardrail.onFail.fallbackPrompt,
      log: guardrail.onFail.log,
    }),
  });
}

function agentEntry(agent: AgentShape): Record<string, unknown> {
  return entry({
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    tools: [...agent.tools],
    memory: [...agent.memory],
    guardrails: [...agent.guardrails],
    maxSteps: agent.maxSteps,
    maxTokensBudget: agent.maxTokensBudget,
    maxCostBudget: agent.maxCostBudget,
    onBudgetExhausted: agent.onBudgetExhausted ?? 'fail',
    handoffs: [...agent.handoffs],
    delegates: [...agent.delegates],
    engine: agent.engine,
    engineVersion: agent.engineVersion,
    // Already a parsed policy object in the IR, and the runtime's `approval` reads it as
    // one: the document carries the parse, never the source text.
    humanInTheLoop: agent.humanInTheLoop,
  });
}

/**
 * The IR projection `fromIr` reads, without `prompts`.
 *
 * Every collection is emitted whole rather than pruned to what one agent names: `fromIr`
 * resolves references and refuses a dangling one by name, and a pruned document would
 * turn that refusal into a claim this module makes silently.
 */
export function agentDocumentEntries(ir: IR): Record<string, unknown> {
  return {
    models: ir.models.map(modelEntry),
    tools: ir.tools.map(toolEntry),
    memory: orderedMemory(ir).map(memoryEntry),
    guardrails: orderedGuardrails(ir).map(guardrailEntry),
    agents: orderedAgents(ir).map(agentEntry),
  };
}

const DOCUMENT = [
  '/**',
  ' * The declarations an agent run reads, as the IR states them.',
  ' *',
  ' * `fromIr` is the only consumer: every field here is one it resolves, and a declaration',
  ' * it would need and this literal omits is refused at plan time rather than left to fail',
  ' * at the first call. `prompts` is assembled beside it by `agentDocument` -- see',
  ' * `promptDocument` for why it is not a second literal here.',
  ' */',
].join('\n');

const AGENT_DOCUMENT = [
  '/**',
  " * The document `fromIr` parses: the IR projection plus this app's prompt text.",
  ' *',
  ' * `deps` is a parameter, not a module-level read, so a test can hand in a registry it',
  ' * built itself and see the projection without standing up the generated app.',
  ' */',
].join('\n');

const PROMPT_DOCUMENT = [
  '/**',
  ' * The prompt entries `fromIr` resolves, borrowed from the registry.',
  ' *',
  ' * `prompts/index.ts` owns the generated text and is the seam a business override',
  ' * replaces, so a second copy here would be a copy an override silently misses: a',
  ' * pipeline would answer with the override while an agent answered with the generated',
  ' * text. `PromptRegistry.latest` is the same string `fromIr` reads verbatim, and the',
  ' * validator refuses an agent prompt that declares variables, so nothing formats either',
  ' * side and the two representations cannot differ while that refusal holds.',
  ' */',
  'function promptDocument(deps: Deps): readonly unknown[] {',
  '  return deps.prompts',
  '    .names()',
  '    .map((name) => ({ id: name, template: deps.prompts.latest(name).template }));',
  '}',
].join('\n');

const BUILD = [
  '/**',
  ' * Build the runtime over this app, reusing the caller-supplied gateway and tools.',
  ' *',
  ' * Taking both from `Deps` rather than constructing them here is what keeps an `agent`',
  ' * step on the same ledger, the same provider overrides and the same tool objects as the',
  ' * pipeline it runs inside. `AgentRuntime.fromIr` builds a gateway of its own from a',
  ' * provider mapping, which would put a second ledger beside the first, so the document is',
  ' * resolved by `fromIr` and the gateway is passed in instead.',
  ' *',
  ' * One runtime per call, because `Deps` is replaceable: a test that swaps the gateway for',
  ' * a fake must reach the agent loop too, and a module-level runtime would hold the real',
  ' * one from the first import.',
  ' */',
  'export function buildAgentRuntime(deps: Deps = getDeps()): AgentRuntime {',
  '  return new AgentRuntime(fromIr({ ...agentDocument(deps) }), deps.gateway, {',
  '    tools: deps.toolList,',
  '  });',
  '}',
].join('\n');

/** `generated/agents.ts`: the agent document and the runtime built over it, or nothing. */
export function emitAgents(ir: IR): EmittedFile | undefined {
  if (!hasAgents(ir)) return undefined;
  const ids = orderedAgents(ir).map((agent) => tsValue(agent.id, ''));
  const header = importStatement('@aid/runtime', [
    { name: 'AgentRuntime', type: false },
    { name: 'fromIr', type: false },
  ]);
  const depsImport = importStatement('./deps.js', [
    { name: 'Deps', type: true },
    { name: 'getDeps', type: false },
  ]);
  return generated(
    paths.agents,
    moduleText(
      `${header}\n${depsImport}`,
      [
        '/** The agents this app declares, in id order. */',
        `export const AGENT_IDS: readonly string[] = [${ids.join(', ')}];`,
      ].join('\n'),
      DOCUMENT,
      'const ENTRIES: Record<string, unknown> = ' +
        `${tsValue(agentDocumentEntries(ir), '')} as Record<string, unknown>;`,
      AGENT_DOCUMENT,
      [
        'export function agentDocument(deps: Deps): Record<string, unknown> {',
        '  return { ...ENTRIES, prompts: promptDocument(deps) };',
        '}',
      ].join('\n'),
      PROMPT_DOCUMENT,
      BUILD,
    ),
  );
}
