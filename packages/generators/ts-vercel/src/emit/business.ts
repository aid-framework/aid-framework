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

import type { EvalShape, IR, MetricShape, ToolShape } from '@aid/ir';
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
  exportStatement,
  fits,
  importStatement,
  moduleText,
  seedText,
  sortStatements,
} from './text.js';

function metricExpression(metric: MetricShape): string {
  switch (metric.kind) {
    case 'exact':
      return `new ExactMatch({ name: ${literal('exact')} })`;
    case 'contains':
      return `new NormalizedContains({ name: ${literal('contains')} })`;
    case 'json-schema':
      return `new JsonSchemaValid({ name: ${literal('json-schema')} })`;
    default:
      return 'unsupportedMetric';
  }
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
  return [`  return Dataset.fromPath(new URL(${literal(`../../${uri}`)}, import.meta.url));`];
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
  const list = arrayLiteral(
    metrics.map((metric) => literal(metric)),
    '  ',
  );
  const inline = `  const thresholds = ${list}.map((metric) => new Threshold({ metric, maxRegression: ${maxRegression} }));`;
  return [
    '/**',
    ' * The gate the spec asks for: one absolute-free threshold per emitted metric, each',
    ' * allowing the declared regression. `minMean` stays unset because the spec carries no',
    ' * floor, and a floor the spec did not ask for would fail a run for the wrong reason.',
    ' */',
    'export function gate(): BaselineGate {',
    ...(fits('', inline)
      ? [inline]
      : [
          `  const thresholds = ${list}.map(`,
          `    (metric) => new Threshold({ metric, maxRegression: ${maxRegression} }),`,
          '  );',
        ]),
    '  return new BaselineGate(thresholds, { metrics: metrics() });',
    '}',
  ];
}

/**
 * The `@aid/runtime` names a plain eval module needs: only the metrics the spec
 * actually asks for, because the emitted module has no other way to use one.
 */
function plainEvalImports(
  evalShape: EvalShape,
  metrics: readonly MetricShape[],
): { name: string; type: boolean }[] {
  const names = metrics.map((metric) => metric.kind);
  return [
    { name: 'BaselineGate', type: false },
    ...(evalShape.dataset.uri === undefined ? [{ name: 'ConfigurationError', type: false }] : []),
    { name: 'Dataset', type: false },
    ...(names.includes('exact') ? [{ name: 'ExactMatch', type: false }] : []),
    { name: 'GatewayRunner', type: false },
    ...(names.includes('json-schema') ? [{ name: 'JsonSchemaValid', type: false }] : []),
    ...(names.includes('contains') ? [{ name: 'NormalizedContains', type: false }] : []),
    { name: 'Threshold', type: false },
    { name: 'runEvaluation', type: false },
    { name: 'EvalBaseline', type: true },
    { name: 'EvalRun', type: true },
    { name: 'GateResult', type: true },
    { name: 'Metric', type: true },
  ];
}

function plainEvalModule(evalShape: EvalShape): string {
  const metrics = evalShape.metrics.filter((metric) => metric.kind !== 'retrieval');
  const names = metrics.map((metric) => metric.kind);
  const header = [
    importStatement('@aid/runtime', plainEvalImports(evalShape, metrics)),
    importStatement('../gateway/index.js', [{ name: 'buildGateway', type: false }]),
  ].join('\n');
  const body = [
    ...datasetBody(evalShape),
    '',
    '/** The metrics the spec asks for, in declaration order. */',
    'export function metrics(): readonly Metric[] {',
    `  return [${metrics.map(metricExpression).join(', ')}];`,
    '}',
    '',
    ...gateBody(evalShape, names),
    '',
    '/** Sample the suite and return the run a baseline gate compares against. */',
    'export async function sample(options: { readonly runs?: number } = {}): Promise<EvalRun> {',
    '  const gateway = buildGateway();',
    `  const runner = new GatewayRunner(gateway, ${literal('default')}, {});`,
    '  return await runEvaluation(dataset(), (entry) => runner.run(entry), metrics(), {',
    `    runs: options.runs ?? ${literal(evalShape.gate.samples)},`,
    '  });',
    '}',
    '',
    '/** Decide whether a run regressed against its baseline. */',
    'export function evaluate(run: EvalRun, baseline: EvalBaseline): GateResult {',
    '  return gate().evaluate(run, baseline);',
    '}',
  ].join('\n');
  return moduleText(header, body);
}

function retrievalEvalModule(ir: IR, evalShape: EvalShape, metric: MetricShape): string {
  const retriever = evalRetriever(ir, evalShape);
  const expectDocs = metric.kind === 'retrieval' ? [...metric.expectDocs] : [];
  const k = metric.kind === 'retrieval' ? metric.k : 5;
  const header = [
    importStatement('@aid/runtime', [
      { name: 'ConfigurationError', type: false },
      { name: 'Dataset', type: false },
      { name: 'RetrievalCase', type: false },
      { name: 'RetrievalGate', type: false },
      { name: 'RetrievalMetricSpec', type: false },
      { name: 'Threshold', type: false },
      { name: 'retrievalMetrics', type: false },
      { name: 'EvalBaseline', type: true },
      { name: 'EvalRun', type: true },
      { name: 'GateResult', type: true },
    ]),
    importStatement('../retrieval/index.js', [{ name: 'buildRetrievers', type: false }]),
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
    `const TOP_K = ${literal(k)};`,
    `const RETRIEVER = ${literal(retriever ?? '')};`,
    '',
    ...datasetBody(evalShape),
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
    'export async function sample(options: { readonly runs?: number } = {}): Promise<EvalRun> {',
    '  const retriever = buildRetrievers().get(RETRIEVER);',
    '  if (retriever === undefined) {',
    `    throw new ConfigurationError(\`retriever \${RETRIEVER} is not built\`);`,
    '  }',
    '  const data = dataset();',
    '  return await gate().sample(cases(data), retriever, {',
    `    runs: options.runs ?? ${literal(evalShape.gate.samples)},`,
    '    dataset: data.name,',
    '    datasetVersion: data.version,',
    '  });',
    '}',
    '',
    '/** Decide whether a run regressed against its baseline. */',
    'export function evaluate(run: EvalRun, baseline: EvalBaseline): GateResult {',
    '  return gate().evaluate(run, baseline);',
    '}',
  ].join('\n');
  return moduleText(header, body);
}

function evalModule(ir: IR, evalShape: EvalShape): string {
  const retrieval = evalShape.metrics.find((metric) => metric.kind === 'retrieval');
  if (retrieval !== undefined) return retrievalEvalModule(ir, evalShape, retrieval);
  return plainEvalModule(evalShape);
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
    importStatement('@aid/runtime', [{ name: 'ConfigurationError', type: false }]),
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
      `import type { PromptTemplate } from '@aid/runtime';`,
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
