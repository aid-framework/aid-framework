// `ajv` is CommonJS, so under NodeNext only the named export is constructable.

import type { ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticPath,
  errorDiagnostic,
  type PathSegment,
} from './diagnostics.js';
import { findMalformedTemplate } from './parse.js';
import specSchema from './schema/spec.schema.json' with { type: 'json' };
import type { SourceDocument } from './source-document.js';

/**
 * Top-level sections spec v0.1 accepts; anything else is reported as
 * `spec/not-supported` (deferred) or `spec/unknown-key` (never defined).
 */
export const SUPPORTED_SECTIONS = [
  'specVersion',
  'project',
  'types',
  'models',
  'prompts',
  'tools',
  'evals',
  'pipelines',
] as const;

/**
 * Sections the design doc defines but Phase 0 does not implement, so the error can
 * say "not yet" instead of "unknown key".
 */
export const DEFERRED_SECTIONS = [
  'agents',
  'retrievers',
  'guardrails',
  'memory',
  'deployments',
] as const;

/** Pipeline step kinds implemented in Phase 0. */
export const SUPPORTED_STEP_KINDS = ['generate', 'tool', 'emit'] as const;

/** Pipeline step kinds the design doc describes for a later phase. */
export const DEFERRED_STEP_KINDS = [
  'retrieve',
  'rerank',
  'agent',
  'guard',
  'branch',
  'parallel',
  'map',
  'reduce',
  'assert',
  'human',
] as const;

export interface ValidateOptions {
  /** Used to resolve line/column for each diagnostic. */
  document?: SourceDocument;
  file?: string;
}

function buildValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    // `strict` makes schema-quality heuristics into hard errors. It also shapes the
    // schema: `strictRequired` requires each conditional branch to restate its
    // property as `"<name>": true`. See the schema's top-level `$comment`.
    strict: true,
    // `strictTypes` rejects a type array unless the union is opted into.
    allowUnionTypes: true,
    // Diagnostics carry their own messages, so Ajv's are only a fallback.
    verbose: false,
  });
  return ajv.compile(specSchema);
}

let compiled: ReturnType<typeof buildValidator> | undefined;

/** Compiled once per process, and lazily so importing this module stays cheap. */
function validator(): ReturnType<typeof buildValidator> {
  compiled ??= buildValidator();
  return compiled;
}

/** The spec v0.1 JSON Schema, for editors, `$schema` references and tooling. */
export function specJsonSchema(): unknown {
  return specSchema;
}

function describeValue(value: NonNullable<unknown>): string {
  if (Array.isArray(value)) {
    return 'a list';
  }
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'a mapping';
    default:
      return typeof value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Turns a JSON pointer from Ajv into this package's path form, extended with the
 * offending property for the two keywords where Ajv reports the parent.
 */
function errorPathOf(error: ErrorObject): DiagnosticPath {
  const base: PathSegment[] =
    error.instancePath === ''
      ? []
      : error.instancePath
          .split('/')
          .slice(1)
          .map((token) => {
            const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
            return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
          });

  const params = error.params as Record<string, unknown>;
  const named =
    error.keyword === 'additionalProperties'
      ? params.additionalProperty
      : error.keyword === 'required'
        ? params.missingProperty
        : undefined;

  return typeof named === 'string' ? [...base, named] : base;
}

function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function messageOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return `missing required property '${String(params.missingProperty)}'`;
    case 'additionalProperties':
      return `unknown property '${String(params.additionalProperty)}'`;
    case 'type': {
      const expected = params.type;
      return Array.isArray(expected)
        ? `must be one of ${expected.map((item) => String(item)).join(', ')}`
        : `must be ${article(String(expected))}`;
    }
    case 'enum': {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      return `must be one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}`;
    }
    case 'const':
      return `must be exactly ${JSON.stringify(params.allowedValue)}`;
    case 'pattern':
      return `does not match ${String(params.pattern)}`;
    case 'oneOf':
    case 'anyOf':
      return 'does not match any of the allowed forms';
    case 'minimum':
      return `must be greater than or equal to ${String(params.limit)}`;
    case 'maximum':
      return `must be less than or equal to ${String(params.limit)}`;
    case 'minItems':
      return `must contain at least ${String(params.limit)} item(s)`;
    case 'minProperties':
      return `must contain at least ${String(params.limit)} entr(ies)`;
    case 'minLength':
      return `must be at least ${String(params.limit)} character(s) long`;
    case 'uniqueItems':
      return 'must not contain duplicate items';
    case 'if':
      return `the requirements that apply when the '${String(params.failingKeyword)}' branch is taken are not satisfied`;
    case 'not':
      return 'must not be present in this form';
    default:
      return error.message ?? 'is not valid here';
  }
}

/**
 * Drops Ajv's conditional wrapper once the branch failure it wraps is reported.
 * A failing `then`/`else` yields both the specific failure and an `if` wrapper at
 * the same `instancePath`, so the same mistake would otherwise appear twice.
 *
 * The pair is matched through `schemaPath`: the wrapper goes only when a sibling
 * failure was reported beneath the same conditional parent.
 */
function dropConditionalWrappers(errors: readonly ErrorObject[]): ErrorObject[] {
  const failures = errors.filter((error) => error.keyword !== 'if');
  return errors.filter((error) => {
    if (error.keyword !== 'if') {
      return true;
    }
    const parent = error.schemaPath.replace(/\/if$/, '');
    return !failures.some((failure) => failure.schemaPath.startsWith(`${parent}/`));
  });
}

/**
 * True when a more precise diagnostic was already reported at this path or an
 * ancestor of it, which is how a scope error suppresses the `oneOf` cascade
 * beneath it (e.g. a `{ retrieve: ... }` step).
 */
function alreadyReported(path: DiagnosticPath, reported: ReadonlySet<string>): boolean {
  for (let depth = path.length; depth >= 0; depth -= 1) {
    if (reported.has(JSON.stringify(path.slice(0, depth)))) {
      return true;
    }
  }
  return false;
}

function scopeDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const deferred = new Set<string>(DEFERRED_SECTIONS);
  const supported = new Set<string>(SUPPORTED_SECTIONS);

  for (const key of Object.keys(spec)) {
    if (deferred.has(key)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'${key}' is defined by the AID design but is not implemented in spec v0.1`,
          path: [key],
          hint: `Phase 0 covers ${SUPPORTED_SECTIONS.join(', ')}. See docs/design.md section 14 and section 18.`,
        }),
      );
      reported.add(JSON.stringify([key]));
    } else if (!supported.has(key)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.unknownKey,
          message: `unknown top-level key '${key}'`,
          path: [key],
          hint: `expected one of ${SUPPORTED_SECTIONS.join(', ')}`,
        }),
      );
      reported.add(JSON.stringify([key]));
    }
  }

  stepDiagnostics(spec, diagnostics, reported);
}

function stepDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const deferred = new Set<string>(DEFERRED_STEP_KINDS);
  const supported = new Set<string>(SUPPORTED_STEP_KINDS);
  const pipelines = asRecord(spec.pipelines);

  for (const [pipelineName, pipeline] of Object.entries(pipelines)) {
    const steps = asRecord(pipeline).steps;
    if (!Array.isArray(steps)) {
      continue;
    }

    steps.forEach((step, index) => {
      const body = asRecord(step);
      const keys = Object.keys(body);
      const path: DiagnosticPath = ['pipelines', pipelineName, 'steps', index];

      const deferredKey = keys.find((key) => deferred.has(key));
      if (deferredKey !== undefined) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.unsupportedStep,
            message: `pipeline step '${deferredKey}' is not implemented in Phase 0`,
            path,
            hint: `supported steps are ${SUPPORTED_STEP_KINDS.join(', ')}`,
          }),
        );
        reported.add(JSON.stringify(path));
        return;
      }

      const kinds = keys.filter((key) => supported.has(key));
      if (kinds.length !== 1) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.unsupportedStep,
            message:
              kinds.length === 0
                ? `step must contain exactly one of ${SUPPORTED_STEP_KINDS.join(', ')}`
                : `step contains more than one step kind (${kinds.join(', ')}); exactly one is allowed`,
            path,
          }),
        );
        reported.add(JSON.stringify(path));
      }
    });
  }
}

function templateDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const prompts = asRecord(spec.prompts);
  for (const [name, prompt] of Object.entries(prompts)) {
    const template = asRecord(prompt).template;
    if (typeof template !== 'string') {
      continue;
    }
    const problem = findMalformedTemplate(template);
    if (problem !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.malformedTemplate,
          message: `prompt '${name}': template ${problem}`,
          path: ['prompts', name, 'template'],
        }),
      );
    }
  }

  const pipelines = asRecord(spec.pipelines);
  for (const [pipelineName, pipeline] of Object.entries(pipelines)) {
    const steps = asRecord(pipeline).steps;
    if (!Array.isArray(steps)) {
      continue;
    }
    steps.forEach((step, index) => {
      const body = asRecord(step);
      for (const kind of SUPPORTED_STEP_KINDS) {
        const input = asRecord(asRecord(body[kind]).input);
        for (const [key, value] of Object.entries(input)) {
          if (typeof value !== 'string') {
            continue;
          }
          const problem = findMalformedTemplate(value);
          if (problem !== undefined) {
            diagnostics.push(
              errorDiagnostic({
                code: DIAGNOSTIC_CODES.malformedTemplate,
                message: `step ${index} (${kind}) input '${key}' ${problem}`,
                path: ['pipelines', pipelineName, 'steps', index, kind, 'input', key],
              }),
            );
          }
        }
      }
    });
  }
}

/**
 * Binding names must be unique within a pipeline. Checked here rather than in the
 * IR because it needs no cross-section knowledge.
 */
function bindingDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const pipelines = asRecord(spec.pipelines);

  for (const [pipelineName, pipeline] of Object.entries(pipelines)) {
    const steps = asRecord(pipeline).steps;
    if (!Array.isArray(steps)) {
      continue;
    }

    const seen = new Map<string, number>();
    steps.forEach((step, index) => {
      const body = asRecord(step);
      for (const kind of ['generate', 'tool'] as const) {
        const binding = asRecord(body[kind]).as;
        if (typeof binding !== 'string') {
          continue;
        }
        const previous = seen.get(binding);
        if (previous !== undefined) {
          diagnostics.push(
            errorDiagnostic({
              code: DIAGNOSTIC_CODES.duplicateBinding,
              message: `binding '${binding}' is already used by step ${previous}`,
              path: ['pipelines', pipelineName, 'steps', index, kind, 'as'],
            }),
          );
        } else {
          seen.set(binding, index);
        }
      }
    });
  }
}

/**
 * An `llm-judge` metric cannot run in the CI gate, which uses the deterministic
 * `fake` provider and no credentials. An error rather than a warning, because a
 * gate that silently drops one of its own metrics is weaker than it advertises.
 */
function metricDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const evals = asRecord(spec.evals);

  for (const [name, evalNode] of Object.entries(evals)) {
    const node = asRecord(evalNode);
    const gate = asRecord(node.gate);
    if (gate.ci !== true || !Array.isArray(node.metrics)) {
      continue;
    }
    node.metrics.forEach((metric, index) => {
      if (asRecord(metric).kind === 'llm-judge') {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.metricUnavailableInCi,
            message: `eval '${name}': the llm-judge metric at index ${index} cannot run under the CI eval gate, so the gate would advertise a criterion it never evaluates`,
            path: ['evals', name, 'metrics', index],
            hint: 'the CI gate runs against the deterministic fake provider, which cannot act as a judge; move this metric to an eval without `gate.ci`, or drop `gate.ci`',
          }),
        );
      }
    });
  }
}

/**
 * Validates an already-parsed spec value. Pure with respect to the filesystem:
 * position information is layered on afterwards once a `document` is supplied.
 */
export function validateSpec(value: unknown, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (value === null || value === undefined) {
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.emptyDocument,
        message: 'the specification is empty',
        hint: 'start with `specVersion: "0.1"` and a `project` block',
      }),
    );
    return withPositions(diagnostics, options);
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.documentNotAMapping,
        message: `the specification must be a mapping at the top level, found ${describeValue(value)}`,
      }),
    );
    return withPositions(diagnostics, options);
  }

  const spec = value as Record<string, unknown>;
  const reported = new Set<string>();

  // Scope first, so the schema pass stays quiet about the paths it reports.
  scopeDiagnostics(spec, diagnostics, reported);

  const validate = validator();
  if (!validate(spec)) {
    for (const error of dropConditionalWrappers(validate.errors ?? [])) {
      const path = errorPathOf(error);
      if (alreadyReported(path, reported)) {
        continue;
      }
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.schemaViolation,
          message: messageOf(error),
          path,
        }),
      );
    }
  }

  templateDiagnostics(spec, diagnostics);
  bindingDiagnostics(spec, diagnostics);
  metricDiagnostics(spec, diagnostics);

  return withPositions(diagnostics, options);
}

/**
 * Attaches file/line/column to every diagnostic with a resolvable path, as one
 * pass at the end so no rule has to care whether a document exists.
 */
function withPositions(diagnostics: Diagnostic[], options: ValidateOptions): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const withFile =
      options.file === undefined ? diagnostic : { ...diagnostic, file: options.file };
    if (options.document === undefined) {
      return withFile;
    }
    const position = options.document.positionAt(diagnostic.path);
    if (position === undefined) {
      return withFile;
    }
    return { ...withFile, line: position.line, column: position.column };
  });
}
