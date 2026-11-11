/**
 * Customer overlays: one agent definition, many customers, no forks.
 *
 * An overlay is **not** a specification and is never fed to `validateSpec`. It is a
 * small file that names a base spec and the document paths to move, and resolving it
 * produces a concrete spec that then faces every gate a hand-written one faces. The
 * namespace split is the point: a broken overlay reports `overlay/...`, so a reader is
 * never told an IR gate failed when what actually happened is that a customer file
 * could not be read.
 *
 * The contract lives in the base, not here. A base spec declares `overridable` paths
 * and how far each may move; a path it does not list cannot be touched, and a
 * relaxation it does not mark `allowWeaken` cannot be made. So the customer file has
 * no power the base author did not hand it in the same commit, in a visible diff.
 *
 * This module is pure: it never touches the filesystem. `overlay/base-missing` is
 * therefore emitted by whichever caller reads the files, through the code constant
 * below, so the `overlay/` namespace still has exactly one home.
 */

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type Diagnostic, errorDiagnostic, formatPath, type PathSegment } from './diagnostics.js';

/**
 * Overlay diagnostics are widened over the code union, exactly as the CLI reads every
 * other layer's: the code string is the contract, and it is not in `DiagnosticCode`
 * because that union belongs to the specification, not to a customer file.
 */
export type OverlayDiagnostic = Diagnostic<string>;

/**
 * Every diagnostic code the overlay layer emits. The `overlay/` prefix keeps them
 * disjoint from `spec/`, `ir/` and `cli/`: a code tells you which artifact is wrong.
 */
export const OVERLAY_DIAGNOSTIC_CODES = {
  syntax: 'overlay/syntax',
  notAMapping: 'overlay/not-a-mapping',
  schemaViolation: 'overlay/schema-violation',
  /** Emitted by the caller that reads files; see the module comment. */
  baseMissing: 'overlay/base-missing',
  pathNotOverridable: 'overlay/path-not-overridable',
  weakensControl: 'overlay/weakens-control',
  removesEval: 'overlay/removes-eval',
  valueOutOfBounds: 'overlay/value-out-of-bounds',
  profileMismatch: 'overlay/profile-mismatch',
} as const;

export type OverlayDiagnosticCode =
  (typeof OVERLAY_DIAGNOSTIC_CODES)[keyof typeof OVERLAY_DIAGNOSTIC_CODES];

/** A parsed overlay. `profile` is a checked label, never a second source of truth. */
export interface OverlayDocument {
  readonly base: string;
  readonly customer: string;
  readonly profile?: string;
  readonly overrides: Readonly<Record<string, unknown>>;
}

export interface OverlayParseResult {
  /** Present only when no error was reported. */
  overlay?: OverlayDocument;
  diagnostics: OverlayDiagnostic[];
}

export interface OverlayApplyResult {
  /** The resolved document. Only meaningful when `diagnostics` holds no error. */
  value: unknown;
  /** The paths that were applied, in the order the overlay declared them. */
  applied: string[];
  diagnostics: OverlayDiagnostic[];
}

/** A parsed base document. `value` is `undefined` when the YAML itself did not parse. */
export interface OverlayApplyBaseResult {
  value?: unknown;
  diagnostics: OverlayDiagnostic[];
}

/**
 * The overlay schema is built here rather than shipped as a second `.json` file: it is
 * small, it has one consumer, and keeping it beside the resolver means the two cannot
 * drift. `overlayJsonSchema()` exposes it for tooling.
 */
const OVERLAY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://aid-framework.dev/schemas/overlay.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['base', 'customer', 'overrides'],
  properties: {
    base: {
      description:
        'The specification this overlay resolves. A path, relative to the overlay file or absolute.',
      type: 'string',
      minLength: 1,
    },
    customer: {
      description: 'Who this overlay is for. Appears in `aid fleet` and in every diagnostic.',
      type: 'string',
      pattern: '^[a-z][a-z0-9_-]{0,63}$',
    },
    profile: {
      description:
        'The tier this customer is on. Optional, and a label rather than an instruction: it must agree with the resolved spec, so it cannot move a control the base did not open.',
      enum: ['standard', 'enterprise'],
    },
    overrides: {
      description:
        'Document paths to move, written the way YAML writes them. `null` removes a key.',
      type: 'object',
      minProperties: 1,
      propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_-]*(\\.[A-Za-z_][A-Za-z0-9_-]*)*$' },
      additionalProperties: true,
    },
  },
} as const;

let compiled: ValidateFunction | undefined;

function overlayValidator(): ValidateFunction {
  if (compiled === undefined) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
      verbose: false,
    });
    compiled = ajv.compile(OVERLAY_SCHEMA as unknown as Record<string, unknown>);
  }
  return compiled;
}

/** The overlay file's JSON Schema, for editors and for anyone publishing it. */
export function overlayJsonSchema(): unknown {
  return OVERLAY_SCHEMA;
}

/**
 * Parses and schema-checks an overlay file. YAML syntax errors are reported as
 * `overlay/syntax`; nothing here validates the *specification* the overlay points at.
 */
export function parseOverlay(text: string, options: { file?: string } = {}): OverlayParseResult {
  const diagnostics: OverlayDiagnostic[] = [];
  let value: unknown;
  try {
    // Imported lazily so the spec package's main path never pays for it twice.
    value = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      errorDiagnostic({
        code: OVERLAY_DIAGNOSTIC_CODES.syntax,
        message: `the overlay is not valid YAML: ${message.split('\n')[0] ?? message}`,
        hint: 'an overlay is a mapping of `base`, `customer`, `profile` and `overrides`',
        ...(options.file === undefined ? {} : { file: options.file }),
      }),
    );
    return { diagnostics };
  }

  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      errorDiagnostic({
        code: OVERLAY_DIAGNOSTIC_CODES.notAMapping,
        message: `the overlay must be a mapping, found ${describe(value)}`,
        hint: 'an overlay is a mapping of `base`, `customer`, `profile` and `overrides`',
        ...(options.file === undefined ? {} : { file: options.file }),
      }),
    );
    return { diagnostics };
  }

  const check = overlayValidator();
  if (!check(value)) {
    for (const error of check.errors ?? []) {
      diagnostics.push(
        errorDiagnostic({
          code: OVERLAY_DIAGNOSTIC_CODES.schemaViolation,
          message: `the overlay does not match its schema: ${describeAjvError(error)}`,
          path: ajvPath(error),
          ...(options.file === undefined ? {} : { file: options.file }),
        }),
      );
    }
    return { diagnostics };
  }

  const record = value as Record<string, unknown>;
  return {
    overlay: {
      base: record.base as string,
      customer: record.customer as string,
      ...(record.profile === undefined ? {} : { profile: record.profile as string }),
      overrides: record.overrides as Record<string, unknown>,
    },
    diagnostics,
  };
}

/**
 * Parses the base a `base:` path points at. Only YAML syntax is judged here: the base is
 * a *document*, and whether the resolved result is a well-formed specification is
 * `aid validate`'s question, asked once against the resolution rather than twice against
 * its inputs. A base that is not a mapping is caught by {@link applyOverlay}, which
 * reports it against the same file.
 */
export function parseOverlayBase(
  text: string,
  options: { file?: string } = {},
): OverlayApplyBaseResult {
  try {
    return { value: parseYaml(text), diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      diagnostics: [
        errorDiagnostic({
          code: OVERLAY_DIAGNOSTIC_CODES.syntax,
          message: `the base spec is not valid YAML: ${message.split('\n')[0] ?? message}`,
          hint: 'point `base` at a specification file this repository can parse',
          ...(options.file === undefined ? {} : { file: options.file }),
        }),
      ],
    };
  }
}

/**
 * Applies an overlay to a base document, returning a new document. The base is never
 * mutated, so a caller can resolve twenty overlays against one parse.
 *
 * Every reported problem is an `overlay/<code>`: nothing here judges whether the
 * *result* is a good specification. That is what `aid validate` on the resolved file
 * is for, and it is why the overlay layer can stay this small.
 */
export function applyOverlay(
  base: unknown,
  overlay: OverlayDocument,
  options: { file?: string } = {},
): OverlayApplyResult {
  const diagnostics: OverlayDiagnostic[] = [];
  const applied: string[] = [];
  const where = options.file === undefined ? {} : { file: options.file };
  const report = (code: OverlayDiagnosticCode, message: string, path: string, hint: string) => {
    diagnostics.push(errorDiagnostic({ code, message, path: [path], hint, ...where }));
  };

  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    report(
      OVERLAY_DIAGNOSTIC_CODES.notAMapping,
      `the overlay resolved against a base that is not a mapping`,
      'overrides',
      'point `base` at a specification, not at another overlay',
    );
    return { value: base, applied, diagnostics };
  }

  const resolved = structuredClone(base) as Record<string, unknown>;
  const contract = isRecord(resolved.overridable) ? resolved.overridable : {};
  const customer = overlay.customer;

  for (const [path, requested] of Object.entries(overlay.overrides)) {
    const rule = contract[path];
    const removesEval = requested === null && gatingEval(resolved, path);

    // Asked first, and asked regardless of the rule: `allowWeaken` buys a weaker *value*,
    // never the absence of the check. Removing the eval that gates CI is the one move an
    // overlay cannot make, so the refusal does not depend on what the base permits.
    if (removesEval) {
      const what =
        path.split('.').length === 2
          ? `it removes eval "${removesEval}", which gate.ci requires`
          : `it removes the gate.ci flag from eval "${removesEval}"`;
      report(
        OVERLAY_DIAGNOSTIC_CODES.removesEval,
        `the overlay gate rejected "${customer}": ${what}`,
        path,
        'overlays may not remove a CI-gating eval; add a stricter eval instead',
      );
      continue;
    }

    if (rule === undefined) {
      report(
        OVERLAY_DIAGNOSTIC_CODES.pathNotOverridable,
        `the overlay gate rejected "${customer}": overrides "${path}" is not an overridable path in the base spec`,
        path,
        `add ${path} to the base spec's overridable block`,
      );
      continue;
    }

    // The bound is checked before the weakening question, because it is the more specific
    // answer: a value above a declared `max` stays refused even after `allowWeaken`, so
    // reporting the weakening first would send the reader to a fix that cannot work.
    const bounds = boundProblem(rule, requested);
    if (bounds !== undefined) {
      report(
        OVERLAY_DIAGNOSTIC_CODES.valueOutOfBounds,
        `the overlay gate rejected "${customer}": ${bounds} at "${path}"`,
        path,
        describeBound(rule),
      );
      continue;
    }

    const weakening = relaxationOf(resolved, path, requested);
    if (weakening !== undefined && !permitsWeakening(rule)) {
      report(
        OVERLAY_DIAGNOSTIC_CODES.weakensControl,
        `the overlay gate rejected "${customer}": it ${weakening.sentence}, which relaxes a control, and the base does not permit weakening at that path`,
        path,
        `mark the path allowWeaken: true in the base, or keep the base ${weakening.kind === 'action' ? 'action' : 'value'}`,
      );
      continue;
    }

    writeAtPath(resolved, path.split('.'), requested);
    applied.push(path);
  }

  const declared = overlay.profile;
  if (declared !== undefined) {
    const actual = typeof resolved.profile === 'string' ? resolved.profile : 'standard';
    if (declared !== actual) {
      report(
        OVERLAY_DIAGNOSTIC_CODES.profileMismatch,
        `the overlay gate rejected "${customer}": it declares profile "${declared}", and the resolved specification is "${actual}"`,
        'profile',
        declared === 'standard'
          ? 'drop `profile`, or set `profile: standard` in the base spec'
          : `override profile to "enterprise" in the overlay, and mark profile overridable in the base`,
      );
    }
  }

  return { value: resolved, applied, diagnostics };
}

/** Renders a resolved document as spec YAML. Deterministic: the same base and overlay
 * always produce the same bytes, which is what lets `aid resolve --check` diff a
 * committed artifact against a fresh resolution.
 *
 * No provenance comment is emitted on purpose. The header would name the overlay path
 * as the command line spelled it, so an absolute and a relative invocation would
 * disagree about bytes. Provenance already lives in the overlay, and in git.
 */
export function serializeResolved(value: unknown): string {
  // `lineWidth: 0` disables folding, so a long instruction stays on the line its author
  // wrote instead of being rewrapped into bytes nobody can review.
  return stringifyYaml(value, { lineWidth: 0 });
}

/**
 * The weakening rules. Deliberately small, and deliberately biased: each one only
 * fires where the direction is unambiguous, so a *tightening* is never refused. A
 * relaxation that slips past these still faces every gate on the resolved spec, and a
 * base author can always make one explicit with `allowWeaken: true`.
 */
const CEILING_KEYS = new Set([
  'maxCostBudget',
  'maxSteps',
  'maxTokens',
  'maxRetries',
  'maxRegression',
  'allowedQualityDrop',
  'allowedCostIncrease',
  'maxLatencyMs',
  'ttlHours',
]);

const FLOOR_KEYS = new Set(['minApprovers', 'retentionDays', 'minMean']);

/** Lists where dropping an entry drops a requirement, so a shorter list is weaker. */
const REQUIREMENT_LISTS = new Set(['require', 'by', 'redact', 'approvers']);

/** Guardrail actions from strictest to loosest. */
const ACTION_ORDER = ['block', 'escalate', 'redact', 'flag'];

/**
 * One weakening move, as a sentence to splice into a diagnostic and a kind, so the hint
 * can name the right thing to keep instead ("keep the base action" does not mean anything
 * for a budget).
 */
interface Relaxation {
  readonly sentence: string;
  readonly kind: 'action' | 'value';
}

function relaxationOf(
  base: Record<string, unknown>,
  path: string,
  requested: unknown,
): Relaxation | undefined {
  const current = readAtPath(base, path.split('.'));
  if (current === undefined) {
    return undefined;
  }

  if (requested === null) {
    return { sentence: `removes "${path}"`, kind: 'value' };
  }

  const key = path.split('.').pop() ?? '';

  if (path === 'profile' && current === 'enterprise' && requested === 'standard') {
    return { sentence: `changes "profile" from "enterprise" to "standard"`, kind: 'value' };
  }

  if (current === true && requested === false) {
    return { sentence: `changes "${path}" from true to false`, kind: 'value' };
  }

  if (typeof current === 'number' && typeof requested === 'number') {
    if (CEILING_KEYS.has(key) && requested > current) {
      return { sentence: `raises "${path}" from ${current} to ${requested}`, kind: 'value' };
    }
    if (FLOOR_KEYS.has(key) && requested < current) {
      return { sentence: `lowers "${path}" from ${current} to ${requested}`, kind: 'value' };
    }
  }

  if (key === 'action' && typeof current === 'string' && typeof requested === 'string') {
    const from = ACTION_ORDER.indexOf(current);
    const to = ACTION_ORDER.indexOf(requested);
    if (from !== -1 && to > from) {
      return {
        sentence: `changes "${path}" from "${current}" to "${requested}"`,
        kind: 'action',
      };
    }
  }

  if (Array.isArray(current) && Array.isArray(requested) && REQUIREMENT_LISTS.has(key)) {
    const dropped = current.filter((entry) => !requested.some((kept) => same(kept, entry)));
    if (dropped.length > 0) {
      return {
        sentence: `drops ${dropped.map((entry) => JSON.stringify(entry)).join(', ')} from "${path}"`,
        kind: 'value',
      };
    }
  }

  return undefined;
}

/**
 * Whether a rule lets an overlay make a weakening move. A listed `from` value is a
 * permitted *value*, not a permitted loosening: relaxing a control is always its own
 * explicit permission, so the two dimensions never collapse into one.
 */
function permitsWeakening(rule: unknown): boolean {
  return isRecord(rule) && rule.allowWeaken === true;
}

/** A value as it is written in the file, so the message reads the way the override does. */
function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function boundProblem(rule: unknown, requested: unknown): string | undefined {
  if (rule === true) {
    return undefined;
  }
  if (!isRecord(rule)) {
    return `${shown(requested)} is outside the values the base allows`;
  }
  if (Array.isArray(rule.from)) {
    if (rule.from.some((allowed) => same(allowed, requested))) {
      return undefined;
    }
    return `${shown(requested)} is not one of ${rule.from.map(shown).join(', ')}`;
  }
  if (typeof rule.max === 'number') {
    if (typeof requested !== 'number') {
      return `${shown(requested)} is not a number, and the base allows at most ${rule.max}`;
    }
    if (requested > rule.max) {
      return `${requested} exceeds the ${rule.max} the base allows`;
    }
    return undefined;
  }
  return undefined;
}

function describeBound(rule: unknown): string {
  if (isRecord(rule) && Array.isArray(rule.from)) {
    return `use one of ${rule.from.map(shown).join(', ')}, or widen 'from' in the base`;
  }
  if (isRecord(rule) && typeof rule.max === 'number') {
    return `use a value of at most ${rule.max}, or raise 'max' in the base`;
  }
  return `mark the path allowWeaken: true in the base to accept any value`;
}

/** The eval id a `null` override removes, when that eval gates CI. */
function gatingEval(base: Record<string, unknown>, path: string): string | undefined {
  const segments = path.split('.');
  // The eval itself (`evals.<id>`) or the flag that makes it gate CI
  // (`evals.<id>.gate.ci`). Both leave the eval unable to hold the deploy honest, and neither
  // is a "weaker value": deleting the check is not a value change, so `allowWeaken` cannot
  // buy it either.
  const evalId =
    segments.length === 2 && segments[0] === 'evals'
      ? segments[1]
      : segments.length === 4 &&
          segments[0] === 'evals' &&
          segments[2] === 'gate' &&
          segments[3] === 'ci'
        ? segments[1]
        : undefined;
  if (evalId === undefined) {
    return undefined;
  }
  const declared = isRecord(base.evals) ? base.evals[evalId] : undefined;
  if (!isRecord(declared) || !isRecord(declared.gate)) {
    return undefined;
  }
  return declared.gate.ci === true ? evalId : undefined;
}

function readAtPath(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Sets or, for `null`, deletes a leaf, creating the containers a new key needs. */
function writeAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let current: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    current = next;
  }
  const leaf = segments[segments.length - 1] as string;
  if (value === null) {
    current[leaf] = undefined;
    // `undefined` survives structuredClone but not a YAML round-trip; delete it so the
    // serialized document and the in-memory document agree.
    delete current[leaf];
    return;
  }
  current[leaf] = value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ajvPath(error: ErrorObject): PathSegment[] {
  const pointer = (error as ErrorObject & { instancePath?: string }).instancePath ?? '';
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  const property = (error.params as { propertyName?: string }).propertyName;
  return property === undefined ? segments : [...segments, property];
}

function describeAjvError(error: ErrorObject): string {
  const where = formatPath(ajvPath(error));
  // AJV's wording for an unexpected key never names the key, which leaves the reader to
  // diff their file against the schema. The overlay's keys are few enough to list.
  const extra = (error.params as { additionalProperty?: string }).additionalProperty;
  if (error.keyword === 'additionalProperties' && extra !== undefined) {
    return `"${extra}" is not an overlay key; an overlay declares base, customer, profile and overrides`;
  }
  return where === '<document>' ? (error.message ?? 'invalid value') : `${where}: ${error.message}`;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) {
    return 'nothing';
  }
  return Array.isArray(value) ? 'a list' : typeof value;
}
