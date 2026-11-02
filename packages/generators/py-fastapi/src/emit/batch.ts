/**
 * The `batch` entrypoint: the module a run-to-completion platform invokes.
 *
 * A route answers and a server keeps waiting; a job has to finish, so it cannot be
 * `app.main:app`. What it can be is the same pipeline the route would have run, entered
 * once with the request body read from stdin. Deriving the input model and the response
 * fields from the pipeline rather than re-describing them is what keeps a job's JSON and
 * a route's body the same shape.
 */

import type { IR, PipelineShape } from '@aid-framework/ir';

import { moduleName } from '../names.js';
import { INDENT, MAX_LINE, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import { ANONYMOUS_PRINCIPAL, hasBranch } from './control.js';
import { DEPS_BINDING } from './deps.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { hasGuardrails } from './guardrails.js';
import { orderedPipelines } from './order.js';
import {
  callStatement,
  contextSeed,
  factoryName,
  mapping,
  pipelineResponse,
  requestModelName,
} from './pipelines.js';
import { pythonDoc } from './text.js';

export const BATCH_PATH = `${GENERATED_ROOT}/batch.py`;

/** The context key the request body travels under, and the local it is validated into. */
const EVENT = 'event';

/**
 * Whether any deployment runs to completion.
 *
 * Separate from `batchPipelines` because the Dockerfile needs the decision, not the list:
 * a `batch` deployment without a pipeline is a plan problem, and the file emitter should
 * not be the thing that reports it.
 */
export function hasBatchDeployment(ir: IR): boolean {
  return ir.deployments.some(
    (deployment) => deployment.target === 'batch' && deployment.pipeline !== undefined,
  );
}

/**
 * The pipelines a `batch` deployment names, in declared-id order, without duplicates.
 *
 * One deployment is one job, and a job runs one pipeline. Two deployments naming the same
 * pipeline is two jobs over one definition, so the entrypoint names it once and the
 * platform says which job is running.
 */
export function batchPipelines(ir: IR): PipelineShape[] {
  const named = new Set(
    ir.deployments
      .filter((deployment) => deployment.target === 'batch')
      .flatMap((deployment) => (deployment.pipeline === undefined ? [] : [deployment.pipeline])),
  );
  return orderedPipelines(ir).filter((pipeline) => named.has(pipeline.id));
}

/** A tuple literal, kept on one line while it fits and exploded when it does not. */
function tuple(values: readonly string[]): string {
  if (values.length === 1) return `(${values[0]},)`;
  const oneLine = `(${values.join(', ')})`;
  if (oneLine.length <= MAX_LINE) return oneLine;
  return `(\n${values.map((value) => `${INDENT}${value},`).join('\n')}\n)`;
}

/**
 * One pipeline, entered the way the route's handler enters it.
 *
 * The handler resolves its deps from FastAPI and validates the body against the request
 * model before any step runs; a job gets neither for free, so it does both here. The
 * answer is built from the same response fields, which is what makes the job's stdout
 * the body the route would have returned.
 */
function runner(ir: IR, pipeline: PipelineShape, guarded: boolean): string {
  const { type: response, fields } = pipelineResponse(ir, pipeline);
  const run = callStatement(
    'context = await ',
    `${factoryName(pipeline.id)}().run`,
    [mapping(contextSeed(pipeline, DEPS_BINDING), INDENT + INDENT)],
    INDENT,
  );
  return [
    `async def run_${moduleName(pipeline.id)}(${DEPS_BINDING}: Deps, payload: object) -> str:`,
    pythonDoc(
      `Run pipeline \`${pipeline.id}\` once and return the answer as JSON. A body the ` +
        'pipeline does not accept raises `ValidationError` and a failing step raises ' +
        '`PipelineError`, so `main` can tell bad input from a failed run.' +
        (guarded ? ' A guardrail refusal is dug back out of the failure by `main`.' : ''),
      INDENT,
    ),
    `${INDENT}${EVENT} = ${requestModelName(pipeline.id)}.model_validate(payload)`,
    run,
    `${INDENT}return ${response}(`,
    ...fields.map(([name, value]) => `${INDENT}${INDENT}${name}=${value},`),
    `${INDENT}).model_dump_json()`,
  ].join('\n');
}

export function emitBatch(ir: IR): EmittedFile {
  const pipelines = batchPipelines(ir);
  if (pipelines.length === 0) {
    throw new Error('emitBatch needs a batch deployment that names a pipeline');
  }
  const guarded = hasGuardrails(ir);
  const branches = pipelines.some((pipeline) => hasBranch([pipeline]));
  const ids = pipelines.map((pipeline) => pythonString(pipeline.id));

  // One pipeline is the whole build, so a run does not have to say which one; several
  // means the platform names the job, and an unnamed run is bad input rather than a guess.
  const resolve =
    pipelines.length === 1
      ? [`${INDENT}name = args.pipeline or PIPELINES[0]`]
      : [
          `${INDENT}name = args.pipeline`,
          `${INDENT}if name is None:`,
          `${INDENT}${INDENT}print(`,
          `${INDENT}${INDENT}${INDENT}"this build deploys several pipelines; name the one to run",`,
          `${INDENT}${INDENT}${INDENT}file=sys.stderr,`,
          `${INDENT}${INDENT})`,
          `${INDENT}${INDENT}return EXIT_USAGE`,
        ];

  // `Pipeline.run` wraps every step exception in `PipelineError`, so a guardrail refusal
  // arrives as a cause rather than as its own type -- the same dig the route does.
  const refused = guarded
    ? [
        `${INDENT}${INDENT}refused = guardrail_block(exc)`,
        `${INDENT}${INDENT}if refused is not None:`,
        `${INDENT}${INDENT}${INDENT}print(f"guardrail blocked {name}: {refused}", ` +
          'file=sys.stderr)',
        `${INDENT}${INDENT}${INDENT}return EXIT_REFUSED`,
      ]
    : [];

  // A docstring that named `EXIT_REFUSED` where `main` cannot return it would document an
  // exit no run produces, so the sentence is chosen with the branch that returns it.
  const failures = guarded
    ? 'A step a guardrail stopped is `EXIT_REFUSED`, and any other failure is ' + '`EXIT_FAILED`.'
    : 'Any other failure is `EXIT_FAILED`.';

  const main = [
    'def main(argv: list[str] | None = None) -> int:',
    pythonDoc(
      'Read one request from stdin, run the named pipeline once, and print the answer.\n\n' +
        'Input that is not a JSON document, or not a request the pipeline accepts, is ' +
        '`EXIT_USAGE`: the caller chose the input and retrying it unchanged would fail ' +
        `the same way. ${failures}`,
      INDENT,
    ),
    `${INDENT}parser = argparse.ArgumentParser(`,
    `${INDENT}${INDENT}description="Run one pipeline of this app once and print its answer.",`,
    `${INDENT})`,
    `${INDENT}parser.add_argument(`,
    `${INDENT}${INDENT}"pipeline",`,
    `${INDENT}${INDENT}nargs="?",`,
    `${INDENT}${INDENT}default=None,`,
    `${INDENT}${INDENT}help="Which pipeline to run; the platform names it.",`,
    `${INDENT})`,
    `${INDENT}args = parser.parse_args(argv)`,
    ...resolve,
    `${INDENT}if name not in _RUNNERS:`,
    `${INDENT}${INDENT}print(`,
    `${INDENT}${INDENT}${INDENT}` +
      `f"unknown pipeline {name!r}; this build deploys {', '.join(PIPELINES)}",`,
    `${INDENT}${INDENT}${INDENT}file=sys.stderr,`,
    `${INDENT}${INDENT})`,
    `${INDENT}${INDENT}return EXIT_USAGE`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}payload = json.load(sys.stdin)`,
    `${INDENT}except json.JSONDecodeError as exc:`,
    `${INDENT}${INDENT}print(f"stdin is not JSON: {exc}", file=sys.stderr)`,
    `${INDENT}${INDENT}return EXIT_USAGE`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}answer = asyncio.run(_RUNNERS[name](build_deps(), payload))`,
    `${INDENT}except ValidationError as exc:`,
    `${INDENT}${INDENT}print(f"stdin is not a {name} request: {exc}", file=sys.stderr)`,
    `${INDENT}${INDENT}return EXIT_USAGE`,
    `${INDENT}except PipelineError as exc:`,
    ...refused,
    `${INDENT}${INDENT}print(f"pipeline {name} failed: {exc}", file=sys.stderr)`,
    `${INDENT}${INDENT}return EXIT_FAILED`,
    `${INDENT}print(answer)`,
    `${INDENT}return EXIT_OK`,
  ].join('\n');

  return generated(
    BATCH_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The `batch` entrypoint: one job runs one pipeline once and prints one JSON ' +
          'object.\n\n' +
          'A `batch` deployment starts this module rather than `app.main:app`, because a ' +
          "server answers and waits while a job has to finish. The job's input is the " +
          "pipeline's request body, JSON on stdin; the answer is the model the pipeline's " +
          '`emit` step produces, JSON on stdout. Diagnostics go to stderr, because stdout ' +
          'is the output the scheduler reads.\n\n' +
          'The exit status is the run: 0 means stdout holds the answer, 1 means a step ' +
          'failed, and 64 means stdin was not something this pipeline accepts.' +
          (guarded ? ' 2 means a guardrail stopped the run.' : '') +
          ' Retrying bad input is not retrying a failure, so the codes differ.',
      ),
      importBlock([
        [
          'import argparse',
          'import asyncio',
          'import json',
          'import sys',
          importFrom('collections.abc', ['Callable', 'Coroutine']),
          importFrom('typing', ['Any']),
        ],
        [importFrom('aid_runtime', ['PipelineError']), importFrom('pydantic', ['ValidationError'])],
        [
          ...(branches ? [importFrom('.control', [ANONYMOUS_PRINCIPAL])] : []),
          importFrom('.deps', ['Deps', 'build_deps']),
          ...(guarded ? [importFrom('.guardrails', ['guardrail_block'])] : []),
          ...pipelines.map((pipeline) =>
            importFrom(`.pipelines.${moduleName(pipeline.id)}`, [factoryName(pipeline.id)]),
          ),
          importFrom(
            '.requests',
            pipelines.map((pipeline) => requestModelName(pipeline.id)),
          ),
          importFrom(
            '.schemas',
            pipelines.map((pipeline) => pipelineResponse(ir, pipeline).type),
          ),
        ],
      ]),
      [
        'EXIT_OK = 0',
        'EXIT_FAILED = 1',
        ...(guarded ? ['EXIT_REFUSED = 2'] : []),
        'EXIT_USAGE = 64',
      ].join('\n'),
      `PIPELINES = ${tuple(ids)}`,
      ...pipelines.map((pipeline) => runner(ir, pipeline, guarded)),
      [
        `_RUNNERS: dict[str, Callable[[Deps, object], Coroutine[Any, Any, str]]] = {`,
        ...pipelines.map(
          (pipeline) => `${INDENT}${pythonString(pipeline.id)}: run_${moduleName(pipeline.id)},`,
        ),
        '}',
      ].join('\n'),
      main,
      ['if __name__ == "__main__":', `${INDENT}raise SystemExit(main())`].join('\n'),
    ]),
  );
}
