/**
 * The generator plugin manifest (§8.1) and its validation.
 *
 * A manifest is the complete contract between a target generator and everything
 * that consumes it: which target id it serves, which IR versions it can compile,
 * which capabilities the code it emits actually *has*, and what runtime
 * technology that code is built against. That last field, `emitsAgainst`, is the
 * one that makes composition honest — a target that emits Pydantic models and an
 * OpenTelemetry tracer is not interchangeable with one that emits Zod and
 * Langfuse, and nothing else in the IR records that.
 *
 * Validation is total: an unknown key is an error, capabilities are resolved
 * through the IR's alias table before being stored, and `irRange` is a real range
 * so "does this generator support the IR it was handed" is answered by
 * {@link checkIRSupport} instead of at codegen time.
 */

import { IR_VERSION, type RequiredCapability, resolveRequiredCapability } from '@aid/ir';
import { type Diagnostic, sortDiagnostics } from '@aid/spec';

import {
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratorDiagnostic,
  type GeneratorDiagnosticCode,
  generatorError,
} from './diagnostics.js';
import {
  DEFAULT_BUSINESS_DIR,
  DEFAULT_GENERATED_DIR,
  escapesRoot,
  isAbsolutePath,
  normalizeRelativePath,
} from './ownership.js';
import type { PlanValidationOptions } from './plan.js';
import { isValidRange, isValidVersion, satisfies } from './semver.js';

/** Current on-disk manifest format. Bumped only for a breaking reshape. */
export const GENERATOR_MANIFEST_VERSION = 1;

/** §8.1: what the emitted code is built against. Closed vocabularies, one value each. */
export const ORCHESTRATIONS = [
  'langgraph',
  'llamaindex',
  'dspy',
  'vercel-ai',
  'semantic-kernel',
] as const;
export type Orchestration = (typeof ORCHESTRATIONS)[number];

export const STRUCTURED_OUTPUTS = ['pydantic', 'instructor', 'zod'] as const;
export type StructuredOutput = (typeof STRUCTURED_OUTPUTS)[number];

export const TRACING_BACKENDS = ['otel-genai', 'langfuse', 'langsmith'] as const;
export type TracingBackend = (typeof TRACING_BACKENDS)[number];

export interface EmitsAgainst {
  /**
   * Absent means the emitted code has no orchestration framework, which is the
   * Phase 0 default: control flow is plain async and orchestration is deferred.
   */
  orchestration?: Orchestration;
  structuredOutput?: StructuredOutput;
  tracing?: TracingBackend;
}

export interface GeneratorOutput {
  /** Repo-relative app root, e.g. `app`. */
  root: string;
  /** Generator-owned directory, relative to `root`. */
  generatedDir?: string;
  /** Developer-owned directory, relative to `root`. */
  businessDir?: string;
}

/** The shape as authored. Everything optional is filled in by {@link parseManifest}. */
export interface GeneratorManifestInput {
  manifestVersion?: number;
  name: string;
  target: string;
  version: string;
  irRange: string;
  capabilities: readonly string[];
  emitsAgainst?: EmitsAgainst;
  output: GeneratorOutput;
  optionsSchema?: unknown;
}

/** The validated manifest, with aliases resolved and defaults applied. */
export interface GeneratorManifest {
  manifestVersion: number;
  name: string;
  target: string;
  version: string;
  irRange: string;
  /** Resolved through `TARGET_CAPABILITY_ALIASES`, deduplicated, in canonical order. */
  capabilities: readonly RequiredCapability[];
  emitsAgainst: EmitsAgainst;
  output: {
    root: string;
    generatedDir: string;
    businessDir: string;
  };
  optionsSchema?: unknown;
}

const TOP_LEVEL_KEYS = new Set([
  'manifestVersion',
  'name',
  'target',
  'version',
  'irRange',
  'capabilities',
  'emitsAgainst',
  'output',
  'optionsSchema',
]);

const EMITS_AGAINST_VOCABULARIES: Record<string, readonly string[]> = {
  orchestration: ORCHESTRATIONS,
  structuredOutput: STRUCTURED_OUTPUTS,
  tracing: TRACING_BACKENDS,
};

export interface ManifestParseResult {
  /** Present only when parsing produced no error-severity diagnostic. */
  manifest?: GeneratorManifest;
  diagnostics: GeneratorDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(
  code: GeneratorDiagnosticCode,
  message: string,
  path: string,
  hint?: string,
): GeneratorDiagnostic {
  return generatorError({ code, message, path, ...(hint === undefined ? {} : { hint }) });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Parses and validates an authored manifest value. Never throws. */
export function parseManifest(value: unknown): ManifestParseResult {
  if (!isRecord(value)) {
    return {
      diagnostics: [
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestNotAMapping,
          'A generator manifest must be an object.',
          'manifest',
        ),
      ],
    };
  }

  const diagnostics: GeneratorDiagnostic[] = [];

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestUnknownKey,
          `Unknown manifest key "${key}".`,
          key,
          'An unrecognised key is usually a typo that silently does nothing. Remove it or fix the spelling.',
        ),
      );
    }
  }

  const manifestVersion = readManifestVersion(value, diagnostics);
  const name = readString(value, 'name', diagnostics);
  const target = readString(value, 'target', diagnostics);
  const version = readVersion(value, diagnostics);
  const irRange = readIrRange(value, diagnostics);
  const capabilities = readCapabilities(value, diagnostics);
  const emitsAgainst = readEmitsAgainst(value, diagnostics);
  const output = readOutput(value, diagnostics);

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }

  // Every read above returns a value once no error was recorded, so these casts are
  // unreachable-but-required by the type checker rather than runtime assertions.
  return {
    manifest: {
      manifestVersion: manifestVersion as number,
      name: name as string,
      target: target as string,
      version: version as string,
      irRange: irRange as string,
      capabilities: capabilities as readonly RequiredCapability[],
      emitsAgainst: emitsAgainst as EmitsAgainst,
      output: output as GeneratorManifest['output'],
      ...(value.optionsSchema === undefined ? {} : { optionsSchema: value.optionsSchema }),
    },
    diagnostics: sortDiagnostics(diagnostics),
  };
}

export function validateManifest(value: unknown): GeneratorDiagnostic[] {
  return parseManifest(value).diagnostics;
}

export function parseManifestJson(text: string): ManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      diagnostics: [
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestParseFailed,
          `Generator manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          'manifest',
        ),
      ],
    };
  }
  return parseManifest(parsed);
}

function readManifestVersion(
  value: Record<string, unknown>,
  diagnostics: GeneratorDiagnostic[],
): number | undefined {
  const raw = value.manifestVersion;
  if (raw === undefined) return GENERATOR_MANIFEST_VERSION;
  if (raw !== GENERATOR_MANIFEST_VERSION) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestVersionUnsupported,
        `manifestVersion ${JSON.stringify(raw)} is not supported; this build reads version ${GENERATOR_MANIFEST_VERSION}.`,
        'manifestVersion',
      ),
    );
    return undefined;
  }
  return GENERATOR_MANIFEST_VERSION;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  diagnostics: GeneratorDiagnostic[],
): string | undefined {
  if (!(key in value)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
        `Manifest is missing required key "${key}".`,
        key,
      ),
    );
    return undefined;
  }
  if (!isNonEmptyString(value[key])) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        `Manifest key "${key}" must be a non-empty string.`,
        key,
      ),
    );
    return undefined;
  }
  return value[key];
}

function readVersion(
  value: Record<string, unknown>,
  diagnostics: GeneratorDiagnostic[],
): string | undefined {
  const version = readString(value, 'version', diagnostics);
  if (version === undefined) return undefined;
  if (!isValidVersion(version)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        `Manifest version "${version}" is not a semantic version.`,
        'version',
      ),
    );
    return undefined;
  }
  return version;
}

function readIrRange(
  value: Record<string, unknown>,
  diagnostics: GeneratorDiagnostic[],
): string | undefined {
  const irRange = readString(value, 'irRange', diagnostics);
  if (irRange === undefined) return undefined;
  if (!isValidRange(irRange)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        `Manifest irRange "${irRange}" is not a supported range expression.`,
        'irRange',
        'Use `||` alternatives with `^`, `~`, `>=`, `<=`, `<`, `>`, or `=` comparators.',
      ),
    );
    return undefined;
  }
  return irRange;
}

function readCapabilities(
  value: Record<string, unknown>,
  diagnostics: GeneratorDiagnostic[],
): readonly RequiredCapability[] | undefined {
  if (!('capabilities' in value)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
        'Manifest is missing required key "capabilities".',
        'capabilities',
        'Declare the capabilities the emitted code actually has; an empty list is allowed but must be explicit.',
      ),
    );
    return undefined;
  }

  const raw = value.capabilities;
  if (!Array.isArray(raw)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        'Manifest key "capabilities" must be an array of capability strings.',
        'capabilities',
      ),
    );
    return undefined;
  }

  const resolved: RequiredCapability[] = [];
  const seen = new Set<RequiredCapability>();
  let failed = false;

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string') {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
          `capabilities[${index}] must be a string.`,
          `capabilities[${index}]`,
        ),
      );
      failed = true;
      continue;
    }

    const capability = resolveRequiredCapability(entry);
    if (capability === undefined) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestCapabilityUnknown,
          `capabilities[${index}] "${entry}" is not a known target capability.`,
          `capabilities[${index}]`,
        ),
      );
      failed = true;
      continue;
    }

    if (seen.has(capability)) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestCapabilityDuplicate,
          `capabilities[${index}] "${entry}" resolves to "${capability}", already declared.`,
          `capabilities[${index}]`,
        ),
      );
      failed = true;
      continue;
    }

    seen.add(capability);
    resolved.push(capability);
  }

  if (failed) return undefined;
  return [...resolved].sort();
}

function readEmitsAgainst(
  value: Record<string, unknown>,
  diagnostics: GeneratorDiagnostic[],
): EmitsAgainst | undefined {
  const raw = value.emitsAgainst;
  if (raw === undefined) return {};

  if (!isRecord(raw)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        'Manifest key "emitsAgainst" must be an object.',
        'emitsAgainst',
      ),
    );
    return undefined;
  }

  const result: EmitsAgainst = {};
  let failed = false;

  for (const [key, entry] of Object.entries(raw)) {
    const vocabulary = EMITS_AGAINST_VOCABULARIES[key];
    if (vocabulary === undefined) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestUnknownKey,
          `Unknown emitsAgainst key "${key}".`,
          `emitsAgainst.${key}`,
          `Known keys: ${Object.keys(EMITS_AGAINST_VOCABULARIES).join(', ')}.`,
        ),
      );
      failed = true;
      continue;
    }

    if (typeof entry !== 'string' || !vocabulary.includes(entry)) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestEmitsAgainstUnknown,
          `emitsAgainst.${key} "${String(entry)}" is not one of: ${vocabulary.join(', ')}.`,
          `emitsAgainst.${key}`,
        ),
      );
      failed = true;
      continue;
    }

    if (key === 'orchestration') {
      result.orchestration = entry as Orchestration;
    } else if (key === 'structuredOutput') {
      result.structuredOutput = entry as StructuredOutput;
    } else {
      result.tracing = entry as TracingBackend;
    }
  }

  if (failed) return undefined;
  return result;
}

function readOutput(
  value: Record<string, unknown>,
  diagnostics: GeneratorDiagnostic[],
): GeneratorManifest['output'] | undefined {
  if (!('output' in value)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
        'Manifest is missing required key "output".',
        'output',
      ),
    );
    return undefined;
  }

  const raw = value.output;
  if (!isRecord(raw)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        'Manifest key "output" must be an object with a `root`.',
        'output',
      ),
    );
    return undefined;
  }

  for (const key of Object.keys(raw)) {
    if (key !== 'root' && key !== 'generatedDir' && key !== 'businessDir') {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestUnknownKey,
          `Unknown output key "${key}".`,
          `output.${key}`,
          'Known keys: root, generatedDir, businessDir.',
        ),
      );
    }
  }

  const root = readRelative(raw, 'root', diagnostics);
  const generatedDir = readRelative(raw, 'generatedDir', diagnostics) ?? DEFAULT_GENERATED_DIR;
  const businessDir = readRelative(raw, 'businessDir', diagnostics) ?? DEFAULT_BUSINESS_DIR;

  if (root === undefined) return undefined;

  // `generatedDir` and `businessDir` are relative to `root`, and ownership is decided
  // from the composed prefix. So the invariant is not that they sit inside `root` —
  // they never do — but that they are distinct and neither contains the other.
  // Otherwise one path would belong to both tiers and drift detection would have no
  // single answer for whether a file may be overwritten.
  if (generatedDir === businessDir) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestNotRelative,
        `output.generatedDir and output.businessDir are both "${generatedDir}"; the generated and business tiers must be separate directories.`,
        'output.businessDir',
      ),
    );
    return undefined;
  }
  if (isNested(generatedDir, businessDir) || isNested(businessDir, generatedDir)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestNotRelative,
        `output.generatedDir "${generatedDir}" and output.businessDir "${businessDir}" overlap; one must not contain the other.`,
        'output.businessDir',
      ),
    );
    return undefined;
  }

  return { root, generatedDir, businessDir };
}

function readRelative(
  source: Record<string, unknown>,
  key: string,
  diagnostics: GeneratorDiagnostic[],
): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;

  if (typeof raw !== 'string' || raw.trim() === '') {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
        `output.${key} must be a non-empty string.`,
        `output.${key}`,
      ),
    );
    return undefined;
  }

  if (isAbsolutePath(raw)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestNotRelative,
        `output.${key} "${raw}" is absolute; output paths are repo-relative.`,
        `output.${key}`,
      ),
    );
    return undefined;
  }

  if (escapesRoot(raw)) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestEscapingRoot,
        `output.${key} "${raw}" escapes the repository root.`,
        `output.${key}`,
      ),
    );
    return undefined;
  }

  const normalized = normalizeRelativePath(raw);
  if (normalized === undefined) {
    diagnostics.push(
      invalid(
        GENERATOR_DIAGNOSTIC_CODES.manifestNotRelative,
        `output.${key} "${raw}" is not a relative path.`,
        `output.${key}`,
      ),
    );
    return undefined;
  }
  return normalized;
}

/** True when `child` is `parent` itself or sits below it. */
function isNested(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * The repo-relative prefixes the plan validator needs. `output.root` is repo-relative,
 * and the managed directories are relative to it, so this is the single place that
 * turns a manifest's output layout into the two roots ownership is decided from.
 */
export function managedRoots(manifest: GeneratorManifest): Required<PlanValidationOptions> {
  const { root, generatedDir, businessDir } = manifest.output;
  return {
    generatedDir: `${root}/${generatedDir}`,
    businessDir: `${root}/${businessDir}`,
    manifestFilename: `${root}/aid.manifest.json`,
  };
}

export function supportsIR(manifest: GeneratorManifest, irVersion: string = IR_VERSION): boolean {
  return satisfies(irVersion, manifest.irRange);
}

/** Reports the manifest's `irRange` against the IR version it will actually be given. */
export function checkIRSupport(
  manifest: GeneratorManifest,
  irVersion: string = IR_VERSION,
): GeneratorDiagnostic[] {
  if (supportsIR(manifest, irVersion)) return [];
  const diagnostic: Diagnostic<GeneratorDiagnosticCode> = generatorError({
    code: GENERATOR_DIAGNOSTIC_CODES.manifestUnsupportedIr,
    message: `Generator "${manifest.name}" supports IR ${manifest.irRange} and cannot compile IR ${irVersion}.`,
    path: 'irRange',
    hint: 'Regenerate with a generator whose irRange covers this IR version, or pin the IR version the generator was built for.',
  });
  return [diagnostic];
}

/**
 * Generator ids and target ids must each be unique across the set a build loads;
 * two generators claiming one target is a silent last-wins otherwise.
 */
export function validateGeneratorSet(
  manifests: readonly GeneratorManifest[],
): GeneratorDiagnostic[] {
  const diagnostics: GeneratorDiagnostic[] = [];
  const seenNames = new Map<string, number>();
  const seenTargets = new Map<string, number>();

  for (const [index, manifest] of manifests.entries()) {
    const name = seenNames.get(manifest.name);
    if (name !== undefined) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestDuplicateGenerator,
          `Generator name "${manifest.name}" is declared twice (also at manifests[${name}]).`,
          `manifests[${index}].name`,
        ),
      );
    } else {
      seenNames.set(manifest.name, index);
    }

    const target = seenTargets.get(manifest.target);
    if (target !== undefined) {
      diagnostics.push(
        invalid(
          GENERATOR_DIAGNOSTIC_CODES.manifestDuplicateGenerator,
          `Target "${manifest.target}" is claimed by two generators (also at manifests[${target}]).`,
          `manifests[${index}].target`,
        ),
      );
    } else {
      seenTargets.set(manifest.target, index);
    }
  }

  return sortDiagnostics(diagnostics);
}

/** The capability declarations a set of manifests contributes, in the IR gate's shape. */
export function targetCapabilityDeclarations(
  manifests: readonly GeneratorManifest[],
): Record<string, readonly string[]> {
  const declarations: Record<string, readonly string[]> = {};
  for (const manifest of [...manifests].sort((left, right) =>
    left.target < right.target ? -1 : left.target > right.target ? 1 : 0,
  )) {
    declarations[manifest.target] = manifest.capabilities;
  }
  return declarations;
}
