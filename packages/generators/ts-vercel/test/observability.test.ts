/**
 * What this target refuses to promise about spans.
 *
 * The manifest declares `otel`, and that declaration is true: `runtimes/typescript/src/
 * tracing.ts` records spans against the GenAI attribute schema, so an operator gets step,
 * model and tool spans in-process. It has never meant the spans leave --
 * `tracing.ts` is API-only on purpose, because "a runtime that demanded a tracer would
 * make tracing a precondition for calling a model".
 *
 * `export: otlp` asks for the leaving half. Until this gate existed the target accepted the
 * declaration and generated a deployment that names a collector in its environment and
 * sends nothing to it: the gap reads as healthy, because a service with no export looks
 * exactly like a service whose collector is quiet. The refusal is the same rule the rest
 * of `validate.ts` follows -- refuse rather than approximate -- and it names both halves of
 * the fix, since the document itself is legal.
 */

import { describe, expect, it } from 'vitest';

import { TsVercelPlanError } from '../src/errors.js';
import { TS_VERCEL_MANIFEST } from '../src/manifest.js';
import { planTsVercel } from '../src/plan.js';
import { checkObservability } from '../src/validate.js';
import { exampleSpecText, irForSpecText } from './helpers.js';

const COLLECTOR_ENV = 'AID_COLLECTOR_ENDPOINT';

/** The example with an export declared, at the version the section arrived in. */
function exportedSpecText(exportKind: 'otlp' | 'none'): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.27"')
    .replace(
      'project:',
      [
        'observability:',
        '  trace: true',
        `  export: ${exportKind}`,
        `  endpointEnv: ${COLLECTOR_ENV}`,
        '',
        'project:',
      ].join('\n'),
    );
}

describe('exporting spans from a target that installs no exporter', () => {
  it('refuses `export: otlp` rather than accepting a destination nothing writes to', () => {
    const ir = irForSpecText(exportedSpecText('otlp'));
    expect(checkObservability(ir)).toEqual([
      {
        code: 'observability-export-unsupported',
        path: 'observability.export',
        message: expect.stringContaining('installs no exporter'),
      },
    ]);
  });

  it('names the fix as well as the refusal, because the document is otherwise legal', () => {
    const ir = irForSpecText(exportedSpecText('otlp'));
    const [problem] = checkObservability(ir);

    // A gate that only says "not supported" leaves the author guessing whether the
    // document is wrong or the target is. Both ways out are named: generate it with the
    // target that wires the exporter, or stop asking this one to export.
    expect(problem?.message).toContain('py-fastapi');
    expect(problem?.message).toContain('`export: none`');
  });

  it('fails generation, not only a check a caller could skip', () => {
    const ir = irForSpecText(exportedSpecText('otlp'));

    // The refusal has to reach `aid gen`. A check that only ran when someone called it
    // would leave the default path emitting the deployment the gate exists to prevent.
    // Collected rather than asserted inside the `catch`, so a plan that quietly succeeds
    // fails this test instead of passing through it.
    let thrown: unknown;
    try {
      planTsVercel(ir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TsVercelPlanError);
    const codes = (thrown as TsVercelPlanError).problems.map((problem) => problem.code);
    expect(codes).toContain('observability-export-unsupported');
  });

  it('accepts `export: none`, which asks for nothing this target cannot do', () => {
    // The same document with the honest half of the enum. Spans stay in-process, which is
    // what the target has always done, so refusing this would be refusing its own
    // behaviour.
    const ir = irForSpecText(exportedSpecText('none'));
    expect(checkObservability(ir)).toEqual([]);
    expect(() => planTsVercel(ir)).not.toThrow();
  });

  it('accepts a document that declares no export at all', () => {
    const ir = irForSpecText(exampleSpecText());
    expect(checkObservability(ir)).toEqual([]);
  });

  it('keeps the `otel` capability, because recording spans was never the export', () => {
    // The reconciliation this gate rests on: `otel` is about the attribute schema the
    // runtime writes and `export` is about the transport it does not have. If `otel` were
    // withdrawn here the refusal would be redundant and the recorded spans would be
    // undeclared; if the refusal were dropped the declaration would be a promise the
    // target does not keep.
    expect(TS_VERCEL_MANIFEST.capabilities).toContain('otel');
    expect(TS_VERCEL_MANIFEST.emitsAgainst.tracing).toBe('otel-genai');
  });
});
