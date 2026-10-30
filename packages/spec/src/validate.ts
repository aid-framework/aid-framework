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
import { findMalformedTemplate, templateRoots } from './parse.js';
import specSchema from './schema/spec.schema.json' with { type: 'json' };
import type { SourceDocument } from './source-document.js';

/**
 * Top-level sections the spec DSL accepts; anything else is reported as
 * `spec/unknown-key`. A section whose minimum version is above the one the document
 * declares is reported as `spec/not-supported` with the version it needs.
 */
export const SUPPORTED_SECTIONS = [
  'specVersion',
  'project',
  'types',
  'models',
  'prompts',
  'tools',
  'stores',
  'retrievers',
  'agents',
  'guardrails',
  'memory',
  'deployments',
  'evals',
  'pipelines',
] as const;

/**
 * Sections the design doc defines but no version of the DSL accepts. The Phase 2 L1
 * promotion moved every previous entry into `SUPPORTED_SECTIONS` behind
 * `SECTION_MIN_VERSION`, so this list is empty rather than deleted: the next section
 * that must answer "not yet" instead of "unknown key" belongs here.
 */
export const DEFERRED_SECTIONS = [] as const;

/** The spec language versions this build reads. A document declares one of them. */
export const SUPPORTED_SPEC_VERSIONS = ['0.1', '0.2', '0.3'] as const;

export type SpecVersion = (typeof SUPPORTED_SPEC_VERSIONS)[number];

/**
 * Sections added after 0.1 and the first version that accepts them. A 0.1 document
 * that uses one is told which version it needs, and its content is not silently
 * ignored: the scope diagnostic suppresses the schema errors underneath it.
 */
export const SECTION_MIN_VERSION: Partial<
  Record<(typeof SUPPORTED_SECTIONS)[number], SpecVersion>
> = {
  agents: '0.2',
  guardrails: '0.2',
  memory: '0.2',
  deployments: '0.2',
};

/**
 * The first spec version that accepts the `models[].cache` construct. Unlike the
 * top-level sections above, this is a *nested* construct: `SECTION_MIN_VERSION`
 * only gates top-level keys, so a model cache needs its own rule below or a 0.2
 * document would silently drop it.
 */
export const MODEL_CACHE_MIN_VERSION: SpecVersion = '0.3';

/** Pipeline step kinds implemented in spec v0.1. */
export const SUPPORTED_STEP_KINDS = [
  'generate',
  'retrieve',
  'tool',
  'emit',
  'branch',
  'parallel',
  'map',
  'reduce',
  'rerank',
  'guard',
  'agent',
] as const;

/**
 * Pipeline step kinds the design doc once described for a later phase.
 *
 * Empty, and that is the point: the last entry, `assert`, is eval-time only and now
 * lives in the eval layer as a metric kind (`evals.<id>.metrics[].kind: assert`).
 * The phase-exit criterion was "this list is empty"; it is met, and it is pinned by
 * `test/phase-exit.test.ts` so it cannot silently regress. A new pipeline step kind
 * belongs in `SUPPORTED_STEP_KINDS`; a removed one belongs in `RETIRED_STEP_KINDS`
 * with the spelling that replaces it. Neither case belongs here, and re-adding
 * `assert` on top of its metric arm would give one construct two spellings.
 */
export const DEFERRED_STEP_KINDS = [] as const;

/**
 * Pipeline step kinds that were removed rather than deferred, and the spelling that
 * replaces each one.
 *
 * `human` is not pending: a human-in-the-loop pause is a property of an *agent*
 * (`agents[].humanInTheLoop`), which the runtime already implements, so a `human`
 * pipeline step would be a second, unaligned way to spell the same thing -- and a
 * second pause mechanism. It is kept in this list, not in `DEFERRED_STEP_KINDS`, so a
 * document using the old spelling is told the replacement instead of being told the
 * key is unknown, while leaving the deferred list honest: re-adding `human` there
 * would make its retirement a no-op.
 */
export const RETIRED_STEP_KINDS: Readonly<Record<string, string>> = {
  human: 'agents[].humanInTheLoop',
};

/**
 * The spelling that replaces a retired step kind, or `undefined` when the kind is not
 * retired.
 *
 * Kept as a function so the "is this kind retired" test and the hint it produces can
 * never disagree about what the replacement is.
 */
export function retiredStepReplacement(kind: string): string | undefined {
  return Object.hasOwn(RETIRED_STEP_KINDS, kind) ? RETIRED_STEP_KINDS[kind] : undefined;
}

/**
 * The composite step kinds: the four a pipeline may nest inside another step.
 *
 * They are separate from `SUPPORTED_STEP_KINDS` because they are the only kinds that
 * can recurse, so the nesting bound and the "no `emit` inside a composite" rule have
 * exactly one list to consult.
 */
export const COMPOSITE_STEP_KINDS = ['branch', 'parallel', 'map', 'reduce'] as const;

/**
 * Deepest composite nesting a pipeline may declare.
 *
 * Enforced here (a plan error, before any code is generated) and again in the
 * runtime (`aid_runtime.control.MAX_STEP_DEPTH`). The runtime value is *emitted* into
 * the generated package rather than imported, so a drift between the two is a test
 * failure rather than a silent divergence -- see `MAX_STEP_DEPTH` in
 * `packages/ir/src/shapes.ts`.
 */
export const MAX_STEP_DEPTH = 4;

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
 * beneath it (e.g. a `{ rerank: ... }` step).
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
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);

  for (const key of Object.keys(spec)) {
    if (deferred.has(key)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'${key}' is defined by the AID design but is not implemented by any supported spec version`,
          path: [key],
          hint: `this build reads spec ${SUPPORTED_SPEC_VERSIONS.join(' and ')}. See docs/design.md section 14 and section 18.`,
        }),
      );
      reported.add(JSON.stringify([key]));
      continue;
    }
    if (!supported.has(key)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.unknownKey,
          message: `unknown top-level key '${key}'`,
          path: [key],
          hint: `expected one of ${SUPPORTED_SECTIONS.join(', ')}`,
        }),
      );
      reported.add(JSON.stringify([key]));
      continue;
    }

    // An unrecognised version is already a schema error at `specVersion`; reporting
    // every section against it would bury that root cause.
    const required = SECTION_MIN_VERSION[key as (typeof SUPPORTED_SECTIONS)[number]];
    if (required === undefined || declared === undefined || !known || declared === required) {
      continue;
    }
    if (specVersionAtLeast(declared, required)) continue;

    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.notSupported,
        message: `'${key}' requires specVersion ${required}, but this specification declares version ${declared}`,
        path: [key],
        hint: `set specVersion: "${required}"; spec 0.1 documents are unchanged`,
      }),
    );
    reported.add(JSON.stringify([key]));
  }

  modelCacheDiagnostics(spec, diagnostics, reported);
  stepDiagnostics(spec, diagnostics, reported);
}

/**
 * Nested version gating for `models[].cache`. `SECTION_MIN_VERSION` only gates
 * top-level keys, so this is where a 0.1/0.2 document that declares a model cache
 * is refused with the version it needs -- the same `spec/not-supported` shape the
 * top-level rule uses, but at the nested path.
 */
function modelCacheDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  if (declared === undefined || !known || specVersionAtLeast(declared, MODEL_CACHE_MIN_VERSION)) {
    return;
  }

  const models = asRecord(spec.models);
  for (const [name, model] of Object.entries(models)) {
    if (asRecord(model).cache === undefined) continue;
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.notSupported,
        message: `'models.${name}.cache' requires specVersion ${MODEL_CACHE_MIN_VERSION}, but this specification declares version ${declared}`,
        path: ['models', name, 'cache'],
        hint: `set specVersion: "${MODEL_CACHE_MIN_VERSION}"; spec 0.1 documents are unchanged`,
      }),
    );
    reported.add(JSON.stringify(['models', name, 'cache']));
  }
}

/** Compares the two-part versions this DSL uses; unknown input is never "at least". */
export function specVersionAtLeast(declared: string | undefined, required: SpecVersion): boolean {
  if (declared === undefined) return false;
  const parse = (value: string): number[] | undefined => {
    if (!/^\d+(\.\d+)*$/.test(value)) return undefined;
    return value.split('.').map(Number);
  };
  const left = parse(declared);
  const right = parse(required);
  if (left === undefined || right === undefined) return false;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

interface WalkedStep {
  body: Record<string, unknown>;
  path: DiagnosticPath;
  /** Number of composite steps enclosing this one; 0 at the top level. */
  depth: number;
}

/**
 * Visit every step in a list, recursing into the composite kinds.
 *
 * One walker serves the kind check, the nesting bound and the template check, so the
 * four composite shapes are enumerated exactly once. A new composite kind that this
 * function does not know about is therefore a single missing `case` rather than three
 * independently-maintained recursions.
 */
function walkSteps(
  steps: unknown,
  basePath: DiagnosticPath,
  depth: number,
  visit: (step: WalkedStep) => void,
): void {
  if (!Array.isArray(steps)) {
    return;
  }
  steps.forEach((step, index) => {
    const body = asRecord(step);
    const path: DiagnosticPath = [...basePath, index];
    visit({ body, path, depth });

    const branch = asRecord(body.branch);
    if (Object.keys(branch).length > 0) {
      walkSteps(branch.then, [...path, 'branch', 'then'], depth + 1, visit);
      walkSteps(branch.else, [...path, 'branch', 'else'], depth + 1, visit);
    }

    const parallel = asRecord(body.parallel);
    if (Array.isArray(parallel.branches)) {
      parallel.branches.forEach((arm, armIndex) => {
        walkSteps(arm, [...path, 'parallel', 'branches', armIndex], depth + 1, visit);
      });
    }

    const map = asRecord(body.map);
    if (Object.keys(asRecord(map.step)).length > 0) {
      walkSteps([map.step], [...path, 'map', 'step'], depth + 1, visit);
    }
  });
}

function stepDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const supported = new Set<string>(SUPPORTED_STEP_KINDS);
  const pipelines = asRecord(spec.pipelines);

  for (const [pipelineName, pipeline] of Object.entries(pipelines)) {
    const steps = asRecord(pipeline).steps;
    if (!Array.isArray(steps)) {
      continue;
    }

    let fanout = false;
    walkSteps(steps, ['pipelines', pipelineName, 'steps'], 0, ({ body, path, depth }) => {
      const keys = Object.keys(body);

      // A retired kind is checked before the unknown-kind fallback: the point of
      // retiring `human` is that a document using it is told the replacement, which
      // the generic "exactly one of ..." error cannot say.
      const retiredKey = keys.find((key) => retiredStepReplacement(key) !== undefined);
      if (retiredKey !== undefined) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.unsupportedStep,
            message: `pipeline step '${retiredKey}' was retired and is no longer part of the language`,
            path,
            hint: `use ${retiredStepReplacement(retiredKey)} instead (the \`agent.humanInTheLoop\` option): a pause belongs to an agent, not to a pipeline step`,
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
        return;
      }

      if (kinds[0] === 'parallel' || kinds[0] === 'map' || kinds[0] === 'reduce') {
        fanout = true;
      }

      // An `emit` is the pipeline's response, so it is a position in the top-level
      // list and nowhere else: a response cannot be bound, forwarded or merged, and
      // a composite's only way to affect the run is through the context.
      if (depth > 0 && kinds[0] === 'emit') {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.nestedEmitStep,
            message:
              'an `emit` step must be a top-level pipeline step, not nested inside a composite',
            path,
            hint: 'a composite reports its result by binding a name in the context; only the pipeline itself emits the response',
          }),
        );
        reported.add(JSON.stringify(path));
      }

      if (depth > MAX_STEP_DEPTH) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.stepNestingTooDeep,
            message: `pipeline step is nested ${depth} composites deep, past the limit of ${MAX_STEP_DEPTH}`,
            path,
            hint: `flatten the pipeline, or move part of it into a separate pipeline; the limit is ${MAX_STEP_DEPTH} levels of ${COMPOSITE_STEP_KINDS.join('/')}`,
          }),
        );
        reported.add(JSON.stringify(path));
      }

      if (kinds[0] === 'parallel' && Array.isArray(asRecord(body.parallel).branches)) {
        const branches = asRecord(body.parallel).branches as unknown[];
        if (branches.length === 0) {
          diagnostics.push(
            errorDiagnostic({
              code: DIAGNOSTIC_CODES.unsupportedStep,
              message: 'a `parallel` step needs at least one branch',
              path,
            }),
          );
          reported.add(JSON.stringify(path));
        }
      }
    });

    if (fanout && !declaresConcurrency(spec)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.fanoutWithoutConcurrency,
          message: `pipeline '${pipelineName}' fans out with parallel/map/reduce but no deployment declares \`concurrency\`, so the fan-out would have no cap`,
          path: ['pipelines', pipelineName, 'steps'],
          hint: 'declare `concurrency: <n>` on a deployment (for example `deployments.api.concurrency: 8`); the effective cap is the smallest `concurrency` across all deployments',
        }),
      );
    }
  }
}

/** True when any deployment declares a cap; the smallest one is the effective cap. */
function declaresConcurrency(spec: Record<string, unknown>): boolean {
  return Object.values(asRecord(spec.deployments)).some((deployment) => {
    const value = asRecord(deployment).concurrency;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
  });
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
    walkSteps(steps, ['pipelines', pipelineName, 'steps'], 0, ({ body, path }) => {
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
                message: `step ${path[path.length - 1]} (${kind}) input '${key}' ${problem}`,
                path: [...path, kind, 'input', key],
              }),
            );
          }
        }
      }

      const query = asRecord(body.retrieve).query;
      if (typeof query === 'string') {
        const problem = findMalformedTemplate(query);
        if (problem !== undefined) {
          diagnostics.push(
            errorDiagnostic({
              code: DIAGNOSTIC_CODES.malformedTemplate,
              message: `step ${path[path.length - 1]} (retrieve) query ${problem}`,
              path: [...path, 'retrieve', 'query'],
            }),
          );
        }
      }

      // `rerank.query`, `guard.text` and `agent.text` are scalar templates rather than
      // template maps, so the `input` loop above cannot see them.
      for (const [kind, field] of [
        ['rerank', 'query'],
        ['guard', 'text'],
        ['agent', 'text'],
      ] as const) {
        const value = asRecord(body[kind])[field];
        if (typeof value !== 'string') {
          continue;
        }
        const problem = findMalformedTemplate(value);
        if (problem !== undefined) {
          diagnostics.push(
            errorDiagnostic({
              code: DIAGNOSTIC_CODES.malformedTemplate,
              message: `step ${path[path.length - 1]} (${kind}) ${field} ${problem}`,
              path: [...path, kind, field],
            }),
          );
        }
      }
    });
  }
}

/**
 * Binding names must be unique within a pipeline. Checked here rather than in the
 * IR because it needs no cross-section knowledge.
 *
 * The scope rules follow the runtime's:
 *
 * - A `branch` arm is a separate path, so the same name in `then` and `else` is not a
 *   duplicate -- it is the only sound shape, because a name bound on one path and not
 *   the other makes the context depend on which arm ran.
 * - A `map` body runs once per item, so its bindings are local to one iteration and
 *   only `map.as` escapes.
 * - `parallel` arms merge into one context, so a name bound by two arms is a
 *   duplicate rather than a last-writer-wins race.
 *
 * A `branch` composite binds only the names *both* arms bind, which is why the same
 * name in `then` and `else` is the sound shape. With no `else`, the composite binds
 * nothing: when the condition is false no arm runs at all. A name bound by only one
 * arm therefore exists or not depending on the branch, so reading it downstream is a
 * path-dependent failure -- see `branchAsymmetryDiagnostics`.
 */
function bindingDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const pipelines = asRecord(spec.pipelines);

  for (const [pipelineName, pipeline] of Object.entries(pipelines)) {
    const steps = asRecord(pipeline).steps;
    if (!Array.isArray(steps)) {
      continue;
    }
    collectBindings(steps, ['pipelines', pipelineName, 'steps'], new Map(), diagnostics);
    branchAsymmetryDiagnostics(steps, ['pipelines', pipelineName, 'steps'], diagnostics);
  }
}

/** Render a diagnostic path as `steps[2].branch.then[0]`, for an error message. */
function pathLabel(path: DiagnosticPath): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number' && index > 0
        ? `[${segment}]`
        : `${index > 0 ? '.' : ''}${segment}`,
    )
    .join('');
}

function ownBinding(
  body: Record<string, unknown>,
  path: DiagnosticPath,
): { name: string; at: DiagnosticPath } | undefined {
  for (const kind of [
    'generate',
    'tool',
    'retrieve',
    'map',
    'reduce',
    'rerank',
    'agent',
  ] as const) {
    const binding = asRecord(body[kind]).as;
    if (typeof binding === 'string') {
      return { name: binding, at: [...path, kind, 'as'] };
    }
  }
  return undefined;
}

function collectBindings(
  steps: unknown,
  basePath: DiagnosticPath,
  bound: Map<string, string>,
  diagnostics: Diagnostic[],
): Map<string, string> {
  if (!Array.isArray(steps)) {
    return new Map(bound);
  }
  let next = new Map(bound);

  steps.forEach((step, index) => {
    const body = asRecord(step);
    const path: DiagnosticPath = [...basePath, index];

    const own = ownBinding(body, path);
    if (own !== undefined) {
      const previous = next.get(own.name);
      if (previous !== undefined) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.duplicateBinding,
            message: `binding '${own.name}' is already bound at ${previous}`,
            path: own.at,
          }),
        );
      } else {
        next.set(own.name, pathLabel(path));
      }
    }

    const branch = asRecord(body.branch);
    if (Object.keys(branch).length > 0) {
      const thenBound = collectBindings(
        branch.then,
        [...path, 'branch', 'then'],
        next,
        diagnostics,
      );
      const elseBound = collectBindings(
        branch.else,
        [...path, 'branch', 'else'],
        next,
        diagnostics,
      );
      next = new Map([...thenBound, ...elseBound]);
    }

    const parallel = asRecord(body.parallel);
    if (Array.isArray(parallel.branches)) {
      const merged = new Map(next);
      parallel.branches.forEach((arm, armIndex) => {
        const armBound = collectBindings(
          arm,
          [...path, 'parallel', 'branches', armIndex],
          next,
          diagnostics,
        );
        for (const [name, label] of armBound) {
          if (next.has(name)) continue;
          const rival = merged.get(name);
          if (rival !== undefined) {
            diagnostics.push(
              errorDiagnostic({
                code: DIAGNOSTIC_CODES.duplicateBinding,
                message: `binding '${name}' is bound by two parallel branches (${rival} and ${pathLabel([...path, 'parallel', 'branches', armIndex])}), so the merged context would depend on which finished last`,
                path: [...path, 'parallel', 'branches', armIndex],
              }),
            );
          } else {
            merged.set(name, label);
          }
        }
      });
      next = merged;
    }

    const map = asRecord(body.map);
    if (Object.keys(asRecord(map.step)).length > 0) {
      // Per-item scope: the body's bindings do not escape the iteration.
      collectBindings([map.step], [...path, 'map', 'step'], new Map(), diagnostics);
    }
  });

  return next;
}

/**
 * A `branch` runs exactly one arm, so a name bound by one arm and not the other is
 * present or absent depending on the condition. Reading such a name after the branch
 * would fail at runtime on one path and succeed on the other -- the path-dependent
 * class of bug that the deterministic-ordering rule exists to prevent, arriving here
 * through the context instead of through completion order.
 *
 * Only the symmetric difference is a problem: a name in both arms is fine, and a name
 * only one arm binds is fine as long as nothing outside the branch reads it.
 */
function branchAsymmetryDiagnostics(
  steps: unknown,
  basePath: DiagnosticPath,
  diagnostics: Diagnostic[],
  outerDownstream: ReadonlySet<string> = new Set(),
): void {
  if (!Array.isArray(steps)) {
    return;
  }

  steps.forEach((step, index) => {
    const body = asRecord(step);
    const path: DiagnosticPath = [...basePath, index];

    // A reference counts as downstream if it runs after this step on any path: a later
    // sibling, anything after the enclosing composite, or anything inside this step but
    // outside the branch's own arms. The arms are excluded on purpose -- reading a name
    // in the arm that binds it is fine.
    const downstream = new Set<string>(outerDownstream);
    collectLeafReferenceRoots(step, downstream);
    for (const later of steps.slice(index + 1)) collectReferenceRoots(later, downstream);
    forEachNestedStepList(step, (nested, suffix) => {
      if (suffix[0] === 'branch') {
        return;
      }
      for (const inner of nested) collectReferenceRoots(inner, downstream);
    });

    const branch = asRecord(body.branch);
    if (Object.keys(branch).length > 0) {
      const thenNames = exportedBindings(branch.then);
      const elseNames = exportedBindings(branch.else);

      const arms = [
        { arm: 'then', own: thenNames, other: elseNames, sibling: 'else' },
        { arm: 'else', own: elseNames, other: thenNames, sibling: 'then' },
      ] as const;

      for (const { arm, own, other, sibling } of arms) {
        for (const name of own) {
          if (other.has(name) || !downstream.has(name)) {
            continue;
          }
          diagnostics.push(
            errorDiagnostic({
              code: DIAGNOSTIC_CODES.branchArmBindingMismatch,
              message: `binding '${name}' is bound by the '${arm}' arm of this branch but not by its '${sibling}' arm, and a later step reads it, so '${name}' would exist or not depending on which arm ran`,
              path: [...path, 'branch', arm],
              hint: `bind '${name}' in both arms, or move the step that reads it inside the '${arm}' arm`,
            }),
          );
        }
      }
    }

    forEachNestedStepList(step, (nested, suffix) =>
      branchAsymmetryDiagnostics(nested, [...path, ...suffix], diagnostics, downstream),
    );
  });
}

/** Names a step list binds once it finishes, including the names its composites bind. */
function exportedBindings(steps: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(steps)) {
    return names;
  }
  for (const step of steps) {
    const own = ownBinding(asRecord(step), []);
    if (own !== undefined) {
      names.add(own.name);
    }
    // A `map` body's bindings are per-item and do not escape, so they are excluded.
    forEachNestedStepList(step, (nested) => {
      for (const name of exportedBindings(nested)) {
        names.add(name);
      }
    });
  }
  return names;
}

/** Every binding name read anywhere inside `step`, resolvable against the same context. */
function collectReferenceRoots(step: unknown, roots: Set<string>): Set<string> {
  collectLeafReferenceRoots(step, roots);
  forEachNestedStepList(step, (nested) => {
    for (const inner of nested) {
      collectReferenceRoots(inner, roots);
    }
  });
  return roots;
}

/** Name references in a step's own fields, without descending into its composites. */
function collectLeafReferenceRoots(step: unknown, roots: Set<string>): Set<string> {
  const body = asRecord(step);
  for (const kind of ['generate', 'retrieve', 'tool', 'emit'] as const) {
    const node = asRecord(body[kind]);
    for (const value of Object.values(asRecord(node.input))) {
      if (typeof value === 'string') {
        for (const root of templateRoots(value)) {
          roots.add(root);
        }
      }
    }
    if (typeof node.query === 'string') {
      for (const root of templateRoots(node.query)) {
        roots.add(root);
      }
    }
  }
  for (const kind of ['map', 'reduce'] as const) {
    const over = asRecord(body[kind]).over;
    if (typeof over === 'string') {
      roots.add(over);
    }
  }
  return roots;
}

/**
 * Visits the step lists a composite contains, with the path suffix that reaches each.
 * `map.step` is deliberately omitted: it is a single step, not a list, and its
 * bindings are per-item.
 */
function forEachNestedStepList(
  step: unknown,
  visit: (steps: readonly unknown[], suffix: DiagnosticPath) => void,
): void {
  const body = asRecord(step);
  const branch = asRecord(body.branch);
  if (Array.isArray(branch.then)) {
    visit(branch.then, ['branch', 'then']);
  }
  if (Array.isArray(branch.else)) {
    visit(branch.else, ['branch', 'else']);
  }
  const parallel = asRecord(body.parallel);
  if (Array.isArray(parallel.branches)) {
    parallel.branches.forEach((arm, index) => {
      if (Array.isArray(arm)) {
        visit(arm, ['parallel', 'branches', index]);
      }
    });
  }
  const mapBody = asRecord(body.map).step;
  if (Object.keys(asRecord(mapBody)).length > 0) {
    visit([mapBody], ['map', 'step']);
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
 * The `assert` metric's two spec-local rules.
 *
 * Kept out of `metricDiagnostics` on purpose: that rule is scoped to `gate.ci`, and
 * these two are not. A false assertion that a non-CI eval merely reports is still a
 * broken declaration -- the duplicate would also silently collapse in the generated
 * gate, which keys metrics by name.
 */
function assertMetricDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const evals = asRecord(spec.evals);

  for (const [name, evalNode] of Object.entries(evals)) {
    const node = asRecord(evalNode);
    if (!Array.isArray(node.metrics)) {
      continue;
    }

    const indices = node.metrics
      .map((metric, index) => ({ metric: asRecord(metric), index }))
      .filter((entry) => entry.metric.kind === 'assert');
    if (indices.length === 0) {
      continue;
    }

    if (indices.length > 1) {
      const first = indices[0] as { index: number };
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.metricAssertDuplicate,
          message: `eval '${name}': ${indices.length} assert metrics are declared, but an eval may declare at most one`,
          path: ['evals', name, 'metrics', indices[1]?.index ?? first.index],
          hint: 'every assert metric is named `assert` at runtime, so a second one overwrites the first; combine the conditions with `and` instead',
        }),
      );
    }

    const gate = asRecord(node.gate);
    if (gate.minMean !== 1) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.metricAssertNeedsFloor,
          message: `eval '${name}': an assert metric needs \`gate.minMean: 1\`, because a 0/1 metric's only honest gate is an absolute floor`,
          path: ['evals', name, 'gate'],
          hint: 'the regression allowance (`maxRegression`) can absorb a single failing case, so without the floor a false assertion can still pass the gate; set `gate.minMean: 1` or drop the assert metric',
        }),
      );
    }
  }
}

/**
 * Sub-features reserved *inside* a section spec v0.1 does implement. `DEFERRED_SECTIONS`
 * can only speak about a whole section, so a key that exists but is not served needs its
 * own rule here. The schema keeps the design doc's enum, so a spec can be written
 * against the final spelling today and be told which phase serves it, instead of having
 * the key silently ignored.
 */
function retrievalDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const retrievers = asRecord(spec.retrievers);

  for (const [name, retrieverNode] of Object.entries(retrievers)) {
    const retriever = asRecord(retrieverNode);
    const at = (...rest: PathSegment[]): DiagnosticPath => ['retrievers', name, ...rest];

    const source = asRecord(retriever.source);
    if (typeof source.kind === 'string' && source.kind !== 'file') {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'retrievers.${name}.source.kind: ${source.kind}' is defined by the AID design but is not implemented in spec v0.1`,
          path: at('source', 'kind'),
          hint: 'spec v0.1 indexes a local `file` source; the remote loaders (s3, http, db, mcp) belong to the phase that ships them',
        }),
      );
    }

    if (asRecord(retriever.chunking).strategy === 'semantic') {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'retrievers.${name}.chunking.strategy: semantic' is defined by the AID design but is not implemented in spec v0.1`,
          path: at('chunking', 'strategy'),
          hint: 'semantic chunking needs an embedding pass over the whole source at ingest; spec v0.1 chunks by size (fixed, recursive, code)',
        }),
      );
    }

    const refresh = asRecord(retriever.refresh);
    if (refresh.mode === 'incremental') {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'retrievers.${name}.refresh.mode: incremental' is defined by the AID design but is not implemented in spec v0.1`,
          path: at('refresh', 'mode'),
          hint: 'spec v0.1 rebuilds the index (mode: full); an incremental refresh the runtime does not honour would claim more than it does',
        }),
      );
    }
    if (refresh.schedule !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'retrievers.${name}.refresh.schedule' is defined by the AID design but is not implemented in spec v0.1`,
          path: at('refresh', 'schedule'),
          hint: 'scheduling an incremental refresh needs the ingestion runtime a later phase ships; spec v0.1 refreshes on rebuild',
        }),
      );
    }

    if (retriever.filters !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'retrievers.${name}.filters' is defined by the AID design but is not implemented in spec v0.1`,
          path: at('filters'),
          hint: 'spec v0.1 ranks the whole index; filter expressions belong to a later phase',
        }),
      );
    }
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
  assertMetricDiagnostics(spec, diagnostics);
  retrievalDiagnostics(spec, diagnostics);

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
