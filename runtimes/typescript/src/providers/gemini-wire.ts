/**
 * The Gemini wire dialect, shared by the Vertex and Gemini API adapters.
 *
 * Both services accept the same body -- `contents` of `parts`, Google-shaped
 * `functionDeclarations`, `systemInstruction`, `generationConfig` -- and answer with
 * the same `candidates` and `usageMetadata`. They differ only in the endpoint and the
 * credentials, so the translation lives here once. A test builds one request through
 * both adapters and asserts the bodies are identical.
 *
 * Internal: not re-exported from the package index.
 */

import { ProviderError, ProviderResponseError } from '../errors.js';
import {
  type CompletionRequest,
  CompletionResponse,
  type FinishReason,
  type Message,
  type ModelSpec,
  TokenUsage,
  ToolCall,
} from '../types.js';
import type { FetchLike } from './http.js';

/** The retry set both adapters share; 400 is never in it. */
export const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

/** Translate a completion request into the body both Gemini endpoints accept. */
export function buildPayload(
  request: CompletionRequest,
  model: ModelSpec,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.min(
      request.maxOutputTokens ?? model.maxOutputTokens,
      model.maxOutputTokens,
    ),
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.stop.length > 0) generationConfig.stopSequences = [...request.stop];
  const payload: Record<string, unknown> = {
    contents: wireContents(request.messages),
    generationConfig,
  };
  const system = systemPrompt(request.messages);
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

/** Gemini takes one `systemInstruction`, so adjacent system turns are joined. */
export function systemPrompt(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (message.content.length === 0) continue;
    parts.push(message.content);
  }
  return parts.join('\n\n');
}

/** Translate the portable message list into `contents` of `parts`. */
export function wireContents(messages: readonly Message[]): Record<string, unknown>[] {
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

/** Read a response body into the runtime's completion shape. */
export function parseCompletion(
  text: string,
  model: ModelSpec,
  provider: string,
): CompletionResponse {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError(`${provider} returned a body that is not JSON`);
  }
  if (!isObject(body)) {
    throw new ProviderResponseError(`${provider} returned a JSON body that is not an object`);
  }
  const candidates = body.candidates;
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!isObject(candidate)) {
    throw new ProviderResponseError(`${provider} returned no candidates`);
  }
  const content = candidate.content;
  const parts = isObject(content) ? content.parts : undefined;
  if (!Array.isArray(parts)) {
    throw new ProviderResponseError(`${provider} returned no content parts`);
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
    provider,
    usage: usage(body),
    toolCalls: calls,
    finishReason: finishReason(candidate.finishReason, calls.length > 0),
  });
}

export function usage(body: Record<string, unknown>): TokenUsage {
  const raw = isObject(body.usageMetadata) ? body.usageMetadata : {};
  const input = raw.promptTokenCount;
  const output = raw.candidatesTokenCount;
  return new TokenUsage({
    inputTokens: typeof input === 'number' ? Math.trunc(input) : 0,
    outputTokens: typeof output === 'number' ? Math.trunc(output) : 0,
  });
}

export function finishReason(raw: unknown, sawToolCall: boolean): FinishReason {
  if (typeof raw !== 'string') return sawToolCall ? 'tool-calls' : 'stop';
  const mapped = FINISH_REASONS[raw] ?? 'stop';
  if (sawToolCall && mapped === 'stop') return 'tool-calls';
  return mapped;
}

export interface PostOptions {
  readonly name: string;
  readonly timeoutSeconds: number;
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
  readonly fetchImpl: FetchLike;
}

/** One POST with the shared retry rule; `statuses` is narrowed per adapter. */
export async function postJson(
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  options: PostOptions,
  statuses: ReadonlySet<number> = DEFAULT_RETRYABLE_STATUSES,
): Promise<string> {
  const { name, timeoutSeconds, maxAttempts, backoffSeconds, fetchImpl } = options;
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers },
        body,
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      const text = await response.text();
      if (!response.ok) {
        last = `${name} returned ${response.status}: ${text}`;
        if (statuses.has(response.status) && attempt < maxAttempts) {
          await delay(backoffSeconds * 2 ** (attempt - 1));
          continue;
        }
        throw new ProviderError(last);
      }
      return text;
    } catch (error) {
      if (error instanceof ProviderResponseError || error instanceof ProviderError) throw error;
      last = `${name} request failed: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < maxAttempts) {
        await delay(backoffSeconds * 2 ** (attempt - 1));
        continue;
      }
      throw new ProviderError(last);
    }
  }
  throw new ProviderError(`${name} failed after ${maxAttempts} attempt(s): ${last}`);
}
