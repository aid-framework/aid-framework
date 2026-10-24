/**
 * The target registry: the one place the CLI learns what a target *is*.
 *
 * A target is a generator plus the layout it declares. Nothing here restates that
 * layout -- the spec path, the generated root, the business root, the manifest path and
 * the eval module names all come from `@aid/generator-sdk`'s `managedRoots` and
 * `@aid/generator-py-fastapi`'s path helpers, so a generator that moves a file moves
 * every command with it, without the CLI being edited.
 *
 * The capability declarations are the SDK's `phase0TargetCapabilities`, not `@aid/ir`'s
 * placeholder of the same name. The placeholder exists so the gate could be written
 * before a real generator existed; feeding it to the gate would make the capability gate
 * pass vacuously for every spec, which is the one failure mode a gate must not have.
 */

import {
  checkPlan as checkPyFastApi,
  EVALS_INIT_PATH,
  PY_FASTAPI_MANIFEST,
  evalModulePath as pyFastApiEvalModulePath,
  pyFastApiGenerator,
  retrievalIngestModulePath as pyFastApiIngestModulePath,
} from '@aid/generator-py-fastapi';
import {
  type Generator,
  type GeneratorManifest,
  managedRoots,
  type Plan,
  targetCapabilityDeclarations,
} from '@aid/generator-sdk';
import {
  checkPlan as checkTsVercel,
  TS_VERCEL_MANIFEST,
  evalModulePath as tsVercelEvalModulePath,
  tsVercelGenerator,
  retrievalIngestModulePath as tsVercelIngestModulePath,
  paths as tsVercelPaths,
} from '@aid/generator-ts-vercel';
import type { IR, TargetCapabilityDeclarations } from '@aid/ir';
import { errorDiagnostic } from '@aid/spec';

import type { CliDiagnostic } from './diagnostics.js';
import { CLI_DIAGNOSTIC_CODES } from './diagnostics.js';
import { parentPath } from './paths.js';

/**
 * What a generator's `checkPlan` reports, structurally.
 *
 * Each generator package declares its own problem type with its own code union, and they
 * are not the same nominal type. The registry only ever reads the three fields every one
 * of them carries, so it takes the shape rather than either generator's type.
 */
interface PlanProblemLike {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * How `aid eval` and `aid ingest` run a target's generated entry points.
 *
 * Both commands used to assume CPython: they discover an interpreter and run `-m`. A
 * target whose emitted modules are not Python has no such entry point, and the honest
 * answer is a diagnostic, not a Python traceback about a missing module.
 */
export type TargetRunner = 'python' | 'node';

export interface Target {
  /** The target id, as a spec's `project.targets` spells it. */
  readonly name: string;
  /** The spec this target's project is expected to keep, repo-relative. */
  readonly specPath: string;
  readonly generatedDir: string;
  readonly businessDir: string;
  readonly manifestPath: string;
  /** The generated evals package, repo-relative. */
  readonly evalsDir: string;
  readonly manifest: GeneratorManifest;
  readonly generator: Generator;
  /** Which toolchain `aid eval` and `aid ingest` would need to run this target. */
  readonly runner: TargetRunner;
  /** Everything that stops this target compiling the IR, as diagnostics. */
  check(ir: IR): readonly CliDiagnostic[];
  plan(ir: IR): Plan;
  /** The dotted module path of the generated eval module for `evalId`. */
  evalModule(evalId: string): string;
  /** The repo-relative file the generated eval module for `evalId` lives in. */
  evalModuleFile(evalId: string): string;
  /** The dotted module path of the generated ingest module for `retrieverId`. */
  retrievalIngestModule(retrieverId: string): string;
  /** The repo-relative file the generated ingest module for `retrieverId` lives in. */
  retrievalIngestModuleFile(retrieverId: string): string;
}

/**
 * Everything about a target the registry cannot derive from its manifest.
 *
 * The path helpers come from the generator package itself, so a generator that moves a
 * file moves every command with it. `extension` is what turns a repo-relative path into
 * the dotted module path a runner understands -- `.py` for CPython's `-m`, `.js` for the
 * TypeScript runtime's emitted ESM.
 */
interface TargetModule {
  readonly manifest: GeneratorManifest;
  readonly generator: Generator;
  readonly runner: TargetRunner;
  readonly extension: string;
  readonly evalsIndexPath: string;
  readonly evalModulePath: (evalId: string) => string;
  readonly retrievalIngestModulePath: (retrieverId: string) => string;
  readonly checkPlan: (ir: IR) => readonly PlanProblemLike[];
}

function dotted(path: string, extension: string): string {
  return path
    .replace(new RegExp(`${extension.replace('.', '\\.')}$`), '')
    .split('/')
    .join('.');
}

function targetFor(module: TargetModule): Target {
  const { manifest } = module;
  const roots = managedRoots(manifest);
  return {
    name: manifest.target,
    specPath: `${manifest.output.root}/app.spec.yaml`,
    generatedDir: roots.generatedDir,
    businessDir: roots.businessDir,
    manifestPath: roots.manifestFilename,
    evalsDir: parentPath(module.evalsIndexPath),
    manifest,
    generator: module.generator,
    runner: module.runner,
    // `checkPlan` is the target's own compiler, and it throws the same problems
    // `plan` does. Reporting them through it means the CLI prints the target's codes
    // and paths verbatim: no catching, no renaming, no second opinion about what is
    // wrong with a spec.
    check(ir) {
      return module.checkPlan(ir).map((problem) =>
        errorDiagnostic({
          code: problem.code,
          message: problem.message,
          path: [problem.path],
        }),
      );
    },
    plan(ir) {
      return module.generator.plan(ir, {
        generatorVersion: manifest.version,
        root: manifest.output.root,
      });
    },
    evalModuleFile(evalId) {
      return module.evalModulePath(evalId);
    },
    evalModule(evalId) {
      return dotted(module.evalModulePath(evalId), module.extension);
    },
    retrievalIngestModuleFile(retrieverId) {
      return module.retrievalIngestModulePath(retrieverId);
    },
    retrievalIngestModule(retrieverId) {
      return dotted(module.retrievalIngestModulePath(retrieverId), module.extension);
    },
  };
}

/**
 * The registry. Order matters only for the default: the first entry is what `aid gen`,
 * `aid validate` and `aid init` use when the caller names no target, and that has been
 * `py-fastapi` since Phase 0.
 */
export const TARGETS: readonly Target[] = [
  targetFor({
    manifest: PY_FASTAPI_MANIFEST,
    generator: pyFastApiGenerator,
    runner: 'python',
    extension: '.py',
    evalsIndexPath: EVALS_INIT_PATH,
    evalModulePath: pyFastApiEvalModulePath,
    retrievalIngestModulePath: pyFastApiIngestModulePath,
    checkPlan: checkPyFastApi,
  }),
  targetFor({
    manifest: TS_VERCEL_MANIFEST,
    generator: tsVercelGenerator,
    runner: 'node',
    // The generated modules are `.ts` on disk and `.js` once compiled; the dotted name
    // is the same either way, and the path helpers hand back the file that exists.
    extension: '.ts',
    evalsIndexPath: tsVercelPaths.evalsIndex,
    evalModulePath: tsVercelEvalModulePath,
    retrievalIngestModulePath: tsVercelIngestModulePath,
    checkPlan: checkTsVercel,
  }),
];

const [primary] = TARGETS;
if (primary === undefined) {
  throw new Error('No Phase 0 target is registered.');
}

export const DEFAULT_TARGET = primary.name;

/** Where `aid validate` and `aid gen` look when the caller names no spec. */
export const DEFAULT_SPEC_PATH = primary.specPath;

export function targetNames(): string[] {
  return TARGETS.map((target) => target.name);
}

/** The named target, the default when `name` is absent, or `undefined` when unknown. */
export function resolveTarget(name: string | undefined): Target | undefined {
  if (name === undefined) return primary;
  return TARGETS.find((target) => target.name === name);
}

/**
 * The capability declarations the build-time gates are run against.
 *
 * Derived from this registry rather than from the SDK's own `phase0Generators`, because
 * the registry is the list of generators this binary can actually run: a spec targeting
 * `ts-vercel` must be judged against `ts-vercel`'s declaration, and the SDK cannot name
 * a generator that depends on the SDK.
 */
export function targetCapabilities(): TargetCapabilityDeclarations {
  return targetCapabilityDeclarations(TARGETS.map((target) => target.manifest));
}

/** Diagnostics for a target id the registry does not know. */
export function unknownTargetDiagnostic(name: string): CliDiagnostic {
  return errorDiagnostic({
    code: CLI_DIAGNOSTIC_CODES.unknownTarget,
    message: `Unknown target \`${name}\`.`,
    path: [],
    hint: `Known targets: ${targetNames().join(', ')}.`,
  });
}
