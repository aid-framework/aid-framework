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
  checkPlan,
  EVALS_INIT_PATH,
  evalModulePath,
  PY_FASTAPI_MANIFEST,
  pyFastApiGenerator,
  retrievalIngestModulePath,
} from '@aid/generator-py-fastapi';
import {
  type Generator,
  type GeneratorManifest,
  managedRoots,
  type Plan,
  phase0TargetCapabilities,
} from '@aid/generator-sdk';
import type { IR, TargetCapabilityDeclarations } from '@aid/ir';
import { errorDiagnostic } from '@aid/spec';

import type { CliDiagnostic } from './diagnostics.js';
import { CLI_DIAGNOSTIC_CODES } from './diagnostics.js';
import { parentPath } from './paths.js';

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

function targetFor(manifest: GeneratorManifest, generator: Generator): Target {
  const roots = managedRoots(manifest);
  return {
    name: manifest.target,
    specPath: `${manifest.output.root}/app.spec.yaml`,
    generatedDir: roots.generatedDir,
    businessDir: roots.businessDir,
    manifestPath: roots.manifestFilename,
    evalsDir: parentPath(EVALS_INIT_PATH),
    manifest,
    generator,
    // `checkPlan` is the target's own compiler, and it throws the same problems
    // `plan` does. Reporting them through it means the CLI prints the target's codes
    // and paths verbatim: no catching, no renaming, no second opinion about what is
    // wrong with a spec.
    check(ir) {
      return checkPlan(ir).map((problem) =>
        errorDiagnostic({
          code: problem.code,
          message: problem.message,
          path: [problem.path],
        }),
      );
    },
    plan(ir) {
      return generator.plan(ir, {
        generatorVersion: manifest.version,
        root: manifest.output.root,
      });
    },
    evalModuleFile(evalId) {
      return evalModulePath(evalId);
    },
    evalModule(evalId) {
      return evalModulePath(evalId).replace(/\.py$/, '').split('/').join('.');
    },
    retrievalIngestModuleFile(retrieverId) {
      return retrievalIngestModulePath(retrieverId);
    },
    retrievalIngestModule(retrieverId) {
      return retrievalIngestModulePath(retrieverId).replace(/\.py$/, '').split('/').join('.');
    },
  };
}

export const TARGETS: readonly Target[] = [targetFor(PY_FASTAPI_MANIFEST, pyFastApiGenerator)];

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
 * The capability declarations the build-time gates are run against. The SDK's set, so
 * the gate is judging the IR against what the generators on this machine really emit.
 */
export function targetCapabilities(): TargetCapabilityDeclarations {
  return phase0TargetCapabilities();
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
