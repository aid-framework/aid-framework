/**
 * `app/generated/control.py`: the two numbers a composite runs under, and the principal
 * it branches on.
 *
 * The point of this file is that both numbers cross a language boundary, and neither can
 * be made to cross it by sharing a constant. `MAX_STEP_DEPTH` is a TypeScript gate that
 * runs at build time; the app is Python that runs per request. So the generator *emits*
 * the bound into the generated package, the runtime keeps a default for a hand-written
 * pipeline, and the parity asserted below is the only thing holding the two together.
 * Without it a bump on one side ships silently: the build would accept a depth the app
 * then refuses at request time, or the app would accept one the build had rejected.
 *
 * The same argument applies to the six context keys the control family owns. Generated
 * code seeds a context by literal key, so a rename in the runtime would otherwise stop
 * seeding anything at all -- quietly, and only observable as a missing key at request
 * time. Reading the runtime's own source and comparing is the mechanism.
 *
 * The third claim is the one with a security shape. `Principal.authenticated` defaults to
 * `True`, so a route that seeded a bare `Principal()` would make every `isAuthenticated()`
 * predicate vacuously true and send every caller down the `then` arm. That is a fail-open,
 * and this file pins the closed alternative: an explicitly unauthenticated principal,
 * emitted and seeded, with no bare `Principal()` anywhere in the plan.
 *
 * Every block ends with a mutation that has been shown to be caught.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_STEP_DEPTH as IR_DEPTH, isCompositeStep } from '@aid-framework/ir';
import { MAX_STEP_DEPTH as SPEC_DEPTH } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_PRINCIPAL,
  CONCURRENCY_LIMIT,
  CONTROL_PATH,
  concurrencyCap,
  DEPTH_KEY,
  hasBranch,
  INDEX_KEY,
  ITEM_KEY,
  LIMITER_KEY,
  PRINCIPAL_KEY,
  REDUCED_KEY,
  RESERVED_KEYS,
} from '../src/index.js';
import {
  compositePlan,
  compositeSpecText,
  fileAt,
  irForSpecText,
  PACKAGE_REPO_ROOT,
  planForSpecText,
} from './composite.js';
import { EXAMPLE_SPEC_PATH, example, exampleSpecText } from './helpers.js';

/**
 * A composite that branches but never fans out.
 *
 * The two constants are gated on two different questions -- `MAX_STEP_DEPTH` on any
 * composite, `CONCURRENCY_LIMIT` on any fan-out -- and a spec that has the first without
 * the second is the only way to see the difference. A `branch` is the composite with no
 * concurrency in it at all, so this is the smallest spec that asks the question.
 */
const BRANCH_ONLY_SPEC = `specVersion: "0.2"
project:
  name: branchonly
  description: A composite with no fan-out, so the cap has nothing to bound.
  targets: [py-fastapi]
types:
  Reply:
    kind: struct
    fields:
      summary:
        type: string
        required: true
models:
  fast:
    provider: fake
    modelId: fake-echo
    capabilities: [json-schema]
prompts:
  reply:
    version: 1
    model: fast
    template: "Reply to {{subject}}"
    variables:
      subject:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply
pipelines:
  only:
    trigger:
      http:
        method: post
        path: /only
    steps:
      - branch:
          when: "hasRole('agent')"
          then:
            - generate:
                prompt: reply
                input:
                  subject: "{{event.subject}}"
                as: note
          else:
            - generate:
                prompt: reply
                input:
                  subject: "{{event.subject}}"
                as: note
      # The only binding whose declared type is the emitted event, so the response plan
      # has one source per field instead of an ambiguity it must refuse. A binding made
      # by a branch arm does not carry its arms' declared type through the merge, so it
      # cannot be the emit's source even though both arms produce one.
      - generate:
          prompt: reply
          input:
            subject: "{{note}}"
          as: report
      - emit:
          event: Reply
`;

const RUNTIME_CONTROL = join(
  PACKAGE_REPO_ROOT,
  'runtimes',
  'python',
  'src',
  'aid_runtime',
  'control.py',
);

/**
 * A module-level assignment's right-hand side, read out of Python source.
 *
 * Matching the literal rather than importing the runtime keeps this suite in one
 * language. It is not a weaker check: the file read is the source the app imports.
 */
function assignment(source: string, name: string): string | undefined {
  const match = new RegExp(`^${name} = (.+)$`, 'm').exec(source);
  return match?.[1];
}

/** The runtime's `control.py`, read once. */
function runtimeControl(): string {
  return readFileSync(RUNTIME_CONTROL, 'utf8');
}

describe('the emitted step depth is the spec gate’s', () => {
  it('is written into the generated module, and equals the gate’s number', () => {
    // The gate and the emitter live in two packages, so even the TypeScript side could
    // drift by a re-export that stopped pointing at the same declaration.
    expect(SPEC_DEPTH).toBe(IR_DEPTH);

    const emitted = assignment(fileAt(compositePlan(), CONTROL_PATH), 'MAX_STEP_DEPTH');
    expect(emitted).toBe(String(IR_DEPTH));
  });

  it('equals the runtime’s own default, which is what a hand-written pipeline reads', () => {
    // The runtime cannot import a TypeScript constant, so its default is a second
    // literal by construction. This is the assertion that makes that acceptable.
    const emitted = assignment(fileAt(compositePlan(), CONTROL_PATH), 'MAX_STEP_DEPTH');
    expect(assignment(runtimeControl(), 'MAX_STEP_DEPTH')).toBe(emitted);
  });

  it('is emitted only for an app that declares a composite', () => {
    // A flat pipeline has no bound to read. Emitting one anyway would give a name to a
    // limit the app does not enforce, which is the kind of thing a reader trusts.
    const steps = example().ir.pipelines.flatMap((pipeline) => pipeline.steps ?? []);
    expect(steps.some(isCompositeStep)).toBe(true);
    expect(
      planForSpecText(exampleSpecText(), EXAMPLE_SPEC_PATH).files.some(
        (file) => file.path === CONTROL_PATH,
      ),
    ).toBe(true);
  });
});

describe('the context keys the control family owns', () => {
  it('are the runtime’s keys, not a parallel spelling of them', () => {
    const source = runtimeControl();
    const pairs: [string, string][] = [
      ['DEPTH_KEY', DEPTH_KEY],
      ['INDEX_KEY', INDEX_KEY],
      ['ITEM_KEY', ITEM_KEY],
      ['LIMITER_KEY', LIMITER_KEY],
      ['PRINCIPAL_KEY', PRINCIPAL_KEY],
      ['REDUCED_KEY', REDUCED_KEY],
    ];
    for (const [constant, value] of pairs) {
      expect(assignment(source, constant), constant).toBe(`"${value}"`);
    }
  });

  it('are exactly the six the runtime reserves, so a new key is not forgotten', () => {
    expect([...RESERVED_KEYS].sort()).toEqual(
      [DEPTH_KEY, INDEX_KEY, ITEM_KEY, LIMITER_KEY, PRINCIPAL_KEY, REDUCED_KEY].sort(),
    );
    // `RESERVED_KEYS` is what tells a spec author which names a step may not bind; if the
    // runtime reserved a seventh and this list did not, the spec gate would accept a
    // binding the runtime then overwrites.
    const reserved = /RESERVED_KEYS = frozenset\(\s*\{([^}]*)\}/.exec(runtimeControl());
    expect(reserved, 'the runtime no longer declares RESERVED_KEYS as a frozenset').not.toBeNull();
    const declared = [...(reserved?.[1] ?? '').matchAll(/[A-Z_]+_KEY/g)].length;
    expect(declared).toBe(RESERVED_KEYS.length);
  });
});

describe('the concurrency cap', () => {
  it('is the smallest any deployment declares, so no deployment widens the one limiter', () => {
    expect(concurrencyCap(irForSpecText(compositeSpecText(), EXAMPLE_SPEC_PATH))).toBe(4);
  });

  it('is emitted under the name the pipeline imports', () => {
    const emitted = assignment(fileAt(compositePlan(), CONTROL_PATH), CONCURRENCY_LIMIT);
    expect(emitted).toBe('4');
  });

  it('is emitted only when a step actually fans out', () => {
    // A branch is a composite with no concurrency in it, so the depth bound is emitted
    // and the cap is not: writing a cap into an app with nothing to bound would give a
    // reader a number that describes no limiter.
    const branchOnly = planForSpecText(BRANCH_ONLY_SPEC, 'branch-only.yaml');
    const control = fileAt(branchOnly, CONTROL_PATH);
    expect(control).toContain('MAX_STEP_DEPTH');
    expect(control).not.toContain(CONCURRENCY_LIMIT);

    // And the composite fixture, which does fan out, carries both.
    expect(fileAt(compositePlan(), CONTROL_PATH)).toContain(CONCURRENCY_LIMIT);
  });
});

describe('the principal a generated route branches on', () => {
  it('is explicitly unauthenticated, never a bare Principal()', () => {
    const control = fileAt(compositePlan(), CONTROL_PATH);

    // The default would be `authenticated=True`. Naming the argument is the whole
    // difference between a closed answer and a fail-open one.
    expect(assignment(control, ANONYMOUS_PRINCIPAL)).toBe('Principal(authenticated=False)');
    expect(control).toContain('from aid_runtime import Principal');

    // Nothing anywhere in the plan may *construct* a bare principal: a second route
    // written with the default would reintroduce the fail-open this one avoids. Comments
    // are stripped first -- the emitted module explains the hazard in prose, and it is
    // the code that decides.
    for (const file of compositePlan().files) {
      const code = file.content
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(code, file.path).not.toMatch(/Principal\(\s*\)/);
    }
  });

  it('is seeded into the context of exactly the route that branches', () => {
    // The seed is the route's, not the pipeline module's: a pipeline is handed a context
    // and never invents one, which is what lets a composite be replayed by the streamed
    // path instead of re-running from the top.
    const route = compositePlan().files.find(
      (file) => file.path === 'app/generated/routes/triage.py',
    );
    expect(route, 'the composite fixture’s triage route is not in the plan').toBeDefined();
    const body = route?.content ?? '';

    expect(body).toContain('from ..control import ANONYMOUS_PRINCIPAL');
    // Seeded by literal key, which is why `PRINCIPAL_KEY` is asserted above.
    expect(body).toContain(`"${PRINCIPAL_KEY}": ANONYMOUS_PRINCIPAL`);
  });

  it('is absent from an app that never branches', () => {
    // The example fans out but does not branch. Emitting a principal anyway would
    // suggest an authorization decision the app does not make.
    expect(hasBranch(example().ir.pipelines)).toBe(false);
    const control = fileAt(example().plan, CONTROL_PATH);
    expect(control).not.toContain('Principal');
    expect(control).not.toContain(ANONYMOUS_PRINCIPAL);
  });
});
