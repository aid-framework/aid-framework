import { Message, type Role, ToolCall } from '../types.js';
import type { GuardrailEscalation, GuardrailRecord } from './guardrails.js';

/**
 * The value types of a run: its steps, its result, and its pause.
 *
 * These live together because they are one shape: a checkpoint *is* a result that stopped
 * early, and a resumed result is a checkpoint plus more steps. Keeping them in one module
 * is also what lets `agents/loop` and a caller share the types without an import cycle.
 *
 * A checkpoint carries the steps completed so far, so a run that paused and resumed
 * reports the whole transcript of steps rather than only the part that happened after the
 * resume -- a trace that forgets the pre-pause steps is not a trace of the run.
 *
 * `caller` is the frame that was awaiting a *delegated* result when the pause happened
 * inside the delegate. Transfer has no caller to return to, which is the distinction the
 * loop is built on; a transfer checkpoint never has one.
 */

/** How a run ended. */
export type RunStatus = 'completed' | 'paused' | 'max-steps' | 'blocked';

/**
 * `PAUSED` is an outcome, not an error. So is `BLOCKED`: a human rejected an escalation
 * the guardrails raised, which is a decision the run respected rather than a failure it
 * suffered.
 */
export const RUN_STATUSES: readonly RunStatus[] = ['completed', 'paused', 'max-steps', 'blocked'];

/** What one model step did with its output. */
export type StepKind = 'answer' | 'tools' | 'transfer' | 'delegate';

export const STEP_KINDS: readonly StepKind[] = ['answer', 'tools', 'transfer', 'delegate'];

/**
 * One model call, and what was done with its output.
 *
 * `degradedFrom` is set only on the step that stepped down the alias ladder, so "did this
 * run degrade?" is a question the trace answers without arithmetic.
 */
export interface StepRecord {
  readonly index: number;
  readonly agentId: string;
  readonly kind: StepKind;
  readonly alias: string;
  readonly model: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly toolNames: readonly string[];
  readonly target: string | undefined;
  readonly degradedFrom: string | undefined;
}

/** What a human answered. Rejection is a normal answer, not an error. */
export type HumanDecision = 'approve' | 'reject';

/** Everything a paused agent needs to continue, and nothing that is derived. */
export interface AgentCheckpoint {
  readonly agentId: string;
  readonly step: number;
  readonly messages: readonly Message[];
  readonly steps: readonly StepRecord[];
  readonly calls: readonly ToolCall[];
  readonly channel: string;
  readonly when: Readonly<Record<string, unknown>>;
  /**
   * `approve`: `calls` are awaiting a person. `delegate`: `calls` holds the one control
   * call whose delegate paused, and the resumed frame must append the delegate's answer
   * rather than execute anything.
   */
  readonly resumeKind: 'approve' | 'delegate';
  readonly costAnchorUsd: number;
  readonly tokenAnchor: number;
  readonly spentUsd: number;
  readonly spentTokens: number;
  readonly degraded: boolean;
  /**
   * The alias the paused frame was actually calling. A resumed run has to keep it:
   * `degraded` records that this run already stepped down, and resuming on the dear alias
   * would silently undo a bounded decision the trace still shows.
   */
  readonly alias: string;
  readonly path: readonly string[];
  readonly memoryKey: string;
  readonly caller: AgentCheckpoint | undefined;
  /**
   * Set when a guardrail escalated. Its `stage` tells the resume path what to do: an
   * `input` escalation has already been checked, an `output` one holds the answer to
   * release on approval, a `tool-call` one holds `calls` to execute.
   */
  readonly escalation: GuardrailEscalation | undefined;
  readonly guardrails: readonly GuardrailRecord[];
}

/** The question a pause is asking, separated from the resume state. */
export interface PendingApproval {
  readonly agentId: string;
  readonly channel: string;
  readonly step: number;
  readonly calls: readonly ToolCall[];
  readonly when: Readonly<Record<string, unknown>>;
  readonly path: readonly string[];
  readonly escalation: GuardrailEscalation | undefined;
}

export function pendingApprovalFrom(checkpoint: AgentCheckpoint): PendingApproval {
  return {
    agentId: checkpoint.agentId,
    channel: checkpoint.channel,
    step: checkpoint.step,
    calls: checkpoint.calls,
    when: checkpoint.when,
    path: checkpoint.path,
    escalation: checkpoint.escalation,
  };
}

/** What a run produced -- including when it produced no answer. */
export class RunResult {
  readonly status: RunStatus;
  readonly agentId: string;
  readonly answer: string;
  readonly steps: readonly StepRecord[];
  readonly path: readonly string[];
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly checkpoint: AgentCheckpoint | undefined;
  readonly guardrails: readonly GuardrailRecord[];

  constructor(init: {
    readonly status: RunStatus;
    readonly agentId: string;
    readonly answer?: string;
    readonly steps?: readonly StepRecord[];
    readonly path?: readonly string[];
    readonly costUsd?: number;
    readonly totalTokens?: number;
    readonly checkpoint?: AgentCheckpoint;
    readonly guardrails?: readonly GuardrailRecord[];
  }) {
    this.status = init.status;
    this.agentId = init.agentId;
    this.answer = init.answer ?? '';
    this.steps = [...(init.steps ?? [])];
    this.path = [...(init.path ?? [])];
    this.costUsd = init.costUsd ?? 0;
    this.totalTokens = init.totalTokens ?? 0;
    this.checkpoint = init.checkpoint;
    this.guardrails = [...(init.guardrails ?? [])];
  }

  get completed(): boolean {
    return this.status === 'completed';
  }

  /** `(from, to)` for every step that stepped down the alias ladder. */
  get degraded(): readonly (readonly [string, string])[] {
    const pairs: (readonly [string, string])[] = [];
    for (const step of this.steps) {
      if (step.degradedFrom !== undefined) pairs.push([step.degradedFrom, step.alias]);
    }
    return pairs;
  }

  /** The question a paused run is asking, or `undefined` when it did not pause. */
  get approval(): PendingApproval | undefined {
    return this.checkpoint === undefined ? undefined : pendingApprovalFrom(this.checkpoint);
  }
}

// --- the wire form ---------------------------------------------------------------
//
// A checkpoint is the only thing a stateless `/resume` route holds a run open with, so it
// has to survive `JSON.stringify` -- which drops class prototypes. `Message` and
// `ToolCall` are classes here, so the codec rebuilds them on the way back rather than
// leaving callers with plain objects typed as class instances.
//
// The field names are the Python runtime's (`agent_id`, `resume_kind`, ...) rather than
// this runtime's camelCase, so a checkpoint written by one runtime resumes in the other.
// That is the property a shared route implementation depends on, and it costs one mapping
// function instead of a second wire vocabulary.

type Json = Record<string, unknown>;

function toolCallToJson(call: ToolCall): Json {
  return { id: call.id, name: call.name, arguments: { ...call.args } };
}

function toolCallFromJson(raw: Json): ToolCall {
  return new ToolCall({
    id: String(raw.id),
    name: String(raw.name),
    arguments: { ...((raw.arguments as Json) ?? {}) },
  });
}

function messageToJson(message: Message): Json {
  return {
    role: message.role,
    content: message.content,
    tool_calls: message.toolCalls.map(toolCallToJson),
    tool_call_id: message.toolCallId ?? null,
    name: message.name ?? null,
  };
}

function messageFromJson(raw: Json): Message {
  const toolCalls = ((raw.tool_calls as Json[] | null) ?? []).map(toolCallFromJson);
  const toolCallId = raw.tool_call_id as string | null;
  const name = raw.name as string | null;
  return new Message(String(raw.role) as Role, String(raw.content), {
    toolCalls,
    ...(toolCallId === null || toolCallId === undefined ? {} : { toolCallId }),
    ...(name === null || name === undefined ? {} : { name }),
  });
}

function stepToJson(step: StepRecord): Json {
  return {
    index: step.index,
    agent_id: step.agentId,
    kind: step.kind,
    alias: step.alias,
    model: step.model,
    cost_usd: step.costUsd,
    total_tokens: step.totalTokens,
    tool_names: [...step.toolNames],
    target: step.target ?? null,
    degraded_from: step.degradedFrom ?? null,
  };
}

function stepFromJson(raw: Json): StepRecord {
  return {
    index: Number(raw.index),
    agentId: String(raw.agent_id),
    kind: String(raw.kind) as StepKind,
    alias: String(raw.alias),
    model: String(raw.model),
    costUsd: Number(raw.cost_usd),
    totalTokens: Number(raw.total_tokens),
    toolNames: ((raw.tool_names as unknown[] | null) ?? []).map(String),
    target: (raw.target as string | null) ?? undefined,
    degradedFrom: (raw.degraded_from as string | null) ?? undefined,
  };
}

function recordToJson(record: GuardrailRecord): Json {
  return {
    guardrail: record.guardrail,
    stage: record.stage,
    action: record.action,
    policies: [...record.policies],
    message: record.message,
  };
}

function recordFromJson(raw: Json): GuardrailRecord {
  return {
    guardrail: String(raw.guardrail),
    stage: String(raw.stage) as GuardrailRecord['stage'],
    action: String(raw.action) as GuardrailRecord['action'],
    policies: ((raw.policies as unknown[] | null) ?? []).map(String),
    message: String(raw.message),
  };
}

function escalationToJson(escalation: GuardrailEscalation): Json {
  return {
    guardrail: escalation.guardrail,
    stage: escalation.stage,
    message: escalation.message,
    channel: escalation.channel,
    text: escalation.text,
  };
}

function escalationFromJson(raw: Json): GuardrailEscalation {
  return {
    guardrail: String(raw.guardrail),
    stage: String(raw.stage) as GuardrailEscalation['stage'],
    message: String(raw.message),
    channel: String(raw.channel ?? ''),
    text: String(raw.text ?? ''),
  };
}

export function checkpointToJson(checkpoint: AgentCheckpoint): Json {
  return {
    agent_id: checkpoint.agentId,
    step: checkpoint.step,
    messages: checkpoint.messages.map(messageToJson),
    steps: checkpoint.steps.map(stepToJson),
    calls: checkpoint.calls.map(toolCallToJson),
    channel: checkpoint.channel,
    when: { ...checkpoint.when },
    resume_kind: checkpoint.resumeKind,
    cost_anchor_usd: checkpoint.costAnchorUsd,
    token_anchor: checkpoint.tokenAnchor,
    spent_usd: checkpoint.spentUsd,
    spent_tokens: checkpoint.spentTokens,
    degraded: checkpoint.degraded,
    alias: checkpoint.alias,
    path: [...checkpoint.path],
    memory_key: checkpoint.memoryKey,
    caller: checkpoint.caller === undefined ? null : checkpointToJson(checkpoint.caller),
    escalation:
      checkpoint.escalation === undefined ? null : escalationToJson(checkpoint.escalation),
    guardrails: checkpoint.guardrails.map(recordToJson),
  };
}

export function checkpointFromJson(raw: Json): AgentCheckpoint {
  const caller = raw.caller as Json | null;
  const escalation = raw.escalation as Json | null;
  return {
    agentId: String(raw.agent_id),
    step: Number(raw.step),
    messages: ((raw.messages as Json[] | null) ?? []).map(messageFromJson),
    steps: ((raw.steps as Json[] | null) ?? []).map(stepFromJson),
    calls: ((raw.calls as Json[] | null) ?? []).map(toolCallFromJson),
    channel: String(raw.channel ?? ''),
    when: { ...((raw.when as Json | null) ?? {}) },
    resumeKind: (raw.resume_kind === 'delegate'
      ? 'delegate'
      : 'approve') as AgentCheckpoint['resumeKind'],
    costAnchorUsd: Number(raw.cost_anchor_usd),
    tokenAnchor: Number(raw.token_anchor),
    spentUsd: Number(raw.spent_usd),
    spentTokens: Number(raw.spent_tokens),
    degraded: Boolean(raw.degraded ?? false),
    alias: String(raw.alias ?? ''),
    path: ((raw.path as unknown[] | null) ?? []).map(String),
    memoryKey: String(raw.memory_key ?? ''),
    caller: caller === null || caller === undefined ? undefined : checkpointFromJson(caller),
    escalation:
      escalation === null || escalation === undefined ? undefined : escalationFromJson(escalation),
    guardrails: ((raw.guardrails as Json[] | null) ?? []).map(recordFromJson),
  };
}

/**
 * Whether two checkpoints are the same value.
 *
 * A round trip that only compares the JSON it wrote cannot notice a field the codec
 * dropped on both sides, so this compares the restored value to the original and asserts
 * the class instances came back as instances.
 */
export function checkpointsEqual(left: AgentCheckpoint, right: AgentCheckpoint): boolean {
  if (left === right) return true;
  if (left.messages.length !== right.messages.length) return false;
  if (left.calls.length !== right.calls.length) return false;
  if (left.steps.length !== right.steps.length) return false;
  if (left.guardrails.length !== right.guardrails.length) return false;
  for (const message of [...left.messages, ...right.messages]) {
    if (!(message instanceof Message)) return false;
  }
  for (const call of [...left.calls, ...right.calls]) {
    if (!(call instanceof ToolCall)) return false;
  }
  return sameJson(checkpointToJson(left), checkpointToJson(right));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left as Json).sort();
    const rightKeys = Object.keys(right as Json).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) => sameJson((left as Json)[key], (right as Json)[key]));
  }
  return false;
}
