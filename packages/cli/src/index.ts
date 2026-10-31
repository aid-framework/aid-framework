/**
 * `@aid-framework/cli` - the `aid` command: init, validate, gen, ingest and eval.
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
export type { EvalOptions } from './commands/eval.js';
export { evaluate } from './commands/eval.js';
export type { GenerateOptions, GenerateSuccess } from './commands/gen.js';
export { generate } from './commands/gen.js';
export type { IngestOptions } from './commands/ingest.js';
export { ingest } from './commands/ingest.js';
export type { InitOptions } from './commands/init.js';
export { init, projectNameFor, starterSpec } from './commands/init.js';
export type { ValidateOptions } from './commands/validate.js';
export { validate } from './commands/validate.js';
export type { CliContext, Spawn, SpawnOptions, SpawnResult } from './context.js';
export { createContext } from './context.js';
export type { CliDiagnostic, CliDiagnosticCode, CliDiagnosticInit } from './diagnostics.js';
export { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from './diagnostics.js';
export type { ExitCode } from './exit.js';
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.js';
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
export { discoverInterpreter, INTERPRETERS, interpreterCommand, invoke } from './python.js';
export type { Target } from './targets.js';
export {
  DEFAULT_SPEC_PATH,
  DEFAULT_TARGET,
  resolveTarget,
  TARGETS,
  targetCapabilities,
  targetNames,
  unknownTargetDiagnostic,
} from './targets.js';
export type { CommandSpec } from './usage.js';
export { commandUsage, globalUsage } from './usage.js';
