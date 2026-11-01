/**
 * `generated/evals/*` and `generated/business/*`.
 *
 * An eval module is generated, not constructed at run time: the dataset, the metrics and
 * the gate thresholds are all IR inputs, so the harness a failure points at is reviewable
 * in the diff that changed it.
 *
 * A business module is the opposite: generated exactly once and then owned by the
 * application. `planRegeneration` never overwrites it, which is why the seed has to
 * compile and fail loudly rather than compile and return a plausible lie.
 */

import {
  type EvalShape,
  evalSubject,
  type IR,
  type MetricShape,
  type ToolShape,
} from '@aid-framework/ir';
import { className, literal, propertyKey, toSnakeCase } from '../names.js';
import {
  business,
  businessToolPath,
  type EmittedFile,
  evalModulePath,
  generated,
  paths,
} from './file.js';
import {
  arrayLiteral,
  type Entry,
  exportStatement,
  fits,
  importStatement,
  moduleText,
  objectLiteral,
  seedText,
  sortStatements,
} from './text.js';

function metricExpression(metric: MetricShape, indent = ''): string {
  switch (metric.kind) {
    case 'exact':
      return `new ExactMatch({ name: ${literal('exact')} })`;
    case 'contains':
      return `new NormalizedContains({ name: ${literal('contains')} })`;
    case 'json-schema':
      return `new JsonSchemaValid({ name: ${literal('json-schema')} })`;
    case 'assert': {
      // The parsed predicate lives in a module-level `ASSERT_EXPR` constant, so it
      // travels as data and the generated eval needs no parser of its own and cannot
      // disagree with the one that validated the spec. Hoisting it also keeps the
      // emission one short line whatever the expression's depth.
      const entries: Entry[] = [
        ['name', literal('assert')],
        ['expr', 'ASSERT_EXPR'],
        ['message', literal(metric.message)],
      ];
      const inline = `new AssertMetric(${objectLiteral(entries, '')})`;
      // The declared message is prose of unbounded length, so the element is the one
      // thing in `metrics()` that can exceed the width on its own; the object spreads
      // over lines exactly as `biome` spreads it when that happens.
      return fits(indent, inline) ? inline : `new AssertMetric(${objectLiteral(entries, indent)})`;
    }
    default:
      return 'unsupportedMetric';
  }
}

/**
 * A JSON literal that breaks across lines when it does not fit.
 *
 * `literal` renders one line always, and a predicate AST nests three or four objects
 * deep, so reusing it here would emit lines past the formatter's width. Rendered at
 * indent `''` from a `const`, the continuation lines land exactly where `biome` puts
 * them, which is what keeps the generated file format-clean in CI.
 */
function jsonLiteral(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    return arrayLiteral(
      value.map((item) => jsonLiteral(item, `${indent}  `)),
      indent,
    );
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]): [string, string] => [propertyKey(key), jsonLiteral(item, `${indent}  `)]);
    return objectLiteral(entries, indent);
  }
  return literal(value);
}

/** The retriever a retrieval eval samples: the eval's own pipeline, else the only one. */
export function evalRetriever(ir: IR, evalShape: EvalShape): string | undefined {
  if (evalShape.target.kind === 'pipeline') {
    const pipeline = ir.pipelines.find((candidate) => candidate.id === evalShape.target.id);
    const step = pipeline?.steps.find((candidate) => candidate.kind === 'retrieve');
    if (step !== undefined && step.kind === 'retrieve') return step.retriever;
  }
  return ir.retrievers.length === 1 ? ir.retrievers[0]?.id : undefined;
}

function loadDataset(evalShape: EvalShape): string[] {
  const uri = evalShape.dataset.uri;
  if (uri === undefined) {
    return [
      '  // The spec declares no dataset file, so the suite cannot be loaded from the',
      '  // repository. Supply cases with Dataset.fromRecords before running it.',
      `  throw new ConfigurationError(${literal(`eval ${evalShape.id} declares no dataset file`)});`,
    ];
  }
  return [`  return Dataset.fromPath(asset(${literal(uri)}));`];
}

function datasetBody(evalShape: EvalShape): string[] {
  return [
    '/**',
    ` * Load the dataset the \`${evalShape.id}\` eval declares.`,
    ' *',
    ' * Read lazily rather than at import time: the dataset is a file, and importing a',
    ' * module should not be able to throw because of the working directory.',
    ' */',
    'export function dataset(): Dataset {',
    ...loadDataset(evalShape),
    '}',
  ];
}

function gateBody(evalShape: EvalShape, metrics: readonly string[]): string[] {
  const maxRegression = literal(evalShape.gate.maxRegression);
  // A floor belongs to the metric it floors. An `assert` metric is only meaningful when
  // every case passes, so it carries the declared floor and the runtime checks that floor
  // before it looks at the regression delta -- a tolerance cannot excuse a false assertion.
  const floor = evalShape.gate.minMean;
  const extra = floor === undefined ? '' : ', minMean: floors[metric]';
  const list = arrayLiteral(
    metrics.map((metric) => literal(metric)),
    '  ',
  );
  const inline = `  const thresholds = ${list}.map((metric) => new Threshold({ metric, maxRegression: ${maxRegression}${extra} }));`;
  return [
    '/**',
    // A spec with no declared floor emits the prose it always emitted, so the shipped
    // example stays byte for byte what it was.
    ...(floor === undefined
      ? [
          ' * The gate the spec asks for: one absolute-free threshold per emitted metric, each',
          ' * allowing the declared regression. `minMean` stays unset because the spec carries no',
          ' * floor, and a floor the spec did not ask for would fail a run for the wrong reason.',
        ]
      : [
          ' * The gate the spec asks for: one threshold per emitted metric, each allowing the',
          ' * declared regression. `minMean` is set only for the metric the spec floored, and a',
          ' * floor the spec did not ask for would fail a run for the wrong reason.',
        ]),
    ' */',
    'export function gate(): BaselineGate {',
    ...(floor === undefined
      ? []
      : [`  const floors: Record<string, number> = { assert: ${literal(floor)} };`]),
    ...(fits('', inline)
      ? [inline]
      : [
          `  const thresholds = ${list}.map(`,
          `    (metric) => new Threshold({ metric, maxRegression: ${maxRegression}${extra} }),`,
          '  );',
        ]),
    '  return new BaselineGate(thresholds, { metrics: metrics() });',
    '}',
  ];
}

/**
 * The baseline and entry-point blocks every generated eval ends with.
 *
 * Shared rather than repeated: the exit status is the verdict `aid eval` and the `evals`
 * CI job both read, so a retrieval eval that exited differently from a classification
 * eval would make the two disagree about the same failure. The baseline lives under
 * `app/evals/` at the same path the Python target writes, so the two targets' committed
 * `evals/` directories are the same shape.
 *
 * `model` is the expression naming what the baseline records as measured: `MODEL` for a
 * prediction eval, `RETRIEVER` for a retrieval eval. `EvalBaseline.model` is descriptive
 * -- the gate never compares it -- but leaving it empty would make a committed baseline
 * say less than the one beside it.
 */
function evalConstants(evalShape: EvalShape): string[] {
  const stem = toSnakeCase(evalShape.id);
  const baseline = `asset(${literal(`evals/${stem}.baseline.json`)})`;
  return [
    '/** The eval id: it names the baseline file and every diagnostic about it. */',
    `export const EVAL_ID = ${literal(evalShape.id)};`,
    '/** The stored measurement this eval is compared against. */',
    ...(fits('', `export const BASELINE_PATH = ${baseline};`)
      ? [`export const BASELINE_PATH = ${baseline};`]
      : [
          'export const BASELINE_PATH = asset(',
          `  ${literal(`evals/${stem}.baseline.json`)},`,
          ');',
        ]),
    '/** How many runs one sample takes; the baseline records the same count. */',
    `export const SAMPLES = ${literal(evalShape.gate.samples)};`,
  ];
}

/**
 * The baseline loader, the recorder and the entry point every generated eval ends with.
 *
 * Shared rather than repeated: the exit status is the verdict `aid eval` and the `evals`
 * CI job both read, so a retrieval eval that exited differently from a classification
 * eval would make the two disagree about the same failure. The baseline lives under
 * `app/evals/` at the same path the Python target writes, so the two targets' committed
 * `evals/` directories are the same shape.
 *
 * `model` is the expression naming what the baseline records as measured: `MODEL` for a
 * prediction eval, `RETRIEVER` for a retrieval eval. `EvalBaseline.model` is descriptive
 * -- the gate never compares it -- but leaving it empty would make a committed baseline
 * say less than the one beside it.
 *
 * `deps` is the one argument every entry point takes and none of them require. It is the
 * same seam the generated pipelines expose, so a test records and checks a committed
 * baseline against a deterministic provider instead of a live one -- which is the only way
 * a stored measurement can be reproducible.
 */
function evalEntrypoints(model: string): string[] {
  return [
    '/**',
    ' * A checked-in input, resolved from the project root rather than from this file.',
    ' *',
    ' * The eval runs from build output, and `dist/` carries no `evals/` beside it: the',
    ' * dataset and the baseline are inputs, kept in the tree. The nearest ancestor',
    ' * `package.json` is the root above both `app/` and `dist/`, so the same call finds',
    ' * the same file from source and from a build, and a recorded baseline lands in the',
    ' * tree rather than inside `dist/`.',
    ' */',
    'function asset(relative: string): URL {',
    '  let directory = dirname(fileURLToPath(import.meta.url));',
    "  while (!existsSync(join(directory, 'package.json'))) {",
    '    const parent = dirname(directory);',
    '    if (parent === directory) break;',
    '    directory = parent;',
    '  }',
    "  return pathToFileURL(join(directory, 'app', relative));",
    '}',
    '',
    '/**',
    ' * The baseline this module compares against. Record one from a run you accept rather',
    ' * than writing one by hand.',
    ' */',
    'export function loadBaseline(): EvalBaseline {',
    '  if (!existsSync(BASELINE_PATH)) {',
    '    throw new ConfigurationError(',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '      `${EVAL_ID} has no baseline at ${fileURLToPath(BASELINE_PATH)}; record one with ` +',
    "        '`aid eval --baseline`',",
    '    );',
    '  }',
    '  return EvalBaseline.fromPath(BASELINE_PATH);',
    '}',
    '',
    '/** Sample the suite and write the baseline `loadBaseline()` reads back. */',
    'export async function recordBaseline(',
    '  options: { readonly note?: string; readonly deps?: Deps | undefined } = {},',
    '): Promise<EvalBaseline> {',
    '  const measured = await sample({ deps: options.deps });',
    '  const baseline = EvalBaseline.fromRun(measured, {',
    `    model: ${model},`,
    "    note: options.note ?? '',",
    '  });',
    '  mkdirSync(dirname(fileURLToPath(BASELINE_PATH)), { recursive: true });',
    '  writeFileSync(BASELINE_PATH, baseline.toJson());',
    '  return baseline;',
    '}',
    '',
    '/** Measure the app and compare the result against the stored baseline. */',
    'export async function runGate(deps?: Deps): Promise<GateResult> {',
    '  return evaluate(await sample({ deps }), loadBaseline());',
    '}',
    '',
    '// The gate runs only as the entry point, never when the index re-exports this module:',
    '// Node sets `argv[1]` to the file it was asked to run.',
    ...(() => {
      const condition =
        'if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {';
      return fits('', condition)
        ? [condition]
        : [
            'if (',
            '  process.argv[1] !== undefined &&',
            '  resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
            ') {',
          ];
    })(),
    '  try {',
    '    const result = await runGate();',
    '    console.log(result.summary());',
    '    process.exitCode = result.failures().length === 0 ? 0 : 1;',
    '  } catch (error) {',
    '    // A crash is not a metric that came in under threshold. Say what broke in one',
    '    // line, because a stack trace standing in for a verdict reads as a gate failure.',
    '    const message = error instanceof Error ? error.message : String(error);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '    console.error(`${EVAL_ID}: ${message}`);',
    '    process.exitCode = 1;',
    '  }',
    '}',
  ];
}

/**
 * The `@aid-framework/runtime` names a plain eval module needs: only the metrics the spec
 * actually asks for, because the emitted module has no other way to use one.
 */
function plainEvalImports(metrics: readonly MetricShape[]): { name: string; type: boolean }[] {
  const names = metrics.map((metric) => metric.kind);
  return [
    ...(names.includes('assert') ? [{ name: 'AssertMetric', type: false }] : []),
    { name: 'BaselineGate', type: false },
    { name: 'ConfigurationError', type: false },
    { name: 'Dataset', type: false },
    { name: 'EvalBaseline', type: false },
    ...(names.includes('exact') ? [{ name: 'ExactMatch', type: false }] : []),
    { name: 'GatewayRunner', type: false },
    ...(names.includes('json-schema') ? [{ name: 'JsonSchemaValid', type: false }] : []),
    ...(names.includes('contains') ? [{ name: 'NormalizedContains', type: false }] : []),
    { name: 'Threshold', type: false },
    { name: 'runEvaluation', type: false },
    { name: 'EvalRun', type: true },
    { name: 'GateResult', type: true },
    { name: 'Metric', type: true },
  ];
}

/**
 * The Node builtins a generated eval needs: the baseline file it reads, writes and
 * locates, and the entry-point test that keeps an import from running the gate.
 */
function nodeEvalImports(): string {
  return [
    importStatement('node:fs', [
      { name: 'existsSync', type: false },
      { name: 'mkdirSync', type: false },
      { name: 'writeFileSync', type: false },
    ]),
    importStatement('node:path', [
      { name: 'dirname', type: false },
      { name: 'join', type: false },
      { name: 'resolve', type: false },
    ]),
    importStatement('node:url', [
      { name: 'fileURLToPath', type: false },
      { name: 'pathToFileURL', type: false },
    ]),
  ].join('\n');
}

function plainEvalModule(ir: IR, evalShape: EvalShape): string {
  const metrics = evalShape.metrics.filter((metric) => metric.kind !== 'retrieval');
  const names = metrics.map((metric) => metric.kind);
  const asserted = metrics.find((metric) => metric.kind === 'assert');
  const subject = evalSubject(ir, evalShape);
  if (!subject.ok) {
    throw new Error(`eval '${evalShape.id}' has no single subject: ${subject.message}`);
  }
  const header = [
    nodeEvalImports(),
    importStatement('@aid-framework/runtime', plainEvalImports(metrics)),
    importStatement('../deps.js', [
      { name: 'Deps', type: true },
      { name: 'buildDeps', type: false },
    ]),
  ].join('\n');
  const body = [
    '/** The model alias this eval measures: the one the app pins for its prompt. */',
    `export const MODEL = ${literal(subject.subject.model)};`,
    ...evalConstants(evalShape),
    '',
    ...(asserted === undefined || asserted.kind !== 'assert'
      ? []
      : [
          '/**',
          ' * The asserted predicate. The IR parsed and checked it, so the generated eval',
          ' * carries it as data: no expression string is ever evaluated here.',
          ' */',
          `const ASSERT_EXPR = ${jsonLiteral(asserted.expr, '')};`,
          '',
        ]),
    ...datasetBody(evalShape),
    '',
    '/** The metrics the spec asks for, in declaration order. */',
    'export function metrics(): readonly Metric[] {',
    ...(() => {
      const items = metrics.map((metric) => metricExpression(metric, '    '));
      const inline = `  return [${items.join(', ')}];`;
      return fits('', inline)
        ? [inline]
        : ['  return [', ...items.map((item) => `    ${item},`), '  ];'];
    })(),
    '}',
    '',
    ...gateBody(evalShape, names),
    '',
    '/** Sample the suite and return the run a baseline gate compares against. */',
    'export async function sample(',
    '  options: { readonly runs?: number; readonly deps?: Deps | undefined } = {},',
    '): Promise<EvalRun> {',
    '  const deps = options.deps ?? buildDeps();',
    `  const runner = new GatewayRunner(deps.gateway, ${literal(subject.subject.model)}, {});`,
    '  return await runEvaluation(dataset(), (entry) => runner.run(entry), metrics(), {',
    '    runs: options.runs ?? SAMPLES,',
    '  });',
    '}',
    '',
    '/** Decide whether a run regressed against its baseline. */',
    'export function evaluate(run: EvalRun, baseline: EvalBaseline): GateResult {',
    '  return gate().evaluate(run, baseline);',
    '}',
    ...evalEntrypoints(literal(subject.subject.model)),
  ].join('\n');
  return moduleText(header, body);
}

function retrievalEvalModule(ir: IR, evalShape: EvalShape, metric: MetricShape): string {
  const retriever = evalRetriever(ir, evalShape);
  const expectDocs = metric.kind === 'retrieval' ? [...metric.expectDocs] : [];
  const k = metric.kind === 'retrieval' ? metric.k : 5;
  const header = [
    nodeEvalImports(),
    importStatement('@aid-framework/runtime', [
      { name: 'ConfigurationError', type: false },
      { name: 'Dataset', type: false },
      { name: 'EvalBaseline', type: false },
      { name: 'RetrievalCase', type: false },
      { name: 'RetrievalGate', type: false },
      { name: 'RetrievalMetricSpec', type: false },
      { name: 'Threshold', type: false },
      { name: 'retrievalMetrics', type: false },
      { name: 'EvalRun', type: true },
      { name: 'GateResult', type: true },
    ]),
    importStatement('../deps.js', [
      { name: 'Deps', type: true },
      { name: 'buildDeps', type: false },
    ]),
  ].join('\n');
  const body = [
    "// The expected documents and `k` are the IR's `retrieval` metric node, so every case",
    '// in this dataset asks the same question of the same pages: the IR carries the',
    '// expectation on the metric, not per case, and inventing a per-case split here would',
    '// be an expectation no spec declared.',
    `const EXPECT_DOCS: readonly string[] = ${arrayLiteral(
      expectDocs.map((doc) => literal(doc)),
      '',
    )};`,
    `/** How many ranked results count as an answer. */
export const TOP_K = ${literal(k)};
/** The retriever this eval measures, by the id the app binds it under. */
export const RETRIEVER = ${literal(retriever ?? '')};`,
    ...evalConstants(evalShape),
    '',
    ...datasetBody(evalShape),
    '',
    "/** The `app/` directory: the base the spec's relative source uris resolve against. */",
    'function appDir(): string {',
    "  return dirname(fileURLToPath(asset('.')));",
    '}',
    '',
    '/** One ranked, cited result per case, scored by the metrics retrieval ships. */',
    'export function cases(data: Dataset): readonly RetrievalCase[] {',
    '  const spec = new RetrievalMetricSpec({ expectDocs: [...EXPECT_DOCS], k: TOP_K });',
    '  return data.cases.map((entry) =>',
    '    RetrievalCase.fromSpec({ caseId: entry.id, query: entry.input, spec }),',
    '  );',
    '}',
    '',
    '/**',
    ' * The retrieval gate. Thresholds come from the metrics the runtime produces rather',
    ' * than from names repeated here, so no threshold can name a metric that no longer',
    ' * exists.',
    ' */',
    'export function gate(): RetrievalGate {',
    `  const maxRegression = ${literal(evalShape.gate.maxRegression)};`,
    '  const metrics = retrievalMetrics();',
    ...(() => {
      const inline = `  const thresholds = metrics.map((metric) => new Threshold({ metric: metric.name, maxRegression }));`;
      return fits('', inline)
        ? [inline]
        : [
            '  const thresholds = metrics.map(',
            '    (metric) => new Threshold({ metric: metric.name, maxRegression }),',
            '  );',
          ];
    })(),
    '  return new RetrievalGate(thresholds, { metrics });',
    '}',
    '',
    '/** Sample the suite and return the run a baseline gate compares against. */',
    'export async function sample(',
    '  options: { readonly runs?: number; readonly deps?: Deps | undefined } = {},',
    '): Promise<EvalRun> {',
    '  const retriever = (options.deps ?? buildDeps({ baseDir: appDir() })).retriever(RETRIEVER);',
    '  const data = dataset();',
    '  return await gate().sample(cases(data), retriever, {',
    '    runs: options.runs ?? SAMPLES,',
    '    dataset: data.name,',
    '    datasetVersion: data.version,',
    '  });',
    '}',
    '',
    '/** Decide whether a run regressed against its baseline. */',
    'export function evaluate(run: EvalRun, baseline: EvalBaseline): GateResult {',
    '  return gate().evaluate(run, baseline);',
    '}',
    ...evalEntrypoints('RETRIEVER'),
  ].join('\n');
  return moduleText(header, body);
}

function evalModule(ir: IR, evalShape: EvalShape): string {
  const retrieval = evalShape.metrics.find((metric) => metric.kind === 'retrieval');
  if (retrieval !== undefined) return retrievalEvalModule(ir, evalShape, retrieval);
  return plainEvalModule(ir, evalShape);
}

export function emitEvalModules(ir: IR): EmittedFile[] {
  return ir.evals.map((evalShape) =>
    generated(evalModulePath(toSnakeCase(evalShape.id)), evalModule(ir, evalShape)),
  );
}

export function emitEvalsIndex(ir: IR): EmittedFile {
  const lines =
    ir.evals.length === 0
      ? ['// This project declares no evals.']
      : ir.evals.map((evalShape) => {
          const pascal = className(evalShape.id);
          const stem = toSnakeCase(evalShape.id);
          return exportStatement(`./${stem}.js`, [
            ['dataset', `${camelId(evalShape.id)}Dataset`],
            ['evaluate', `evaluate${pascal}`],
            ['gate', `${camelId(evalShape.id)}Gate`],
            ['sample', `sample${pascal}`],
          ]);
        });
  return generated(paths.evalsIndex, moduleText(...lines));
}

function camelId(id: string): string {
  const pascal = className(id);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function businessToolSeed(tool: ToolShape): string {
  const handler = `${className(tool.id)}Handler`;
  const header = [
    importStatement('@aid-framework/runtime', [{ name: 'ConfigurationError', type: false }]),
    importStatement(`../../generated/contracts/${tool.id}.js`, [{ name: handler, type: true }]),
  ].join('\n');
  const body = [
    '/**',
    ` * The business implementation of \`${tool.id}\`.`,
    ' *',
    ' * Created once and never overwritten: edit this file freely. Replace the throw with',
    ' * the real lookup; the handler signature is the contract the pipeline calls through.',
    ' */',
    `export const ${camelId(tool.id)}: ${handler} = async (context, request) => {`,
    '  void request;',
    '  throw new ConfigurationError(',
    `    \`\${context.name} has no business implementation yet: fill in ${paths.businessToolsIndex.replace(
      'index.ts',
      `${tool.id}.ts`,
    )}\`,`,
    '  );',
    '};',
  ].join('\n');
  return seedText(header, body);
}

export function emitBusinessToolSeeds(ir: IR): EmittedFile[] {
  return ir.tools.map((tool) => business(businessToolPath(tool.id), businessToolSeed(tool)));
}

export function emitBusinessToolsIndex(ir: IR): EmittedFile {
  const imports = [...ir.tools]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((tool) => importStatement(`./${tool.id}.js`, [{ name: camelId(tool.id), type: false }]));
  const entries = ir.tools.map((tool) => `  ${propertyKey(tool.id)}: ${camelId(tool.id)},`);
  return business(
    paths.businessToolsIndex,
    seedText(
      imports.join('\n'),
      [
        '/**',
        ' * Every hand-written tool implementation, keyed by the IR tool id.',
        ' *',
        ' * The generated executor reads this map, so a new tool is added here and nowhere',
        ' * else. The `unknown` value type is deliberate: the generated adapter is what',
        ' * pins each entry to its declared handler type.',
        ' */',
        'export const IMPLEMENTATIONS: Readonly<Record<string, unknown>> = {',
        ...entries,
        '};',
      ].join('\n'),
    ),
  );
}

export function emitBusinessPromptsIndex(ir: IR): EmittedFile {
  void ir;
  return business(
    paths.businessPromptsIndex,
    seedText(
      `import type { PromptTemplate } from '@aid-framework/runtime';`,
      [
        '/**',
        ' * Prompt overrides, layered over the generated templates at build time.',
        ' *',
        ' * Register a template with the same name and version as a generated one to replace',
        ' * its wording without touching generated code. Empty by default.',
        ' */',
        'export const OVERRIDES: readonly PromptTemplate[] = [];',
      ].join('\n'),
    ),
  );
}

export function emitBusinessIndex(ir: IR): EmittedFile {
  void ir;
  return business(
    paths.businessIndex,
    seedText(
      '// The hand-written tier: implementations, prompt overrides, and the rest.',
      sortStatements([
        {
          from: './prompts/index.js',
          text: exportStatement('./prompts/index.js', [['OVERRIDES', 'OVERRIDES']]),
        },
        {
          from: './tools/index.js',
          text: exportStatement('./tools/index.js', [['IMPLEMENTATIONS', 'IMPLEMENTATIONS']]),
        },
      ]).join('\n'),
    ),
  );
}

export function emitGeneratedIndex(ir: IR): EmittedFile {
  void ir;
  const statements = [
    { from: './deps.js', names: ['buildDeps', 'Deps', 'getDeps', 'setDeps'] },
    {
      from: './gateway/index.js',
      names: ['ALIASES', 'FALLBACKS', 'buildGateway', 'defaultProviders'],
    },
    { from: './observability.js', names: ['generatedCapabilities'] },
    { from: './pipelines/index.js', names: undefined },
    { from: './prompts/index.js', names: ['buildPrompts'] },
    { from: './requests.js', names: undefined },
    { from: './routes/index.js', names: undefined },
    { from: './schemas.js', names: undefined },
    { from: './tools/index.js', names: ['buildExecutor', 'buildTools'] },
  ];
  const lines = [
    '/** The generated surface of this application, as one import. */',
    '',
    ...sortStatements(
      statements.map((statement) => ({
        from: statement.from,
        text:
          statement.names === undefined
            ? `export * from '${statement.from}';`
            : exportStatement(
                statement.from,
                statement.names.map((name) => [name, name] as const),
              ),
      })),
    ),
  ];
  return generated(paths.generatedIndex, moduleText(lines.join('\n')));
}
