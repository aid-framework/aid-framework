#!/usr/bin/env node
/**
 * Regenerates one of the `examples/` apps from its spec.
 *
 * The app defaults to `support-copilot`; pass an example directory name as the
 * first argument to regenerate another one (`pnpm generate:guarded` does that for
 * `examples/guarded-reply`). Both apps go through the identical path below, which
 * is the point: a second example must not demonstrate a different generator.
 *
 * This is the example's `aid gen`, and it is deliberately three library calls rather
 * than a bespoke code path: the spec is checked and lowered by `@aid/spec` and `@aid/ir`,
 * the IR is gated, and the plan is applied through the generator SDK's regeneration
 * algorithm -- the same one the CLI will use (design §10). That matters for the example
 * specifically, because the algorithm is what preserves `app/business/**` and refuses to
 * overwrite a generated file a human edited, and an example that wrote its output with
 * `writeFileSync` in a loop would demonstrate the opposite of the ownership model.
 *
 * Run it from the repository root: `pnpm generate:example`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNodeSink,
  parseAidManifestJson,
  regenerate,
  serializeAidManifest,
} from '@aid/generator-sdk';
import { buildIR, runGates } from '@aid/ir';
import { checkSpecText } from '@aid/spec';
import {
  GENERATOR_NAME,
  GENERATOR_VERSION,
  PY_FASTAPI_MANIFEST,
  PY_FASTAPI_TARGET,
} from '../dist/manifest.js';
import { planPyFastApi } from '../dist/plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const example = process.argv[2] ?? 'support-copilot';
const appRoot = join(repoRoot, 'examples', example);
const specPath = join(appRoot, 'app', 'app.spec.yaml');
const manifestPath = join(appRoot, 'app', 'aid.manifest.json');

const sink = createNodeSink(appRoot);

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function render(diagnostics) {
  return diagnostics.map(
    (diagnostic) =>
      `  ${diagnostic.severity}: ${diagnostic.path.join('.') || '<document>'}: ${diagnostic.message}`,
  );
}

const spec = checkSpecText(readFileSync(specPath, 'utf8'), { file: specPath });
if (!spec.ok) {
  fail(['app.spec.yaml did not pass the spec checks:', ...render(spec.diagnostics)]);
}

const { ir, diagnostics: buildDiagnostics } = buildIR(spec.value, { file: specPath });
const buildErrors = buildDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
if (buildErrors.length > 0) {
  fail(['app.spec.yaml did not lower to an IR:', ...render(buildErrors)]);
}

// The capabilities this generator declares travel with the IR, the way they do under
// the CLI. Left to its default, `runGates` falls back to `@aid/ir`'s placeholder
// catalog, which declares no retrieval at all: the example would then be gated against a
// narrower vocabulary than the target really has, and a spec asking for retrieval would
// be rejected here while `aid gen` accepted it.
const gates = runGates(ir, {
  targetCapabilities: { [PY_FASTAPI_TARGET]: PY_FASTAPI_MANIFEST.capabilities },
});
const gateErrors = gates.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
if (gateErrors.length > 0) {
  fail(['the IR did not pass the build gates:', ...render(gateErrors)]);
}

let plan;
try {
  plan = planPyFastApi(ir);
} catch (error) {
  fail([String(error instanceof Error ? error.message : error)]);
}

const existing = existsSync(manifestPath)
  ? parseAidManifestJson(sink.read('app/aid.manifest.json') ?? '', {
      generatedDir: 'app/generated',
      businessDir: 'app/business',
    })
  : { diagnostics: [] };

const provenance = {
  generator: GENERATOR_NAME,
  generatorVersion: GENERATOR_VERSION,
  irVersion: ir.irVersion,
};

const { report, manifest } = regenerate(plan, {
  sink,
  manifest: existing.manifest,
  provenance,
});

const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
if (errors.length > 0) {
  fail([
    'generation refused to overwrite files that changed since the manifest was written:',
    ...render(errors),
  ]);
}

sink.write('app/aid.manifest.json', serializeAidManifest(manifest));

console.log(
  `${example}: ${report.created.length} created, ${report.updated.length} updated, ` +
    `${report.unchanged.length} unchanged, ${report.kept.length} kept (business)`,
);
for (const diagnostic of report.diagnostics) {
  console.log(`  ${diagnostic.severity}: ${diagnostic.path}: ${diagnostic.message}`);
}
