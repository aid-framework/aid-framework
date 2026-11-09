/**
 * `generated/sse.ts`: how a route decides whether the caller asked for a stream.
 *
 * One route serves both media types -- the same path, the same request body -- so the
 * only thing that differs is what the `Accept` header asks for. Keeping the negotiation
 * in one function means the answer is the same at every route that reads it, and it is
 * the only place the header is parsed at all.
 *
 * A route with nowhere to put this module is a route that cannot stream, so the file
 * exists only when `../streaming.ts` says some pipeline streams. That is `../plan.ts`'s
 * decision, as every other file's presence is.
 */

import { literal } from '../names.js';
import { type EmittedFile, generated, paths } from './file.js';
import { moduleText } from './text.js';

/** The media type a streaming response carries, and the one `Accept` asks for. */
export const EVENT_STREAM = 'text/event-stream';

export function emitSse(): EmittedFile {
  const body = [
    '/** The media type a streaming response carries, and the one `Accept` asks for. */',
    `export const EVENT_STREAM = ${literal(EVENT_STREAM)};`,
    '',
    '/** The header half of the Fetch API that a route actually uses. */',
    'export interface RouteHeaders {',
    '  readonly get: (name: string) => string | null;',
    '}',
    '',
    '/**',
    ' * Whether the caller asked for `text/event-stream`. `Accept` is a comma-separated',
    ' * list of media ranges, each optionally followed by parameters such as `;q=0.9`, so a',
    ' * substring test would accept a bare mention -- `text/event-stream-extra`, or a range',
    ' * whose parameters mean the opposite. Comparing the media type of each range is the',
    ' * part of RFC 9110 that decides what a route returns.',
    ' */',
    'export function wantsEventStream(headers: RouteHeaders | undefined): boolean {',
    "  const accept = headers?.get('accept') ?? '';",
    '  return accept',
    "    .split(',')",
    "    .some((range) => (range.split(';')[0] ?? '').trim() === EVENT_STREAM);",
    '}',
    '',
    '/**',
    ' * The gateway stream as a `ReadableStream`, which is what a Fetch `Response` takes.',
    ' * The gateway yields whole SSE frames, so nothing here frames anything: it moves each',
    ' * frame across as it arrives and closes when the gateway does. A provider failure',
    ' * rejects `pull`, which errors the response -- the same truncation a caller would see',
    ' * from any SSE endpoint whose upstream died mid-stream.',
    ' */',
    'export function toEventStream(source: AsyncIterable<string>): ReadableStream<Uint8Array> {',
    '  const encoder = new TextEncoder();',
    '  const iterator = source[Symbol.asyncIterator]();',
    '  return new ReadableStream<Uint8Array>({',
    '    async pull(controller) {',
    '      const next = await iterator.next();',
    '      if (next.done === true) {',
    '        controller.close();',
    '        return;',
    '      }',
    '      controller.enqueue(encoder.encode(next.value));',
    '    },',
    '    async cancel() {',
    '      await iterator.return?.(undefined);',
    '    },',
    '  });',
    '}',
  ].join('\n');
  return generated(paths.sse, moduleText(body));
}
