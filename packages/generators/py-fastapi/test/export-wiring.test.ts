/**
 * The exporter declaration: `app/generated/observability.py`.
 *
 * `export: otlp` is the one observability promise that leaves the process, and for seven
 * phases it left nothing: the document said the spans should reach a collector, the
 * generated app reported the destination, and no code anywhere read it. The gate that
 * refused an alarm over an unexported series (`alerts-unexported`) named the discrepancy
 * without closing it.
 *
 * The fix cannot be an import side effect. A runtime library that installed a global
 * exporter on import would decide telemetry for every application embedding it, so
 * `aid_runtime.telemetry.configure_export` installs one only when called. And the
 * generator cannot make that call either: the ASGI entrypoint belongs to the developer,
 * which `emit/package.ts` records as the ownership boundary. So what is emitted is the
 * *declaration* -- a helper that names the document's own export and endpoint variable and
 * delegates to the runtime -- and these tests hold the three properties that makes it
 * worth anything:
 *
 *   1. It reports the document, not the target's defaults. A helper that hardcoded `otlp`
 *      would export spans for every spec that never asked, which is a worse failure than
 *      the gap it fixed.
 *   2. It passes the document's endpoint *variable name* through rather than the default.
 *      An exporter wired to the wrong environment variable reports "unset" forever and
 *      reads exactly like a collector that is down.
 *   3. Nothing installs at import. The call site is the developer's, so the module must be
 *      inert until it is called.
 */

import { describe, expect, it } from 'vitest';

import { OBSERVABILITY_PATH } from '../src/emit/observability.js';
import { buildForSpecText, exampleSpecText } from './helpers.js';

/** The emitted module's bytes for one spec. */
function observabilityFor(text: string): string {
  const { plan } = buildForSpecText(text);
  const file = plan.files.find((planned) => planned.path === OBSERVABILITY_PATH);
  if (file === undefined) {
    throw new Error(`${OBSERVABILITY_PATH} is not in the plan`);
  }
  return file.content;
}

/**
 * The example with an export declared.
 *
 * The example is deliberately minimal and carries no `observability` section, so the
 * default case is already pinned by the shipped tree. This derives the other branch from
 * the same document rather than hand-writing a second spec: the only two edits are the
 * version the section arrived in and the section itself, so a difference in the output is
 * attributable to the declaration and nothing else.
 */
const OTLP_ENV = 'AID_COLLECTOR_ENDPOINT';

function exportedSpecText(): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.27"')
    .replace(
      'project:',
      [
        'observability:',
        '  trace: true',
        '  export: otlp',
        `  endpointEnv: ${OTLP_ENV}`,
        '',
        'project:',
      ].join('\n'),
    );
}

/** The `configure_export(...)` call the helper makes, as keywords. */
function callArguments(source: string): string {
  const start = source.indexOf('    return configure_export(');
  if (start === -1) throw new Error('no configure_export call');
  const end = source.indexOf('\n    )', start);
  if (end === -1) throw new Error('the configure_export call is not closed');
  return source.slice(start, end + '\n    )'.length);
}

describe('the exporter declaration', () => {
  it('says the document exports nothing when it declares nothing, rather than defaulting to otlp', () => {
    const source = observabilityFor(exampleSpecText());

    // The example predates the section entirely. Treating an absent `export` as `otlp`
    // would make every document written before 0.27 start shipping spans to a collector
    // none of them configured, which is the silent decision the schema refuses to make.
    expect(source).toContain('"export": "none",');
    expect(callArguments(source)).toContain('declared="none",');
  });

  it('reports the default endpoint variable when the document names none', () => {
    const source = observabilityFor(exampleSpecText());

    // Only reachable with `export` not `otlp`, since the schema requires the two together.
    // Naming it anyway keeps one signature for every generated app, so a document that
    // later adds `otlp` does not change the shape of the call.
    expect(source).toContain('"endpointEnv": "OTEL_EXPORTER_OTLP_ENDPOINT",');
    expect(callArguments(source)).toContain('endpoint_env="OTEL_EXPORTER_OTLP_ENDPOINT",');
  });

  it('passes the declared endpoint variable through instead of the default', () => {
    const source = observabilityFor(exportedSpecText());

    // The claim `export: otlp` makes is not "spans leave" but "spans leave for the
    // address this variable holds". An emitter that kept reading
    // OTEL_EXPORTER_OTLP_ENDPOINT after the document named another one would report an
    // unset endpoint forever, and report it as if the operator had not configured one.
    expect(source).toContain('"export": "otlp",');
    expect(source).toContain(`"endpointEnv": "${OTLP_ENV}",`);
    expect(callArguments(source)).toContain(`endpoint_env="${OTLP_ENV}",`);
    expect(callArguments(source)).toContain('declared="otlp",');
  });

  it('delegates to the runtime instead of importing the exporter itself', () => {
    const source = observabilityFor(exportedSpecText());

    // The exporter is a separate distribution (`aid-runtime-python[otlp]`), so a generated
    // import of it would turn an optional dependency into a hard one for every app that
    // declares observability. The runtime owns the lazy import and the failure message;
    // the generated file names only the two names that carry a status back.
    expect(source).toContain('from aid_runtime.telemetry import ExportStatus, configure_export');
    expect(source).not.toContain('opentelemetry');
  });

  it('installs nothing at import, because the call site belongs to the application', () => {
    const source = observabilityFor(exportedSpecText());

    // Every reference to the runtime is inside a function body. A module-level call would
    // install a global provider the moment anything imported the generated tree -- every
    // test, every CLI subcommand -- and `set_tracer_provider` cannot be undone.
    const references = source.split('configure_export(').length - 1;
    expect(references).toBe(1);
    expect(source).toContain('\n    return configure_export(\n');
    expect(source).not.toMatch(/^\s*configure_export\(/m);
  });

  it('emits lines a formatter would leave alone', () => {
    // The docstring is wrapped by the emitter rather than left to `ruff format`, because
    // generated files are pinned by digest and CI runs `ruff format --check`: a docstring
    // that overran the limit would be rewritten by the first developer who ran the
    // formatter and would then fail the digest instead of the lint.
    const overlong = observabilityFor(exportedSpecText())
      .split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => line.length > 100);
    expect(overlong).toEqual([]);
  });
});
