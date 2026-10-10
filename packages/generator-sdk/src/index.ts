/**
 * `@aid/generator-sdk` — the generator plugin contract, the `generated/` vs `business/`
 * ownership model with its drift algorithm, and the determinism primitives that make
 * regeneration reproducible.
 *
 * Layering is one-directional: `spec ← ir ← generator-sdk ← generators ← cli`. This
 * package may import `@aid/ir` and `@aid/spec`, and neither of them may import this.
 * That is why a generator's capability declarations travel as data (see `targets.ts`
 * and `targetCapabilityDeclarations`) instead of the IR gate reaching in here.
 */

export type {
  AidManifest,
  AidManifestFile,
  AidManifestParseResult,
  AidManifestProvenance,
  Sha256Hex,
} from './aid-manifest.js';
export {
  AID_MANIFEST_VERSION,
  emptyAidManifest,
  manifestFor,
  manifestRecordFor,
  parseAidManifest,
  parseAidManifestJson,
  serializeAidManifest,
} from './aid-manifest.js';
export type { BannerOptions, DeterminismPattern, DeterminismViolation } from './determinism.js';
export {
  checkDeterminism,
  compareIds,
  DETERMINISM_PATTERNS,
  ensureTrailingNewline,
  GENERATED_BANNER_MARKER,
  generatedBanner,
  normalizeNewlines,
  normalizeText,
  scanForNonDeterminism,
  sha256Hex,
  sortById,
  sortByPath,
  stableId,
  stableSortBy,
} from './determinism.js';
export type { GeneratorDiagnostic, GeneratorDiagnosticCode } from './diagnostics.js';
export {
  GENERATOR_DIAGNOSTIC_CODES,
  generatorError,
  generatorWarning,
  withFile,
} from './diagnostics.js';
export type {
  DriftedFile,
  RegenerationAction,
  RegenerationOptions,
  RegenerationReport,
  RegenerationResult,
  RegenerationSink,
} from './drift.js';
export {
  checkDrift,
  formatRegenerationSummary,
  generatedFiles,
  hasDrift,
  planRegeneration,
  regenerate,
  staleGeneratedFiles,
} from './drift.js';
export type {
  EmitsAgainst,
  GeneratorManifest,
  GeneratorManifestInput,
  GeneratorOutput,
  ManifestParseResult,
  Orchestration,
  StructuredOutput,
  TracingBackend,
} from './manifest.js';
export {
  checkIRSupport,
  GENERATOR_MANIFEST_VERSION,
  managedRoots,
  ORCHESTRATIONS,
  parseManifest,
  parseManifestJson,
  STRUCTURED_OUTPUTS,
  supportsIR,
  TRACING_BACKENDS,
  targetCapabilityDeclarations,
  validateGeneratorSet,
  validateManifest,
} from './manifest.js';
export { createMemorySink, createNodeSink } from './node-sink.js';
export type { FileOwner } from './ownership.js';
export {
  DEFAULT_BUSINESS_DIR,
  DEFAULT_GENERATED_DIR,
  DEFAULT_MANIFEST_FILENAME,
  escapesRoot,
  isAbsolutePath,
  isBusinessPath,
  isGeneratedPath,
  isRelativePath,
  isReservedPath,
  normalizeRelativePath,
  ownerForPath,
  REJECTION_SUFFIX,
  rejectionPath,
} from './ownership.js';
export type {
  GeneratedFile,
  Generator,
  GeneratorContext,
  Plan,
  PlanValidationOptions,
} from './plan.js';
export { isRecord, validatePlan } from './plan.js';
export type { Version } from './semver.js';
export {
  compareVersions,
  formatVersion,
  isValidRange,
  isValidVersion,
  parseRange,
  parseVersion,
  satisfies,
} from './semver.js';

export {
  PY_FASTAPI_MANIFEST,
  PY_FASTAPI_MANIFEST_INPUT,
  PY_FASTAPI_TARGET,
  phase0Generators,
  phase0TargetCapabilities,
} from './targets.js';
