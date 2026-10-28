import { ConcurrencyLimiter } from '../concurrency.js';
import { Budget, type CostLedger, LedgerEntry } from '../cost.js';
import {
  AgentBudgetDegradedError,
  AgentTransferCycleError,
  BudgetExceededError,
  CapabilityMismatchError,
  ConfigurationError,
  GuardrailBlockedError,
  PolicyEvaluationError,
  ToolPermissionError,
} from '../errors.js';
import { ModelGateway } from '../gateway.js';
import { evaluatePolicy, Principal, policySource } from '../policy.js';
import type { Provider } from '../providers/base.js';
import { type Tool, ToolExecutor } from '../tools.js';
import {
  type Capability,
  CompletionRequest,
  type CompletionResponse,
  type GenerationResult,
  Message,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import type { DeepAgentsHost } from './deep_agents.js';
import { checkEngine, DEEPAGENTS } from './engine.js';
import {
  ACTION_BLOCK,
  ACTION_ESCALATE,
  ACTION_REDACT,
  GuardrailEngine,
  type GuardrailEscalation,
  type GuardrailRecord,
  type GuardrailVerdict,
} from './guardrails.js';
import {
  type AgentDefinition,
  fromIr,
  hasControlTools,
  type MemoryDefinition,
  type RuntimeSpec,
  stageGuardrails,
  type ToolSpec,
} from './ir.js';
import {
  checkMemorySupported,
  InProcessMemoryStore,
  type MemoryStore,
  renderContext,
  ThreadMemory,
} from './memory.js';
import {
  type AgentCheckpoint,
  type HumanDecision,
  RunResult,
  type RunStatus,
  type StepRecord,
} from './state.js';

/**
 * The native agent engine: one loop, three ways to leave it.
 *
 * The loop is a model call, its tool calls, the observations, repeat -- until the model
 * answers without a tool call, until `maxSteps` is spent, until a budget is crossed, or
 * until a human is needed. It consumes a `RuntimeSpec` (the IR seam in `agents/ir`) and
 * calls models through `ModelGateway`, so fallback, cost accounting, and tracing behave
 * exactly as they do for a pipeline step.
 *
 * Two control edges, and the difference is not cosmetic:
 *
 * **transfer** -- IR `handoffs`. Control *moves*. The caller does not resume; the target
 * owns the rest of the turn and its answer is the run's answer. The target inherits the
 * conversation but not the caller's instructions: a system prompt belongs to an agent, not
 * to a transcript. The runtime primitive is `transfer`, and it never returns to the caller.
 *
 * **delegate** -- IR `delegates` (Deep Agents `subagents`). Control is *lent*. The delegate
 * gets an isolated context -- its own system prompt and the one message it was handed,
 * nothing else -- and returns exactly one observation. The caller resumes, sees that
 * observation as a tool result, and authors the final answer. The runtime primitive is
 * `delegate`.
 *
 * So the observable difference is who produces the final answer, and whose transcript
 * contains the other's messages: after a transfer the answer is the target's and the
 * caller's steps are a prefix of the target's run; after a delegate the answer is the
 * caller's and the delegate's transcript is a separate, closed conversation.
 *
 * Budgets are ratified decision D1: crossing one is a hard failure. An agent that declares
 * `onBudgetExhausted: degrade` instead steps **one** rung down its declared alias ladder,
 * **once**, and both the step record and the ledger show the cheaper alias. It is never a
 * retry loop: a degraded frame that still does not fit fails.
 *
 * Span recording (`agent_span`, HITL and guardrail events) is not ported here: decision D-7
 * defers agent-level tracing to the layer that also gives this runtime a tracer seam, and no
 * conformance case observes a span. The observable behaviours the Python module records
 * spans *for* -- status, steps, transfer target, degradation -- are all in `RunResult`.
 */

/** Namespacing for the control tools. A model cannot transfer by emitting prose. */
export const TRANSFER_PREFIX = 'transfer_to_';
export const DELEGATE_PREFIX = 'delegate_to_';

/** The one argument a control tool takes: what the other agent needs to know. */
export const CONTROL_ARGUMENT = 'message';

const DEGRADE = 'degrade';
const THREAD = 'thread';
const GLOBAL = 'global';
const IN_PROCESS = 'in-process';
const RESTORED_ALIAS = 'restored';
const TOOL_CONFIRMATION = 'tool-confirmation';
const GUARDRAIL_CHANNEL = 'guardrail';
const GUARDRAIL_OUTPUT = 'output';
const GUARDRAIL_TOOL = 'tool-call';
/**
 * Side effects that must be explicitly granted. `read` and `none` are not in here on
 * purpose: permissioning exists to gate effects, and gating reads would make every hostile
 * tool the interesting one.
 */
const SIDE_EFFECTING: ReadonlySet<string> = new Set(['write', 'destructive']);
const REJECTED = 'rejected by the human approver';

/** A step record while the loop is still deciding what the step did. */
export type StepDraft = { -readonly [K in keyof StepRecord]: StepRecord[K] };

/** The memory context one agent turn resolved, and what it measured. */
export interface MemoryState {
  thread: ThreadMemory | undefined;
  context: string;
  scopes: readonly string[];
  entries: number;
  tokens: number;
}

/** One agent's turn in progress: its own transcript, budget anchors, and steps. */
export interface Frame {
  agent: AgentDefinition;
  messages: Message[];
  alias: string;
  path: readonly string[];
  step: number;
  degraded: boolean;
  memory: MemoryState;
  memoryKey: string;
  costAnchor: number;
  tokenAnchor: number;
  steps: StepDraft[];
  resumedDecision: HumanDecision | undefined;
  resumedChannel: string;
  /**
   * `input` runs once per frame, on the message the frame started from. A transferred
   * target re-checks the conversation it inherited (its guardrails are its own), while a
   * resumed frame does not: the checkpoint only exists because the input stage already ran.
   */
  inputChecked: boolean;
  guardrails: GuardrailRecord[];
}

/** What a frame decided, before the run's totals are stamped on it. */
export interface Outcome {
  status: RunStatus;
  agentId: string;
  answer: string;
  steps: readonly StepDraft[];
  path: readonly string[];
  checkpoint: AgentCheckpoint | undefined;
  guardrails: readonly GuardrailRecord[];
}

export function outcomeOf(init: {
  status: RunStatus;
  agentId: string;
  answer?: string;
  steps: readonly StepDraft[];
  path: readonly string[];
  checkpoint?: AgentCheckpoint;
  guardrails: readonly GuardrailRecord[];
}): Outcome {
  return {
    status: init.status,
    agentId: init.agentId,
    answer: init.answer ?? '',
    steps: init.steps,
    path: init.path,
    checkpoint: init.checkpoint,
    guardrails: init.guardrails,
  };
}

/** `round(x, 6)`, so a sum of float costs does not differ from Python's by an epsilon. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Runs the IR's agents on the native engine. */
export class AgentRuntime {
  readonly #spec: RuntimeSpec;
  readonly #gateway: ModelGateway;
  readonly #executor: ToolExecutor;
  readonly #stores: ReadonlyMap<string, MemoryStore>;
  readonly #defaultStore: MemoryStore;
  readonly #guardrails: GuardrailEngine;
  readonly #toolsByName: ReadonlyMap<string, ToolSpec>;

  constructor(
    spec: RuntimeSpec,
    gateway: ModelGateway,
    options: {
      readonly tools?: Iterable<Tool>;
      readonly stores?: Readonly<Record<string, MemoryStore>> | ReadonlyMap<string, MemoryStore>;
      readonly memoryStore?: MemoryStore;
      readonly limiter?: ConcurrencyLimiter;
    } = {},
  ) {
    this.#spec = spec;
    this.#gateway = gateway;
    this.#executor = new ToolExecutor(options.tools ?? [], { limiter: options.limiter });
    this.#stores =
      options.stores instanceof Map
        ? new Map(options.stores)
        : new Map(Object.entries(options.stores ?? {}));
    this.#defaultStore = options.memoryStore ?? new InProcessMemoryStore();
    this.#guardrails = new GuardrailEngine(spec.guardrails);
    const byName = new Map<string, ToolSpec>();
    for (const definition of spec.tools.values()) byName.set(definition.name, definition);
    this.#toolsByName = byName;
    this.#checkDeclarations();
  }

  /**
   * Build a runtime from an emitted IR document.
   *
   * The IR's `deployments[].concurrency` becomes one limiter shared by the gateway and the
   * tool executor, so model calls, tool calls, and delegation all draw from the same budget
   * rather than running two independent pools.
   */
  static fromIr(
    document: Record<string, unknown>,
    options: {
      readonly providers: Readonly<Record<string, Provider>>;
      readonly tools?: Iterable<Tool>;
      readonly stores?: Readonly<Record<string, MemoryStore>> | ReadonlyMap<string, MemoryStore>;
      readonly memoryStore?: MemoryStore;
      readonly ledger?: CostLedger;
      readonly budget?: Budget;
    },
  ): AgentRuntime {
    const spec = fromIr(document);
    const limiter =
      spec.concurrency === undefined ? undefined : new ConcurrencyLimiter(spec.concurrency);
    const gateway = new ModelGateway({
      providers: options.providers,
      aliases: Object.fromEntries(spec.models),
      ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(limiter === undefined ? {} : { limiter }),
    });
    return new AgentRuntime(spec, gateway, {
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.stores === undefined ? {} : { stores: options.stores }),
      ...(options.memoryStore === undefined ? {} : { memoryStore: options.memoryStore }),
      ...(limiter === undefined ? {} : { limiter }),
    });
  }

  get spec(): RuntimeSpec {
    return this.#spec;
  }

  get gateway(): ModelGateway {
    return this.#gateway;
  }

  /** Run `agentId` to a stop condition on one user message. */
  async run(
    agentId: string,
    text: string,
    options: {
      readonly principal?: Principal;
      readonly memoryKey?: string;
      readonly conversation?: readonly Message[];
    } = {},
  ): Promise<RunResult> {
    const agent = this.#spec.agent(agentId);
    checkEngine(agent);
    const key = options.memoryKey ?? agent.id;
    const frame = await this.#open(
      agent,
      [
        Message.system(this.#spec.systemPrompt(agent)),
        ...(options.conversation ?? []),
        Message.user(text),
      ],
      { path: [agent.id], memoryKey: key },
    );
    const startCost = this.#gateway.ledger.costUsd;
    const startTokens = this.#gateway.ledger.totalTokens;
    const outcome = await this.#drive(frame, {
      principal: options.principal ?? new Principal(),
      memoryKey: key,
    });
    return this.#wrap(outcome, startCost, startTokens);
  }

  /** Continue a paused run from its checkpoint, with a human's answer. */
  async resume(
    checkpoint: AgentCheckpoint,
    decision: HumanDecision,
    options: { readonly principal?: Principal } = {},
  ): Promise<RunResult> {
    this.#restoreLedger(checkpoint);
    const startCost = this.#gateway.ledger.costUsd;
    const startTokens = this.#gateway.ledger.totalTokens;
    const outcome = await this.#resumeFrom(
      checkpoint,
      decision,
      options.principal ?? new Principal(),
    );
    return this.#wrap(outcome, startCost, startTokens);
  }

  async #resumeFrom(
    checkpoint: AgentCheckpoint,
    decision: HumanDecision,
    principal: Principal,
  ): Promise<Outcome> {
    if (checkpoint.resumeKind === 'delegate') {
      throw new ConfigurationError(
        `the checkpoint belongs to agent ${JSON.stringify(checkpoint.agentId)}, which was waiting ` +
          'inside a delegate; resume the checkpoint that carries the caller link',
      );
    }
    const agent = this.#spec.agent(checkpoint.agentId);
    checkEngine(agent);
    const frame = await this.#frameFrom(checkpoint);
    frame.resumedDecision = decision;
    frame.resumedChannel = checkpoint.channel;
    const escalation = checkpoint.escalation;
    if (decision === 'approve') {
      if (escalation !== undefined && escalation.stage === GUARDRAIL_OUTPUT) {
        // The model already produced this answer and a person released it; re-generating
        // would spend tokens to answer the same question and could produce a different
        // answer than the one that was approved.
        const answer = escalation.text;
        frame.messages.push(Message.assistant(answer));
        await this.#remember(agent, answer, checkpoint.memoryKey);
        return this.#guardrailCompleted(frame, answer);
      }
      frame.messages.push(...(await this.#observe(agent, checkpoint.calls, principal)));
    } else if (escalation !== undefined) {
      // A person declined to release what the guardrail flagged. That is a decision, not an
      // error, and the run stops here with the guardrail's own message as the answer rather
      // than inventing one.
      return outcomeOf({
        status: 'blocked',
        agentId: agent.id,
        answer: escalation.message,
        steps: frame.steps,
        path: frame.path,
        guardrails: frame.guardrails,
      });
    } else {
      frame.messages.push(
        ...checkpoint.calls.map((call) => Message.tool(call.id, REJECTED, { name: call.name })),
      );
    }
    const outcome = await this.#drive(frame, { principal, memoryKey: checkpoint.memoryKey });
    if (checkpoint.caller === undefined) return outcome;
    if (outcome.status === 'paused' && outcome.checkpoint !== undefined) {
      // The delegate paused again; the caller is still the one waiting, and the caller link
      // has to survive the second pause or the run cannot continue.
      return { ...outcome, checkpoint: { ...outcome.checkpoint, caller: checkpoint.caller } };
    }
    return this.#resumeCaller(checkpoint.caller, outcome, principal);
  }

  async #resumeCaller(
    caller: AgentCheckpoint,
    inner: Outcome,
    principal: Principal,
  ): Promise<Outcome> {
    const frame = await this.#frameFrom(caller);
    const call = caller.calls[0];
    if (call === undefined) {
      throw new ConfigurationError(
        'a caller checkpoint holds no pending call, so there is nothing to resume into',
      );
    }
    frame.messages.push(Message.tool(call.id, inner.answer, { name: call.name }));
    frame.steps.push(...inner.steps);
    frame.guardrails.push(...inner.guardrails);
    return this.#drive(frame, { principal, memoryKey: caller.memoryKey });
  }

  /** Complete a frame after an approved escalation released its answer. */
  #guardrailCompleted(frame: Frame, answer: string): Outcome {
    return outcomeOf({
      status: 'completed',
      agentId: frame.agent.id,
      answer,
      steps: frame.steps,
      path: frame.path,
      guardrails: frame.guardrails,
    });
  }

  async #drive(
    frame: Frame,
    options: { readonly principal: Principal; readonly memoryKey: string },
  ): Promise<Outcome> {
    const budget = this.#budgetFor(frame);
    return this.#runEngine(frame, {
      ...(budget === undefined ? {} : { budget }),
      principal: options.principal,
      memoryKey: options.memoryKey,
    });
  }

  /**
   * Drive the frame on the engine its agent declared.
   *
   * The native loop is the default and the only engine loaded eagerly. `deepagents` is
   * imported here, on demand: the harness is an optional peer dependency, so a static import
   * would make this package unloadable for every application that never opts in. The caller
   * has already run `checkEngine`, which is what turns an absent harness into
   * `DeepAgentsUnavailableError` -- so this import is reached only when the packages are
   * installed at the pinned releases.
   */
  async #runEngine(
    frame: Frame,
    options: {
      readonly budget?: Budget;
      readonly principal: Principal;
      readonly memoryKey: string;
    },
  ): Promise<Outcome> {
    if (frame.agent.engine === DEEPAGENTS) {
      const { DeepAgentsEngine } = await import('./deep_agents.js');
      return new DeepAgentsEngine(this.#deepAgentsHost()).drive(
        frame,
        options.budget,
        options.principal,
        options.memoryKey,
      );
    }
    return this.#runLoop(frame, options);
  }

  /**
   * The narrow surface the Deep Agents backend is allowed to reach.
   *
   * A closure built inside the class, because the loop's state lives behind ECMAScript
   * `#private` fields that a sibling module could not read. Passing exactly these fifteen
   * operations keeps the backend on the same accounting, authorization, guardrail and
   * memory paths as the native loop instead of giving it a second implementation of each.
   */
  #deepAgentsHost(): DeepAgentsHost {
    return {
      gateway: this.#gateway,
      agent: (agentId) => this.#spec.agent(agentId),
      systemPrompt: (agent) => this.#spec.systemPrompt(agent),
      fallbacksFor: (alias) => this.#spec.fallbacksFor(alias),
      budgetFor: (frame) => this.#budgetFor(frame),
      toolDefinitions: (agent) => this.#toolDefinitions(agent),
      toolNameFor: (toolId, agent) =>
        this.#requireTool(toolId, `agent ${JSON.stringify(agent.id)}`).name,
      toolRequiresConfirmation: (name) =>
        this.#toolsByName.get(name)?.requiresConfirmation === true,
      needsApproval: (agent, calls, principal) => this.#needsApproval(agent, calls, principal),
      authorize: (agent, call, principal) => this.#authorize(agent, call, principal),
      observe: (agent, calls, principal) => this.#observe(agent, calls, principal),
      checkpoint: (frame, calls, memoryKey) => this.#checkpoint(frame, calls, memoryKey),
      guardrailInput: (frame, memoryKey) => this.#guardrailText('input', frame, memoryKey, true),
      guardrailAnswer: (frame, text, memoryKey) => this.#guardrailAnswer(frame, text, memoryKey),
      guardrailToolCalls: (frame, calls, memoryKey) =>
        this.#guardrailToolCalls(frame, calls, memoryKey),
      remember: (agent, answer, memoryKey) => this.#remember(agent, answer, memoryKey),
      outcome: (status, frame, answer) => this.#outcome(status, frame, answer),
    };
  }

  async #runLoop(
    frame: Frame,
    options: {
      readonly budget?: Budget;
      readonly principal: Principal;
      readonly memoryKey: string;
    },
  ): Promise<Outcome> {
    const agent = frame.agent;
    const { budget, principal, memoryKey } = options;
    for (;;) {
      if (frame.step >= agent.maxSteps) {
        return this.#outcome('max-steps', frame);
      }

      if (!frame.inputChecked) {
        frame.inputChecked = true;
        const paused = this.#guardrailText('input', frame, memoryKey, true);
        if (paused !== undefined) return paused;
      }

      const request = this.#request(frame);
      const routed = this.#route(frame, request, budget);
      const generation = await this.#generate(agent, routed.alias, request, budget);
      frame.step += 1;
      const record: StepDraft = {
        index: frame.step,
        agentId: agent.id,
        kind: 'answer',
        alias: generation.alias,
        model: generation.response.model,
        costUsd: generation.costUsd,
        totalTokens: generation.usage.totalTokens,
        toolNames: [],
        target: undefined,
        degradedFrom: routed.degradedFrom,
      };
      frame.steps.push(record);
      const response = generation.response;

      if (response.toolCalls.length === 0) {
        const guarded = this.#guardrailAnswer(frame, response.text, memoryKey);
        if (typeof guarded !== 'string') return guarded;
        frame.messages.push(Message.assistant(guarded));
        await this.#remember(agent, guarded, memoryKey);
        return this.#outcome('completed', frame, guarded);
      }

      const control = this.#controlCall(response.toolCalls);
      if (control !== undefined) {
        const moved = await this.#control(frame, record, control, response, {
          ...(budget === undefined ? {} : { budget }),
          principal,
          memoryKey,
        });
        if (moved !== undefined) return moved;
        continue;
      }

      record.kind = 'tools';
      record.toolNames = response.toolCalls.map((call) => call.name);
      const guardResult = this.#guardrailToolCalls(frame, response.toolCalls, memoryKey);
      if (guardResult.paused !== undefined) return guardResult.paused;
      frame.messages.push(Message.assistantToolCalls(response.text, guardResult.calls));
      if (this.#needsApproval(agent, guardResult.calls, principal)) {
        const checkpoint = this.#checkpoint(frame, guardResult.calls, memoryKey);
        return outcomeOf({
          status: 'paused',
          agentId: agent.id,
          steps: frame.steps,
          path: frame.path,
          checkpoint,
          guardrails: frame.guardrails,
        });
      }

      frame.messages.push(...(await this.#observe(agent, guardResult.calls, principal)));
    }
  }

  /**
   * Run a whole-transcript stage (`input`) and apply its action.
   *
   * `rewrite` is what `redact` does here: the last user message is replaced with the masked
   * text *in place*, so the model is called on the redacted turn rather than on the original
   * with a note attached.
   */
  #guardrailText(
    stage: string,
    frame: Frame,
    memoryKey: string,
    rewrite: boolean,
  ): Outcome | undefined {
    const index = lastUserIndex(frame.messages);
    const text = index === undefined ? '' : (frame.messages[index]?.content ?? '');
    const verdict = this.#guardrails.checkInput(stageGuardrails(frame.agent, stage), text);
    this.#recordGuardrails(frame, verdict);
    const deciding = verdict.deciding;
    if (verdict.action === ACTION_BLOCK && deciding !== undefined) {
      throw new GuardrailBlockedError(deciding.guardrail, stage, deciding.message);
    }
    if (verdict.action === ACTION_ESCALATE) {
      return this.#guardrailPause(frame, verdict, memoryKey, [], '');
    }
    if (rewrite && verdict.action === ACTION_REDACT && index !== undefined) {
      frame.messages[index] = Message.user(verdict.text);
    }
    return undefined;
  }

  /**
   * Run the `output` stage over an answer, returning the text to ship.
   *
   * An `Outcome` means the answer is held: an escalation paused the run and the checkpoint
   * carries the text, so approving it releases this exact answer without paying for a second
   * generation.
   */
  #guardrailAnswer(frame: Frame, text: string, memoryKey: string): string | Outcome {
    const verdict = this.#guardrails.checkOutput(
      stageGuardrails(frame.agent, GUARDRAIL_OUTPUT),
      text,
    );
    this.#recordGuardrails(frame, verdict);
    const deciding = verdict.deciding;
    if (verdict.action === ACTION_BLOCK && deciding !== undefined) {
      throw new GuardrailBlockedError(deciding.guardrail, GUARDRAIL_OUTPUT, deciding.message);
    }
    if (verdict.action === ACTION_ESCALATE) {
      return this.#guardrailPause(frame, verdict, memoryKey, [], text);
    }
    return verdict.action === ACTION_REDACT ? verdict.text : text;
  }

  /**
   * Run the `tool-call` stage over every call in one step.
   *
   * The guardrail scopes on tool *ids*, so each model name is resolved through the IR before
   * the engine sees it. A name the IR does not declare keeps its own spelling as the scope
   * key -- it will be refused later for a different reason, and mapping it to some other
   * tool's id would let a guardrail scoped to one tool decide about another.
   */
  #guardrailToolCalls(
    frame: Frame,
    calls: readonly ToolCall[],
    memoryKey: string,
  ): { calls: readonly ToolCall[]; paused: Outcome | undefined } {
    const guarded: ToolCall[] = [];
    let escalation: GuardrailVerdict | undefined;
    for (const original of calls) {
      let call = original;
      const definition = this.#toolsByName.get(call.name);
      const toolId = definition !== undefined ? definition.id : call.name;
      const verdict = this.#guardrails.checkToolCall(
        stageGuardrails(frame.agent, GUARDRAIL_TOOL),
        toolId,
        call.args,
      );
      this.#recordGuardrails(frame, verdict);
      const deciding = verdict.deciding;
      if (verdict.action === ACTION_BLOCK && deciding !== undefined) {
        throw new GuardrailBlockedError(deciding.guardrail, GUARDRAIL_TOOL, deciding.message);
      }
      if (verdict.action === ACTION_ESCALATE && escalation === undefined) escalation = verdict;
      if (verdict.action === ACTION_REDACT) {
        call = new ToolCall({ id: call.id, name: call.name, arguments: { ...verdict.arguments } });
      }
      guarded.push(call);
    }
    if (escalation !== undefined) {
      return {
        calls: guarded,
        paused: this.#guardrailPause(frame, escalation, memoryKey, guarded, ''),
      };
    }
    return { calls: guarded, paused: undefined };
  }

  /** Record what fired. Every record reaches the result, not only the deciding one. */
  #recordGuardrails(frame: Frame, verdict: GuardrailVerdict): void {
    frame.guardrails.push(...verdict.records);
  }

  /** Enter HITL for an `escalate`. A pause, never a failure. */
  #guardrailPause(
    frame: Frame,
    verdict: GuardrailVerdict,
    memoryKey: string,
    calls: readonly ToolCall[],
    text: string,
  ): Outcome {
    const deciding = verdict.deciding;
    if (deciding === undefined) {
      throw new ConfigurationError(
        'a guardrail verdict with no deciding record cannot be escalated',
      );
    }
    const approval = frame.agent.approval;
    const escalation: GuardrailEscalation = {
      guardrail: deciding.guardrail,
      stage: verdict.stage,
      message: deciding.message,
      channel: approval === undefined ? GUARDRAIL_CHANNEL : approval.channel,
      text,
    };
    const checkpoint = this.#checkpoint(frame, calls, memoryKey, escalation);
    return outcomeOf({
      status: 'paused',
      agentId: frame.agent.id,
      steps: frame.steps,
      path: frame.path,
      checkpoint,
      guardrails: frame.guardrails,
    });
  }

  /** Act on a control call. `undefined` means the caller keeps control. */
  async #control(
    frame: Frame,
    record: StepDraft,
    call: ToolCall,
    response: CompletionResponse,
    options: {
      readonly budget?: Budget;
      readonly principal: Principal;
      readonly memoryKey: string;
    },
  ): Promise<Outcome | undefined> {
    const transferring = call.name.startsWith(TRANSFER_PREFIX);
    const prefix = transferring ? TRANSFER_PREFIX : DELEGATE_PREFIX;
    const targetId = call.name.slice(prefix.length);
    const declared = transferring ? frame.agent.handoffs : frame.agent.delegates;
    if (!declared.includes(targetId)) {
      throw new ConfigurationError(
        `agent ${JSON.stringify(frame.agent.id)} called control tool ` +
          `${JSON.stringify(call.name)}, but does not declare it; declared handoffs ` +
          `${listRepr(frame.agent.handoffs)} and delegates ${listRepr(frame.agent.delegates)}`,
      );
    }
    if (frame.path.includes(targetId)) {
      throw new AgentTransferCycleError([...frame.path, targetId]);
    }
    const message = controlMessage(call, response);
    if (transferring) {
      record.kind = 'transfer';
      record.target = targetId;
      return this.#transfer(frame, targetId, message, options);
    }
    record.kind = 'delegate';
    record.target = targetId;
    return this.#delegate(frame, call, response, targetId, message, options);
  }

  /**
   * Move control to another agent. The caller does not come back.
   *
   * The target inherits the conversation -- every message except the caller's system prompt,
   * which is the caller's instructions and not the target's.
   */
  async #transfer(
    frame: Frame,
    targetId: string,
    message: string,
    options: { readonly principal: Principal; readonly memoryKey: string },
  ): Promise<Outcome> {
    const target = this.#spec.agent(targetId);
    frame.messages.push(Message.assistant(message));
    const history = frame.messages.filter((item) => item.role !== 'system');
    const targetFrame = await this.#open(
      target,
      [Message.system(this.#spec.systemPrompt(target)), ...history],
      { path: [...frame.path, target.id], memoryKey: options.memoryKey },
    );
    const outcome = await this.#drive(targetFrame, options);
    return {
      ...outcome,
      steps: [...frame.steps, ...outcome.steps],
      guardrails: [...frame.guardrails, ...outcome.guardrails],
      path: [...frame.path, target.id],
    };
  }

  /**
   * Lend control to another agent, then continue as the caller.
   *
   * The delegate's context is isolated: its own system prompt and the single message it was
   * handed. Nothing else of the caller's transcript is visible, which is what makes its
   * result one observation rather than a continuation.
   */
  async #delegate(
    frame: Frame,
    call: ToolCall,
    response: CompletionResponse,
    targetId: string,
    message: string,
    options: {
      readonly budget?: Budget;
      readonly principal: Principal;
      readonly memoryKey: string;
    },
  ): Promise<Outcome | undefined> {
    const target = this.#spec.agent(targetId);
    frame.messages.push(Message.assistantToolCalls(response.text, response.toolCalls));
    const delegateFrame = await this.#open(
      target,
      [Message.system(this.#spec.systemPrompt(target)), Message.user(message)],
      { path: [...frame.path, target.id], memoryKey: options.memoryKey },
    );
    const inner = await this.#drive(delegateFrame, options);
    if (inner.status === 'paused') {
      const caller = {
        ...this.#checkpoint(frame, [call], options.memoryKey),
        resumeKind: 'delegate' as const,
        channel: '',
      };
      return {
        ...inner,
        steps: [...frame.steps, ...inner.steps],
        guardrails: [...frame.guardrails, ...inner.guardrails],
        checkpoint: inner.checkpoint === undefined ? undefined : { ...inner.checkpoint, caller },
      };
    }
    if (inner.status !== 'completed') {
      // The delegate ran out of steps or budget, so it has no result to hand back; the
      // caller cannot borrow an answer that was never produced.
      return {
        ...inner,
        steps: [...frame.steps, ...inner.steps],
        guardrails: [...frame.guardrails, ...inner.guardrails],
      };
    }
    frame.steps.push(...inner.steps);
    frame.guardrails.push(...inner.guardrails);
    frame.messages.push(Message.tool(call.id, inner.answer, { name: call.name }));
    return this.#runLoop(frame, options);
  }

  /**
   * Turn calls into observations, in the order the model asked for them.
   *
   * A name this agent cannot call comes back as a tool error instead of raising: the model
   * composed the call, so the model is the party that can correct it, exactly as for bad
   * arguments. A missing *registration* is a different failure and is refused when the
   * runtime is built, where the application can fix it.
   *
   * Permission is the third case and it does raise, before any handler runs. The grant is the
   * agent's declared tool list, and a side-effecting tool additionally needs an `auth` policy
   * that holds for this principal. A model cannot repair either: the spec is what is wrong.
   */
  async #observe(
    agent: AgentDefinition,
    calls: readonly ToolCall[],
    principal: Principal,
  ): Promise<Message[]> {
    const registered = new Set(this.#executor.names());
    const known = calls.filter((call) => registered.has(call.name));
    for (const call of known) this.#authorize(agent, call, principal);
    const results = await this.#executor.executeAll(known);
    const executed = new Map(results.map((result) => [result.callId, result]));
    const observations: Message[] = [];
    for (const call of calls) {
      const result = executed.get(call.id);
      if (result === undefined) {
        observations.push(
          Message.tool(
            call.id,
            `error: this agent has no tool named ${JSON.stringify(call.name)}`,
            {
              name: call.name,
            },
          ),
        );
        continue;
      }
      observations.push(Message.tool(result.callId, result.content, { name: result.name }));
    }
    return observations;
  }

  /**
   * Refuse a call this agent may not make, before the handler body runs.
   *
   * Deny by default, in three steps:
   *
   * 1. the agent must declare the tool -- the IR's `tools` is the grant, and an undeclared
   *    tool is refused even when the runtime has it registered;
   * 2. a `write`/`destructive` tool must declare an `auth` policy, because a side effect with
   *    no authorization is an accident waiting to be called;
   * 3. that policy is evaluated here, against *this* principal, not at build time -- `auth`
   *    is a question about the caller, and the caller is only known now.
   *
   * An undecidable policy is a denial. `PolicyEvaluationError` means the evaluator could not
   * answer, and "could not answer" must never render as "allowed".
   */
  #authorize(agent: AgentDefinition, call: ToolCall, principal: Principal): void {
    const granted = new Set(
      agent.tools.map(
        (toolId) => this.#requireTool(toolId, `agent ${JSON.stringify(agent.id)}`).name,
      ),
    );
    if (!granted.has(call.name)) {
      throw new ToolPermissionError(
        agent.id,
        call.name,
        'the agent does not declare it; the tool list is the grant, and there is no ' +
          'implicit wildcard',
      );
    }
    const definition = this.#toolsByName.get(call.name);
    if (definition === undefined) {
      throw new ToolPermissionError(
        agent.id,
        call.name,
        'it is registered on this runtime but not declared in the IR, so its side effects ' +
          'and auth policy are unknown',
      );
    }
    if (definition.auth !== undefined) {
      let allowed: boolean;
      try {
        allowed = evaluatePolicy(definition.auth, principal);
      } catch (error) {
        if (!(error instanceof PolicyEvaluationError)) throw error;
        throw new ToolPermissionError(
          agent.id,
          call.name,
          `its auth policy ${policySource(definition.auth)} could not be decided (${error.message})`,
        );
      }
      if (!allowed) {
        throw new ToolPermissionError(
          agent.id,
          call.name,
          `its auth policy ${policySource(definition.auth)} denies this principal`,
        );
      }
      return;
    }
    if (SIDE_EFFECTING.has(definition.sideEffects)) {
      throw new ToolPermissionError(
        agent.id,
        call.name,
        `it has sideEffects ${JSON.stringify(definition.sideEffects)} and declares no auth ` +
          'policy; a side effect with no authorization is denied by default',
      );
    }
  }

  #request(frame: Frame): CompletionRequest {
    let messages = [...frame.messages];
    if (frame.memory.thread !== undefined) messages = frame.memory.thread.trim(messages);
    if (frame.memory.context.length > 0) {
      const head = messages[0];
      const rest = messages.slice(1);
      if (head !== undefined) messages = [head, Message.system(frame.memory.context), ...rest];
    }
    return new CompletionRequest({ messages, tools: this.#toolDefinitions(frame.agent) });
  }

  #toolDefinitions(agent: AgentDefinition): ToolDefinition[] {
    const definitions = agent.tools.map((toolId) =>
      this.#executor.definition(
        this.#requireTool(toolId, `agent ${JSON.stringify(agent.id)}`).name,
      ),
    );
    for (const target of agent.handoffs)
      definitions.push(controlDefinition(TRANSFER_PREFIX, target));
    for (const target of agent.delegates)
      definitions.push(controlDefinition(DELEGATE_PREFIX, target));
    return definitions;
  }

  /**
   * Call the model, refusing a silent downgrade to one that cannot tool-call.
   *
   * The pinned model must advertise `tool-calling` when the agent has tools or control edges.
   * A gateway fallback is chosen for a provider failure without re-negotiating capabilities,
   * so the answer's alias is checked too: an agent that cannot call a tool would otherwise
   * answer from memory and look fine.
   *
   * The agent's ceiling goes to the gateway as the call's budget, so a breach is the
   * gateway's own `BudgetExceededError` -- hard failure by default, with no second accounting
   * path in the loop.
   */
  async #generate(
    agent: AgentDefinition,
    alias: string,
    request: CompletionRequest,
    budget: Budget | undefined,
  ): Promise<GenerationResult> {
    const required: readonly Capability[] =
      agent.tools.length > 0 || hasControlTools(agent) ? ['tool-calling'] : [];
    if (required.length > 0) this.#gateway.require(alias, required);
    const generation = await this.#gateway.generate(alias, request, {
      fallbacks: this.#spec.fallbacksFor(alias),
      ...(budget === undefined ? {} : { budget }),
    });
    if (required.length > 0) {
      const resolved = this.#gateway.resolve(generation.alias).model;
      if (!required.every((capability) => resolved.capabilities.has(capability))) {
        throw new CapabilityMismatchError(generation.alias, required);
      }
    }
    return generation;
  }

  /** Pick the alias for this call, stepping down the ladder at most once. */
  #route(
    frame: Frame,
    request: CompletionRequest,
    budget: Budget | undefined,
  ): { alias: string; degradedFrom: string | undefined } {
    const agent = frame.agent;
    if (agent.onBudgetExhausted !== DEGRADE || frame.degraded) {
      return { alias: frame.alias, degradedFrom: undefined };
    }
    // Degrade steps down a *price* ladder, so it needs a dollar ceiling to step down from. A
    // token-only ceiling cannot be made affordable by switching alias, and the gate refuses
    // degrade without maxCostBudget, so there is nothing to route here. Returning keeps that
    // hard failure with the ledger.
    if (budget === undefined || budget.maxUsd === undefined) {
      return { alias: frame.alias, degradedFrom: undefined };
    }
    if (this.#gateway.fits(frame.alias, request, budget)) {
      return { alias: frame.alias, degradedFrom: undefined };
    }
    const cheaper = this.#spec.cheaperFallback(frame.alias);
    if (cheaper === undefined) {
      throw new AgentBudgetDegradedError(
        `agent ${JSON.stringify(agent.id)} declares onBudgetExhausted: degrade, but alias ` +
          `${JSON.stringify(frame.alias)} declares no cheaper fallback; ` +
          'ir/agents-budget-degrade rejects this at build time, so this IR did not come ' +
          'through the gate',
      );
    }
    if (!this.#gateway.fits(cheaper, request, budget)) {
      // One rung was available and is still too dear: the budget is exhausted.
      throw new BudgetExceededError(budget.scope, budget.maxUsd, this.#gateway.ledger.costUsd);
    }
    const previous = frame.alias;
    frame.alias = cheaper;
    frame.degraded = true;
    return { alias: cheaper, degradedFrom: previous };
  }

  /**
   * The agent's ceiling, expressed as absolute spend for one ledger.
   *
   * The ledger is shared by the whole run, so a per-agent ceiling is anchored at the spend
   * the agent started from. That keeps a single accounting path instead of a second ledger
   * per agent, and it is what lets a cheaper alias make the *same* ceiling affordable again.
   */
  #budgetFor(frame: Frame): Budget | undefined {
    const agent = frame.agent;
    if (agent.maxCostBudget === undefined && agent.maxTokensBudget === undefined) return undefined;
    return new Budget({
      ...(agent.maxCostBudget === undefined
        ? {}
        : { maxUsd: round6(frame.costAnchor + agent.maxCostBudget) }),
      ...(agent.maxTokensBudget === undefined
        ? {}
        : { maxTotalTokens: frame.tokenAnchor + agent.maxTokensBudget }),
      scope: `agent:${agent.id}`,
    });
  }

  #controlCall(calls: readonly ToolCall[]): ToolCall | undefined {
    const controls = calls.filter(
      (call) => call.name.startsWith(TRANSFER_PREFIX) || call.name.startsWith(DELEGATE_PREFIX),
    );
    if (controls.length === 0) return undefined;
    if (calls.length > 1) {
      throw new ConfigurationError(
        'a control call must be the only call in its step, because it changes who owns the ' +
          `rest of the turn; got ${listRepr(calls.map((call) => call.name))}`,
      );
    }
    return controls[0];
  }

  /**
   * Whether a person must answer before these calls run.
   *
   * Two triggers, both from the IR: the tool declares `requiresConfirmation`, or the agent's
   * `humanInTheLoop.when` policy holds for this principal. The policy is evaluated against
   * the caller, never against a step counter, which is why a pause cannot fire on "step 3"
   * unless the IR's policy says so.
   */
  #needsApproval(
    agent: AgentDefinition,
    calls: readonly ToolCall[],
    principal: Principal,
  ): boolean {
    for (const call of calls) {
      if (this.#toolsByName.get(call.name)?.requiresConfirmation === true) return true;
    }
    return agent.approval !== undefined && evaluatePolicy(agent.approval.when, principal);
  }

  #checkpoint(
    frame: Frame,
    calls: readonly ToolCall[],
    memoryKey: string,
    escalation?: GuardrailEscalation,
  ): AgentCheckpoint {
    const approval = frame.agent.approval;
    let channel: string;
    if (escalation !== undefined) channel = escalation.channel;
    else if (approval !== undefined) channel = approval.channel;
    else channel = TOOL_CONFIRMATION;
    return {
      agentId: frame.agent.id,
      step: frame.step,
      messages: [...frame.messages],
      steps: [...frame.steps],
      calls: [...calls],
      channel,
      when: approval === undefined ? {} : { ...approval.when },
      resumeKind: 'approve',
      costAnchorUsd: frame.costAnchor,
      tokenAnchor: frame.tokenAnchor,
      spentUsd: this.#gateway.ledger.costUsd,
      spentTokens: this.#gateway.ledger.totalTokens,
      degraded: frame.degraded,
      alias: frame.alias,
      path: frame.path,
      memoryKey,
      caller: undefined,
      escalation,
      guardrails: [...frame.guardrails],
    };
  }

  /**
   * Carry a pause's spend into this process's ledger before resuming.
   *
   * A resume in a fresh process starts with an empty ledger, which would hand the agent a
   * ceiling it has already partly spent. The restored amount is a real ledger entry under a
   * distinct alias, so the spend stays auditable instead of becoming a number the loop
   * quietly remembers.
   */
  #restoreLedger(checkpoint: AgentCheckpoint): void {
    const ledger = this.#gateway.ledger;
    const missingUsd = round6(checkpoint.spentUsd - ledger.costUsd);
    const missingTokens = checkpoint.spentTokens - ledger.totalTokens;
    if (missingUsd <= 0 && missingTokens <= 0) return;
    ledger.charge(
      undefined,
      new LedgerEntry({
        alias: RESTORED_ALIAS,
        model: RESTORED_ALIAS,
        provider: RESTORED_ALIAS,
        usage: new TokenUsage({ inputTokens: Math.max(missingTokens, 0), outputTokens: 0 }),
        costUsd: Math.max(missingUsd, 0),
      }),
    );
  }

  async #open(
    agent: AgentDefinition,
    messages: readonly Message[],
    options: { readonly path: readonly string[]; readonly memoryKey: string },
  ): Promise<Frame> {
    checkEngine(agent);
    const memory = await this.#memoryState(agent, options.memoryKey);
    const ledger = this.#gateway.ledger;
    return {
      agent,
      messages: [...messages],
      alias: agent.model,
      path: options.path,
      step: 0,
      degraded: false,
      memory,
      memoryKey: options.memoryKey,
      costAnchor: ledger.costUsd,
      tokenAnchor: ledger.totalTokens,
      steps: [],
      resumedDecision: undefined,
      resumedChannel: '',
      inputChecked: false,
      guardrails: [],
    };
  }

  async #frameFrom(checkpoint: AgentCheckpoint): Promise<Frame> {
    const agent = this.#spec.agent(checkpoint.agentId);
    const memory = await this.#memoryState(agent, checkpoint.memoryKey);
    return {
      agent,
      messages: [...checkpoint.messages],
      alias: checkpoint.alias.length > 0 ? checkpoint.alias : agent.model,
      path: checkpoint.path,
      step: checkpoint.step,
      degraded: checkpoint.degraded,
      memory,
      memoryKey: checkpoint.memoryKey,
      costAnchor: checkpoint.costAnchorUsd,
      tokenAnchor: checkpoint.tokenAnchor,
      steps: [...checkpoint.steps],
      resumedDecision: undefined,
      resumedChannel: '',
      // A checkpoint exists only after the input stage ran, so a resumed frame must not
      // re-check the message it already passed -- and must not re-apply a redaction to text
      // that is already masked.
      inputChecked: true,
      guardrails: [...checkpoint.guardrails],
    };
  }

  async #memoryState(agent: AgentDefinition, memoryKey: string): Promise<MemoryState> {
    let thread: ThreadMemory | undefined;
    const blocks: string[] = [];
    const scopes: string[] = [];
    let entries = 0;
    let tokens = 0;
    for (const definition of agent.memory) {
      checkMemorySupported({
        memoryId: definition.id,
        kind: definition.kind,
        summarizeModel: definition.summarizeModel,
        ttl: definition.ttl,
        redact: definition.redact,
      });
      scopes.push(definition.scope);
      if (definition.scope === THREAD) {
        if (thread === undefined || definition.tokenBudget < budgetOf(thread)) {
          thread = new ThreadMemory(definition.tokenBudget);
        }
        continue;
      }
      const values = await this.#storeFor(definition).read({
        scope: definition.scope,
        key: storageKey(definition, memoryKey),
      });
      const rendered = renderContext(values, definition.tokenBudget);
      if (rendered.text.length > 0) blocks.push(`[${definition.id}]\n${rendered.text}`);
      entries += values.length;
      tokens += rendered.tokens;
    }
    return {
      thread,
      context: blocks.join('\n\n'),
      scopes,
      entries,
      tokens,
    };
  }

  /** Record the answer in every memory that outlives the run. */
  async #remember(agent: AgentDefinition, answer: string, memoryKey: string): Promise<void> {
    if (answer.length === 0) return;
    for (const definition of agent.memory) {
      if (definition.scope === THREAD) continue;
      await this.#storeFor(definition).append({
        scope: definition.scope,
        key: storageKey(definition, memoryKey),
        value: answer,
      });
    }
  }

  #storeFor(definition: MemoryDefinition): MemoryStore {
    const backend = definition.backend;
    if (backend === undefined || backend === IN_PROCESS) return this.#defaultStore;
    const store = this.#stores.get(backend);
    if (store === undefined) {
      const registered = [...this.#stores.keys()].sort();
      throw new ConfigurationError(
        `memory ${JSON.stringify(definition.id)} names backend ` +
          `${JSON.stringify(backend)}, which is not registered here; registered stores: ` +
          `${registered.length === 0 ? '<none>' : listRepr(registered)}`,
      );
    }
    return store;
  }

  #checkDeclarations(): void {
    const registered = new Set(this.#executor.names());
    for (const agent of this.#spec.agents.values()) {
      const declared = new Set(
        agent.tools.map(
          (toolId) => this.#requireTool(toolId, `agent ${JSON.stringify(agent.id)}`).name,
        ),
      );
      const missing = [...declared].filter((name) => !registered.has(name)).sort();
      if (missing.length > 0) {
        throw new ConfigurationError(
          `agent ${JSON.stringify(agent.id)} declares tools that are not registered on this ` +
            `runtime: ${listRepr(missing)}; registered tools: ${listRepr([...registered].sort())}`,
        );
      }
      const control = new Set([
        ...agent.handoffs.map((target) => TRANSFER_PREFIX + target),
        ...agent.delegates.map((target) => DELEGATE_PREFIX + target),
      ]);
      const shadowed = [...control].filter((name) => declared.has(name)).sort();
      if (shadowed.length > 0) {
        throw new ConfigurationError(
          `agent ${JSON.stringify(agent.id)} declares a tool named like a control tool ` +
            `(${listRepr(shadowed)}); transfer and delegation would be silently shadowed`,
        );
      }
    }
  }

  #outcome(status: RunStatus, frame: Frame, answer = ''): Outcome {
    return outcomeOf({
      status,
      agentId: frame.agent.id,
      answer,
      steps: frame.steps,
      path: frame.path,
      guardrails: frame.guardrails,
    });
  }

  #wrap(outcome: Outcome, startCost: number, startTokens: number): RunResult {
    const ledger = this.#gateway.ledger;
    return new RunResult({
      status: outcome.status,
      agentId: outcome.agentId,
      answer: outcome.answer,
      steps: outcome.steps,
      path: outcome.path,
      costUsd: round6(Math.max(ledger.costUsd - startCost, 0)),
      totalTokens: Math.max(ledger.totalTokens - startTokens, 0),
      ...(outcome.checkpoint === undefined ? {} : { checkpoint: outcome.checkpoint }),
      guardrails: outcome.guardrails,
    });
  }

  /** One IR tool id, resolved or refused by name. */
  #requireTool(toolId: string, where: string): ToolSpec {
    const definition = this.#spec.tools.get(toolId);
    if (definition === undefined) {
      throw new ConfigurationError(
        `${where} names tool ${JSON.stringify(toolId)}, which is not in the IR`,
      );
    }
    return definition;
  }
}

function budgetOf(thread: ThreadMemory): number {
  return thread.tokenBudget ?? 0;
}

/** The turn the input stage guards: the most recent user message. */
function lastUserIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return undefined;
}

/** Global scope is shared by every caller; user scope is per key. */
function storageKey(definition: MemoryDefinition, memoryKey: string): string {
  if (definition.scope === GLOBAL) return definition.id;
  return `${memoryKey}:${definition.id}`;
}

function controlMessage(call: ToolCall, response: CompletionResponse): string {
  const raw = call.args[CONTROL_ARGUMENT];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return response.text.length > 0 ? response.text : `control passed to ${call.name}`;
}

function controlDefinition(prefix: string, target: string): ToolDefinition {
  const transferring = prefix === TRANSFER_PREFIX;
  const description = transferring
    ? `Transfer the conversation to agent ${JSON.stringify(target)}. Control moves: you will ` +
      'not answer again, and the other agent produces the final answer.'
    : `Delegate a self-contained task to agent ${JSON.stringify(target)}. Control returns to ` +
      'you with its result as an observation; you still produce the final answer.';
  return new ToolDefinition({
    name: `${prefix}${target}`,
    description,
    parameters: {
      type: 'object',
      properties: {
        [CONTROL_ARGUMENT]: {
          type: 'string',
          description: transferring
            ? 'Where to take the conversation from here.'
            : 'The whole task; the other agent cannot see this conversation.',
        },
      },
      required: [CONTROL_ARGUMENT],
      additionalProperties: false,
    },
  });
}

/** `['a', 'b']`, the shape Python's `{list(...)}` puts in a diagnostic. */
function listRepr(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}
