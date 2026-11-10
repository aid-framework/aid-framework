/**
 * `@aid-framework/cli` - the `aid` command: init, validate, gen, dev, ingest, eval, cost, trace,
 * doctor, eject and infra.
 *
 * The CLI is glue. Every judgement it reports -- whether a spec parses, what the IR is,
 * what a target can emit, which generated file was hand-edited, whether an eval regressed
 * -- is made by a package below it, and this layer's job is to route arguments into those
 * packages and their answers back out as text, JSON and an exit code. It reimplements no
 * gate, no hash and no drift rule, because a second implementation of a rule is a defect:
 * the two will disagree, and only one of them will be right.
 *
 * The layering is `spec <- ir <- generator-sdk <- generators <- cli`.
 */

export type { FlagSpec, ParsedArguments, ParseOutcome } from './args.js';
export { booleanFlag, JSON_FLAG, parseArguments, valueFlag } from './args.js';
export type { CostOptions } from './commands/cost.js';
export { cost } from './commands/cost.js';
export type { DevOptions } from './commands/dev.js';
export { dev } from './commands/dev.js';
export type { DoctorOptions } from './commands/doctor.js';
export { doctor } from './commands/doctor.js';
export type { EvalOptions } from './commands/eval.js';
export { evaluate } from './commands/eval.js';
export type { GenerateOptions, GenerateSuccess } from './commands/gen.js';
export { generate } from './commands/gen.js';
export type { GuardOptions } from './commands/guard.js';
export { guard } from './commands/guard.js';
export type { InfraOptions } from './commands/infra.js';
export { infra } from './commands/infra.js';
export type { IngestOptions } from './commands/ingest.js';
export { ingest } from './commands/ingest.js';
export type { InitOptions } from './commands/init.js';
export { init, projectNameFor, starterSpec } from './commands/init.js';
export type { MigrateOptions } from './commands/migrate.js';
export { migrate } from './commands/migrate.js';
export type { PackageOptions } from './commands/package.js';
export { packageEdge } from './commands/package.js';
export type { TraceOptions } from './commands/trace.js';
export { trace } from './commands/trace.js';
export type { ValidateOptions } from './commands/validate.js';
export { validate } from './commands/validate.js';
export type { CliContext, Spawn, SpawnOptions, SpawnResult } from './context.js';
export { createContext } from './context.js';
export type { CliDiagnostic, CliDiagnosticCode, CliDiagnosticInit } from './diagnostics.js';
export { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from './diagnostics.js';
export type {
  EdgeArchive,
  HelperScript,
  StepResult,
} from './edge-zip.js';
export {
  EDGE_PLATFORM,
  EDGE_PYTHON_VERSION,
  EDGE_REQUIREMENTS_FILE,
  EDGE_STAGE_FILES,
  extractRequirements,
  installWheels,
  missingStageInputs,
  REQUIREMENTS_HELPER,
  runHelper,
  stageApplication,
  wheelInstallArgs,
  writeArchive,
  ZIP_HELPER,
} from './edge-zip.js';
export type { ExitCode } from './exit.js';
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.js';
export type { InfraFile } from './infra/emit.js';
export { emitInfra, INFRA_GENERATED_DIR, INFRA_MANIFEST_PATH, tfvars } from './infra/emit.js';
export type { InfraAction } from './infra/tofu.js';
export { envRoot, TFVARS_PATH, tofuArgs } from './infra/tofu.js';
export { COMMANDS, run } from './main.js';
export type { CommandOutcome, OutcomeInit } from './output.js';
export { emit, outcome } from './output.js';
export { absolutePath, parentPath } from './paths.js';
export type {
  Compiled,
  CompileOutcome,
  Failed,
  Lowered,
  LowerOutcome,
  ManifestOutcome,
  ReadManifest,
  ReadSpec,
} from './pipeline.js';
export { compile, lowerSpec, provenanceFor, readManifest, readSpec } from './pipeline.js';
export {
  DEV_PROBE,
  discoverInterpreter,
  discoverStdlibInterpreter,
  INTERPRETERS,
  interpreterCommand,
  invoke,
  STDLIB_PROBE,
  stdlibCommand,
} from './python.js';
export type { Target, TargetDev } from './targets.js';
export {
  DEFAULT_SPEC_PATH,
  DEFAULT_TARGET,
  resolveTarget,
  TARGETS,
  targetCapabilities,
  targetNames,
  unknownTargetDiagnostic,
} from './targets.js';
export type {
  CostSummary,
  Latency,
  ModelSpend,
  ParsedTrace,
  SpanFacts,
  SpanRow,
  TraceRun,
  TraceSpan,
} from './trace.js';
export {
  childrenOf,
  factsOf,
  parseSince,
  parseTraceLines,
  runsOf,
  summariseSpans,
  treeRowsOf,
} from './trace.js';
export type { TraceDir } from './trace-dir.js';
export { readTraceDir, resolveTraceDir, TRACE_DIR_ENV } from './trace-dir.js';
export type { CommandSpec } from './usage.js';
export { commandUsage, globalUsage } from './usage.js';
