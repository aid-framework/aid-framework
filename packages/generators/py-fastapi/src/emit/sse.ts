/**
 * `app/generated/sse.py`: how a route decides whether the caller asked for a stream.
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

import { INDENT, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';

export const SSE_PATH = `${GENERATED_ROOT}/sse.py`;

/** The media type a streaming response carries, and the one `Accept` asks for. */
export const EVENT_STREAM = 'text/event-stream';

export function emitSse(): EmittedFile {
  return generated(
    SSE_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'Whether a request asks for a server-sent event stream. A route serves the same ' +
          'pipeline either way; `Accept: text/event-stream` changes the media type of the ' +
          'response, not the work the pipeline does.',
      ),
      importBlock([[importFrom('fastapi', ['Request'])]]),
      `EVENT_STREAM = ${pythonString(EVENT_STREAM)}`,
      [
        'def wants_event_stream(request: Request) -> bool:',
        pythonDoc(
          'Whether the caller asked for `text/event-stream`. `Accept` is a comma-separated ' +
            'list of media ranges, each optionally followed by parameters such as `;q=0.9`, ' +
            'so a substring test would accept a bare mention -- `text/event-stream-extra`, ' +
            'or a range carrying `q=0` that means the opposite. Comparing the media type of ' +
            'each range is the part of RFC 9110 that decides what a route returns.',
          INDENT,
        ),
        `${INDENT}for ranged in request.headers.get("accept", "").split(","):`,
        `${INDENT}${INDENT}if ranged.split(";")[0].strip() == EVENT_STREAM:`,
        `${INDENT}${INDENT}${INDENT}return True`,
        `${INDENT}return False`,
      ].join('\n'),
    ]),
  );
}
