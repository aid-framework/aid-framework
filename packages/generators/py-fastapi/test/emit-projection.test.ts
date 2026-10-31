/**
 * The emit terminator agrees with the response plan the generated route ships.
 *
 * `emit` used to have no runtime surface at all: the emitted route composed its response
 * itself, from `responsePlan` plus `emitIndex`/`eventType`, so the only definition of the
 * projection lived in generated Python. The runtime now also has an `emit` step
 * (`emitStep`), and the two are independent -- this target still composes through
 * `responsePlan`, because the ratified scope for that layer left generated output
 * byte-identical. Nothing in the build forces them to agree, and a conformance case that
 * only drives the new step would pin a surface that could quietly diverge from what
 * ships.
 *
 * So the two are pinned to each other here, on one representative shape: the same
 * declared event, the same bindings, and the same corpus case. `responsePlan` decides
 * which reference path fills each field; `emitStep` projects the context along those
 * paths; and the shared `conformance/corpus.json` case is the literal both are held to.
 * Drift on either side reddens one of the assertions below:
 *
 * - a plan that derives a different path fails `sources`
 * - a plan whose order changes fails `fields`, which is compared against the corpus
 * - a terminator that reads a different path, or reorders, fails `payload`/`fields`
 *
 * The runtime is imported by relative path, not by package: the generator does not
 * depend on it and must not start doing so. Reading the other side of a cross-language
 * pin is what `control.test.ts` does too, for the same reason.
 */

import { readFileSync } from 'node:fs';

import type { TypeRef, TypeShape } from '@aid/ir';
import { describe, expect, it } from 'vitest';

import { emitStep, Pipeline, PipelineContext } from '../../../../runtimes/typescript/src/index.js';

import { responsePlan } from '../src/index.js';
import type { StepBinding } from '../src/validate.js';

/** The corpus case whose declaration and payload the two projections are pinned to. */
const CASE_ID = 'steps-emit-projects-the-declared-fields';

const CORPUS = new URL('../../../../conformance/corpus.json', import.meta.url);

interface EmitCase {
  readonly id: string;
  readonly input: {
    readonly as: string;
    readonly fields: Record<string, string>;
    readonly values: Record<string, unknown>;
  };
  readonly expect: { readonly payload: Record<string, unknown>; readonly fields: string[] };
}

function corpusCase(): EmitCase {
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as { cases: EmitCase[] };
  const found = corpus.cases.find((entry) => entry.id === CASE_ID);
  if (found === undefined) throw new Error(`corpus has no case ${CASE_ID}`);
  return found;
}

const text: TypeRef = { kind: 'primitive', name: 'string', list: false };

/** The two types the plan ranks against: the event, and the struct an earlier step bound. */
const TYPES = new Map<string, TypeShape>([
  [
    'Ticket',
    {
      id: 'Ticket',
      kind: 'struct',
      fields: [
        { name: 'subject', type: text, required: true },
        { name: 'state', type: text, required: true },
      ],
    },
  ],
  [
    'TicketEvent',
    {
      id: 'TicketEvent',
      kind: 'struct',
      fields: [
        { name: 'subject', type: text, required: true },
        { name: 'state', type: text, required: true },
      ],
    },
  ],
]);

/** One step bound a `Ticket`; the event is filled from it, field by field. */
const BINDINGS: readonly StepBinding[] = [
  { name: 'ticket', type: { kind: 'named', name: 'Ticket', list: false, resolved: true } },
];

describe('the emit terminator and the emitted response plan', () => {
  it('derives the reference paths the corpus case declares', () => {
    const plan = responsePlan(BINDINGS, 'TicketEvent', TYPES, 'response');
    expect(plan.problems).toEqual([]);
    expect(plan.sources).toEqual([
      { field: 'subject', path: ['ticket', 'subject'] },
      { field: 'state', path: ['ticket', 'state'] },
    ]);
  });

  it('projects the corpus case to the payload the corpus pins', async () => {
    const plan = responsePlan(BINDINGS, 'TicketEvent', TYPES, 'response');
    const declared = corpusCase();

    // The corpus states each field's source as a dotted path, which is exactly how the
    // terminator receives one. Comparing here is what ties the case -- and so both
    // runtimes' conformance verdicts -- to the plan rather than to a copy of it.
    const fields = Object.fromEntries(
      plan.sources.map((source) => [source.field, source.path.join('.')]),
    );
    expect(fields).toEqual(declared.input.fields);

    const context = new PipelineContext({ ...declared.input.values });
    const settled = await Pipeline.of(emitStep(fields, { key: declared.input.as })).run(context);
    const payload = settled.require(declared.input.as) as Record<string, unknown>;

    expect(payload).toEqual(declared.expect.payload);
    // Declaration order, not sorted: the plan's order is the emitted event's order, and a
    // projection that reordered its keys would still compare equal as a mapping.
    expect(Object.keys(payload)).toEqual(declared.expect.fields);
  });
});
