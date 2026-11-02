/**
 * A provider for Gemini on Vertex AI.
 *
 * Vertex does not accept an API key: it authenticates with an OAuth2 bearer
 * token. The token is resolved once per call from an explicit value, the
 * environment, or the GCE metadata server that Cloud Run and Cloud Functions
 * provide, so `api_key_env` is absent from the spec and an empty one is valid.
 *
 * Three translations are structural:
 *
 * 1. Messages become `contents` of `parts`, with `model` as the assistant role.
 * 2. The system prompt is a top-level `systemInstruction`, not a turn.
 * 3. Tool results become `functionResponse` parts in a `user` turn.
 *
 * No `stream`: the TypeScript seam is request/response only, matching every
 * other TS provider, so this adapter does not advertise `streaming`.
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

/** The default location when none is configured. */
export const DEFAULT_VERTEX_LOCATION = 'us-central1';

/** Where the metadata server mints a token for the default service account. */
export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** The environment variable a developer sets off GCP (`gcloud auth print-access-token`). */
export const VERTEX_TOKEN_ENV = 'GOOGLE_ACCESS_TOKEN';

/** The default endpoint host, used when no base URL is configured. */
export function defaultVertexBaseUrl(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 424, 425, 429, 500, 502, 503, 504,
]);

/** The candidate `finishReason` values mapped to the runtime's vocabulary. */
const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content-filter',
  RECITATION: 'content-filter',
  BLOCKLIST: 'content-filter',
  PROHIBITED_CONTENT: 'content-filter',
  SPII: 'content-filter',
  MALFORMED_FUNCTION_CALL: 'error',
};

/** Refresh a metadata token this long before it expires. */
const TOKEN_REFRESH_MS = 60 * 1000;

export interface VertexOptions {
  /** The GCP project. Defaults to `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`. */
  readonly project?: string;
  /** The location. Defaults to `GOOGLE_CLOUD_REGION`, then `us-central1`. */
  readonly location?: string;
  /** A bearer token. When absent, the environment or the metadata server supplies one. */
  readonly accessToken?: string;
  /** Overrides the endpoint host; tests point this at a stub. */
  readonly baseUrl?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: FetchLike;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Supplied by tests so token caching is reproducible. */
  readonly now?: () => number;
  /** Supplied by tests, or to plug in a different credential source. */
  readonly tokenProvider?: () => Promise<string>;
}

interface CachedToken {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
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

function env(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

export class VertexProvider implements Provider {
  private readonly _project: string | undefined;
  private readonly _location: string | undefined;
  private readonly _accessToken: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _name: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: FetchLike;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private readonly _now: () => number;
  private readonly _tokenProvider: (() => Promise<string>) | undefined;
  private _cachedToken: CachedToken | undefined;
  private _closed = false;

  constructor(options: VertexOptions = {}) {
    this._project = options.project;
    this._location = options.location;
    this._accessToken = options.accessToken;
    this._baseUrl = options.baseUrl;
    this._name = options.name ?? 'google';
    this._timeoutSeconds = options.timeoutSeconds ?? 60;
    this._maxAttempts = options.maxAttempts ?? 3;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this._extraHeaders = options.extraHeaders ?? {};
    this._now = options.now ?? (() => Date.now());
    this._tokenProvider = options.tokenProvider;
  }

  get name(): string {
    return this._name;
  }

  get capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(['tool-calling', 'structured-output']);
  }

  async complete(request: CompletionRequest, model: ModelSpec): Promise<CompletionResponse> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const body = JSON.stringify(this.payload(request, model));
    const text = await this.post(this.endpoint(model), body);
    return this.parse(text, model);
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  private project(): string {
    const project = this._project ?? env('GOOGLE_CLOUD_PROJECT') ?? env('GCLOUD_PROJECT');
    if (project === undefined) {
      throw new ProviderError(
        `${this._name} needs a project: set provider 'project' or GOOGLE_CLOUD_PROJECT`,
      );
    }
    return project;
  }

  private location(): string {
    return (
      this._location ??
      env('GOOGLE_CLOUD_REGION') ??
      env('VERTEX_LOCATION') ??
      DEFAULT_VERTEX_LOCATION
    );
  }

  private endpoint(model: ModelSpec): string {
    const location = this.location();
    const base = stripTrailingSlashes(this._baseUrl ?? defaultVertexBaseUrl(location));
    return `${base}/v1/projects/${this.project()}/locations/${location}/publishers/google/models/${model.name}:generateContent`;
  }

  private async token(): Promise<string> {
    if (this._accessToken !== undefined) return this._accessToken;
    const fromEnv = env(VERTEX_TOKEN_ENV) ?? env('VERTEX_ACCESS_TOKEN');
    if (fromEnv !== undefined) return fromEnv;
    const cached = this._cachedToken;
    if (cached !== undefined && cached.expiresAt - this._now() > TOKEN_REFRESH_MS) {
      return cached.token;
    }
    const minted = await this.mintToken();
    this._cachedToken = minted;
    return minted.token;
  }

  private async mintToken(): Promise<CachedToken> {
    if (this._tokenProvider !== undefined) {
      return { token: await this._tokenProvider(), expiresAt: this._now() + 5 * 60 * 1000 };
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this._fetch(METADATA_TOKEN_URL, {
        method: 'GET',
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(this._timeoutSeconds * 1000),
      });
    } catch (error) {
      throw new ProviderError(
        `${this._name} has no credentials: set ${VERTEX_TOKEN_ENV} or run on GCP where the ` +
          `metadata server mints a token (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(
        `${this._name} metadata token request returned ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderResponseError(`${this._name} metadata token is not JSON`);
    }
    const token = isObject(body) ? body.access_token : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ProviderResponseError(`${this._name} metadata response had no access_token`);
    }
    const rawExpiry = isObject(body) ? body.expires_in : undefined;
    const seconds = typeof rawExpiry === 'number' ? rawExpiry : 300;
    return { token, expiresAt: this._now() + seconds * 1000 };
  }

  private payload(request: CompletionRequest, model: ModelSpec): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: Math.min(
        request.maxOutputTokens ?? model.maxOutputTokens,
        model.maxOutputTokens,
      ),
    };
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.stop.length > 0) generationConfig.stopSequences = [...request.stop];
    const payload: Record<string, unknown> = {
      contents: this.wireContents(request.messages),
      generationConfig,
    };
    const system = this.systemPrompt(request.messages);
    if (system.length > 0) payload.systemInstruction = { parts: [{ text: system }] };
    if (request.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }
    return payload;
  }

  /** Vertex takes one `systemInstruction`, so adjacent system turns are joined. */
  private systemPrompt(messages: readonly Message[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      if (message.role !== 'system') continue;
      if (message.content.length === 0) continue;
      parts.push(message.content);
    }
    return parts.join('\n\n');
  }

  /** Translate the portable message list into `contents` of `parts`. */
  private wireContents(messages: readonly Message[]): Record<string, unknown>[] {
    const contents: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: message.name ?? 'tool',
                response: { content: message.content },
              },
            },
          ],
        });
        continue;
      }
      const parts: Record<string, unknown>[] = [];
      if (message.content.length > 0) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
    return contents;
  }

  private async post(url: string, body: string): Promise<string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token()}`,
      'content-type': 'application/json',
      ...this._extraHeaders,
    };
    let last = 'no attempt was made';
    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      try {
        const response = await this._fetch(url, {
          method: 'POST',
          headers,
          body,
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
        return text;
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

  private parse(text: string, model: ModelSpec): CompletionResponse {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderResponseError(`${this._name} returned a body that is not JSON`);
    }
    if (!isObject(body)) {
      throw new ProviderResponseError(`${this._name} returned a JSON body that is not an object`);
    }
    const candidates = body.candidates;
    const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
    if (!isObject(candidate)) {
      throw new ProviderResponseError(`${this._name} returned no candidates`);
    }
    const content = candidate.content;
    const parts = isObject(content) ? content.parts : undefined;
    if (!Array.isArray(parts)) {
      throw new ProviderResponseError(`${this._name} returned no content parts`);
    }

    const textParts: string[] = [];
    const calls: ToolCall[] = [];
    parts.forEach((part, index) => {
      if (!isObject(part)) return;
      if (typeof part.text === 'string') {
        textParts.push(part.text);
        return;
      }
      const call = part.functionCall;
      if (!isObject(call)) return;
      const name = call.name;
      if (typeof name !== 'string' || name.length === 0) return;
      calls.push(
        new ToolCall({
          id: `${model.name}-call-${index}`,
          name,
          arguments: isObject(call.args) ? call.args : {},
        }),
      );
    });

    return new CompletionResponse({
      text: textParts.join(''),
      model: model.name,
      provider: this._name,
      usage: this.usage(body),
      toolCalls: calls,
      finishReason: this.finishReason(candidate.finishReason, calls.length > 0),
    });
  }

  private usage(body: Record<string, unknown>): TokenUsage {
    const raw = isObject(body.usageMetadata) ? body.usageMetadata : {};
    const input = raw.promptTokenCount;
    const output = raw.candidatesTokenCount;
    return new TokenUsage({
      inputTokens: typeof input === 'number' ? Math.trunc(input) : 0,
      outputTokens: typeof output === 'number' ? Math.trunc(output) : 0,
    });
  }

  private finishReason(raw: unknown, sawToolCall: boolean): FinishReason {
    if (typeof raw !== 'string') return sawToolCall ? 'tool-calls' : 'stop';
    const mapped = FINISH_REASONS[raw] ?? 'stop';
    if (sawToolCall && mapped === 'stop') return 'tool-calls';
    return mapped;
  }
}
