/**
 * The eval driver a compiled target needs and an interpreted one does not.
 *
 * Running `node dist/app/generated/evals/<name>.js` directly is the plain entry point,
 * and it is the right thing when the store outlives the process. A `kind: memory` store
 * does not: the index one process writes is gone before the next one samples it, so a
 * retrieval gate would score an empty corpus and report 0.0 -- a failure that says
 * nothing about retrieval. This module ingests once through the same `Deps` instance the
 * gate samples, which is what makes the number mean what the baseline recorded.
 *
 * Emitted rather than scaffolded because it names the generated modules it loads: after a
 * rename, a copy the developer owns would be a stale second source of truth. The Python
 * target needs no equivalent because its eval modules import source, so
 * `python -m app.generated.evals.<name>` already runs from the tree.
 */

import type { EmittedFile } from './file.js';
import { generated, paths } from './file.js';
import { moduleText } from './text.js';

/**
 * The script every eval suite runs. Its argument is the eval's id, so a workflow step
 * names the same identifier the spec does.
 */
export function emitEvalDriver(): EmittedFile {
  return generated(paths.evalsDriver, moduleText(driverBody().join('\n')));
}

function driverBody(): string[] {
  return [
    '/**',
    ' * Runs the generated eval gates against a real model, indexing the corpus first.',
    ' *',
    ' * Usage: `node app/generated/evals/run-evals.mjs <eval> [<eval> ...]`',
    ' */',
    "import { join } from 'node:path';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    '',
    '/** `import()` needs a file URL: a Windows absolute path is rejected outright. */',
    'const importPath = (path) => pathToFileURL(path).href;',
    '',
    "const root = fileURLToPath(new URL('../../..', import.meta.url));",
    "const appDir = join(root, 'app');",
    '',
    '/**',
    ' * Where the build puts the generated modules. A project whose tsconfig emits',
    ' * somewhere else sets `AID_EVAL_MODULES` to that directory.',
    ' */',
    "const modules = process.env.AID_EVAL_MODULES ?? join(root, 'dist', 'app', 'generated');",
    '',
    'const names = process.argv.slice(2);',
    'if (names.length === 0) {',
    "  console.error('usage: node app/generated/evals/run-evals.mjs <eval> [<eval> ...]');",
    '  process.exit(2);',
    '}',
    '',
    'let buildDeps;',
    'let buildRetrievers;',
    'try {',
    "  ({ buildDeps } = await import(importPath(join(modules, 'deps.js'))));",
    "  ({ buildRetrievers } = await import(importPath(join(modules, 'retrieval', 'index.js'))));",
    '} catch {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source, not interpolation
    '  console.error(`cannot load the built modules from ${modules}; run npm run build first`);',
    '  process.exit(2);',
    '}',
    '',
    '// One index for the whole run: every retrieval eval scores the same corpus, and',
    '// re-indexing per eval would only repeat identical work.',
    'const retrievers = buildRetrievers({ baseDir: appDir });',
    'let indexed = false;',
    'let shared;',
    '',
    '/**',
    ' * The `Deps` the gate samples. A retrieval eval gets the indexed map, so the',
    ' * documents it scores are the documents this process just wrote; any other eval',
    ' * gets the same map unindexed, because it never reads it.',
    ' */',
    'async function depsFor(evalModule) {',
    '  if (evalModule.RETRIEVER !== undefined && !indexed) {',
    '    for (const retriever of retrievers.values()) await retriever.ingest();',
    '    indexed = true;',
    '  }',
    '  if (shared === undefined) shared = buildDeps({ baseDir: appDir, retrievers });',
    '  return shared;',
    '}',
    '',
    'let failed = 0;',
    'for (const name of names) {',
    '  let evalModule;',
    '  try {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source, not interpolation
    "    evalModule = await import(importPath(join(modules, 'evals', `${name}.js`)));",
    '  } catch (error) {',
    '    const message = error instanceof Error ? error.message : String(error);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '    console.error(`${name}: cannot load the eval: ${message}`);',
    '    failed += 1;',
    '    continue;',
    '  }',
    '  try {',
    '    const result = await evalModule.runGate(await depsFor(evalModule));',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '    console.log(`${name}: ${result.summary()}`);',
    '    if (result.failures().length > 0) failed += 1;',
    '  } catch (error) {',
    '    const message = error instanceof Error ? error.message : String(error);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '    console.error(`${name}: ${message}`);',
    '    failed += 1;',
    '  }',
    '}',
    '',
    'process.exitCode = failed === 0 ? 0 : 1;',
  ];
}
