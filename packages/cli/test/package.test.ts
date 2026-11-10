/**
 * `aid package edge`: the archive the emitted `edge` module deploys.
 *
 * Two kinds of test live here, and the split is deliberate. The refusals and the install
 * argv are asserted through the CLI with an injected spawn, because they are the command's
 * contract and must hold on a machine with no Python at all. The helper behaviour -- what
 * `[project].dependencies` becomes, and what the archive contains -- is asserted against a
 * real interpreter, because "the archive is deterministic" and "`app/` is at the root" are
 * claims about what `zipfile` wrote, and a fake that echoed them back would assert nothing.
 *
 * Those helper tests skip when the machine has neither a Python 3.11+ nor `uv`, which is
 * exactly the condition the command itself refuses on, so the suite and the product agree
 * about what "there is no way to build this here" means.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { CliContext, Spawn } from '../src/index.js';
import {
  createContext,
  discoverStdlibInterpreter,
  EDGE_PLATFORM,
  EDGE_PYTHON_VERSION,
  EDGE_REQUIREMENTS_FILE,
  extractRequirements,
  stageApplication,
  wheelInstallArgs,
  writeArchive,
} from '../src/index.js';
import { aid, diagnosticsOf, EXAMPLE_SPEC, project, REPO_ROOT, recordingSpawn } from './helpers.js';

/**
 * The committed example with its one `container` deployment replaced by an `edge` one.
 *
 * Built by substitution rather than written out: a second whole spec here would be a
 * second thing to keep true as the language moves, and the example is already the fixture
 * every other generation test generates from. The two fields are what the language
 * requires of an `edge` deployment -- `secrets`, because the platform supplies them, and
 * `concurrency`, because this pipeline fans out and would otherwise have no cap.
 */
const EDGE_SPEC = EXAMPLE_SPEC.replace(
  /^deployments:[\s\S]*$/m,
  'deployments:\n  edge:\n    target: edge\n    concurrency: 4\n    secrets: [OPENAI_API_KEY]\n',
);

const PYPROJECT = `[project]
name = "support-copilot"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "aid-runtime-python",
  "fastapi>=0.115,<1",
  "uvicorn>=0.30,<1",
]
`;

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'aid-edge-'));
  roots.push(root);
  return root;
}

function contextAt(cwd: string): CliContext {
  return createContext({ cwd, stdout: () => {}, stderr: () => {} });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Discovered once, at collection time, because `it.skipIf` has to decide before any test
 * body runs. It is the same probe the command performs, so a machine that can package is a
 * machine that runs these.
 */
const interpreted = discoverStdlibInterpreter(contextAt(REPO_ROOT));

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Answers the spawns `aid package edge` makes, and records them.
 *
 * The two helpers answer with the JSON the real ones print, so the command's own wiring --
 * which value goes where, and what the report says -- is exercised without a Python or a
 * network. The interpreter probes (`-c`) pass, which is what makes the command get as far
 * as the helpers. `dependencies` is what the fixture manifest declares, because a fake
 * that always reported a dependency could not exercise an app that has none.
 */
function scriptedSpawn(dependencies: readonly string[] = ['fastapi>=0.115,<1']): Spawn & {
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const spawn: Spawn = (command, args) => {
    calls.push({ command, args });
    if (args.includes('-c')) return { status: 0, stdout: '', stderr: '' };
    const script = args.find((arg) => arg.endsWith('.py')) ?? '';
    if (script.endsWith('aid_edge_requirements.py')) {
      return { status: 0, stdout: JSON.stringify({ dependencies }), stderr: '' };
    }
    if (script.endsWith('aid_edge_zip.py')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          entries: 2,
          bytes: 4096,
          names: ['app/generated/edge.py', 'pyproject.toml'],
        }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  Object.defineProperty(spawn, 'calls', { value: calls, enumerable: true });
  return spawn as Spawn & { readonly calls: Call[] };
}

/**
 * A stage holding what `uv pip install --target` and the emitted `Dockerfile` would leave
 * behind, plus the two things the archive must not carry: a bytecode cache and the
 * requirements file the dependencies were installed from.
 */
function stagedStage(): string {
  const stage = join(scratch(), 'stage');
  const write = (relPath: string, text: string): void => {
    const full = join(stage, ...relPath.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  };
  write('app/__init__.py', '');
  write('app/generated/__init__.py', '');
  write('app/generated/edge.py', 'def handler(event, context):\n    return {"statusCode": 200}\n');
  write('app/__pycache__/edge.cpython-312.pyc', 'bytecode');
  write('fastapi/__init__.py', '');
  write('pyproject.toml', PYPROJECT);
  write('README.md', '# support copilot\n');
  write(EDGE_REQUIREMENTS_FILE, 'fastapi>=0.115,<1\n');
  return stage;
}

describe('aid package edge -- refusals', () => {
  it('refuses a target that does not emit Python', () => {
    const made = project(EDGE_SPEC);
    const run = aid(made, ['package', 'edge', '--target', 'ts-vercel', '--json'], recordingSpawn());

    // 2, not 1: the flag names a target whose output this command cannot build, so the
    // invocation is wrong and nothing about the project has been judged.
    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/runner-unsupported');
    expect(diagnostic?.message).toContain('TypeScript');
  });

  it('refuses a spec that declares no edge deployment', () => {
    // The example declares one `container` deployment and nothing else, so there is no
    // Lambda@Edge function to hand an archive to.
    const made = project(EXAMPLE_SPEC);
    const run = aid(made, ['package', 'edge', '--json'], recordingSpawn());

    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/package-no-edge-deployment');
    expect(diagnostic?.hint).toContain('target: edge');
  });
});

describe('aid package edge -- what it installs', () => {
  it('installs the declared dependencies as manylinux wheels into the stage', () => {
    const made = project(EDGE_SPEC);
    made.write('pyproject.toml', PYPROJECT);
    made.write('README.md', '# support copilot\n');
    made.write('app/__init__.py', '');
    const spawn = scriptedSpawn();

    const run = aid(made, ['package', 'edge', '--json'], spawn);

    expect(run.code).toBe(0);
    const install = spawn.calls.find((call) => call.command === 'uv');
    const args = install?.args ?? [];
    // The flags are the whole point: a wheel for another platform would install here and
    // fail to load in the function, so they are asserted, not assumed.
    expect(args.slice(0, 10)).toEqual([
      'pip',
      'install',
      '--target',
      expect.any(String),
      '--python-platform',
      EDGE_PLATFORM,
      '--python-version',
      EDGE_PYTHON_VERSION,
      '--only-binary',
      ':all:',
    ]);
    expect(args[10]).toBe('--requirement');
    expect(args[11]?.endsWith(EDGE_REQUIREMENTS_FILE)).toBe(true);
    // The requirement file lives in the stage that is being installed into, so the
    // relative resolution `uv` does cannot pick up a `requirements.txt` from elsewhere.
    expect(args[3]).toBe(dirname(args[11] ?? ''));

    const report = run.json<{ dependencies: string[]; entries: number; bytes: number }>();
    expect(report.dependencies).toEqual(['fastapi>=0.115,<1']);
    expect(report.entries).toBe(2);
    expect(run.stdout).toContain('edge.zip');
  });

  it('does not invoke uv when the app declares no dependencies', () => {
    const made = project(EDGE_SPEC);
    made.write(
      'pyproject.toml',
      '[project]\nname = "bare"\nversion = "0.1.0"\ndependencies = []\n',
    );
    made.write('README.md', '# bare\n');
    made.write('app/__init__.py', '');
    const spawn = scriptedSpawn([]);

    const run = aid(made, ['package', 'edge'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls.some((call) => call.command === 'uv')).toBe(false);
    expect(run.stdout).toContain('none declared');
  });
});

describe('aid package edge -- the requirements helper', () => {
  it.skipIf(interpreted === undefined)('reads dependencies out of a fixture pyproject.toml', () => {
    const interpreter = interpreted ?? '';
    const stage = stagedStage();
    const work = scratch();

    const extracted = extractRequirements(contextAt(REPO_ROOT), interpreter, work, stage);

    expect(extracted.ok).toBe(true);
    expect(extracted.ok ? extracted.value : []).toEqual([
      'aid-runtime-python',
      'fastapi>=0.115,<1',
      'uvicorn>=0.30,<1',
    ]);
    // The file uv is pointed at holds the same list, one requirement per line.
    expect(readFileSync(join(stage, EDGE_REQUIREMENTS_FILE), 'utf8')).toBe(
      'aid-runtime-python\nfastapi>=0.115,<1\nuvicorn>=0.30,<1\n',
    );
  });

  it.skipIf(interpreted === undefined)('refuses a manifest with no dependency list', () => {
    const interpreter = interpreted ?? '';
    const stage = join(scratch(), 'stage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'pyproject.toml'), '[project]\nname = "bare"\nversion = "0.1.0"\n');

    const extracted = extractRequirements(contextAt(REPO_ROOT), interpreter, scratch(), stage);

    // A missing list is a refusal, not an empty archive: the function would import nothing
    // and fail at its first line, which is a worse outcome than a diagnostic naming the
    // file.
    expect(extracted.ok).toBe(false);
    expect(extracted.ok ? '' : extracted.diagnostic.code).toBe('cli/package-dependencies-missing');
  });

  it.skipIf(interpreted === undefined)('accepts an app that genuinely has no dependencies', () => {
    const interpreter = interpreted ?? '';
    const stage = join(scratch(), 'stage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(
      join(stage, 'pyproject.toml'),
      '[project]\nname = "bare"\nversion = "0.1.0"\ndependencies = []\n',
    );

    const extracted = extractRequirements(contextAt(REPO_ROOT), interpreter, scratch(), stage);

    // An empty list is a real application, so it is a successful extraction; the caller
    // says so in its report rather than failing a legitimate archive.
    expect(extracted.ok).toBe(true);
    expect(extracted.ok ? extracted.value : ['unexpected']).toEqual([]);
  });
});

describe('aid package edge -- the archive', () => {
  it.skipIf(interpreted === undefined)('rebuilds to identical bytes', () => {
    const interpreter = interpreted ?? '';
    const work = scratch();
    const first = join(work, 'first.zip');
    const second = join(work, 'second.zip');

    // Two separate stages, written a moment apart, so this also asserts that nothing in
    // the archive carries a file's mtime: `source_code_hash` is computed from these bytes.
    const firstWritten = writeArchive(
      contextAt(REPO_ROOT),
      interpreter,
      scratch(),
      stagedStage(),
      first,
    );
    const secondWritten = writeArchive(
      contextAt(REPO_ROOT),
      interpreter,
      scratch(),
      stagedStage(),
      second,
    );

    expect(firstWritten.ok && secondWritten.ok).toBe(true);
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
  });

  it.skipIf(interpreted === undefined)('puts the stage contents at the archive root', () => {
    const interpreter = interpreted ?? '';
    const work = scratch();

    const written = writeArchive(
      contextAt(REPO_ROOT),
      interpreter,
      work,
      stagedStage(),
      join(work, 'edge.zip'),
    );

    expect(written.ok).toBe(true);
    // `app/generated/edge.py`, not `stage/app/generated/edge.py`: the handler is imported
    // as `app.generated.edge`, so a nesting directory would make the archive unimportable.
    expect(written.ok ? written.value.names : []).toEqual([
      'README.md',
      'app/__init__.py',
      'app/generated/__init__.py',
      'app/generated/edge.py',
      'fastapi/__init__.py',
      'pyproject.toml',
    ]);
    expect(written.ok ? written.value.entries : 0).toBe(6);
    expect(written.ok ? written.value.bytes : 0).toBeGreaterThan(0);
  });
});

describe('the install argv', () => {
  it('pins the target, the platform, the interpreter version and wheels only', () => {
    // Exported so this can be asserted without a subprocess: the flags are the difference
    // between an archive that deploys and one that imports on the machine that built it.
    expect(wheelInstallArgs('/stage', '/stage/requirements.txt')).toEqual([
      'pip',
      'install',
      '--target',
      '/stage',
      '--python-platform',
      'x86_64-manylinux2014',
      '--python-version',
      '3.12',
      '--only-binary',
      ':all:',
      '--requirement',
      '/stage/requirements.txt',
    ]);
  });
});

/**
 * The stage is `app/` plus the packaging metadata, which is the set the emitted Dockerfile
 * copies. Asserted through the real file system, because `cpSync`'s filter is where a
 * bytecode cache would otherwise reach the archive.
 */
describe('staging the application', () => {
  it('copies app/, pyproject.toml and README.md without build artefacts', () => {
    const made = project(EDGE_SPEC);
    made.write('pyproject.toml', PYPROJECT);
    made.write('README.md', '# support copilot\n');
    made.write('app/__init__.py', '');
    made.write('app/__pycache__/edge.cpython-312.pyc', 'bytecode');
    const stage = join(scratch(), 'stage');

    stageApplication(contextAt(made.root), 'app', stage);

    expect(readFileSync(join(stage, 'pyproject.toml'), 'utf8')).toBe(PYPROJECT);
    expect(readFileSync(join(stage, 'app', '__init__.py'), 'utf8')).toBe('');
    // The filters here mirror the archive helper's, so a cache that made it into the stage
    // would still be skipped; dropping it at the copy is what keeps the stage honest.
    expect(() => readFileSync(join(stage, 'app', '__pycache__', 'edge.cpython-312.pyc'))).toThrow();
  });
});
