/**
 * The Deep Agents backend: run a `deepagents` agent on the real npm harness.
 *
 * The harness supplies orchestration -- the loop, the delegation implementation, the
 * interrupt machinery -- and nothing else. Every guarantee the runtime already makes is
 * re-established here rather than inherited from the harness:
 *
 * - model calls go through {@link ModelGateway} via {@link GatewayChatModel}, so fallback,
 *   budgets, the ledger and LLM spans still apply;
 * - tools execute through the native loop's `ToolExecutor`, via the same `#observe` the
 *   native loop calls, so a tool call is the same event in the trace either way;
 * - authorization and the `tool-call` guardrail run in {@link guardrailMiddleware}, and a
 *   decision it makes throws so the harness cannot continue past it;
 * - steps are recorded from the generations the adapter actually gathered, which is what
 *   makes the run's cost auditable;
 * - `maxSteps` is enforced by the adapter, because the harness's own limiter appends a
 *   synthetic "limit exceeded" answer and *completes*.
 *
 * One engine instance serves one frame. Building it per frame keeps one run's tools,
 * models, interrupts and transcript out of the next one's.
 */

import { Command, GraphRecursionError, MemorySaver } from '@langchain/langgraph';
import type { SubAgent } from 'deepagents';
import { createDeepAgent } from 'deepagents';

import type { Budget } from '../cost.js';
import { DeepAgentsEngineError, DeepAgentsMaxStepsError } from '../errors.js';
import type { ModelGateway } from '../gateway.js';
import type { Principal } from '../policy.js';
import { Message, ToolCall, type ToolDefinition } from '../types.js';
import { checkEngine } from './engine.js';
import { GatewayChatModel, harnessTool, toLangchainMessages } from './gateway_chat_model.js';
import { DELEGATE_TOOL, guardrailMiddleware, HaltError } from './guardrail_middleware.js';
import type { Frame, Outcome } from './loop.js';
import type { AgentCheckpoint, RunStatus } from './state.js';

/**
 * Recursion allowed per `maxSteps`.
 *
 * The harness recurses several graph nodes per model call, and its limit is a backstop
 * against a graph that cycles without spending a call -- not the step budget. Four per step
 * with a floor of {@link MIN_RECURSION} matches the Python runtime, so the same IR hits the
 * same wall.
 */
const RECURSION_PER_STEP = 4;
const MIN_RECURSION = 8;

/** How far a wrapped error is chased before it is reported as-is. */
const MAX_CAUSE_DEPTH = 8;

/** One agent's adapter and the id it was built for. */
interface ModelRecord {
  readonly agentId: string;
  readonly model: GatewayChatModel;
}

/** The state the harness returns from an invocation. */
type HarnessResult = Record<string, unknown>;

/**
 * The harness graph, as this module uses it.
 *
 * A narrow structural type rather than `createDeepAgent`'s inferred type: the latter carries
 * the whole middleware/subagent/tool generic stack, and naming it here would make every
 * edit to a tool schema a type check over the entire graph. `invoke` is the only method
 * this adapter calls, and it is already asynchronous in the JS port -- there is no
 * `ainvoke` here, unlike Python.
 */
interface HarnessGraph {
  invoke(input: unknown, config?: RunnableConfigLike): Promise<HarnessResult>;
}

interface RunnableConfigLike {
  readonly recursionLimit?: number;
  readonly configurable?: Record<string, unknown>;
}

/**
 * Everything this adapter is allowed to reach on the runtime.
 *
 * The native loop keeps its state behind ECMAScript `#private` fields, which no sibling
 * module can read even with the same class. So the loop builds this object itself: the
 * closures below are created inside the class, which keeps the surface explicitly bounded
 * to what the backend needs and means the adapter cannot reach into the loop's state.
 */
export interface DeepAgentsHost {
  readonly gateway: ModelGateway;
  /** One declared agent's definition, for resolving a delegate id. */
  agent(agentId: string): Frame['agent'];
  systemPrompt(agent: Frame['agent']): string;
  fallbacksFor(alias: string): readonly string[];
  budgetFor(frame: Frame): Budget | undefined;
  /** The executor's definition of every tool this agent declares. */
  toolDefinitions(agent: Frame['agent']): readonly ToolDefinition[];
  /** The registered name of one granted tool id. */
  toolNameFor(toolId: string, agent: Frame['agent']): string;
  toolRequiresConfirmation(name: string): boolean;
  needsApproval(agent: Frame['agent'], calls: readonly ToolCall[], principal: Principal): boolean;
  authorize(agent: Frame['agent'], call: ToolCall, principal: Principal): void;
  observe(
    agent: Frame['agent'],
    calls: readonly ToolCall[],
    principal: Principal,
  ): Promise<Message[]>;
  checkpoint(frame: Frame, calls: readonly ToolCall[], memoryKey: string): AgentCheckpoint;
  /** The `input` stage, run once per frame. */
  guardrailInput(frame: Frame, memoryKey: string): Outcome | undefined;
  guardrailAnswer(frame: Frame, text: string, memoryKey: string): string | Outcome;
  guardrailToolCalls(
    frame: Frame,
    calls: readonly ToolCall[],
    memoryKey: string,
  ): { calls: readonly ToolCall[]; paused: Outcome | undefined };
  remember(agent: Frame['agent'], answer: string, memoryKey: string): Promise<void>;
  outcome(status: RunStatus, frame: Frame, answer?: string): Outcome;
}

/** Run one frame on the harness. */
export class DeepAgentsEngine {
  readonly #host: DeepAgentsHost;

  constructor(host: DeepAgentsHost) {
    this.#host = host;
  }

  /**
   * Run `frame` to a stop condition, reported in our terms.
   *
   * The three catch clauses are the whole reason this method exists rather than a bare
   * `invoke`: the harness reports two different kinds of exhaustion as a *successful* run,
   * and a guardrail decision arrives as an exception from inside a tool.
   */
  async drive(
    frame: Frame,
    budget: Budget | undefined,
    principal: Principal,
    memoryKey: string,
  ): Promise<Outcome> {
    const agent = frame.agent;
    checkEngine(agent);
    if (!frame.inputChecked) {
      frame.inputChecked = true;
      const held = this.#host.guardrailInput(frame, memoryKey);
      if (held !== undefined) return held;
    }

    const models: ModelRecord[] = [];
    const graph = this.#graph(frame, { budget, principal, memoryKey, models });
    const config: RunnableConfigLike = {
      recursionLimit: Math.max(agent.maxSteps * RECURSION_PER_STEP, MIN_RECURSION),
      configurable: { thread_id: `${agent.id}:${memoryKey}` },
    };
    let result: HarnessResult;
    try {
      result = await this.#invoke(graph, frame, config, principal);
    } catch (raised) {
      // The harness rethrows anything raised inside a node as a `MiddlewareError`, so our
      // own errors reach this frame one or more `cause` links deep. Unwrapping first is
      // what keeps "a guardrail blocked" distinguishable from "the harness crashed".
      const error = unwrapped(raised);
      if (error instanceof HaltError) {
        this.#recordSteps(frame, models);
        return error.outcome;
      }
      if (error instanceof DeepAgentsMaxStepsError) {
        this.#recordSteps(frame, models);
        return this.#host.outcome('max-steps', frame);
      }
      if (error instanceof GraphRecursionError) {
        // The backstop. A graph that cycled without spending a model call has still
        // exhausted the agent's step budget; reporting it as a harness crash would hide an
        // agent that never terminates.
        this.#recordSteps(frame, models);
        return this.#host.outcome('max-steps', frame);
      }
      if (error !== raised) throw error;
      throw raised;
    }

    this.#recordSteps(frame, models);
    const held = this.#pause(frame, result, memoryKey);
    if (held !== undefined) return held;
    return await this.#complete(frame, result, memoryKey);
  }

  // -- graph -------------------------------------------------------------------

  /**
   * Build the harness graph.
   *
   * `models` is filled here rather than returned because those adapters are the only record
   * of what the harness spent: every generation they hold came back through the gateway.
   */
  #graph(
    frame: Frame,
    options: {
      readonly budget: Budget | undefined;
      readonly principal: Principal;
      readonly memoryKey: string;
      readonly models: ModelRecord[];
    },
  ): HarnessGraph {
    const { budget, principal, memoryKey, models } = options;
    const agent = frame.agent;
    const interrupts = this.#interrupts(agent);
    const subagents = this.#subagents(frame, { budget, principal, memoryKey, models });
    const built = createDeepAgent({
      model: this.#model(agent, frame, { budget, models }),
      tools: this.#tools(agent, principal),
      systemPrompt: this.#host.systemPrompt(agent),
      middleware: [guardrailMiddleware({ host: this.#host, frame, principal, memoryKey })],
      ...(subagents.length === 0 ? {} : { subagents }),
      ...(interrupts === undefined ? {} : { interruptOn: interrupts }),
      // Only a run that can be interrupted needs a checkpointer, and the pause it enables
      // is a suspension point, never the decision itself.
      ...(interrupts === undefined ? {} : { checkpointer: new MemorySaver() }),
      name: agent.id,
    });
    return built as unknown as HarnessGraph;
  }

  /**
   * The adapter for one agent, with the capability check the native loop also makes.
   *
   * A model that cannot tool-call would answer from memory and look fine, and a gateway
   * fallback is chosen for a provider failure without re-negotiating capabilities. Checking
   * here is what keeps that guarantee *inside* the harness instead of only on the native
   * path.
   */
  #model(
    agent: Frame['agent'],
    frame: Frame,
    options: { readonly budget: Budget | undefined; readonly models: ModelRecord[] },
  ): GatewayChatModel {
    const gateway = this.#host.gateway;
    const required =
      agent.tools.length > 0 || agent.handoffs.length > 0 || agent.delegates.length > 0;
    if (required) gateway.require(agent.model, ['tool-calling']);
    const allowed = new Set<string>();
    for (const toolId of agent.tools) allowed.add(this.#host.toolNameFor(toolId, agent));
    if (agent.delegates.length > 0) {
      // Delegation is the one harness tool this engine exposes on purpose, and only an
      // agent that declares a delegate gets it. It carries no side effect of its own: the
      // delegate's own grant governs what it may do.
      allowed.add(DELEGATE_TOOL);
    }
    const model = new GatewayChatModel({
      gateway,
      alias: agent.model,
      fallbacks: this.#host.fallbacksFor(agent.model),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      allowedTools: allowed,
      maxCalls: Math.max(agent.maxSteps - frame.step, 0),
    });
    options.models.push({ agentId: agent.id, model });
    return model;
  }

  /**
   * Map `delegates` onto `subagents`: delegation with isolated context.
   *
   * The harness gives a subagent only the task it was handed and returns its result to the
   * caller, which is what a delegate is. Each subagent gets its own model and its own tool
   * grant, so a delegate cannot inherit the caller's allow-list or spend against the
   * caller's step budget.
   *
   * Each subagent also carries its own guardrail middleware, because the harness builds a
   * subagent's middleware list from the spec and nothing else: an omitted `middleware` means
   * the delegate's graph has no tool-call guardrail at all, and the caller's middleware does
   * not reach inside it.
   */
  #subagents(
    frame: Frame,
    options: {
      readonly budget: Budget | undefined;
      readonly principal: Principal;
      readonly memoryKey: string;
      readonly models: ModelRecord[];
    },
  ): SubAgent[] {
    const built: SubAgent[] = [];
    for (const targetId of frame.agent.delegates) {
      const target = this.#host.agent(targetId);
      checkEngine(target);
      built.push({
        name: target.id,
        description: target.name || target.id,
        systemPrompt: this.#host.systemPrompt(target),
        model: this.#model(target, frame, options),
        tools: this.#tools(target, options.principal),
        middleware: [
          guardrailMiddleware({
            host: this.#host,
            frame: delegateFrame(frame, target),
            principal: options.principal,
            memoryKey: frame.memoryKey,
          }),
        ],
      } as SubAgent);
    }
    return built;
  }

  /**
   * Wrap each declared tool as a harness tool whose body is our executor.
   *
   * Authorization and the tool-call guardrail run in the middleware of whichever agent is
   * calling -- the caller's for the caller's tools, the delegate's own for the delegate's.
   */
  #tools(agent: Frame['agent'], principal: Principal): ReturnType<typeof harnessTool>[] {
    const definitions = new Map(this.#host.toolDefinitions(agent).map((d) => [d.name, d]));
    const tools: ReturnType<typeof harnessTool>[] = [];
    for (const toolId of agent.tools) {
      const name = this.#host.toolNameFor(toolId, agent);
      const definition = definitions.get(name);
      tools.push(
        harnessTool({
          name,
          description: definition?.description || name,
          parameters: definition?.parameters ?? {},
          call: async (args) => {
            const call = new ToolCall({ id: `${agent.id}:${name}`, name, arguments: args });
            const observations = await this.#host.observe(agent, [call], principal);
            return observations[0]?.content ?? '';
          },
        }),
      );
    }
    return tools;
  }

  /**
   * Which tools arm the harness's interrupt.
   *
   * A tool the IR marks `requiresConfirmation` always arms it. When the agent carries a
   * `humanInTheLoop.when` policy, every tool arms it, and the policy itself is then
   * evaluated by us when the interrupt fires -- an interrupt the policy does not cover is
   * released immediately, so the pause a caller observes is always our policy's and never
   * the harness's default.
   */
  #interrupts(agent: Frame['agent']): Record<string, boolean> | undefined {
    const armed = new Set<string>();
    for (const toolId of agent.tools) {
      const name = this.#host.toolNameFor(toolId, agent);
      if (agent.approval !== undefined || this.#host.toolRequiresConfirmation(name)) {
        armed.add(name);
      }
    }
    if (armed.size === 0) return undefined;
    const record: Record<string, boolean> = {};
    for (const name of [...armed].sort()) record[name] = true;
    return record;
  }

  /**
   * Invoke the graph, releasing any interrupt our own policy does not hold.
   *
   * The harness interrupts on every armed tool and hands the decision to nobody; ours is the
   * `humanInTheLoop.when` policy. An interrupt it does not cover is approved and the graph
   * continues, so the only pause that survives to the caller is one the IR asked for.
   */
  async #invoke(
    graph: HarnessGraph,
    frame: Frame,
    config: RunnableConfigLike,
    principal: Principal,
  ): Promise<HarnessResult> {
    const seeds = toLangchainMessages(
      frame.messages.filter((message) => message.role !== 'system'),
    );
    let result = await graph.invoke({ messages: seeds }, config);
    for (;;) {
      const pending = result.__interrupt__;
      if (!isHeld(pending)) return result;
      const calls = interrupted(pending);
      if (this.#host.needsApproval(frame.agent, calls, principal)) return result;
      result = await graph.invoke(
        new Command({ resume: { decisions: calls.map(() => ({ type: 'approve' })) } }),
        config,
      );
    }
  }

  // -- outcomes ----------------------------------------------------------------

  /**
   * Turn a held interrupt into our checkpoint, or `undefined` when nothing is held.
   *
   * A pause that names no call is a harness payload change, not a decision, so it fails
   * loudly: reporting it as a pause would produce a checkpoint nothing could resume.
   */
  #pause(frame: Frame, result: HarnessResult, memoryKey: string): Outcome | undefined {
    const pending = result.__interrupt__;
    if (!isHeld(pending)) return undefined;
    const calls = interrupted(pending);
    if (calls.length === 0) {
      throw new DeepAgentsEngineError(
        `agent ${frame.agent.id} paused on an interrupt that named no tool call; ` +
          "the harness's interrupt payload has changed shape",
      );
    }
    const checkpoint = this.#host.checkpoint(frame, calls, memoryKey);
    return {
      status: 'paused',
      agentId: frame.agent.id,
      answer: '',
      steps: frame.steps,
      path: frame.path,
      checkpoint,
      guardrails: [...frame.guardrails],
    };
  }

  /** Apply the output guardrail, record memory, and report the answer. */
  async #complete(frame: Frame, result: HarnessResult, memoryKey: string): Promise<Outcome> {
    const released = this.#host.guardrailAnswer(frame, answerOf(result), memoryKey);
    if (typeof released !== 'string') return released;
    frame.messages.push(Message.assistant(released));
    await this.#host.remember(frame.agent, released, memoryKey);
    return this.#host.outcome('completed', frame, released);
  }

  /**
   * Append one step per model call, in the order the gateway charged them.
   *
   * The alias, cost and tokens come from the generation the gateway returned, so a fallback
   * appears in the step exactly as it would under the native loop.
   */
  #recordSteps(frame: Frame, models: readonly ModelRecord[]): void {
    for (const { agentId, model } of models) {
      for (const generation of model.calls) {
        frame.step += 1;
        const response = generation.response;
        frame.steps.push({
          index: frame.step,
          agentId,
          kind: response.toolCalls.length > 0 ? 'tools' : 'answer',
          alias: generation.alias,
          model: response.model,
          costUsd: generation.costUsd,
          totalTokens: generation.usage.totalTokens,
          toolNames: response.toolCalls.map((call) => call.name),
          target: undefined,
          degradedFrom: undefined,
        });
      }
      model.calls.length = 0;
    }
  }
}

/**
 * The frame a delegate's tool calls are decided under.
 *
 * The harness keeps a subagent's own transcript, so this frame carries no messages: it
 * exists because authorization and the guardrail engine need the target's own agent
 * definition, its position in the run's path and the run's memory key. It shares the
 * caller's `guardrails` list so a delegate's records reach the run's result, which is what
 * the native loop's delegation does when it extends the caller's list.
 */
function delegateFrame(caller: Frame, target: Frame['agent']): Frame {
  return {
    agent: target,
    messages: [],
    alias: target.model,
    path: [...caller.path, target.id],
    step: 0,
    degraded: false,
    memory: caller.memory,
    memoryKey: caller.memoryKey,
    costAnchor: caller.costAnchor,
    tokenAnchor: caller.tokenAnchor,
    steps: [],
    resumedDecision: undefined,
    resumedChannel: '',
    inputChecked: true,
    guardrails: caller.guardrails,
  };
}

/** Whether the harness is holding an interrupt. */
function isHeld(pending: unknown): boolean {
  if (pending === undefined || pending === null) return false;
  if (Array.isArray(pending)) return pending.length > 0;
  return true;
}

/**
 * The deepest error in a cause chain.
 *
 * LangGraph rethrows what a node raises inside a `MiddlewareError`, which hides our own
 * error types behind a `.cause` link. The chain is walked rather than assumed to be one
 * link deep because a nested subagent graph can re-wrap at more than one node. An error
 * with no cause is returned unchanged, so this is a no-op for a plain failure.
 */
function unwrapped(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isRecord(current) || !('cause' in current)) return current;
    const cause = current.cause;
    if (cause === undefined || cause === null || cause === current) return current;
    current = cause;
  }
  return current;
}

/**
 * The calls a pause is holding, as our own type.
 *
 * The harness reports a description of each held action rather than the call it composed,
 * so the id is derived from position when none is supplied. It only has to pair a resumed
 * observation with its call, and a derived id is stable across a replay where a random one
 * would not be.
 */
function interrupted(pending: unknown): ToolCall[] {
  const calls: ToolCall[] = [];
  const entries = Array.isArray(pending) ? pending : [pending];
  for (const [index, entry] of entries.entries()) {
    const value = isRecord(entry) && 'value' in entry ? entry.value : entry;
    const requests = requestsOf(value);
    for (const [position, request] of requests.entries()) {
      const name = nameOf(request);
      if (name === '') continue;
      const args = isRecord(request.args) ? request.args : {};
      const declared = typeof request.id === 'string' && request.id !== '' ? request.id : '';
      calls.push(
        new ToolCall({
          id: declared === '' ? `interrupt-${index}-${position}` : declared,
          name,
          arguments: args,
        }),
      );
    }
  }
  return calls;
}

/**
 * The held actions in a pause payload.
 *
 * The JS harness spells the field `actionRequests`; the Python one uses
 * `action_requests`. Both are accepted because only the harness knows which it emits, and
 * silently finding nothing would turn "approval is required" into "nothing to approve".
 */
function requestsOf(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  for (const key of ['actionRequests', 'action_requests']) {
    const found = value[key];
    if (Array.isArray(found)) {
      return found.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    }
  }
  return [];
}

function nameOf(request: Record<string, unknown>): string {
  for (const key of ['name', 'tool', 'tool_name']) {
    const found = request[key];
    if (typeof found === 'string' && found !== '') return found;
  }
  return '';
}

/** The last thing the model said, which is what a native run would report. */
function answerOf(result: HarnessResult): string {
  const messages = result.messages;
  if (!Array.isArray(messages)) return '';
  for (const message of [...messages].reverse()) {
    if (!isRecord(message)) continue;
    if (messageType(message) !== 'ai') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('');
  }
  return '';
}

function messageType(message: Record<string, unknown>): string {
  if (typeof message.type === 'string') return message.type;
  const get = message._getType;
  return typeof get === 'function' ? String((get as () => unknown).call(message)) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Re-exported so the loop's delegation boundary and the tests name the same tool. */
export { DELEGATE_TOOL };
