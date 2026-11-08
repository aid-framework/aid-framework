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
  'knowledgeBases',
  'agents',
  'guardrails',
  'decisions',
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
export const SUPPORTED_SPEC_VERSIONS = [
  '0.1',
  '0.2',
  '0.3',
  '0.4',
  '0.5',
  '0.6',
  '0.7',
  '0.8',
  '0.9',
  '0.10',
  '0.11',
  '0.12',
  '0.13',
] as const;

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
  decisions: '0.6',
  knowledgeBases: '0.12',
};

/**
 * The first spec version that accepts the `models[].cache` construct. Unlike the
 * top-level sections above, this is a *nested* construct: `SECTION_MIN_VERSION`
 * only gates top-level keys, so a model cache needs its own rule below or a 0.2
 * document would silently drop it.
 */
export const MODEL_CACHE_MIN_VERSION: SpecVersion = '0.3';

/**
 * The first spec version that lets a guardrail name a decision. Spec 0.6 introduced
 * the `decisions` section itself; coupling the two would have made a 0.6 document
 * that already declares decisions silently gain an enforcement path, so the wiring
 * is its own version.
 */
export const GUARDRAIL_DECISION_MIN_VERSION: SpecVersion = '0.7';

/**
 * The first spec version that lets an eval score with a decision. The metric kind lives
 * inside `evals`, so `SECTION_MIN_VERSION` cannot see it; a 0.7 document that declares
 * one is refused rather than measured by a runtime it did not ask for.
 */
export const DECISION_METRIC_MIN_VERSION: SpecVersion = '0.8';

/**
 * The `route` step arrived in 0.9. A pipeline has existed since 0.1, so this is a
 * nested construct that `SECTION_MIN_VERSION` cannot gate; the check lives in
 * `routeDiagnostics`, which runs for every step.
 */
export const ROUTE_MIN_VERSION: SpecVersion = '0.9';

/**
 * The Jev aliases that move with the vendor's next release. Duplicated from the runtimes
 * on purpose: `packages/spec` does not depend on a runtime, and the fixtures pin the same
 * pair on both sides.
 */
const JEV_MOVING_ALIASES: ReadonlySet<string> = new Set(['jev-latest', 'jev-preview']);

/**
 * The question types whose answers carry a `confidence`. `choice` and `score` do; `noul`
 * carries only its probability, and the wire contract forbids a confidence on it. Any
 * rule that reads a confidence has to consult this, because the missing value cannot be
 * defaulted: a missing confidence is not a high one.
 */
export const CONFIDENCE_ANSWER_TYPES: readonly string[] = ['choice', 'score'];

/**
 * The first spec version that accepts `deployments[].image`. Nested for the same reason
 * as `models[].cache`: the section itself predates it, so the top-level gate cannot see
 * it, and a 0.2/0.3 document that declares an image must be told which version it needs
 * rather than have the key silently dropped by a schema it declared.
 */
export const DEPLOYMENT_IMAGE_MIN_VERSION: SpecVersion = '0.4';

/**
 * The first spec version that accepts the batch surface: `pipelines[].trigger.manual` and
 * `deployments[].pipeline`. A batch job is the pair -- a pipeline with no inbound route and
 * a deployment that names it -- so both are gated together: a 0.4 document that declares
 * either is told which version it needs instead of being read as if the key never existed.
 */
export const BATCH_SURFACE_MIN_VERSION: SpecVersion = '0.5';

/**
 * The first spec version that accepts `provider: google` (Vertex AI).
 *
 * A provider is a vocabulary change, not a new section, so it needs its own nested gate:
 * a 0.5 document that names a provider its version did not offer was written against a
 * mistake, and the schema enum alone would only say "must be one of" without saying which
 * version offers it.
 */
export const GOOGLE_PROVIDER_MIN_VERSION: SpecVersion = '0.6';

/**
 * The first spec version that accepts `provider: gemini`, the Gemini API rather than
 * Vertex AI. It is a separate id because the provider id names the wire *and* the auth:
 * Vertex needs a project, a location and an OAuth2 token, while the Gemini API needs one
 * key and a different version segment. Under one id the generator would have to infer the
 * auth story from `baseUrl`, which the adapter mapping deliberately never does.
 */
export const GEMINI_PROVIDER_MIN_VERSION: SpecVersion = '0.10';

/**
 * The first spec version that lets a guardrail delegate its policy to a managed engine
 * (`engine: bedrock` and the `bedrock` policy block).
 *
 * A managed guardrail is not a new provider and not a new section: it is a different
 * *location* for a guardrail's policy, with a different wire — `ApplyGuardrail` takes
 * text and returns text, and it cannot run at `retrieval` or `tool-call` because those
 * stages have no prompt text to send. A 0.10 document that names an engine is told
 * which version it needs rather than having the key dropped.
 */
export const BEDROCK_GUARDRAIL_MIN_VERSION: SpecVersion = '0.11';

/**
 * The first spec version that lets a retriever bind to a managed knowledge base.
 *
 * `knowledgeBases` is a top-level section, so `SECTION_MIN_VERSION` gates it. The
 * binding itself lives on `retrievers[].knowledgeBase`, which that map cannot see, and
 * a 0.11 document that names one would otherwise lose its `source`/`store` requirements
 * to an unrelated schema error. So the nested binding has its own gate here.
 */
export const KNOWLEDGE_BASE_MIN_VERSION: SpecVersion = '0.12';

/**
 * The first spec version that accepts `deployments[].runtime`, the managed agent
 * runtime block. Nested for the same reason as the gates above: `deployments` has
 * existed since 0.2, so a 0.12 document that names a platform has to be told which
 * version it needs instead of being deployed to a compute module it did not ask for.
 */
export const RUNTIME_MIN_VERSION: SpecVersion = '0.13';

/** The version gate for every provider id that arrived after the spec that introduced it. */
const PROVIDER_MIN_VERSIONS: Readonly<Record<string, SpecVersion>> = {
  google: GOOGLE_PROVIDER_MIN_VERSION,
  gemini: GEMINI_PROVIDER_MIN_VERSION,
};

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
  'route',
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
 * The composite step kinds: the five a pipeline may nest inside another step.
 *
 * They are separate from `SUPPORTED_STEP_KINDS` because they are the only kinds that
 * can recurse, so the nesting bound and the "no `emit` inside a composite" rule have
 * exactly one list to consult.
 */
export const COMPOSITE_STEP_KINDS = ['branch', 'parallel', 'map', 'reduce', 'route'] as const;

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
  providerVersionDiagnostics(spec, diagnostics, reported);
  guardrailDecisionDiagnostics(spec, diagnostics, reported);
  deploymentImageDiagnostics(spec, diagnostics, reported);
  batchSurfaceDiagnostics(spec, diagnostics, reported);
  stepDiagnostics(spec, diagnostics, reported);
  routeDiagnostics(spec, diagnostics, reported);
  knowledgeBaseDiagnostics(spec, diagnostics, reported);
  runtimeDiagnostics(spec, diagnostics, reported);
}

/**
 * Version gating for the provider ids that arrived after the spec that first offered
 * their wire dialect. `google` (Vertex AI) is a 0.6 addition and `gemini` (the Gemini
 * API) a 0.10 one, so a document that declares an earlier version and names one is told
 * which version it needs; the schema's enum error at the same path is suppressed by
 * `reported`.
 */
function providerVersionDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  if (declared === undefined || !known) {
    return;
  }

  for (const [name, model] of Object.entries(asRecord(spec.models))) {
    const provider = asRecord(model).provider;
    if (typeof provider !== 'string') continue;
    const required = PROVIDER_MIN_VERSIONS[provider];
    if (required === undefined || specVersionAtLeast(declared, required)) continue;
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.notSupported,
        message: `'models.${name}.provider: ${provider}' requires specVersion ${required}, but this specification declares version ${declared}`,
        path: ['models', name, 'provider'],
        hint: `set specVersion: "${required}"; documents that do not use provider '${provider}' are unchanged`,
      }),
    );
    reported.add(JSON.stringify(['models', name, 'provider']));
  }
}

/**
 * The rules a decision-backed guardrail needs that JSON Schema cannot state.
 *
 * Three checks live here. **Version**: `decision` is a 0.7 construct, while the
 * `decisions` section itself is 0.6, so this is a nested gate like
 * `models[].cache`. **Reference**: the decision must exist and be a `choice` --
 * `noul` has no labels and `score` has an order, neither of which an `onDecision`
 * map can answer. **Coverage**: `onDecision` must map every declared label and no
 * other, because a missing label would otherwise be an allow nobody declared and
 * an extra one a typo that silently never fires.
 *
 * The stage restriction is in the schema (`items: {const: "input"}`), and stated
 * again nowhere else: there is one place to look.
 */
function guardrailDecisionDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  const decisions = asRecord(spec.decisions);

  for (const [name, raw] of Object.entries(asRecord(spec.guardrails))) {
    const guardrail = asRecord(raw);
    const decision = typeof guardrail.decision === 'string' ? guardrail.decision : undefined;
    const hasPolicies = Array.isArray(guardrail.policies) && guardrail.policies.length > 0;
    const engine = guardrail.engine === 'bedrock' ? 'bedrock' : 'builtin';
    const managed = guardrail.bedrock !== undefined;

    if ((engine === 'bedrock' || managed) && declared !== undefined && known) {
      if (!specVersionAtLeast(declared, BEDROCK_GUARDRAIL_MIN_VERSION)) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.notSupported,
            message: `'guardrails.${name}.engine' requires specVersion ${BEDROCK_GUARDRAIL_MIN_VERSION}, but this specification declares version ${declared}`,
            path: ['guardrails', name, 'engine'],
            hint: `set specVersion: "${BEDROCK_GUARDRAIL_MIN_VERSION}"; documents whose guardrails all use the builtin engine are unchanged`,
          }),
        );
        reported.add(JSON.stringify(['guardrails', name, 'engine']));
        continue;
      }
    }

    if (engine === 'bedrock') {
      // The engine is the evaluator, so "nothing to check" is not this guardrail's
      // problem. What is: a managed guardrail can only refuse or rewrite text, and a
      // redaction that also blocks cannot be represented -- `pii` is the one policy the
      // API can anonymise, so a blocking category beside `action: redact` would ship a
      // guardrail that anonymises what it was asked to stop.
      const policy = asRecord(guardrail.bedrock);
      const blocking = ['content', 'topics', 'words'].filter((key) => policy[key] !== undefined);
      if (guardrail.action === 'redact' && blocking.length > 0) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `guardrail '${name}' sets action 'redact' but its bedrock policy also blocks (${blocking.join(', ')}); a managed guardrail either anonymises personal information or refuses the text`,
            path: ['guardrails', name, 'action'],
            hint: "keep only 'pii' under 'bedrock' for a redacting guardrail, or change the action to 'block'",
          }),
        );
      }
      if (guardrail.action === 'redact' && policy.pii === undefined) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `guardrail '${name}' sets action 'redact' but its bedrock policy declares no 'pii' entity to anonymise`,
            path: ['guardrails', name, 'action'],
            hint: "name the entities under 'bedrock.pii', or use action 'block'",
          }),
        );
      }
      continue;
    }

    if (decision === undefined) {
      if (!hasPolicies) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `guardrail '${name}' declares neither 'policies' nor 'decision', so it has nothing to check`,
            path: ['guardrails', name],
            hint: "add 'policies' with an 'action', or a 'decision' with 'onDecision'",
          }),
        );
      }
      for (const stray of ['onDecision', 'minConfidence'] as const) {
        if (guardrail[stray] === undefined) continue;
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `'guardrails.${name}.${stray}' is only meaningful beside 'decision', which this guardrail does not declare`,
            path: ['guardrails', name, stray],
          }),
        );
      }
      continue;
    }

    if (
      declared !== undefined &&
      known &&
      !specVersionAtLeast(declared, GUARDRAIL_DECISION_MIN_VERSION)
    ) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'guardrails.${name}.decision' requires specVersion ${GUARDRAIL_DECISION_MIN_VERSION}, but this specification declares version ${declared}`,
          path: ['guardrails', name, 'decision'],
          hint: `set specVersion: "${GUARDRAIL_DECISION_MIN_VERSION}"; documents without a decision-backed guardrail are unchanged`,
        }),
      );
      reported.add(JSON.stringify(['guardrails', name, 'decision']));
      continue;
    }

    if (!Object.hasOwn(decisions, decision)) {
      const ids = Object.keys(decisions).sort();
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.schemaViolation,
          message: `guardrail '${name}' names decision '${decision}', which the 'decisions' section does not declare`,
          path: ['guardrails', name, 'decision'],
          hint:
            ids.length > 0
              ? `declare '${decision}', or use one of: ${ids.join(', ')}`
              : "add a 'decisions' section that declares it",
        }),
      );
      continue;
    }

    const target = asRecord(decisions[decision]);
    if (target.type !== 'choice') {
      // A `minConfidence` floor reads a field the answer may not carry. A `noul` answer
      // carries only its probability, so the floor could never be satisfied and must be
      // refused here rather than defaulted at run time to "no opinion, therefore pass".
      const floor = typeof guardrail.minConfidence === 'number' ? guardrail.minConfidence : 0;
      const type = String(target.type ?? 'unknown');
      if (floor > 0 && !CONFIDENCE_ANSWER_TYPES.includes(type)) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `'guardrails.${name}.minConfidence' reads a confidence, but decision '${decision}' is a '${type}' question and a '${type}' answer carries none, so the floor could never be satisfied`,
            path: ['guardrails', name, 'minConfidence'],
            hint: "a 'noul' answer carries only its probability; drop 'minConfidence' or declare a 'choice' decision",
          }),
        );
        continue;
      }
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.schemaViolation,
          message: `decision '${decision}' is a '${type}' question; a guardrail needs a 'choice' decision whose labels it can act on`,
          path: ['guardrails', name, 'decision'],
          hint: 'declare the decision with type: choice and name each label under criteria',
        }),
      );
      continue;
    }

    const criteria = Object.keys(asRecord(target.criteria));
    const onDecision = asRecord(guardrail.onDecision);
    for (const label of criteria) {
      if (Object.hasOwn(onDecision, label)) continue;
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.schemaViolation,
          message: `'guardrails.${name}.onDecision' does not say what the '${label}' answer means`,
          path: ['guardrails', name, 'onDecision'],
          hint: `add '${label}': allow, block, flag or escalate`,
        }),
      );
    }
    for (const label of Object.keys(onDecision)) {
      if (criteria.includes(label)) continue;
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.schemaViolation,
          message: `'guardrails.${name}.onDecision.${label}' names no criterion of decision '${decision}'`,
          path: ['guardrails', name, 'onDecision', label],
          hint:
            criteria.length > 0
              ? `declared criteria: ${criteria.join(', ')}`
              : 'the decision declares no criteria',
        }),
      );
    }
  }
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

/**
 * Nested version gating and the container-only rule for `deployments[].image`.
 *
 * The version half mirrors `models[].cache`: the `deployments` section exists from 0.2,
 * but an image contract is a 0.4 construct, so a 0.2/0.3 document that declares one is
 * refused with the version it needs instead of being read as if it always existed.
 *
 * The second half is a contradiction, not a version problem: only a `target: container`
 * deployment produces an image, so an image on a `serverless`, `batch` or `edge`
 * deployment names an artifact nothing builds. Reported here rather than in the schema so
 * the message can say why, and so a document below 0.4 hears about the version first.
 */
function deploymentImageDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  const needsVersion =
    declared !== undefined && known && !specVersionAtLeast(declared, DEPLOYMENT_IMAGE_MIN_VERSION);
  // An unrecognised version is already a schema error at `specVersion`; saying "0.4
  // needed" against it would bury the root cause.
  if (declared === undefined || !known) return;

  for (const [id, raw] of Object.entries(asRecord(spec.deployments))) {
    const deployment = asRecord(raw);
    if (deployment.image === undefined) continue;
    if (needsVersion) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'deployments.${id}.image' requires specVersion ${DEPLOYMENT_IMAGE_MIN_VERSION}, but this specification declares version ${declared}`,
          path: ['deployments', id, 'image'],
          hint: `set specVersion: "${DEPLOYMENT_IMAGE_MIN_VERSION}"; a document that declares no image is unchanged`,
        }),
      );
      reported.add(JSON.stringify(['deployments', id, 'image']));
      continue;
    }
    if (deployment.target === 'container') continue;
    const target = typeof deployment.target === 'string' ? deployment.target : 'unknown';
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.deploymentImageWithoutContainer,
        message: `deployment '${id}' declares an image but targets '${target}', which builds no image`,
        path: ['deployments', id, 'image'],
        hint: 'set `target: container` to get a Dockerfile and a release workflow, or drop `image`; the generator will not publish an artifact it cannot build',
      }),
    );
  }
}

/**
 * The batch surface: `pipelines[].trigger.manual` and `deployments[].pipeline`.
 *
 * Both halves are needed for one feature and are gated together. A batch deployment
 * without a pipeline names a job nothing can run -- `target: batch` has always been
 * accepted, and until now a document that declared it compiled to an image with no
 * entrypoint and a deploy plan with no module, which is the silent gap this rule closes
 * rather than a behaviour worth preserving. The version half is reported first, so a
 * 0.4 document hears "0.5" instead of a contradiction it cannot fix without it.
 */
function batchSurfaceDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  if (declared === undefined || !known) return;
  const needsVersion = !specVersionAtLeast(declared, BATCH_SURFACE_MIN_VERSION);
  const pipelines = asRecord(spec.pipelines);
  const manual = new Set(
    Object.entries(pipelines)
      .filter(([, raw]) => asRecord(asRecord(raw).trigger)?.manual !== undefined)
      .map(([id]) => id),
  );

  if (needsVersion) {
    for (const id of [...manual].sort()) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'pipelines.${id}.trigger.manual' requires specVersion ${BATCH_SURFACE_MIN_VERSION}, but this specification declares version ${declared}`,
          path: ['pipelines', id, 'trigger', 'manual'],
          hint: `set specVersion: "${BATCH_SURFACE_MIN_VERSION}"; a document with no manual pipeline is unchanged`,
        }),
      );
      reported.add(JSON.stringify(['pipelines', id, 'trigger']));
    }
  }

  for (const [id, raw] of Object.entries(asRecord(spec.deployments))) {
    const deployment = asRecord(raw);
    const target = typeof deployment.target === 'string' ? deployment.target : 'unknown';
    const pipeline = deployment.pipeline;
    if (pipeline === undefined) {
      if (target !== 'batch') continue;
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.batchDeploymentWithoutPipeline,
          message: `deployment '${id}' targets 'batch' but names no pipeline, so the job would run nothing`,
          path: ['deployments', id],
          hint: `declare \`pipeline: <id>\` naming a pipeline with \`trigger: { manual: true }\` (spec ${BATCH_SURFACE_MIN_VERSION}); a batch job exists to run one pipeline once`,
        }),
      );
      reported.add(JSON.stringify(['deployments', id]));
      continue;
    }
    if (needsVersion) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'deployments.${id}.pipeline' requires specVersion ${BATCH_SURFACE_MIN_VERSION}, but this specification declares version ${declared}`,
          path: ['deployments', id, 'pipeline'],
          hint: `set specVersion: "${BATCH_SURFACE_MIN_VERSION}"; a document that binds no job is unchanged`,
        }),
      );
      reported.add(JSON.stringify(['deployments', id, 'pipeline']));
      continue;
    }
    if (target !== 'batch') {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.deploymentPipelineWithoutBatch,
          message: `deployment '${id}' names pipeline '${String(pipeline)}' but targets '${target}', which answers requests through a route rather than running one pipeline`,
          path: ['deployments', id, 'pipeline'],
          hint: 'set `target: batch` to get a job that runs the pipeline once, or drop `pipeline`; a route is selected by the request, not by the deployment',
        }),
      );
      reported.add(JSON.stringify(['deployments', id, 'pipeline']));
      continue;
    }
    const name = typeof pipeline === 'string' ? pipeline : undefined;
    if (name === undefined || !Object.hasOwn(pipelines, name)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.batchPipelineUnknown,
          message: `deployment '${id}' names pipeline '${String(pipeline)}', which this specification does not declare`,
          path: ['deployments', id, 'pipeline'],
          hint: `declare \`pipelines.${String(pipeline)}\`, or name one of ${Object.keys(pipelines).sort().join(', ') || '(none declared)'}`,
        }),
      );
      reported.add(JSON.stringify(['deployments', id, 'pipeline']));
      continue;
    }
    if (manual.has(name)) continue;
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.batchPipelineNotManual,
        message: `deployment '${id}' runs pipeline '${name}', but that pipeline does not declare 'trigger.manual'`,
        path: ['deployments', id, 'pipeline'],
        hint: `set \`trigger: { manual: true }\` on '${name}'; a job and a route are different entrypoints, and only a manual pipeline has no inbound route to contradict the deployment`,
      }),
    );
    reported.add(JSON.stringify(['deployments', id, 'pipeline']));
  }
}

/**
 * Managed knowledge bases: the version gate for the retriever binding, the two
 * combinations the schema cannot refuse, and the cross-field check whose schema error
 * would read as "must be equal to constant".
 *
 * A managed knowledge base owns a retriever's `source`, `chunking`, `embedModel`,
 * `store` and `index`. Declaring one of those beside `knowledgeBase` is refused rather
 * than silently preferred: a spec that says both has two answers to one question, and
 * only one of them can be checked against the cloud.
 */
function knowledgeBaseDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  const bases = asRecord(spec.knowledgeBases);
  const baseNames = Object.keys(bases).sort();
  const needsVersion =
    declared !== undefined && known && !specVersionAtLeast(declared, KNOWLEDGE_BASE_MIN_VERSION);

  for (const [id, raw] of Object.entries(bases)) {
    const base = asRecord(raw);
    const engine = base.engine;
    const kind = asRecord(base.dataSource).kind;
    const expected = engine === 'aws-bedrock' ? 's3' : engine === 'vertex-rag' ? 'gcs' : undefined;
    if (expected === undefined || kind === undefined || kind === expected) continue;
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.knowledgeBaseSource,
        message: `knowledge base '${id}' uses engine '${String(engine)}' but reads its documents from a '${String(kind)}' data source`,
        path: ['knowledgeBases', id, 'dataSource', 'kind'],
        hint: `a '${String(engine)}' knowledge base reads '${expected}' only; the other cloud's bucket is not reachable with this engine's credentials`,
      }),
    );
    reported.add(JSON.stringify(['knowledgeBases', id, 'dataSource']));
  }

  const owned = ['source', 'chunking', 'embedModel', 'store', 'index'] as const;

  for (const [id, raw] of Object.entries(asRecord(spec.retrievers))) {
    const retriever = asRecord(raw);
    const bound = retriever.knowledgeBase;
    if (bound === undefined) continue;

    if (needsVersion) {
      // The section gate already told the reader once. Repeating it at the binding, with
      // a different path, would make a two-line fix look like two problems.
      if (!alreadyReported(['knowledgeBases'], reported)) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.notSupported,
            message: `'retrievers.${id}.knowledgeBase' requires specVersion ${KNOWLEDGE_BASE_MIN_VERSION}, but this specification declares version ${String(declared)}`,
            path: ['retrievers', id, 'knowledgeBase'],
            hint: `set specVersion: "${KNOWLEDGE_BASE_MIN_VERSION}"; a specification that indexes locally is unchanged by the bump`,
          }),
        );
      }
      reported.add(JSON.stringify(['retrievers', id]));
      continue;
    }

    const named = typeof bound === 'string' ? bound : undefined;
    if (named === undefined || !Object.hasOwn(bases, named)) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.knowledgeBaseUnknown,
          message: `retriever '${id}' binds knowledge base '${String(bound)}', which this specification does not declare`,
          path: ['retrievers', id, 'knowledgeBase'],
          hint:
            baseNames.length === 0
              ? `declare a \`knowledgeBases\` entry named '${String(bound)}'`
              : `declare \`knowledgeBases.${String(bound)}\`, or bind one of ${baseNames.join(', ')}`,
        }),
      );
      reported.add(JSON.stringify(['retrievers', id]));
      continue;
    }

    const redundant = owned.filter((key) => retriever[key] !== undefined);
    if (redundant.length > 0) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.knowledgeBaseAmbiguous,
          message: `retriever '${id}' binds knowledge base '${named}' and also declares ${redundant.map((key) => `'${key}'`).join(', ')}; the knowledge base already owns those`,
          path: ['retrievers', id],
          hint: `keep \`knowledgeBase: ${named}\` and \`topK\`; move source, chunking and embedModel into \`knowledgeBases.${named}\`. Declaring both would mean indexing the same corpus twice`,
        }),
      );
    }

    if (retriever.refresh !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.knowledgeBaseRefresh,
          message: `retriever '${id}' binds knowledge base '${named}' but declares 'refresh'; the managed engine owns ingestion`,
          path: ['retrievers', id, 'refresh'],
          hint: `drop \`refresh\`; the managed engine owns ingestion, and the emitted README names the ingestion command for this engine`,
        }),
      );
    }
  }
}

/**
 * Managed agent runtimes: `deployments[].runtime`.
 *
 * The schema states the shape; these are the rules it cannot state. A runtime is a
 * destination for a container, so the target, the platform and the session ceiling have
 * to be checked together: each one alone is a valid document that would deploy to a
 * process the platform cannot reach. The invocation-route rule is the one that keeps the
 * adapter honest -- one request shape in, one route out -- and the `PORT` rule exists
 * because the generated Dockerfile listens on 8080 and the platform health check calls
 * it; an app told to listen elsewhere would fail the check at deploy time, not at build.
 */
function runtimeDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  if (declared === undefined || !known) return;
  const needsVersion = !specVersionAtLeast(declared, RUNTIME_MIN_VERSION);
  const deployments = asRecord(spec.deployments);
  const httpRoutes = Object.entries(asRecord(spec.pipelines))
    .filter(([, raw]) => asRecord(asRecord(raw).trigger).http !== undefined)
    .map(([id]) => id);

  let platform: string | undefined;
  let platformOwner: string | undefined;

  for (const [id, raw] of Object.entries(deployments)) {
    const deployment = asRecord(raw);
    if (deployment.runtime === undefined) continue;
    const runtime = asRecord(deployment.runtime);
    const path: DiagnosticPath = ['deployments', id, 'runtime'];

    if (needsVersion) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.notSupported,
          message: `'deployments.${id}.runtime' requires specVersion ${RUNTIME_MIN_VERSION}, but this specification declares version ${declared}`,
          path,
          hint: `set specVersion: "${RUNTIME_MIN_VERSION}"; a specification that deploys to a compute module is unchanged`,
        }),
      );
      reported.add(JSON.stringify(path));
      continue;
    }

    if (deployment.target !== 'container') {
      const target = typeof deployment.target === 'string' ? deployment.target : 'unknown';
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.runtimeWithoutContainer,
          message: `deployment '${id}' declares a runtime but targets '${target}', which the platform cannot address`,
          path,
          hint: 'set `target: container`; a managed runtime runs the image that target builds, so the other targets have no artifact to hand the platform',
        }),
      );
      reported.add(JSON.stringify(path));
      continue;
    }

    const named = typeof runtime.platform === 'string' ? runtime.platform : undefined;
    if (named !== undefined) {
      if (platform === undefined) {
        platform = named;
        platformOwner = id;
      } else if (named !== platform) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.runtimePlatformConflict,
            message: `deployment '${id}' names platform '${named}' but deployment '${String(platformOwner)}' names '${platform}'; one environment root runs on one cloud`,
            path: [...path, 'platform'],
            hint: `use '${platform}' on both, or split them into two environments; the root has one provider set`,
          }),
        );
        reported.add(JSON.stringify([...path, 'platform']));
      }
    }

    if (named === 'aws-agentcore') {
      const session = asRecord(runtime.session);
      const ttl = session.ttlMinutes;
      if (typeof ttl === 'number' && ttl > 480) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.runtimeSessionTtl,
            message: `deployment '${id}' asks for a ${ttl}-minute session, but AgentCore microVMs stop at 480`,
            path: [...path, 'session', 'ttlMinutes'],
            hint: 'use `ttlMinutes: 480` or less; a longer session needs the Instances tier, which this module does not create',
          }),
        );
        reported.add(JSON.stringify([...path, 'session', 'ttlMinutes']));
      }
    }

    const memory = asRecord(runtime.memory);
    if (named === 'gcp-agent-platform' && memory.shortTerm !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.runtimeMemoryOnPlatform,
          message: `deployment '${id}' asks for managed memory on 'gcp-agent-platform', which has no Terraform resource for a memory bank in v1`,
          path: [...path, 'memory'],
          hint: 'drop `memory`; AgentCore Memory is the only managed memory this module creates, and a memory the plan cannot create would be a promise the deploy breaks',
        }),
      );
      reported.add(JSON.stringify([...path, 'memory']));
    }

    const port = (Array.isArray(deployment.env) ? deployment.env : [])
      .map(asRecord)
      .find((entry) => entry.name === 'PORT');
    if (port !== undefined && port.value !== undefined && String(port.value) !== '8080') {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.runtimePort,
          message: `deployment '${id}' sets PORT=${String(port.value)}, but the runtime contract calls the app on 8080`,
          path: [...path],
          hint: 'drop the PORT variable or set it to 8080; the generated Dockerfile listens on 8080 and the platform health check calls that port',
        }),
      );
      reported.add(JSON.stringify([...path]));
    }
  }

  const runtimeIds = Object.entries(deployments)
    .filter(([, raw]) => asRecord(raw).runtime !== undefined)
    .map(([id]) => id);
  if (runtimeIds.length > 0 && httpRoutes.length !== 1) {
    const first = runtimeIds[0] as string;
    diagnostics.push(
      errorDiagnostic({
        code: DIAGNOSTIC_CODES.runtimeInvocationRoutes,
        message: `deployment '${first}' declares a runtime, but this specification declares ${httpRoutes.length} HTTP-triggered pipelines; the platform invocation route carries exactly one request shape`,
        path: ['deployments', first, 'runtime'],
        hint:
          httpRoutes.length === 0
            ? 'declare one pipeline with `trigger.http`'
            : `keep one pipeline with \`trigger.http\`; currently ${httpRoutes.join(', ')}. A second route needs its own service`,
      }),
    );
  }
}

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
 * composite shapes are enumerated exactly once. A new composite kind that this
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

    const route = asRecord(body.route);
    if (Object.keys(route).length > 0) {
      for (const [label, arm] of Object.entries(asRecord(route.on))) {
        walkSteps(arm, [...path, 'route', 'on', label], depth + 1, visit);
      }
      walkSteps(route.default, [...path, 'route', 'default'], depth + 1, visit);
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

/**
 * The rules a `route` step needs that JSON Schema cannot state.
 *
 * **Version**: `route` is 0.9 while `pipelines` has been legal since 0.1, so this is a
 * nested gate like `models[].cache`, not a `SECTION_MIN_VERSION` entry. **Reference**:
 * the decision must exist and be a `choice`; a `score` answer is an ordinal and a
 * `noul` answer a probability, and neither names an arm. **Arms**: every key in `on`
 * must be a label the decision can return, every label must reach an arm, and a
 * `default` must not be dead -- an arm that can never run is a mistake in the
 * document, not a harmless one.
 */
function routeDiagnostics(
  spec: Record<string, unknown>,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  if (declared === undefined || !known) {
    return;
  }

  const decisions = asRecord(spec.decisions);
  for (const [pipelineName, pipeline] of Object.entries(asRecord(spec.pipelines))) {
    const steps = asRecord(pipeline).steps;
    if (!Array.isArray(steps)) {
      continue;
    }

    walkSteps(steps, ['pipelines', pipelineName, 'steps'], 0, ({ body, path }) => {
      const route = asRecord(body.route);
      if (Object.keys(route).length === 0) {
        return;
      }

      if (!specVersionAtLeast(declared, ROUTE_MIN_VERSION)) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.notSupported,
            message: `a 'route' step requires specVersion ${ROUTE_MIN_VERSION}, but this specification declares version ${declared}`,
            path,
            hint: `set specVersion: "${ROUTE_MIN_VERSION}"; a document that does not route by a decision is unchanged`,
          }),
        );
        reported.add(JSON.stringify(path));
        return;
      }

      const decisionName = typeof route.decision === 'string' ? route.decision : undefined;
      if (decisionName === undefined) {
        // The schema already reports the missing key; there is nothing to resolve.
        return;
      }
      if (!Object.hasOwn(decisions, decisionName)) {
        const ids = Object.keys(decisions).sort();
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `route step names decision '${decisionName}', which the 'decisions' section does not declare`,
            path: [...path, 'route', 'decision'],
            hint:
              ids.length > 0
                ? `declare '${decisionName}', or use one of: ${ids.join(', ')}`
                : "add a 'decisions' section that declares it",
          }),
        );
        reported.add(JSON.stringify([...path, 'route', 'decision']));
        return;
      }

      const target = asRecord(decisions[decisionName]);
      const type = String(target.type ?? 'unknown');
      if (type !== 'choice') {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `decision '${decisionName}' is a '${type}' question; a route needs a 'choice' decision, because only a label names an arm`,
            path: [...path, 'route', 'decision'],
            hint: "declare the decision with type: choice, or branch on the answer's value in a generate step",
          }),
        );
        reported.add(JSON.stringify([...path, 'route', 'decision']));
        return;
      }

      const labels = Object.keys(asRecord(target.criteria));
      const on = asRecord(route.on);
      const hasDefault = route.default !== undefined;

      for (const label of Object.keys(on)) {
        if (labels.includes(label)) continue;
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `'route.on.${label}' names no criterion of decision '${decisionName}', so no answer could ever select it`,
            path: [...path, 'route', 'on', label],
            hint:
              labels.length > 0
                ? `declared labels: ${labels.join(', ')}`
                : 'the decision declares no criteria',
          }),
        );
      }

      const unmapped = labels.filter((label) => !Object.hasOwn(on, label));
      if (unmapped.length > 0 && !hasDefault) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `'route' does not say what to do when decision '${decisionName}' answers '${unmapped[0]}'${unmapped.length > 1 ? ` (or ${unmapped.length - 1} other label${unmapped.length > 2 ? 's' : ''})` : ''}`,
            path: [...path, 'route'],
            hint: `map ${unmapped.length === 1 ? 'it' : 'each one'} under 'on', or add a 'default' arm`,
          }),
        );
      }

      if (hasDefault && unmapped.length === 0) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `'route.default' can never run, because 'on' already maps every label decision '${decisionName}' can return`,
            path: [...path, 'route', 'default'],
            hint: "remove the 'default' arm, or leave one label out of 'on' if it should fall through",
          }),
        );
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
/**
 * The rules a `decision` metric must satisfy.
 *
 * A `score` decision already carries the rubric as an ordered `criteria` list, so the
 * metric is the answer's position mapped onto `[0, 1]`. That only works when the answer
 * *is* a score: a `choice` would need an invented ordering and a `noul` has no position
 * at all, so both are refused here rather than silently mis-scored later.
 */
function decisionMetricDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  const declared = typeof spec.specVersion === 'string' ? spec.specVersion : undefined;
  const known =
    declared !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(declared);
  const decisions = asRecord(spec.decisions);

  for (const [name, evalNode] of Object.entries(asRecord(spec.evals))) {
    const node = asRecord(evalNode);
    if (!Array.isArray(node.metrics)) {
      continue;
    }
    const gate = asRecord(node.gate);

    // Every decision metric reports under the same runtime name, so `metricBindings`
    // would keep only the first and quietly drop the rest. Say so once, at the second.
    const decisionIndexes = node.metrics.flatMap((raw, index) =>
      asRecord(raw).kind === 'decision' ? [index] : [],
    );
    const secondDecision = decisionIndexes.length > 1 ? decisionIndexes[1] : undefined;
    if (secondDecision !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.schemaViolation,
          message: `eval '${name}' declares ${decisionIndexes.length} decision metrics, but an eval measures one score`,
          path: ['evals', name, 'metrics', secondDecision],
          hint: 'keep one decision metric; the others would share its runtime name and be dropped',
        }),
      );
    }

    for (const [index, raw] of node.metrics.entries()) {
      const metric = asRecord(raw);
      if (metric.kind !== 'decision' || (secondDecision !== undefined && index >= secondDecision)) {
        continue;
      }
      const path = ['evals', name, 'metrics', index];

      if (
        declared !== undefined &&
        known &&
        !specVersionAtLeast(declared, DECISION_METRIC_MIN_VERSION)
      ) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.notSupported,
            message: `'evals.${name}.metrics[${index}].kind: decision' requires specVersion ${DECISION_METRIC_MIN_VERSION}, but this specification declares version ${declared}`,
            path,
            hint: `set specVersion: "${DECISION_METRIC_MIN_VERSION}"; evals without a decision metric are unchanged`,
          }),
        );
        continue;
      }

      if (gate.ci === true) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.metricUnavailableInCi,
            message: `eval '${name}': the decision metric at index ${index} asks a model, so it cannot run under the CI eval gate`,
            path,
            hint: 'the CI gate runs against the deterministic fake provider, which cannot answer a decision; move this metric to an eval without `gate.ci`, or drop `gate.ci`',
          }),
        );
      }

      const reference = typeof metric.decision === 'string' ? metric.decision : undefined;
      if (reference === undefined) {
        continue;
      }
      if (!Object.hasOwn(decisions, reference)) {
        const ids = Object.keys(decisions).sort();
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `eval '${name}': the decision metric at index ${index} names decision '${reference}', which the 'decisions' section does not declare`,
            path,
            hint:
              ids.length > 0
                ? `declare '${reference}', or use one of: ${ids.join(', ')}`
                : "add a 'decisions' section that declares it",
          }),
        );
        continue;
      }

      const decision = asRecord(decisions[reference]);
      if (decision.type !== 'score') {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `eval '${name}': decision '${reference}' is a '${String(decision.type)}' decision, but a decision metric needs a 'score' decision`,
            path,
            hint: "a choice has no declared order and a noul has no position, so neither maps onto [0, 1]; declare the rubric with 'type: score'",
          }),
        );
        continue;
      }

      const model = typeof decision.model === 'string' ? decision.model : undefined;
      if (model !== undefined && JEV_MOVING_ALIASES.has(model)) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.schemaViolation,
            message: `eval '${name}' scores with decision '${reference}', whose model '${model}' is a moving alias`,
            path: ['decisions', reference, 'model'],
            hint: 'pin a Jev version such as jev-1.14.0: two runs of an eval would otherwise score two different models',
          }),
        );
      }
    }
  }
}

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

    // A managed knowledge base owns its own loader, chunker and ingestion schedule, so
    // none of the local-pipeline reservations below apply. `filters` stays legal here
    // for the same reason it is legal on a local retriever's schema: the shape is
    // allowed, and the IR gate is what refuses a binding this version cannot honour.
    if (retriever.knowledgeBase !== undefined) continue;

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
 * Deployment rules the JSON Schema cannot express.
 *
 * The schema types `autoscale` and `env[]` but cannot say that a scaling range is
 * ordered, that a variable name is unique, or that an entry does not claim to be a
 * literal and a secret reference at once. These matter once infrastructure is
 * generated from the IR: each would otherwise become a fabricated scaling policy, a
 * duplicated environment variable key, or an ambiguous credential.
 */
function deploymentDiagnostics(spec: Record<string, unknown>, diagnostics: Diagnostic[]): void {
  for (const [id, raw] of Object.entries(asRecord(spec.deployments))) {
    const deployment = asRecord(raw);

    const autoscale = asRecord(deployment.autoscale);
    const min = typeof autoscale.min === 'number' ? autoscale.min : undefined;
    const max = typeof autoscale.max === 'number' ? autoscale.max : undefined;
    if (min !== undefined && max !== undefined && min > max) {
      diagnostics.push(
        errorDiagnostic({
          code: DIAGNOSTIC_CODES.deploymentAutoscaleRange,
          message: `deployment '${id}' declares autoscale.min ${min} above autoscale.max ${max}, so the range can never be honoured`,
          path: ['deployments', id, 'autoscale'],
          hint: 'set `min` at or below `max`; `min` is the floor the service keeps running and `max` is the ceiling it may scale to',
        }),
      );
    }

    const env = Array.isArray(deployment.env) ? deployment.env : [];
    const firstIndex = new Map<string, number>();
    env.forEach((rawEntry, index) => {
      const entry = asRecord(rawEntry);
      const name = typeof entry.name === 'string' ? entry.name : undefined;

      if (name !== undefined) {
        const first = firstIndex.get(name);
        if (first === undefined) {
          firstIndex.set(name, index);
        } else {
          diagnostics.push(
            errorDiagnostic({
              code: DIAGNOSTIC_CODES.deploymentEnvDuplicate,
              message: `deployment '${id}' declares the env name '${name}' more than once (first at index ${first})`,
              path: ['deployments', id, 'env', index],
              hint: 'merge the entries into one; a repeated name would emit two environment variables with the same key',
            }),
          );
        }
      }

      if (entry.value !== undefined && entry.secret === true) {
        diagnostics.push(
          errorDiagnostic({
            code: DIAGNOSTIC_CODES.deploymentEnvValueAndSecret,
            message: `deployment '${id}' env entry ${name === undefined ? `at index ${index}` : `'${name}'`} sets both a literal \`value\` and \`secret: true\``,
            path: ['deployments', id, 'env', index],
            hint: 'drop `value` to read the secret from the platform, or drop `secret: true` to declare a literal',
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
  assertMetricDiagnostics(spec, diagnostics);
  decisionMetricDiagnostics(spec, diagnostics);
  retrievalDiagnostics(spec, diagnostics);
  deploymentDiagnostics(spec, diagnostics);

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
