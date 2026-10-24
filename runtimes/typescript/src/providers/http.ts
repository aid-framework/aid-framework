/**
 * A provider for any OpenAI-compatible chat-completions endpoint.
 *
 * One adapter covers OpenAI, Azure OpenAI, vLLM, Ollama, Together, Groq and most
 * others, because they all speak the same request and response shape. Providers that
 * diverge are handled by writing a new {@link Provider}, not by adding flags here.
 *
 * Note the capability list: `long-context` is not claimed. Whether a given deployment
 * has a large window is a property of the deployment, not of the wire protocol, so
 * claiming it here would let the gateway route a request that the endpoint then
 * rejects.
 */

import { ProviderError, ProviderResponseError } from '../errors.js';
import { stripTrailingSlashes } from '../internal/text.js';
import {
  type Capability,
  type CompletionRequest,
  CompletionResponse,
  type FinishReason,
  type ModelSpec,
  TokenUsage,
  ToolCall,
} from '../types.js';
import type { Provider } from './base.js';

/** The public OpenAI endpoint, used when no base URL is configured. */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Statuses worth retrying: the request was well-formed and may succeed unchanged. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** The wire names a `finish_reason` can take, mapped to the runtime's vocabulary. */
const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool-calls',
  content_filter: 'content-filter',
  error: 'error',
};

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface OpenAICompatibleOptions {
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

/** Talks to an OpenAI-compatible `/chat/completions` endpoint. */
export class OpenAICompatibleProvider implements Provider {
  private readonly _baseUrl: string;
  private readonly _apiKey: string | undefined;
  private readonly _name: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: FetchLike;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private _closed = false;

  constructor(options: OpenAICompatibleOptions = {}) {
    const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    if (!/^https?:\/\/[^/]/i.test(baseUrl)) {
      throw new RangeError(
        `base_url must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}`,
      );
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (maxAttempts < 1) throw new RangeError('max_attempts must be at least 1');
    this._baseUrl = baseUrl;
    this._apiKey = options.apiKey;
    this._name = options.name ?? 'openai-compatible';
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
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    const requested = request.maxOutputTokens ?? model.maxOutputTokens;
    payload.max_tokens = Math.min(requested, model.maxOutputTokens);
    if (request.stop !== undefined && request.stop.length > 0) payload.stop = [...request.stop];
    if (request.tools !== undefined && request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => tool.asOpenAiTool());
    }
    return payload;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this._extraHeaders,
    };
    if (this._apiKey !== undefined) headers.authorization = `Bearer ${this._apiKey}`;
    return headers;
  }

  private async post(payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this._baseUrl}/chat/completions`;
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
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderResponseError(`${this._name} returned no choices`);
    }
    const first = choices[0];
    if (!isObject(first)) {
      throw new ProviderResponseError(`${this._name} returned a malformed choice`);
    }
    const message = first.message;
    if (!isObject(message)) {
      throw new ProviderResponseError(`${this._name} returned a choice without a message`);
    }
    const content = message.content;
    if (content !== null && content !== undefined && typeof content !== 'string') {
      throw new ProviderResponseError(`${this._name} returned non-string content`);
    }
    return new CompletionResponse({
      text: typeof content === 'string' ? content : '',
      model: model.name,
      provider: this._name,
      usage: this.usage(message, body),
      toolCalls: this.toolCalls(message),
      finishReason: this.finishReason(first.finish_reason),
    });
  }

  private usage(message: Record<string, unknown>, body: Record<string, unknown>): TokenUsage {
    const raw = isObject(body.usage) ? body.usage : isObject(message.usage) ? message.usage : {};
    const input = raw.prompt_tokens;
    const output = raw.completion_tokens;
    return new TokenUsage({
      inputTokens: typeof input === 'number' ? Math.trunc(input) : 0,
      outputTokens: typeof output === 'number' ? Math.trunc(output) : 0,
    });
  }

  private toolCalls(message: Record<string, unknown>): ToolCall[] | undefined {
    const raw = message.tool_calls;
    if (!Array.isArray(raw)) return undefined;
    const calls: ToolCall[] = [];
    for (const [index, entry] of raw.entries()) {
      if (!isObject(entry)) continue;
      const fn = entry.function;
      if (!isObject(fn)) continue;
      const name = fn.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      let args: unknown = {};
      if (typeof fn.arguments === 'string') {
        try {
          const parsed: unknown = JSON.parse(fn.arguments);
          if (isObject(parsed)) args = parsed;
        } catch {
          args = {};
        }
      } else if (isObject(fn.arguments)) {
        args = fn.arguments;
      }
      const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `call_${index}`;
      calls.push(new ToolCall({ id, name, arguments: args as Record<string, unknown> }));
    }
    return calls;
  }

  private finishReason(raw: unknown): FinishReason {
    if (typeof raw !== 'string') return 'stop';
    return FINISH_REASONS[raw] ?? 'stop';
  }
}
