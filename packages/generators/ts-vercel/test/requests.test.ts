/**
 * `generated/requests.ts` is exported unconditionally, so it must exist unconditionally.
 *
 * The barrel says `export * from './requests.js'`, and every module that needs a request
 * type imports it from there. An earlier emitter returned nothing when no pipeline read an
 * `event.*` field, which left the import unresolvable and made the app unbuildable -- the
 * kind of defect the text-only tests could not see, because there was no text to read.
 * These tests pin the invariant that replaces it: one request type per pipeline, always.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { filesFor } from '../src/plan.js';
import { buildForSpecText, example, MINIMAL_STREAMING_SPEC } from './helpers.js';

const REQUESTS = 'app/generated/requests.ts';
const BARREL = 'app/generated/index.ts';

/** The emitted file at `path`, or a failure naming what was planned instead. */
function emitted(ir: IR, path: string): string {
  const file = filesFor(ir).find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(
      `${path} was not planned; planned: ${filesFor(ir)
        .map((candidate) => candidate.path)
        .join(', ')}`,
    );
  }
  return file.content;
}

describe('the request schemas', () => {
  it('exist even when no pipeline reads an event field', () => {
    // The zero-event case is the one the plan used to omit entirely.
    const { ir } = buildForSpecText(MINIMAL_STREAMING_SPEC);
    expect(emitted(ir, BARREL)).toContain("export * from './requests.js';");
    expect(emitted(ir, REQUESTS)).toContain('export const ChatRequest');
  });

  it('declare no field for a body the pipeline never looks at', () => {
    // `z.object({})` is the honest schema: it accepts the JSON object `seeded` needs and
    // declares nothing this app reads. An empty `z.object({` block would imply fields
    // were meant to be there.
    const { ir } = buildForSpecText(MINIMAL_STREAMING_SPEC);
    expect(emitted(ir, REQUESTS)).toContain('export const ChatRequest = z.object({});');
    expect(emitted(ir, REQUESTS)).not.toContain('subject');
  });

  it('carry every field the pipeline does read', () => {
    const requests = emitted(example().ir, REQUESTS);
    // The example's prompt interpolates both, so both are request fields.
    expect(requests).toContain('subject:');
    expect(requests).toContain('body:');
  });
});

describe('the pipeline module', () => {
  it('imports the request type only when the pipeline reads an event field', () => {
    // An unused import is an error under this target's tsconfig, so the import follows
    // the reference rather than the pipeline's existence.
    const minimal = buildForSpecText(MINIMAL_STREAMING_SPEC);
    expect(emitted(minimal.ir, 'app/generated/pipelines/chat.ts')).not.toContain('../requests.js');

    expect(emitted(example().ir, 'app/generated/pipelines/answer_ticket.ts')).toContain(
      "from '../requests.js'",
    );
  });
});
