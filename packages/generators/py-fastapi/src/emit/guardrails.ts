/**
 * `app/generated/guardrails.py`: the spec's guardrails, and the check that runs them.
 *
 * The runtime ships the engine (`aid_runtime.agents.GuardrailEngine`); this module is
 * wiring, not semantics. Each IR declaration becomes one `GuardrailDefinition` -- a
 * value the runtime validates and evaluates -- and the two functions below are the whole
 * of what the generated code adds: log what fired, refuse what must stop, and hand back
 * the payload the caller is allowed to use.
 *
 * ## Every declaration applies to every route
 *
 * The IR attaches a guardrail to a *prompt* or an *agent*; a `PipelineShape` has no
 * `guardrails` field, and the gate that requires an `input` stage for a `specVersion`
 * >= 0.2 HTTP `generate` route is document-global. So there is no reference a per-pipeline
 * attachment could come from, and the honest reading is the only one available: an
 * `input` guardrail inspects the prompt text of every HTTP `generate` route in this app,
 * and an `input` guardrail an agent declares inspects pipeline input too. The module
 * docstring says so where a reader of the generated code will find it.
 *
 * ## What a stage's payload is
 *
 * `{"text": ...}` for `input`, `output` and `retrieval`; the tool's own arguments for
 * `tool-call`. That is the runtime's shape, and it is why a `redact` action has to name
 * `text` on the first three -- `./validate.ts` refuses anything else at plan time.
 */

import type { GuardrailShape, IR } from '@aid/ir';

import { INDENT, MAX_LINE, pythonString, pythonTuple } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedGuardrails } from './order.js';
import { pythonDoc } from './text.js';

export const GUARDRAILS_PATH = `${GENERATED_ROOT}/guardrails.py`;

/** The stage whose rules a pipeline route runs; named so the call site reads as prose. */
export const STAGES = ['input', 'output', 'retrieval', 'tool-call'] as const;
export type GuardrailStage = (typeof STAGES)[number];

/** The module constant holding one stage's declarations. */
export function stageTable(stage: GuardrailStage): string {
  return `${stage.replace('-', '_').toUpperCase()}_GUARDRAILS`;
}

/** The declarations a stage runs, in declared-id order. */
export function stageGuardrails(ir: IR, stage: GuardrailStage): GuardrailShape[] {
  return orderedGuardrails(ir).filter((guardrail) => guardrail.stages.includes(stage));
}

/** The `GuardrailDefinition(...)` literal for one declaration, one argument per line. */
function definition(guardrail: GuardrailShape): string {
  const tuples = (values: readonly string[]): string => pythonTuple(values.map(pythonString));
  const arguments_ = [
    `id=${pythonString(guardrail.id)}`,
    `stages=${tuples(guardrail.stages)}`,
    `policies=${tuples(guardrail.policies)}`,
    `action=${pythonString(guardrail.action)}`,
    `redact=${tuples(guardrail.redact)}`,
    `tools=${tuples(guardrail.tools)}`,
    `message=${pythonString(guardrail.onFail.message)}`,
    `fallback_prompt=${
      guardrail.onFail.fallbackPrompt === undefined
        ? 'None'
        : pythonString(guardrail.onFail.fallbackPrompt)
    }`,
    `log=${guardrail.onFail.log ? 'True' : 'False'}`,
  ];
  const inner = `${INDENT}${INDENT}`;
  return [
    `${INDENT}GuardrailDefinition(`,
    ...arguments_.map((argument) => `${inner}${argument},`),
    `${INDENT}),`,
  ].join('\n');
}

/**
 * The stage tables, emitted only for stages that have something in them.
 *
 * A table nothing reads is a name a reader has to check before deciding it does not
 * matter, so an app whose guardrails are all `input`-stage carries no `output` table.
 */
function tables(ir: IR): string[] {
  return STAGES.filter((stage) => stageGuardrails(ir, stage).length > 0).map((stage) =>
    [
      `${stageTable(stage)}: tuple[GuardrailDefinition, ...] = tuple(`,
      `${INDENT}g for g in GUARDRAILS if ${pythonString(stage)} in g.stages`,
      ')',
    ].join('\n'),
  );
}

/**
 * The module's public surface, declared.
 *
 * A route imports `ENGINE`, the stage tables and the two functions, so the stage table is
 * read only from another module. `__all__` says so in the file itself, which is both the
 * documentation a reader wants and the statement a static analyzer needs before it can
 * tell an exported name from a dead one.
 */
function exports(ir: IR): string {
  const names = [
    'ENGINE',
    'GUARDRAILS',
    ...STAGES.filter((stage) => stageGuardrails(ir, stage).length > 0).map(stageTable),
    'enforce_guardrail',
    'guardrail_block',
  ].map(pythonString);
  const oneLine = `__all__ = [${names.join(', ')}]`;
  if (oneLine.length <= MAX_LINE) return oneLine;
  return ['__all__ = [', ...names.map((name) => `${INDENT}${name},`), ']'].join('\n');
}

const ENFORCE = [
  'def enforce_guardrail(verdict: GuardrailVerdict) -> GuardrailVerdict:',
  pythonDoc(
    'Log what fired, refuse what must stop, and return the verdict whose payload is ' +
      'safe to use. A caller that keeps its own copy of the text has skipped a `redact`. ' +
      '`escalate` stops here too: a pipeline route has no checkpoint to resume from, so a ' +
      'question to a human is a question nobody is asked. The generator refuses an ' +
      '`escalate` declaration at plan time; this is the backstop for a table edited by hand.',
    INDENT,
  ),
  `${INDENT}for record in verdict.records:`,
  `${INDENT}${INDENT}if _BY_ID[record.guardrail].log:`,
  `${INDENT}${INDENT}${INDENT}_LOGGER.warning(`,
  `${INDENT}${INDENT}${INDENT}${INDENT}"guardrail %s fired at the %s stage over %s: %s",`,
  `${INDENT}${INDENT}${INDENT}${INDENT}record.guardrail,`,
  `${INDENT}${INDENT}${INDENT}${INDENT}record.stage,`,
  `${INDENT}${INDENT}${INDENT}${INDENT}", ".join(record.policies),`,
  `${INDENT}${INDENT}${INDENT}${INDENT}record.message,`,
  `${INDENT}${INDENT}${INDENT})`,
  `${INDENT}deciding = verdict.deciding`,
  `${INDENT}if deciding is not None and deciding.action in _STOPPING:`,
  `${INDENT}${INDENT}raise GuardrailBlockedError(deciding.guardrail, deciding.stage, deciding.message)`,
  `${INDENT}return verdict`,
].join('\n');

const BLOCK = [
  'def guardrail_block(error: BaseException) -> GuardrailBlockedError | None:',
  pythonDoc(
    "The guardrail block inside an error's cause chain, or `None`. A step re-raises " +
      'whatever it caught as a `PipelineError`, so a block reaches a route wrapped; ' +
      'unwrapping it is what lets the route answer 4xx for a refused input instead of ' +
      'blaming the model with a 502.',
    INDENT,
  ),
  `${INDENT}seen: set[int] = set()`,
  `${INDENT}current: BaseException | None = error`,
  `${INDENT}while current is not None and id(current) not in seen:`,
  `${INDENT}${INDENT}if isinstance(current, GuardrailBlockedError):`,
  `${INDENT}${INDENT}${INDENT}return current`,
  `${INDENT}${INDENT}seen.add(id(current))`,
  `${INDENT}${INDENT}current = current.__cause__ or current.__context__`,
  `${INDENT}return None`,
].join('\n');

export function emitGuardrails(ir: IR): EmittedFile {
  const definitions = orderedGuardrails(ir).map(definition);
  return generated(
    GUARDRAILS_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The guardrails the spec declares, and the check every pipeline route runs. Each ' +
          'declaration applies to *every* pipeline route in this app, not to the one that ' +
          'named it: the IR attaches a guardrail to a prompt or an agent and gives a ' +
          'pipeline no field for one, and the security gate that requires an `input` stage ' +
          'is document-wide. So an `input` guardrail inspects the prompt text of every HTTP ' +
          '`generate` route, and an `input` guardrail an agent declares inspects pipeline ' +
          'input too. A guardrail evaluates the stage payload the runtime defines -- ' +
          "{'text': ...} for the `input`, `output` and `retrieval` stages, the tool's own " +
          'arguments for `tool-call` -- so a `redact` action names `text` on the first three.',
      ),
      importBlock([
        ['import logging'],
        [
          importFrom('aid_runtime', ['GuardrailBlockedError']),
          importFrom('aid_runtime.agents', [
            'GuardrailDefinition',
            'GuardrailEngine',
            'GuardrailVerdict',
          ]),
        ],
      ]),
      exports(ir),
      '_LOGGER = logging.getLogger(__name__)',
      '_STOPPING = frozenset({"block", "escalate"})',
      'ENGINE = GuardrailEngine()',
      ['GUARDRAILS: tuple[GuardrailDefinition, ...] = (', ...definitions, ')'].join('\n'),
      '_BY_ID: dict[str, GuardrailDefinition] = {g.id: g for g in GUARDRAILS}',
      ...tables(ir).map((table) => ['', table].join('\n')),
      ENFORCE,
      BLOCK,
    ]),
  );
}

/** Whether this app carries a single guardrail, which is what decides the file. */
export function hasGuardrails(ir: IR): boolean {
  return (ir.guardrails ?? []).length > 0;
}
