/**
 * `app/generated/guardrails.ts`: the spec's guardrails, and the check that runs them.
 *
 * The runtime ships the engine (`GuardrailEngine`); this module is wiring, not
 * semantics. Each IR declaration becomes one `GuardrailDefinition` -- a value the runtime
 * evaluates -- and the two functions below are the whole of what the generated code adds:
 * log what fired, refuse what must stop, and hand back the verdict whose payload the
 * caller is allowed to use.
 *
 * ## Every declaration applies to every route
 *
 * The IR attaches a guardrail to a *prompt* or an *agent*; a `PipelineShape` has no
 * `guardrails` field, and the gate that requires an `input` stage for a `specVersion`
 * >= 0.2 HTTP `generate` route is document-global. So there is no reference a per-pipeline
 * attachment could come from, and the honest reading is the only one available: an `input`
 * guardrail inspects the prompt text of every HTTP `generate` route in this app, and an
 * `input` guardrail an agent declares inspects pipeline input too.
 *
 * A `guard` *step* is the one exception, and it is the opposite case: the step names a
 * guardrail and a stage, so it runs that declaration alone through `BY_ID` instead of
 * running the stage's whole table. That is why `BY_ID` is exported here.
 *
 * ## What a stage's payload is
 *
 * `{ text }` for `input`, `output` and `retrieval`; the tool's own arguments for
 * `tool-call`. That is the runtime's shape, and it is why a `redact` action has to name
 * `text` on the first three -- the validator refuses anything else at plan time.
 */

import type { GuardrailShape, IR } from '@aid-framework/ir';

import { stringLiteral } from '../names.js';
import { type EmittedFile, generated, paths } from './file.js';
import {
  arrayLiteral,
  compareNames,
  type Entry,
  importStatement,
  moduleText,
  objectLiteral,
} from './text.js';

/** The stages a declaration may name, in the order the runtime lists them. */
export const STAGES = ['input', 'output', 'retrieval', 'tool-call'] as const;
export type GuardrailStage = (typeof STAGES)[number];

/** The module constant holding one stage's declarations. */
export function stageTable(stage: GuardrailStage): string {
  return `${stage.replace('-', '_').toUpperCase()}_GUARDRAILS`;
}

/** The declarations a stage runs, in id order. */
export function stageGuardrails(ir: IR, stage: GuardrailStage): GuardrailShape[] {
  return orderedGuardrails(ir).filter((guardrail) => guardrail.stages.includes(stage));
}

/** The declarations the spec makes, in id order. */
export function orderedGuardrails(ir: IR): GuardrailShape[] {
  return [...(ir.guardrails ?? [])].sort((a, b) => compareNames(a.id, b.id));
}

/** Whether this app declares a guardrail at all, which is what decides the file. */
export function hasGuardrails(ir: IR): boolean {
  return orderedGuardrails(ir).length > 0;
}

/** Whether any declaration names this stage. */
export function usesStage(ir: IR, stage: GuardrailStage): boolean {
  return stageGuardrails(ir, stage).length > 0;
}

function stringArray(values: readonly string[]): string {
  return arrayLiteral(
    values.map((value) => stringLiteral(value)),
    '  ',
  );
}

/**
 * The `GuardrailDefinition` literal for one declaration.
 *
 * The IR's `onFail` block is nested and the runtime's definition is flat, so this is where
 * the two shapes meet -- the same projection the Python emitter makes. `fallbackPrompt` is
 * written as `undefined` rather than omitted because the runtime field is required and
 * reads it to decide whether a fallback prompt substitutes for the blocked one.
 */
function definition(guardrail: GuardrailShape): string {
  const entries: Entry[] = [
    ['id', stringLiteral(guardrail.id)],
    ['stages', stringArray(guardrail.stages)],
    ['policies', stringArray(guardrail.policies)],
    ['action', stringLiteral(guardrail.action)],
    ['redact', stringArray(guardrail.redact)],
    ['tools', stringArray(guardrail.tools)],
    ['message', stringLiteral(guardrail.onFail.message)],
    [
      'fallbackPrompt',
      guardrail.onFail.fallbackPrompt === undefined
        ? 'undefined'
        : stringLiteral(guardrail.onFail.fallbackPrompt),
    ],
    ['log', guardrail.onFail.log ? 'true' : 'false'],
  ];
  return objectLiteral(entries, '  ');
}

/**
 * The stage tables, emitted only for stages that have something in them.
 *
 * A table nothing reads is a name a reader has to check before deciding it does not
 * matter, so an app whose guardrails are all `input`-stage carries no `output` table.
 */
function tables(ir: IR): string[] {
  return STAGES.filter((stage) => usesStage(ir, stage)).map(
    (stage) =>
      `export const ${stageTable(stage)}: readonly GuardrailDefinition[] = byStage(${stringLiteral(
        stage,
      )});`,
  );
}

const ENFORCE = [
  '/**',
  ' * Log what fired, refuse what must stop, and return the verdict whose payload is safe',
  ' * to use. A caller that keeps its own copy of the text has skipped a `redact`.',
  ' *',
  ' * `escalate` stops here too: a pipeline route has no checkpoint to resume from, so a',
  ' * question to a human is a question nobody is asked. The validator refuses an',
  ' * `escalate` declaration at plan time; this is the backstop for a table edited by hand.',
  ' */',
  'export function enforceGuardrail(verdict: GuardrailVerdict): GuardrailVerdict {',
  '  for (const record of verdict.records) {',
  '    if (BY_ID.get(record.guardrail)?.log === true) {',
  '      console.warn(',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source, not interpolation
  '        `guardrail ${record.guardrail} fired at the ${record.stage} stage: ${record.message}` +',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source, not interpolation
  "          ` (${record.policies.join(', ')})`,",
  '      );',
  '    }',
  '  }',
  '  const deciding = verdict.deciding;',
  '  if (deciding !== undefined && STOPPING.has(deciding.action)) {',
  '    throw new GuardrailBlockedError(deciding.guardrail, deciding.stage, deciding.message);',
  '  }',
  '  return verdict;',
  '}',
].join('\n');

const BLOCK = [
  '/**',
  " * The guardrail block inside an error's `cause` chain, or `undefined`. A step re-raises",
  ' * whatever it caught as a `PipelineError`, so a block reaches a route wrapped;',
  ' * unwrapping it is what lets the route answer 4xx for a refused input instead of',
  ' * blaming the model with a 502.',
  ' */',
  'export function guardrailBlock(error: unknown): GuardrailBlockedError | undefined {',
  '  const seen = new Set<unknown>();',
  '  let current: unknown = error;',
  '  while (current instanceof Error && !seen.has(current)) {',
  '    if (current instanceof GuardrailBlockedError) return current;',
  '    seen.add(current);',
  '    current = current.cause;',
  '  }',
  '  return undefined;',
  '}',
].join('\n');

export function emitGuardrails(ir: IR): EmittedFile {
  const definitions = orderedGuardrails(ir).map(definition);
  return generated(
    paths.guardrails,
    moduleText(
      importStatement('@aid-framework/runtime', [
        { name: 'ConfigurationError', type: false },
        { name: 'GuardrailBlockedError', type: false },
        { name: 'GuardrailDefinition', type: true },
        { name: 'GuardrailEngine', type: false },
        { name: 'GuardrailVerdict', type: true },
      ]),
      [
        '/**',
        ' * Every guardrail the spec declares, in id order.',
        ' *',
        ' * An `input` or `output` declaration applies to *every* generated route, not to the',
        ' * prompt or agent that named it: the IR attaches a guardrail to a prompt, and the gate',
        ' * that requires an `input` stage is document-wide, so there is no narrower unit to',
        ' * scope it to. A guardrail evaluates the payload the runtime defines -- `{ text }` for',
        ' * `input`, `output` and `retrieval`, the tool arguments for `tool-call` -- which is why',
        ' * a `redact` action names `text` on the first three.',
        ' */',
        definitions.length === 0
          ? 'export const GUARDRAILS: readonly GuardrailDefinition[] = [];'
          : [
              'export const GUARDRAILS: readonly GuardrailDefinition[] = [',
              ...definitions.map((text) => `  ${text},`),
              '];',
            ].join('\n'),
      ].join('\n'),
      [
        '/** The actions that stop the request instead of annotating it. */',
        "const STOPPING = new Set(['block', 'escalate']);",
      ].join('\n'),
      [
        '/** The declarations by id, which is how a `guard` step names one. */',
        'export const BY_ID: ReadonlyMap<string, GuardrailDefinition> = new Map(',
        '  GUARDRAILS.map((guardrail) => [guardrail.id, guardrail] as const),',
        ');',
      ].join('\n'),
      [
        "/** The engine every call site shares, over this app's declarations. */",
        'export const ENGINE = new GuardrailEngine(BY_ID);',
      ].join('\n'),
      [
        '/** The declarations that run at one stage. */',
        'function byStage(stage: string): readonly GuardrailDefinition[] {',
        '  return GUARDRAILS.filter((guardrail) => guardrail.stages.includes(stage));',
        '}',
      ].join('\n'),
      [
        '/** One declaration by id, which is how a `guard` step names one. */',
        'export function guardrailById(id: string): GuardrailDefinition {',
        '  const found = BY_ID.get(id);',
        '  if (found === undefined) {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
        '    throw new ConfigurationError(`no guardrail ${JSON.stringify(id)} is declared`);',
        '  }',
        '  return found;',
        '}',
      ].join('\n'),
      tables(ir).join('\n\n'),
      ENFORCE,
      BLOCK,
    ),
  );
}
