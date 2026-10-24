/**
 * The value types every other module is written against.
 *
 * Two rules are enforced here rather than by convention. First, a `PinnedModel`
 * carries an alias *and* the exact model it resolves to, so nothing is resolved at
 * call time and a recorded baseline means what it says. Second, `TokenUsage` adds
 * component-wise, so merging the usage of a retried call is arithmetic rather than
 * an accounting decision each caller makes differently.
 */

import { canonicalJson, roundTo, sha256Hex } from './internal/json.js';

/** Who authored a message. */
export type Role = 'system' | 'user' | 'assistant';

/** Why a generation stopped. */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error';

/** What a model or adapter can do. */
export type Capability =
  | 'tool-calling'
  | 'structured-output'
  | 'streaming'
  | 'long-context'
  | 'embeddings'
  | 'rerank';

/** One prompt message. */
export class Message {
  readonly role: Role;
  readonly content: string;

  constructor(role: Role, content: string) {
    this.role = role;
    this.content = content;
  }

  static system(content: string): Message {
    return new Message('system', content);
  }

  static user(content: string): Message {
    return new Message('user', content);
  }

  static assistant(content: string): Message {
    return new Message('assistant', content);
  }

  toJSON(): { role: Role; content: string } {
    return { role: this.role, content: this.content };
  }
}

/** Token counts for one call. */
export class TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;

  constructor(init: { readonly inputTokens?: number; readonly outputTokens?: number } = {}) {
    const input = init.inputTokens ?? 0;
    const output = init.outputTokens ?? 0;
    if (!Number.isInteger(input) || input < 0) {
      throw new RangeError('inputTokens must be a non-negative integer');
    }
    if (!Number.isInteger(output) || output < 0) {
      throw new RangeError('outputTokens must be a non-negative integer');
    }
    this.inputTokens = input;
    this.outputTokens = output;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  /** Component-wise sum, so a retry chain is added rather than guessed at. */
  add(other: TokenUsage): TokenUsage {
    return new TokenUsage({
      inputTokens: this.inputTokens + other.inputTokens,
      outputTokens: this.outputTokens + other.outputTokens,
    });
  }

  toJSON(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}

/**
 * Published prices, quoted per **1,000 tokens**.
 *
 * Deliberately not interchangeable with
 * {@link import('./retrieval/types.js').EmbeddingCostProfile}, which quotes per
 * million tokens because the IR does.
 */
export class CostProfile {
  readonly inputPer1kUsd: number;
  readonly outputPer1kUsd: number;

  constructor(init: { readonly inputPer1kUsd: number; readonly outputPer1kUsd: number }) {
    for (const [label, value] of [
      ['inputPer1kUsd', init.inputPer1kUsd],
      ['outputPer1kUsd', init.outputPer1kUsd],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative number`);
      }
    }
    this.inputPer1kUsd = init.inputPer1kUsd;
    this.outputPer1kUsd = init.outputPer1kUsd;
  }

  /** The price of one call, rounded to six decimals. */
  costUsd(usage: TokenUsage): number {
    const thousandths =
      usage.inputTokens * this.inputPer1kUsd + usage.outputTokens * this.outputPer1kUsd;
    return roundTo(thousandths / 1000, 6);
  }

  toJSON(): { inputPer1kUsd: number; outputPer1kUsd: number } {
    return { inputPer1kUsd: this.inputPer1kUsd, outputPer1kUsd: this.outputPer1kUsd };
  }
}

/** A provider's model, as declared. */
export class ModelSpec {
  readonly name: string;
  readonly provider: string;
  readonly cost: CostProfile;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(init: {
    readonly name: string;
    readonly provider: string;
    readonly cost: CostProfile;
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly capabilities?: Iterable<Capability>;
  }) {
    this.name = init.name;
    this.provider = init.provider;
    this.cost = init.cost;
    this.contextWindow = init.contextWindow;
    this.maxOutputTokens = init.maxOutputTokens;
    this.capabilities = new Set(init.capabilities ?? []);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      provider: this.provider,
      cost: this.cost.toJSON(),
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      capabilities: [...this.capabilities].sort(),
    };
  }
}

/**
 * An alias already resolved to an exact model.
 *
 * The alias exists purely so cost and traces can be attributed to the name the
 * caller used; the model is what actually runs.
 */
export class PinnedModel {
  readonly alias: string;
  readonly model: ModelSpec;

  constructor(init: { readonly alias: string; readonly model: ModelSpec }) {
    if (init.alias.length === 0) throw new RangeError('alias must not be empty');
    this.alias = init.alias;
    this.model = init.model;
  }

  /** Whether every requested capability is declared. A subset test, not "any". */
  supports(capabilities: Iterable<Capability>): boolean {
    for (const capability of capabilities) {
      if (!this.model.capabilities.has(capability)) return false;
    }
    return true;
  }

  /** The capabilities in `wanted` that this model does not declare. */
  missing(capabilities: Iterable<Capability>): Capability[] {
    const absent: Capability[] = [];
    for (const capability of capabilities) {
      if (!this.model.capabilities.has(capability)) absent.push(capability);
    }
    return absent;
  }
}

/** One function a model may call. */
export class ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(init: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  }) {
    if (init.name.length === 0) throw new RangeError('tool name must not be empty');
    this.name = init.name;
    this.description = init.description ?? '';
    this.parameters = init.parameters ?? { type: 'object', properties: {} };
  }

  /** The OpenAI `tools` entry for this definition. */
  asOpenAiTool(): {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  } {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }
}

/** A model's request to call a tool. */
export class ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;

  constructor(init: {
    readonly id: string;
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
  }) {
    if (init.name.length === 0) throw new RangeError('tool call name must not be empty');
    this.id = init.id;
    this.name = init.name;
    this.args = init.arguments ?? {};
  }

  /** The arguments under the spelling the OpenAI wire format uses. */
  get arguments(): Record<string, unknown> {
    return this.args;
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, name: this.name, arguments: this.args };
  }
}

/** What a tool handed back. */
export class ToolResult {
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;

  constructor(init: {
    readonly callId: string;
    readonly name: string;
    readonly content: string;
    readonly isError?: boolean;
  }) {
    this.callId = init.callId;
    this.name = init.name;
    this.content = init.content;
    this.isError = init.isError ?? false;
  }

  /** Wrap a value as a string result. */
  static fromValue(call: ToolCall, value: unknown): ToolResult {
    const content = typeof value === 'string' ? value : canonicalJson(value);
    return new ToolResult({ callId: call.id, name: call.name, content });
  }

  /** Wrap a failure as an error result. */
  static fromError(call: ToolCall, message: string): ToolResult {
    return new ToolResult({ callId: call.id, name: call.name, content: message, isError: true });
  }

  toJSON(): Record<string, unknown> {
    return {
      callId: this.callId,
      name: this.name,
      content: this.content,
      isError: this.isError,
    };
  }
}

/** A single request to a model. */
export class CompletionRequest {
  readonly messages: readonly Message[];
  readonly temperature: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly tools: readonly ToolDefinition[];
  readonly stop: readonly string[];

  constructor(
    init: {
      readonly messages?: readonly Message[];
      readonly temperature?: number;
      readonly maxOutputTokens?: number;
      readonly tools?: readonly ToolDefinition[];
      readonly stop?: readonly string[];
    } = {},
  ) {
    this.messages = init.messages ?? [];
    this.temperature = init.temperature;
    this.maxOutputTokens = init.maxOutputTokens;
    this.tools = init.tools ?? [];
    this.stop = init.stop ?? [];
  }

  /** A one-message request, with an optional system turn prepended. */
  static prompt(text: string, system?: string): CompletionRequest {
    const messages: Message[] = [];
    if (system !== undefined) messages.push(Message.system(system));
    messages.push(Message.user(text));
    return new CompletionRequest({ messages });
  }

  /** The concatenated message text, which is what a provider hashes. */
  get text(): string {
    return this.messages.map((message) => message.content).join('\n');
  }

  /**
   * A stable identity for this request.
   *
   * Recorded next to a result so a baseline can be tied to the exact request that
   * produced it; unset members are excluded so an omitted option and an explicit
   * `undefined` fingerprint identically.
   */
  fingerprint(): string {
    const dump: Record<string, unknown> = {
      messages: this.messages.map((message) => message.toJSON()),
      temperature: this.temperature ?? null,
      maxOutputTokens: this.maxOutputTokens ?? null,
      tools: this.tools.map((tool) => tool.toJSON()),
      stop: [...this.stop],
    };
    return sha256Hex(canonicalJson(dump, { excludeNull: true }));
  }

  toJSON(): Record<string, unknown> {
    return {
      messages: this.messages.map((message) => message.toJSON()),
      temperature: this.temperature ?? null,
      maxOutputTokens: this.maxOutputTokens ?? null,
      tools: this.tools.map((tool) => tool.toJSON()),
      stop: [...this.stop],
    };
  }
}

/** What a provider answered. */
export class CompletionResponse {
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly usage: TokenUsage;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;

  constructor(init: {
    readonly text: string;
    readonly model: string;
    readonly provider: string;
    readonly usage?: TokenUsage;
    readonly toolCalls?: readonly ToolCall[];
    readonly finishReason?: FinishReason;
  }) {
    this.text = init.text;
    this.model = init.model;
    this.provider = init.provider;
    this.usage = init.usage ?? new TokenUsage();
    this.toolCalls = init.toolCalls ?? [];
    this.finishReason = init.finishReason ?? 'stop';
  }
}

/**
 * A gateway result, including the alias chain that produced it.
 *
 * `fellBack` is derived rather than stored: it is exactly "more than one candidate
 * was tried", and storing it separately invites the two to disagree.
 */
export class GenerationResult {
  readonly response: CompletionResponse;
  readonly alias: string;
  readonly costUsd: number;
  readonly attempts: readonly string[];

  constructor(init: {
    readonly response: CompletionResponse;
    readonly alias: string;
    readonly costUsd: number;
    readonly attempts?: readonly string[];
  }) {
    if (!(Number.isFinite(init.costUsd) && init.costUsd >= 0)) {
      throw new RangeError('costUsd must be a non-negative number');
    }
    this.response = init.response;
    this.alias = init.alias;
    this.costUsd = init.costUsd;
    this.attempts = init.attempts ?? [];
  }

  get text(): string {
    return this.response.text;
  }

  get usage(): TokenUsage {
    return this.response.usage;
  }

  get fellBack(): boolean {
    return this.attempts.length > 1;
  }
}
