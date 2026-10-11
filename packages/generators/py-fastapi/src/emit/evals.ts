/**
 * `app/generated/evals/`: one module per eval, turning the spec's declarations into the
 * runtime's measurement.
 *
 * Two properties drive the shape.
 *
 * * **The eval measures; the baseline decides.** Model output is not deterministic, so a
 *   gate that compared one run to one stored string would be a check that fails at
 *   random. The spec's `maxRegression` is a tolerance, and the runtime's `BaselineGate`
 *   applies it to the mean over `samples` runs -- the generated module contains no
 *   comparison of its own, and no threshold is ever an equality.
 * * **The dataset and the baseline are data, not code.** Both live under `app/evals/`,
 *   which the developer owns (`docs/design.md` §8.3), so moving a threshold is a data
 *   change rather than a regeneration.
 *
 * The prompt the eval sends is the prompt the app sends: `request_for` renders the same
 * prompt and version the pipeline renders, with the case's input as the prompt's one
 * variable. An eval that paraphrased the prompt would measure a prompt nobody calls.
 */

import type { EvalShape, IR, PromptShape } from '@aid/ir';

import { jsonSchemaMetric, judgeAlias, metricBindings, usesJudge } from '../metrics.js';
import { className, moduleName } from '../names.js';
import { INDENT, MAX_LINE, pythonNumber, pythonString } from '../python.js';
import {
  assemble,
  HEADER,
  importBlock,
  importFrom,
  moduleBody,
  tupleLiteral,
} from '../template.js';
import type { EvalSubject } from '../validate.js';
import { evalSubject, renderNames } from '../validate.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedEvals } from './order.js';
import { promptVersion } from './prompts.js';
import { require } from './require.js';
import { pythonDoc } from './text.js';

export const EVALS_INIT_PATH = `${GENERATED_ROOT}/evals/__init__.py`;

export function evalModulePath(evalId: string): string {
  return `${GENERATED_ROOT}/evals/${moduleName(evalId)}.py`;
}

/**
 * Where a spec's dataset URI resolves to, relative to the app directory.
 *
 * The URI is app-relative -- `docs/design.md` §8.3 puts developer-owned datasets and
 * baselines under `app/evals/`, and the example spec writes `evals/tickets.jsonl` -- so
 * the generated loader resolves it from the app directory rather than from `evals/`.
 * The segments are normalized here so the emitted path is the same expression for
 * `evals/x.jsonl` and `evals//x.jsonl`; `checkEvals` has already refused traversal.
 */
export function datasetRelativePath(uri: string): string {
  return datasetSegments(uri).join('/');
}

/** Where an eval's baseline lives, relative to the app directory. */
export function baselineRelativePath(evalId: string): string {
  return `evals/${evalId}.baseline.json`;
}

/** The dataset URI's path segments, as the generated loader joins them. */
export function datasetSegments(uri: string): string[] {
  return uri.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The prompt and model an eval measures.
 *
 * The plan is validated before anything is emitted, so a target that resolves to no
 * subject cannot reach here; this reads the same `evalSubject` decision `checkEvals`
 * makes, so the two cannot drift. Going through the resolver rather than looking the
 * prompt up by `target.id` is what makes a `pipeline:` target work: there, `target.id`
 * names the pipeline, and the prompt is whichever one its steps render.
 */
export function evalSubjectOf(ir: IR, evaluation: EvalShape): EvalSubject {
  const result = evalSubject(ir, evaluation);
  return require(result.ok ? result.subject : undefined, `the subject of eval '${evaluation.id}'`);
}

/** The one prompt variable a dataset's input fills. */
export function variableUnderTest(prompt: PromptShape): string {
  return require(renderNames(prompt)[0], `the variable of prompt '${prompt.id}'`);
}

/** Every metric expression is `ClassName(...)`, so the class is the prefix. */
function metricClass(expression: string): string {
  return expression.slice(0, expression.indexOf('('));
}

function pathExpression(relative: string): string {
  return ['Path(__file__).resolve().parents[2]', ...relative.split('/').map(pythonString)].join(
    ' / ',
  );
}

function datasetLoader(injectSchema: boolean): string {
  const load = [
    'def load_dataset() -> Dataset:',
    pythonDoc(
      injectSchema
        ? "The eval's cases, resolved under app/evals/.\n\n" +
            "The declared JSON Schema travels in each case's metadata, so the `json-valid` " +
            'metric scores against the schema the spec declares rather than a copy of it ' +
            'repeated in the dataset file.'
        : "The eval's cases, resolved under app/evals/.",
      INDENT,
    ),
    `${INDENT}if not DATASET_PATH.is_file():`,
    `${INDENT}${INDENT}raise FileNotFoundError(f"{EVAL_ID} expects its dataset at {DATASET_PATH}")`,
    `${INDENT}loaded = Dataset.from_path(DATASET_PATH)`,
  ];
  if (!injectSchema) {
    return [...load, `${INDENT}return loaded`].join('\n');
  }
  const oneLine = `${INDENT}return case.model_copy(update={"metadata": {**case.metadata, "json_schema": JSON_SCHEMA}})`;
  const copy =
    oneLine.length <= MAX_LINE
      ? [oneLine]
      : [
          `${INDENT}return case.model_copy(`,
          `${INDENT}${INDENT}update={"metadata": {**case.metadata, "json_schema": JSON_SCHEMA}}`,
          `${INDENT})`,
        ];
  return moduleBody([
    [
      'def _with_schema(case: EvalCase) -> EvalCase:',
      pythonDoc('One case, carrying the declared schema for the `json-valid` metric.', INDENT),
      ...copy,
    ].join('\n'),
    [
      ...load,
      `${INDENT}return Dataset(`,
      `${INDENT}${INDENT}name=loaded.name,`,
      `${INDENT}${INDENT}version=loaded.version,`,
      `${INDENT}${INDENT}cases=tuple(_with_schema(case) for case in loaded.cases),`,
      `${INDENT})`,
    ].join('\n'),
  ]);
}

function baselineLoader(): string {
  return [
    'def load_baseline() -> EvalBaseline:',
    pythonDoc(
      'The stored measurement this eval is compared against. Record one from a run you ' +
        'accept rather than writing one by hand.',
      INDENT,
    ),
    `${INDENT}if not BASELINE_PATH.is_file():`,
    `${INDENT}${INDENT}raise FileNotFoundError(`,
    `${INDENT}${INDENT}${INDENT}f"{EVAL_ID} has no baseline at {BASELINE_PATH}; record one with "`,
    `${INDENT}${INDENT}${INDENT}"EvalBaseline.from_run(await run()).to_json()"`,
    `${INDENT}${INDENT})`,
    `${INDENT}return EvalBaseline.from_path(BASELINE_PATH)`,
  ].join('\n');
}

function gateBuilder(thresholds: readonly string[]): string {
  return [
    'def thresholds() -> tuple[Threshold, ...]:',
    pythonDoc(
      'The tolerances the gate applies.\n\n' +
        '`max_regression` is a statistical tolerance, not an exact match: sampling a ' +
        'non-deterministic model twice never produces the same numbers, so the gate ' +
        'compares the mean over SAMPLES runs against the baseline.',
      INDENT,
    ),
    `${INDENT}return ${tupleLiteral(thresholds, INDENT, 'return ', '')}`,
  ].join('\n');
}

function metricsBuilder(inline: readonly string[], judge: string | undefined): string {
  const header =
    judge === undefined
      ? ['def metrics() -> tuple[Metric, ...]:']
      : [
          'def metrics(',
          `${INDENT}judge_call: JudgeCall | None = None,`,
          ') -> tuple[Metric, ...]:',
        ];
  const body = [
    ...header,
    pythonDoc(
      judge === undefined
        ? 'The metrics the spec declares for this eval.'
        : 'The metrics the spec declares for this eval, including the judge once a call is given.',
      INDENT,
    ),
  ];
  if (judge === undefined) {
    return [...body, `${INDENT}return ${tupleLiteral(inline, INDENT, 'return ', '')}`].join('\n');
  }
  return [
    ...body,
    `${INDENT}declared: list[Metric] = [${inline.join(', ')}]`,
    `${INDENT}if judge_call is not None:`,
    `${INDENT}${INDENT}declared.append(${judge})`,
    `${INDENT}return tuple(declared)`,
  ].join('\n');
}

function runnerBuilder(): string {
  return [
    'def build_runner(deps: Deps) -> GatewayRunner:',
    pythonDoc(
      'The measurement, over the prompt the app actually renders.\n\n' +
        '`request_for` renders the same prompt and version the pipeline renders, with the ' +
        "case's input as the prompt's one variable, so the eval measures the prompt the " +
        "app sends rather than a paraphrase of it. The fallback chain is the pipeline's too, " +
        'so the measurement covers the app as wired rather than only its primary model.',
      INDENT,
    ),
    '',
    `${INDENT}def request_for(case: EvalCase) -> CompletionRequest:`,
    `${INDENT}${INDENT}rendered = deps.prompts.render(`,
    `${INDENT}${INDENT}${INDENT}PROMPT, version=PROMPT_VERSION, values={PROMPT_VARIABLE: case.input}`,
    `${INDENT}${INDENT})`,
    `${INDENT}${INDENT}return CompletionRequest.prompt(rendered.text)`,
    '',
    `${INDENT}return GatewayRunner(`,
    `${INDENT}${INDENT}deps.gateway, MODEL, request_for=request_for, fallbacks=FALLBACKS.get(MODEL, ())`,
    `${INDENT})`,
  ].join('\n');
}

function runBuilder(samples: number, judged: boolean): string {
  return [
    'async def run(deps: Deps | None = None) -> EvalRun:',
    pythonDoc(
      `Sample the dataset ${samples} times and return every metric's mean per run.`,
      INDENT,
    ),
    `${INDENT}container = build_deps() if deps is None else deps`,
    judged
      ? `${INDENT}judge_call = await gateway_judge(container.gateway, JUDGE_MODEL)`
      : undefined,
    `${INDENT}return await run_evaluation(`,
    `${INDENT}${INDENT}load_dataset(),`,
    `${INDENT}${INDENT}build_runner(container),`,
    judged ? `${INDENT}${INDENT}metrics(judge_call),` : `${INDENT}${INDENT}metrics(),`,
    `${INDENT}${INDENT}runs=SAMPLES,`,
    `${INDENT})`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function emitEval(ir: IR, evaluation: EvalShape): EmittedFile {
  const subject = evalSubjectOf(ir, evaluation);
  const prompt = subject.prompt;
  const model = subject.model;
  const variable = variableUnderTest(prompt);
  const judge = judgeAlias(evaluation);
  const schema = jsonSchemaMetric(evaluation);
  const bindings = metricBindings(evaluation);
  const inline = bindings.filter((binding) => binding.deterministic);
  const judged = usesJudge(evaluation);

  const judgedMetric = judged
    ? require(bindings.find(
        (binding) => !binding.deterministic,
      ), `the judge metric of eval '${evaluation.id}'`)
    : undefined;

  const rubric = evaluation.metrics.find((metric) => metric.kind === 'llm-judge')?.rubric ?? '';

  const runtimeEvals = [
    'BaselineGate',
    'Dataset',
    'EvalBaseline',
    ...bindings.map((binding) => metricClass(binding.expression)),
    judged ? 'gateway_judge' : undefined,
    'GatewayRunner',
    'Metric',
    'Threshold',
    'run_evaluation',
  ].filter((name): name is string => name !== undefined);

  const typeOnly = ['EvalCase', 'EvalRun', 'GateResult', judged ? 'JudgeCall' : undefined].filter(
    (name): name is string => name !== undefined,
  );

  const constants = [
    `EVAL_ID = ${pythonString(evaluation.id)}`,
    `MODEL = ${pythonString(model)}`,
    `PROMPT = ${pythonString(prompt.id)}`,
    `PROMPT_VERSION = ${pythonString(promptVersion(prompt.version))}`,
    `PROMPT_VARIABLE = ${pythonString(variable)}`,
    `SAMPLES = ${pythonNumber(evaluation.gate.samples)}`,
    `MAX_REGRESSION = ${pythonNumber(evaluation.gate.maxRegression)}`,
    judged ? `JUDGE_MODEL = ${pythonString(judge ?? '')}` : undefined,
    schema === undefined
      ? undefined
      : `JSON_SCHEMA = json.dumps(${className(schema.name)}.model_json_schema())`,
    `DATASET_PATH = ${pathExpression(datasetRelativePath(evaluation.dataset.uri ?? ''))}`,
    `BASELINE_PATH = ${pathExpression(baselineRelativePath(evaluation.id))}`,
  ].filter((line): line is string => line !== undefined);

  const thresholds = inline.map(
    (binding) => `Threshold(metric=${pythonString(binding.name)}, max_regression=MAX_REGRESSION)`,
  );

  return generated(
    evalModulePath(evaluation.id),
    assemble([
      HEADER,
      pythonDoc(
        `The \`${evaluation.id}\` eval${evaluation.description === undefined ? '.' : `: ${evaluation.description}`}\n\n` +
          `It samples the dataset ${evaluation.gate.samples} times against \`${model}\`, measuring ` +
          'the prompt the pipeline renders, and hands the result to a baseline gate. It never ' +
          'decides correctness itself: model output is not deterministic, so the gate compares ' +
          'a mean against a tolerance rather than a run against a stored string.',
      ),
      importBlock([
        [
          'import asyncio',
          schema === undefined ? undefined : 'import json',
          importFrom('pathlib', ['Path']),
          importFrom('typing', ['TYPE_CHECKING']),
        ].filter((line): line is string => line !== undefined),
        [
          importFrom('aid_runtime', ['CompletionRequest']),
          importFrom('aid_runtime.evals', runtimeEvals),
        ],
        [
          importFrom('..deps', ['Deps', 'build_deps']),
          importFrom('..gateway.models', ['FALLBACKS']),
          ...(schema === undefined ? [] : [importFrom('..schemas', [className(schema.name)])]),
        ],
      ]),
      ['if TYPE_CHECKING:', `${INDENT}from aid_runtime.evals import ${typeOnly.join(', ')}`].join(
        '\n',
      ),
      constants.join('\n'),
      datasetLoader(schema !== undefined),
      baselineLoader(),
      gateBuilder(thresholds),
      metricsBuilder(
        inline.map((binding) => binding.expression),
        judgedMetric === undefined
          ? undefined
          : `LlmJudge(judge_call, rubric=${pythonString(rubric)})`,
      ),
      runnerBuilder(),
      runBuilder(evaluation.gate.samples, judged),
      [
        'def gate(measured: EvalRun, baseline: EvalBaseline) -> GateResult:',
        pythonDoc(
          'Compare a measurement against the stored baseline. The tolerance comes from the ' +
            'spec, and the gate refuses to threshold on a metric a model produced.',
          INDENT,
        ),
        `${INDENT}return BaselineGate(thresholds(), metrics=metrics()).evaluate(measured, baseline)`,
      ].join('\n'),
      [
        'async def evaluate(deps: Deps | None = None) -> GateResult:',
        pythonDoc('Measure the app and compare the result against the stored baseline.', INDENT),
        `${INDENT}return gate(await run(deps=deps), load_baseline())`,
      ].join('\n'),
      [
        'def main() -> int:',
        pythonDoc('Run the gate, print its summary, and exit non-zero on a regression.', INDENT),
        `${INDENT}result = asyncio.run(evaluate())`,
        `${INDENT}print(result.summary())`,
        `${INDENT}return 1 if result.failures() else 0`,
      ].join('\n'),
      ['if __name__ == "__main__":', `${INDENT}raise SystemExit(main())`].join('\n'),
    ]),
  );
}

export function emitEvalsInit(ir: IR): EmittedFile {
  const names = orderedEvals(ir).map((evaluation) => moduleName(evaluation.id));

  return generated(
    EVALS_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc("The app's evals, one module each, named after the id the spec declares."),
      names.length === 0 ? undefined : names.map((name) => `from . import ${name}`).join('\n'),
      names.length === 0 ? undefined : `__all__ = [${names.map(pythonString).join(', ')}]`,
    ]),
  );
}
