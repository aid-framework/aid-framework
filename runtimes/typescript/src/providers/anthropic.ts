/**
 * A provider for Anthropic's Messages API.
 *
 * The Messages API is *not* OpenAI-compatible, so it gets its own adapter rather
 * than a flag on {@link OpenAICompatibleProvider}. Three differences are structural
 * rather than cosmetic:
 *
 * 1. The system prompt is a top-level `system` field, not a message role.
 * 2. `max_tokens` is required, so every request must supply one.
 * 3. Tool results are `user` turns carrying `tool_result` blocks, and adjacent
 *    results must be merged into a single turn or the API rejects the request.
 *
 * Like the OpenAI adapter this claims `tool-calling` and `structured-output` but not
 * `long-context`, and it does not claim `embeddings`: the Messages API has no
 * embeddings endpoint, so advertising one would let a spec bind a model that can
 * only fail when it is finally called.
 */

import { ProviderError, ProviderResponseError } from '../errors.js';
import { stripTrailingSlashes } from '../internal/text.js';
import {
  type Capability,
  type CompletionRequest,
  CompletionResponse,
  type FinishReason,
  type Message,
  type ModelSpec,
  TokenUsage,
  ToolCall,
} from '../types.js';
import type { Provider } from './base.js';
import type { FetchLike } from './http.js';

/** The public Anthropic endpoint, used when no base URL is configured. */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * The API version this adapter was written against.
 *
 * Pinned rather than floating: a new version may reshape the request, and an
 * adapter that silently follows the endpoint would change behaviour under the app.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Statuses worth retrying: the request was well-formed and may succeed unchanged.
 *
 * 529 is Anthropic's "overloaded" status. It is not an HTTP standard code, so
 * omitting it would make a busy provider look like a permanent client error.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 529,
]);

/** The wire names `stop_reason` can take, mapped to the runtime's vocabulary. */
const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool-calls',
  refusal: 'content-filter',
};

export interface AnthropicOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: FetchLike;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

/** One entry in the wire `messages` array. */
interface WireMessage {
  role: 'user' | 'assistant';
  content: string | Record<string, unknown>[];
}

/** Talks to Anthropic's `/messages` endpoint. */
export class AnthropicProvider implements Provider {
  private readonly _baseUrl: string;
  private readonly _apiKey: string | undefined;
  private readonly _name: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: FetchLike;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private _closed = false;

  constructor(options: AnthropicOptions = {}) {
    const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL);
    if (!/^https?:\/\/[^/]/i.test(baseUrl)) {
      throw new RangeError(
        `base_url must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}`,
      );
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (maxAttempts < 1) throw new RangeError('max_attempts must be at least 1');
    this._baseUrl = baseUrl;
    this._apiKey = options.apiKey;
    this._name = options.name ?? 'anthropic';
    this._timeoutSeconds = options.timeoutSeconds ?? 60;
    this._maxAttempts = maxAttempts;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this._extraHeaders = options.extraHeaders ?? {};
  }

  get name(): string {
    return this._name;
  }

  get capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(['tool-calling', 'structured-output']);
  }

  async complete(request: CompletionRequest, model: ModelSpec): Promise<CompletionResponse> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const body = await this.post(this.payload(request, model));
    return this.parse(body, model);
  }

  async close(): Promise<void> {
    // A caller-supplied client owns its own connection pool and stays open.
    this._closed = true;
  }

  private payload(request: CompletionRequest, model: ModelSpec): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: model.name,
      max_tokens: Math.min(request.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
      messages: this.wireMessages(request.messages),
    };
    const system = this.systemPrompt(request.messages);
    if (system.length > 0) payload.system = system;
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.stop.length > 0) payload.stop_sequences = [...request.stop];
    if (request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    return payload;
  }

  /** Adjacent system turns joined, because the API accepts only one `system` string. */
  private systemPrompt(messages: readonly Message[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      if (message.role !== 'system') continue;
      if (message.content.length === 0) continue;
      parts.push(message.content);
    }
    return parts.join('\n\n');
  }

  /**
   * Translate the portable message list into the wire shape.
   *
   * Two invariants matter. An assistant turn carrying tool calls must send them as
   * `tool_use` blocks, or the following `tool_result` has no caller. And adjacent
   * `tool` turns must collapse into one `user` turn, because the API rejects a
   * `tool_result` that does not immediately follow its `tool_use` and rejects
   * duplicate consecutive user turns produced by splitting them.
   */
  private wireMessages(messages: readonly Message[]): WireMessage[] {
    const wire: WireMessage[] = [];
    let previousWasToolResult = false;
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        if (message.toolCallId === undefined) {
          throw new ProviderError(`${this._name} cannot send a tool result without a tool_call_id`);
        }
        const block: Record<string, unknown> = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        };
        const last = wire[wire.length - 1];
        if (previousWasToolResult && last !== undefined) {
          // Both branches above guarantee an array; this keeps the type honest.
          (last.content as Record<string, unknown>[]).push(block);
        } else {
          wire.push({ role: 'user', content: [block] });
        }
        previousWasToolResult = true;
        continue;
      }
      previousWasToolResult = false;
      if (message.role === 'user') {
        wire.push({ role: 'user', content: message.content });
        continue;
      }
      const blocks: Record<string, unknown>[] = [];
      if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      // An assistant turn with neither text nor calls is not representable; skipping
      // it is better than sending `content: []`, which the API refuses.
      if (blocks.length === 0) continue;
      wire.push({ role: 'assistant', content: blocks });
    }
    return wire;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...this._extraHeaders,
    };
    if (this._apiKey !== undefined) headers['x-api-key'] = this._apiKey;
    return headers;
  }

  private async post(payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this._baseUrl}/messages`;
    let last = 'no attempt was made';
    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      try {
        const response = await this._fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this._timeoutSeconds * 1000),
        });
        const text = await response.text();
        if (!response.ok) {
          last = `${this._name} returned ${response.status}: ${text}`;
          if (RETRYABLE_STATUSES.has(response.status) && attempt < this._maxAttempts) {
            await delay(this._backoffSeconds * 2 ** (attempt - 1));
            continue;
          }
          throw new ProviderError(last);
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ProviderResponseError(`${this._name} returned a body that is not JSON`);
        }
      } catch (error) {
        if (error instanceof ProviderResponseError || error instanceof ProviderError) throw error;
        last = `${this._name} request failed: ${error instanceof Error ? error.message : String(error)}`;
        if (attempt < this._maxAttempts) {
          await delay(this._backoffSeconds * 2 ** (attempt - 1));
          continue;
        }
        throw new ProviderError(last);
      }
    }
    throw new ProviderError(`${this._name} failed after ${this._maxAttempts} attempt(s): ${last}`);
  }

  private parse(body: unknown, model: ModelSpec): CompletionResponse {
    if (!isObject(body)) {
      throw new ProviderResponseError(`${this._name} returned a JSON body that is not an object`);
    }
    const blocks = body.content;
    if (!Array.isArray(blocks)) {
      throw new ProviderResponseError(`${this._name} returned no content blocks`);
    }
    const text: string[] = [];
    const calls: ToolCall[] = [];
    for (const entry of blocks) {
      if (!isObject(entry)) continue;
      if (entry.type === 'text' && typeof entry.text === 'string') {
        text.push(entry.text);
      } else if (entry.type === 'tool_use') {
        const id = entry.id;
        const name = entry.name;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (typeof name !== 'string' || name.length === 0) continue;
        calls.push(new ToolCall({ id, name, arguments: isObject(entry.input) ? entry.input : {} }));
      }
    }
    return new CompletionResponse({
      text: text.join(''),
      model: model.name,
      provider: this._name,
      usage: this.usage(body),
      toolCalls: calls,
      finishReason: this.finishReason(body.stop_reason, calls.length > 0),
    });
  }

  private usage(body: Record<string, unknown>): TokenUsage {
    const raw = isObject(body.usage) ? body.usage : {};
    const input = raw.input_tokens;
    const output = raw.output_tokens;
    return new TokenUsage({
      inputTokens: typeof input === 'number' ? Math.trunc(input) : 0,
      outputTokens: typeof output === 'number' ? Math.trunc(output) : 0,
    });
  }

  private finishReason(raw: unknown, sawToolCall: boolean): FinishReason {
    if (typeof raw !== 'string') return sawToolCall ? 'tool-calls' : 'stop';
    return FINISH_REASONS[raw] ?? 'stop';
  }
}
