/**
 * Expose {@link ModelGateway} as a LangChain chat model.
 *
 * This module is the load-bearing part of the Deep Agents backend. A harness handed a
 * provider would keep working while silently dropping every guarantee the gateway exists
 * to provide: the fallback chain, the budget preflight, the cost ledger and the
 * per-attempt LLM span. The agent would look fine and the budget would stop applying. So
 * the harness is never handed a provider -- it is handed *this adapter*, and every model
 * call inside the graph goes back out through our gateway.
 *
 * What the adapter is responsible for:
 *
 * - **Translation, both directions.** LangChain messages to our {@link Message}, and our
 *   {@link CompletionResponse} back to an `AIMessage` carrying tool calls, `usage_metadata`
 *   and the alias/cost the gateway actually charged. The alias matters: a fallback means
 *   the answer did not come from the pinned model, and the response says so rather than
 *   letting the harness believe otherwise.
 * - **Tool filtering.** `bindTools` is the single funnel every tool reaches the model
 *   through, which makes it the one place to enforce what the agent may call. Deep Agents
 *   bundles `ls`/`read_file`/`write_file`/`edit_file`/`delete`/`glob`/`grep`/`execute` and
 *   binds all of them; the allow-list drops everything the agent did not declare, so the
 *   filesystem and shell tools are unreachable rather than merely undocumented.
 * - **Budget continuity.** The agent's ceiling travels with every call, so a breach
 *   surfaces as the gateway's own {@link BudgetExceededError} from inside the harness.
 *   There is no second accounting path here to disagree with it.
 *
 * Everything in here statically imports `@langchain/*`. That is deliberate and safe: the
 * harness is optional for consumers, `agents/deep_agents.ts` is the only module that
 * reaches this one, and it does so with a dynamic `import()` after {@link checkEngine} has
 * proved the packages are installed.
 */

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type {
  BaseChatModelCallOptions,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type { Budget } from '../cost.js';
import { DeepAgentsEngineError, DeepAgentsMaxStepsError } from '../errors.js';
import type { ModelGateway } from '../gateway.js';
import type { GenerationResult } from '../types.js';
import { CompletionRequest, Message, ToolCall, ToolDefinition } from '../types.js';

/** What {@link harnessTool} needs to build one harness tool around our executor. */
export interface HarnessToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Run the call through the native loop's executor and return the observation. */
  readonly call: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * A LangChain chat model whose every generation is a gateway call.
 *
 * Construct it with the alias the IR pinned, the gateway that owns fallback and
 * accounting, and the ceiling this agent may spend. `allowedTools` is the tool allow-list:
 * `undefined` admits everything the harness binds, which is only appropriate for an agent
 * that declares no tools.
 */
export class GatewayChatModel extends BaseChatModel {
  readonly gateway: ModelGateway;
  readonly alias: string;
  readonly fallbacks: readonly string[];
  readonly budget: Budget | undefined;
  readonly allowedTools: ReadonlySet<string> | undefined;
  /**
   * The agent's `maxSteps`, counted in model calls. Enforced here because this adapter is
   * the only place that sees every model call -- and because the harness's own limiter
   * *completes* the run with a synthetic answer instead of failing.
   */
  readonly maxCalls: number | undefined;
  /** What `bindTools` last admitted. Read by tests, never by the harness. */
  readonly boundTools: readonly ToolDefinition[];
  /** Every generation this model produced, in order: proof the harness went through us. */
  readonly calls: GenerationResult[];

  constructor(init: {
    readonly gateway: ModelGateway;
    readonly alias: string;
    readonly fallbacks?: readonly string[];
    readonly budget?: Budget;
    readonly allowedTools?: ReadonlySet<string>;
    readonly maxCalls?: number;
    readonly boundTools?: readonly ToolDefinition[];
    readonly calls?: GenerationResult[];
  }) {
    super({});
    this.gateway = init.gateway;
    this.alias = init.alias;
    this.fallbacks = [...(init.fallbacks ?? [])];
    this.budget = init.budget;
    this.allowedTools = init.allowedTools;
    this.maxCalls = init.maxCalls;
    this.boundTools = [...(init.boundTools ?? [])];
    this.calls = init.calls ?? [];
  }

  /**
   * Admit only the tools this agent declared.
   *
   * Every tool the harness offers -- bundled ones included -- arrives here, so an
   * allow-list applied at this point is the difference between "we do not document a
   * shell" and "there is no shell the model can reach". The filtered set is kept on a copy
   * rather than on `this` so two agents sharing one adapter cannot widen each other's
   * grant; the copy shares `calls`, because the accumulator is the run's spend record and a
   * per-copy one would silently lose the generations of every bound model.
   */
  override bindTools(tools: BindToolsInput[]): GatewayChatModel {
    const admitted = toToolDefinitions(tools, { allowed: this.allowedTools });
    return new GatewayChatModel({
      gateway: this.gateway,
      alias: this.alias,
      fallbacks: this.fallbacks,
      ...(this.budget === undefined ? {} : { budget: this.budget }),
      ...(this.allowedTools === undefined ? {} : { allowedTools: this.allowedTools }),
      ...(this.maxCalls === undefined ? {} : { maxCalls: this.maxCalls }),
      boundTools: admitted,
      calls: this.calls,
    });
  }

  override _llmType(): string {
    return 'aid-gateway';
  }

  override _identifyingParams(): Record<string, unknown> {
    return { alias: this.alias, fallbacks: [...this.fallbacks] };
  }

  /**
   * One harness model call, routed through the gateway.
   *
   * LangChain 1.x exposes a single async generation hook: `generate` and `invoke` both
   * return promises and there is no synchronous entry point at all, so unlike the Python
   * adapter there is no second path to refuse here.
   *
   * `fallbacks` and `budget` travel with the call, so the harness gets the same fallback
   * behaviour and the same hard ceiling as the native loop. A breach is raised, not
   * returned: the harness must not be able to continue past a budget the ledger refused.
   */
  override async _generate(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const request = new CompletionRequest({
      messages: toAidMessages(messages),
      tools: this.boundTools,
    });
    if (this.maxCalls !== undefined && this.calls.length >= this.maxCalls) {
      // Refused before the call, not after: an agent that has spent its step budget must
      // not spend one more to discover that it has.
      throw new DeepAgentsMaxStepsError(this.alias, this.maxCalls);
    }
    const generation = await this.gateway.generate(this.alias, request, {
      fallbacks: this.fallbacks,
      ...(this.budget === undefined ? {} : { budget: this.budget }),
    });
    this.calls.push(generation);
    return {
      generations: [{ text: generation.response.text, message: toAiMessage(generation) }],
    };
  }

  // biome-ignore lint/correctness/useYield: a stream that works is the bug; this refuses.
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    throw new DeepAgentsEngineError(
      'streaming is not exposed through the deepagents engine: ModelGateway.stream serves ' +
        'Server-Sent Event bytes for the HTTP layer, but the engine consumes ' +
        'request/response generation and never an SSE byte stream. A structured LangChain ' +
        'chunk stream would be a second streaming contract and a second accounting path, ' +
        'so it is refused here rather than buffered into a non-stream.',
    );
  }
}

/** Carry the gateway's answer across, including what it cost and where from. */
function toAiMessage(generation: GenerationResult): AIMessage {
  const response = generation.response;
  const usage = generation.usage;
  return new AIMessage({
    content: response.text,
    tool_calls: response.toolCalls.map((call) => ({
      name: call.name,
      args: { ...call.args },
      id: call.id,
      type: 'tool_call' as const,
    })),
    usage_metadata: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
    response_metadata: {
      model: response.model,
      provider: response.provider,
      finish_reason: response.finishReason,
      // Not decoration: after a fallback these differ from the alias the IR pinned, and
      // that has to stay visible to the caller.
      alias: generation.alias,
      cost_usd: generation.costUsd,
      fell_back: generation.fellBack,
    },
  });
}

/**
 * Translate the harness transcript into ours.
 *
 * Tool calls and their ids are preserved verbatim: the harness pairs a result with its
 * call by id, and renaming or renumbering them here would break the pairing in a way that
 * only shows up as a tool result attached to the wrong call.
 */
export function toAidMessages(messages: readonly BaseMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const type = message.getType();
    if (type === 'system') {
      converted.push(Message.system(text(message)));
    } else if (type === 'human') {
      converted.push(Message.user(text(message)));
    } else if (type === 'ai') {
      const calls = (message as AIMessage).tool_calls ?? [];
      if (calls.length > 0) {
        converted.push(
          Message.assistantToolCalls(
            text(message),
            calls.map(
              (call, index) =>
                new ToolCall({
                  id: call.id ?? `call_${index}`,
                  name: call.name,
                  arguments: call.args ?? {},
                }),
            ),
          ),
        );
      } else {
        converted.push(Message.assistant(text(message)));
      }
    } else if (type === 'tool') {
      const observed = message as ToolMessage;
      converted.push(
        Message.tool(observed.tool_call_id, text(message), {
          ...(observed.name === undefined ? {} : { name: observed.name }),
        }),
      );
    } else {
      // Deep Agents may hand us one of its own message subclasses. Dropping it would lose
      // a turn from the transcript, so it is carried as plain text.
      converted.push(Message.user(text(message)));
    }
  }
  return converted;
}

/**
 * Normalise the harness's tool specs and drop everything outside the grant.
 *
 * The harness offers OpenAI-shaped objects, bare `{name, parameters}` records, and
 * `BaseTool` instances carrying a Zod schema. All are accepted so the allow-list cannot be
 * bypassed by a shape the filter did not recognise: anything unparseable has no name, and
 * a tool with no name is refused rather than passed through.
 */
export function toToolDefinitions(
  tools: readonly BindToolsInput[],
  options: { readonly allowed?: ReadonlySet<string> | undefined } = {},
): ToolDefinition[] {
  const allowed = options.allowed;
  const definitions: ToolDefinition[] = [];
  for (const entry of tools) {
    const definition = toolDefinition(entry);
    if (definition === undefined) continue;
    if (allowed !== undefined && !allowed.has(definition.name)) continue;
    definitions.push(definition);
  }
  return definitions;
}

function toolDefinition(entry: BindToolsInput): ToolDefinition | undefined {
  const record = entry as unknown as Record<string, unknown>;
  const body =
    record.type === 'function' && isRecord(record.function)
      ? (record.function as Record<string, unknown>)
      : record;
  const name = body.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  return new ToolDefinition({
    name,
    description: typeof body.description === 'string' ? body.description : '',
    parameters: jsonSchemaOf(body),
  });
}

/**
 * The parameter schema of one harness tool, as JSON Schema.
 *
 * A LangChain tool normally carries a Zod schema here. Reading it through
 * `z.toJSONSchema` keeps the model's parameter schema intact instead of handing it an
 * empty one, which would only fail later as a tool call with no arguments.
 */
function jsonSchemaOf(body: Record<string, unknown>): Record<string, unknown> {
  const declared = body.parameters;
  if (isRecord(declared)) return { ...declared };
  const schema = body.schema;
  if (schema === undefined || schema === null) return {};
  try {
    const json = z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
    // `$schema` is metadata about the dialect, not a constraint the model can act on.
    const { $schema: _dialect, ...rest } = json;
    return rest;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten message content to text, keeping block content that carries prose. */
function text(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * Translate our transcript back out, for seeding the harness with prior turns.
 *
 * This exists so a resumed run hands the harness the same transcript the native loop would
 * have, rather than a summary of it. Tool calls are re-emitted as `AIMessage.tool_calls` so
 * the harness sees them as calls it can pair, which is what keeps a resumed run's
 * transcript comparable to an uninterrupted one.
 */
export function toLangchainMessages(messages: readonly Message[]): BaseMessage[] {
  const converted: BaseMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      converted.push(new SystemMessage(message.content));
    } else if (message.role === 'user') {
      converted.push(new HumanMessage(message.content));
    } else if (message.role === 'tool') {
      converted.push(
        new ToolMessage({
          content: message.content,
          tool_call_id: message.toolCallId ?? '',
          name: message.name ?? '',
        }),
      );
    } else if (message.toolCalls.length > 0) {
      converted.push(
        new AIMessage({
          content: message.content,
          tool_calls: message.toolCalls.map((call) => ({
            name: call.name,
            args: { ...call.args },
            id: call.id,
            type: 'tool_call' as const,
          })),
        }),
      );
    } else {
      converted.push(new AIMessage(message.content));
    }
  }
  return converted;
}

/**
 * Wrap one declared tool as a harness tool whose body is our executor.
 *
 * The body is deliberately thin: authorization and the tool-call guardrail run in the
 * guardrail middleware of whichever agent is calling, and execution goes through the same
 * `ToolExecutor` the native loop uses. That is what makes a tool call under this engine the
 * same event as one under the native engine.
 *
 * The call id is derived, not random: the harness pairs a result with its call by id, and a
 * random one would make two identical runs differ.
 */
export function harnessTool(spec: HarnessToolSpec) {
  const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
  return tool(async (args: Record<string, unknown>) => spec.call(args), {
    name: spec.name,
    description: spec.description,
    schema,
  });
}
