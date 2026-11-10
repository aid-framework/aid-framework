/**
 * The archive `aid package edge` builds for the emitted `edge` module.
 *
 * The module already expects one: `filename = var.edge_zip_path`, a `fileexists`
 * precondition that refuses to plan without it, and a handler at
 * `app.generated.edge.handler`. Nothing in the tree produced that file, so an `edge`
 * deployment could only be planned after an operator had assembled the archive by hand
 * and hoped they had assembled the right one. This is that assembly, spelled out.
 *
 * Four decisions carry the weight:
 *
 * - **The dependency list comes from `pyproject.toml`, not from the project.**
 *   `uv pip install <project>` would install the application package too, and `uv pip`
 *   has no `--no-install-project` (that flag belongs to `uv sync`). So a stdlib `tomllib`
 *   helper reads PEP 621's `[project].dependencies` into a `requirements.txt` and uv
 *   installs *that*. The packaging metadata is developer-owned and already states the
 *   list authoritatively, and reading it in Python means no TOML parser is added to a
 *   package that has no third-party dependencies at all.
 * - **Wheels only, for the platform that is not this one.** `--only-binary :all:` beside
 *   `--python-platform x86_64-manylinux2014 --python-version 3.12` is what makes the
 *   result deployable: a source build on the operator's Windows or macOS machine would
 *   carry its own platform's artifacts into the Lambda, where they cannot load. There is
 *   deliberately no retry without the flag, because the retry produces an archive that
 *   fails at the function's first `import`.
 * - **Deterministic bytes.** The module hashes the archive into `source_code_hash`, so a
 *   rebuild of unchanged inputs that produced different bytes would read as a new
 *   deployment. Entries are sorted, every timestamp is the zip epoch and every mode is
 *   `0644`, so the same stage yields the same file.
 * - **The stage is the set the emitted Dockerfile already declares.** `app/`,
 *   `pyproject.toml`, `README.md` -- what `COPY` + `RUN pip install .` needs. The archive
 *   holds the stage's *contents* at its root, because the handler is imported as
 *   `app.generated.edge`, not as `stage.app.generated.edge`.
 *
 * The two Python helpers are plain script text passed to an interpreter by
 * {@link runHelper}: a script file rather than stdin, because `uv run python -` does not
 * forward the stdin it is given, and uv is the only interpreter on a machine without a
 * system Python.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CliContext, SpawnResult } from './context.js';
import type { CliDiagnostic } from './diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from './diagnostics.js';
import { absolutePath } from './paths.js';
import { invoke, stdlibCommand } from './python.js';

/**
 * The interpreter the archive is built for.
 *
 * Lambda@Edge's Python runtime is 3.12, and the emitted module pins the same string, so a
 * wheel set built for any other version would be installed into a function that cannot
 * import it.
 */
export const EDGE_PYTHON_VERSION = '3.12';

/**
 * The wheel platform: x86_64 Amazon Linux, whose oldest supported tag is manylinux2014.
 *
 * Pinned rather than passed through, because the alternative is uv choosing the operator's
 * own platform and the archive silently becoming machine-specific.
 */
export const EDGE_PLATFORM = 'x86_64-manylinux2014';

/** Written into the stage by the requirements helper. It describes the stage, not the app. */
export const EDGE_REQUIREMENTS_FILE = 'requirements.txt';

/**
 * The files `RUN pip install .` needs beside the application.
 *
 * `app/` itself is not listed: it is the target's own root, passed in per target rather
 * than assumed here.
 */
export const EDGE_STAGE_FILES = ['pyproject.toml', 'README.md'] as const;

/** Directories that are build output rather than application source. */
const SKIPPED_DIRECTORIES = new Set(['__pycache__', '.mypy_cache', '.pytest_cache']);

function isBuildArtifact(path: string): boolean {
  return (
    path.split(/[\\/]/).some((segment) => SKIPPED_DIRECTORIES.has(segment)) || path.endsWith('.pyc')
  );
}

function baseName(posixPath: string): string {
  const index = posixPath.lastIndexOf('/');
  return index === -1 ? posixPath : posixPath.slice(index + 1);
}

/**
 * The inputs that are not on disk, relative to the project root.
 *
 * Checked before staging rather than letting `cpSync` throw: a missing `pyproject.toml` is
 * a fact about the project -- run `aid gen`, keep the metadata -- not an internal error,
 * and the diagnostic can say which file and why the archive needs it.
 */
export function missingStageInputs(context: CliContext, appRoot: string): readonly string[] {
  return [appRoot, ...EDGE_STAGE_FILES].filter(
    (path) => !existsSync(absolutePath(context.cwd, path)),
  );
}

/** Copy the application and its packaging metadata into `stage`. */
export function stageApplication(context: CliContext, appRoot: string, stage: string): void {
  mkdirSync(stage, { recursive: true });
  for (const entry of [appRoot, ...EDGE_STAGE_FILES]) {
    cpSync(absolutePath(context.cwd, entry), join(stage, baseName(entry)), {
      recursive: true,
      filter: (source) => !isBuildArtifact(source),
    });
  }
}

/** A helper, as a file name to write and the source to write into it. */
export interface HelperScript {
  readonly name: string;
  readonly source: string;
}

/**
 * The statuses the requirements helper exits with when the manifest is the problem.
 *
 * Separate codes because "there is no dependency list" and "the list is not a list of
 * strings" are different mistakes with different fixes, and a reader of the diagnostic
 * should not have to guess which one they made.
 */
const EXIT_DEPENDENCIES_MISSING = 3;
const EXIT_DEPENDENCIES_INVALID = 4;

/**
 * Reads `[project].dependencies` and writes `requirements.txt` beside `pyproject.toml`.
 *
 * `tomllib` is the standard library's TOML parser, so nothing in TypeScript has to know
 * TOML's grammar and no dependency is added to the CLI. A dependency that contains a
 * newline is rejected: in a requirements file that would be a second requirement, so the
 * manifest would be able to install something it never declared. The newline written
 * between requirements is pinned for the same reason the archive is deterministic -- a
 * Windows checkout would otherwise produce a CRLF file that a POSIX one would not.
 */
export const REQUIREMENTS_HELPER: HelperScript = {
  name: 'aid_edge_requirements.py',
  source: `import json
import sys
import tomllib
from pathlib import Path

stage = Path(sys.argv[1])
manifest = stage / "pyproject.toml"

try:
    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
except FileNotFoundError as error:
    print(f"cannot read {manifest}: {error}", file=sys.stderr)
    sys.exit(2)
except (OSError, tomllib.TOMLDecodeError) as error:
    print(f"cannot read {manifest} as TOML: {error}", file=sys.stderr)
    sys.exit(2)

project = data.get("project")
if not isinstance(project, dict) or "dependencies" not in project:
    print(
        f"{manifest} declares no [project].dependencies, so the archive would carry "
        "no dependency at runtime",
        file=sys.stderr,
    )
    sys.exit(3)

dependencies = project["dependencies"]
if not isinstance(dependencies, list) or any(
    not isinstance(item, str) or "\\n" in item for item in dependencies
):
    print(f"[project].dependencies in {manifest} is not a list of one-line strings", file=sys.stderr)
    sys.exit(4)

(stage / "requirements.txt").write_text(
    "".join(f"{item}\\n" for item in dependencies), encoding="utf-8", newline="\\n"
)
print(json.dumps({"dependencies": dependencies}))
`,
};

/**
 * Zips the stage's contents at the archive root, deterministically.
 *
 * `ZipInfo` is constructed rather than letting `write()` fill one in, because `write()`
 * stamps each entry with the file's mtime and mode; two checkouts of the same commit would
 * then hash differently. `date_time=(1980, 1, 1)` is the zip epoch, and `create_system=3`
 * is what makes the `external_attr` Unix mode meaningful to an unzipper. The stage's own
 * `requirements.txt` is skipped: it is how the dependencies got in, not something the
 * function imports.
 */
export const ZIP_HELPER: HelperScript = {
  name: 'aid_edge_zip.py',
  source: `import json
import sys
import zipfile
from pathlib import Path

stage = Path(sys.argv[1])
archive = Path(sys.argv[2])

skipped_directories = {"__pycache__", ".mypy_cache", ".pytest_cache"}
skipped_files = {"requirements.txt"}

names = []
for path in stage.rglob("*"):
    if not path.is_file():
        continue
    relative = path.relative_to(stage).as_posix()
    if relative in skipped_files or path.suffix == ".pyc":
        continue
    if any(part in skipped_directories for part in relative.split("/")):
        continue
    names.append(relative)
names.sort()

with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for relative in names:
        info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        bundle.writestr(info, (stage / relative).read_bytes())

print(json.dumps({"entries": len(names), "bytes": archive.stat().st_size, "names": names}))
`,
};

/** A step that either produced a value or has the diagnostic that explains why it did not. */
export type StepResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly diagnostic: CliDiagnostic;
      /** A subprocess's own stderr, for the caller to pass through to the CLI's. */
      readonly stderr?: string;
    };

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * Write a helper into `work` and run it.
 *
 * The script goes to a file, and the arguments go through argv, so no value is ever
 * interpolated into a shell string -- a dependency such as `fastapi>=0.115,<1` contains
 * characters a shell would interpret, and the archive path may contain spaces.
 */
export function runHelper(
  context: CliContext,
  interpreter: string,
  work: string,
  script: HelperScript,
  args: readonly string[],
): SpawnResult | undefined {
  const path = join(work, script.name);
  writeFileSync(path, script.source, 'utf8');
  return invoke(context, [...stdlibCommand(interpreter), path, ...args]);
}

function readJson(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function noInterpreter(what: string): StepResult<never> {
  return {
    ok: false,
    diagnostic: cliError({
      code: CLI_DIAGNOSTIC_CODES.packageNoInterpreter,
      message: `\`aid package edge\` could not start the ${what} helper.`,
      hint: 'Install Python 3.11 or newer, or `uv`, which supplies one. The helper needs only the standard library.',
    }),
  };
}

function helperFailed(run: SpawnResult, fallback: string): StepResult<never> {
  const said = firstLine(run.stderr);
  return {
    ok: false,
    diagnostic: cliError({
      code: CLI_DIAGNOSTIC_CODES.packageHelperFailed,
      message: said === '' ? fallback : said,
      hint: 'The helper reads `pyproject.toml` and writes the archive with the standard library only; `tomllib` needs Python 3.11 or newer.',
    }),
  };
}

/**
 * Read the declared dependencies out of the staged `pyproject.toml`.
 *
 * An empty list succeeds: an application with no dependencies is a real application, and
 * the caller says so in what it reports rather than failing a legitimate archive.
 */
export function extractRequirements(
  context: CliContext,
  interpreter: string,
  work: string,
  stage: string,
): StepResult<readonly string[]> {
  const run = runHelper(context, interpreter, work, REQUIREMENTS_HELPER, [stage]);
  if (run === undefined) return noInterpreter('requirements');

  const said = firstLine(run.stderr);
  if (run.status === EXIT_DEPENDENCIES_MISSING) {
    return {
      ok: false,
      diagnostic: cliError({
        code: CLI_DIAGNOSTIC_CODES.packageDependenciesMissing,
        message: said === '' ? '`pyproject.toml` declares no `[project].dependencies`.' : said,
        path: ['pyproject.toml'],
        hint: "The archive is installed from that list, so a missing one would ship a function that fails at its first import. List the application's dependencies under `[project].dependencies` in `pyproject.toml`.",
      }),
    };
  }
  if (run.status === EXIT_DEPENDENCIES_INVALID) {
    return {
      ok: false,
      diagnostic: cliError({
        code: CLI_DIAGNOSTIC_CODES.packageDependenciesInvalid,
        message: said === '' ? '`[project].dependencies` is not a list of strings.' : said,
        path: ['pyproject.toml'],
        hint: 'PEP 621 spells each dependency as one string, for example `fastapi>=0.115,<1`.',
      }),
    };
  }
  if (run.status !== 0) {
    return helperFailed(run, `The requirements helper exited with status ${String(run.status)}.`);
  }

  const reported = readJson(run.stdout)?.dependencies;
  if (!Array.isArray(reported)) {
    return helperFailed(run, 'The requirements helper did not report a dependency list.');
  }
  const dependencies: string[] = [];
  for (const item of reported as unknown[]) {
    if (typeof item !== 'string') {
      return helperFailed(run, 'The requirements helper reported a non-string dependency.');
    }
    dependencies.push(item);
  }
  return { ok: true, value: dependencies };
}

/**
 * The install argv, exported so a test can pin the flags that make the archive deployable.
 *
 * `--requirement` rather than `-r` because the requirement file lives in the stage beside
 * the packages being installed into it, and a reader of a log should see which file it was.
 */
export function wheelInstallArgs(target: string, requirements: string): readonly string[] {
  return [
    'pip',
    'install',
    '--target',
    target,
    '--python-platform',
    EDGE_PLATFORM,
    '--python-version',
    EDGE_PYTHON_VERSION,
    '--only-binary',
    ':all:',
    '--requirement',
    requirements,
  ];
}

/**
 * Install the declared dependencies as manylinux wheels directly into the stage.
 *
 * `--target` puts them where the archive will pick them up, next to `app/`, which is the
 * same layout `pip install --target` has always produced and therefore the layout the
 * handler's imports expect. Nothing is installed into the environment running the command.
 */
export function installWheels(
  context: CliContext,
  stage: string,
  dependencies: readonly string[],
): StepResult<number> {
  const run = invoke(context, [
    'uv',
    ...wheelInstallArgs(stage, join(stage, EDGE_REQUIREMENTS_FILE)),
  ]);
  if (run === undefined) {
    return {
      ok: false,
      diagnostic: cliError({
        code: CLI_DIAGNOSTIC_CODES.packageUvMissing,
        message:
          "`aid package edge` installs the application's dependencies with `uv`, and `uv` could not be run.",
        hint: 'Install uv (https://docs.astral.sh/uv/) and re-run. It is what resolves a wheel set for a platform other than this one.',
      }),
    };
  }
  if (run.status !== 0) {
    const said = firstLine(run.stderr);
    return {
      ok: false,
      stderr: run.stderr,
      diagnostic: cliError({
        code: CLI_DIAGNOSTIC_CODES.packageWheelsUnavailable,
        message: `Could not install ${dependencies.join(', ')} as ${EDGE_PLATFORM} wheels for CPython ${EDGE_PYTHON_VERSION}${said === '' ? '' : `: ${said}`}`,
        hint: "Lambda@Edge runs x86_64 Linux, so every dependency needs a published manylinux wheel for that interpreter. A source-only or platform-specific package cannot be cross-installed, and building one here would ship this machine's artifacts; pin a version that publishes a wheel, or vendor the code into the app.",
      }),
    };
  }
  return { ok: true, value: dependencies.length };
}

/** What the archive helper reports about the file it wrote. */
export interface EdgeArchive {
  readonly entries: number;
  readonly bytes: number;
  readonly names: readonly string[];
}

/** Zip the staged contents at the archive root and report what landed there. */
export function writeArchive(
  context: CliContext,
  interpreter: string,
  work: string,
  stage: string,
  archive: string,
): StepResult<EdgeArchive> {
  const run = runHelper(context, interpreter, work, ZIP_HELPER, [stage, archive]);
  if (run === undefined) return noInterpreter('archive');
  if (run.status !== 0) {
    return helperFailed(run, `The archive helper exited with status ${String(run.status)}.`);
  }

  const reported = readJson(run.stdout);
  const entries = reported?.entries;
  const bytes = reported?.bytes;
  const names = reported?.names;
  if (typeof entries !== 'number' || typeof bytes !== 'number' || !Array.isArray(names)) {
    return helperFailed(run, 'The archive helper did not report what it wrote.');
  }
  const listed: string[] = [];
  for (const item of names as unknown[]) {
    if (typeof item === 'string') listed.push(item);
  }
  return { ok: true, value: { entries, bytes, names: listed } };
}
