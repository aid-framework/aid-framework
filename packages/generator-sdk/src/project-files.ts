/**
 * The dependency manifest a generated project needs before anything can be installed.
 *
 * `aid gen` emits plumbing that imports two things from outside the repository: the AID
 * runtime and a web framework. Neither is declared anywhere in a generated tree, so a
 * fresh project could not be installed, could not be packaged by `aid package`, and could
 * not run the `app` job in the CI workflow `aid gen` scaffolds -- that job probes for the
 * dependency manifest and *skips* rather than reporting a false green. These builders close
 * that gap: a project that has only ever run `aid gen` gets a manifest that installs.
 *
 * They are scaffold files, not generated ones, and the difference matters. A scaffold is
 * written once and then belongs to the developer: it is never overwritten, never hashed
 * into `aid.manifest.json`, and never diffed by `gen --check`. A dependency manifest is
 * exactly that -- something you edit as you add libraries, not something a spec should own.
 * Emitting it as generated output would mean every added dependency broke the drift check.
 *
 * What is emitted is deliberately the same configuration the committed examples are held
 * to, because those examples pass the same commands this scaffold's CI job runs. A
 * scaffold that installs but does not lint clean would turn a fresh project's first CI run
 * red for reasons the developer did not cause.
 */

import type { GeneratedFile } from './plan.js';

/**
 * The Node major a scaffolded project targets. It has to be the major the TypeScript
 * runtime itself requires -- `engines.node` on `@aid-framework/runtime` -- or the scaffold
 * would declare a floor it cannot satisfy once `npm install` pulls the runtime in.
 */
export const SCAFFOLD_NODE_MAJOR = '24';

/** The linter and type checker the scaffolded CI runs, and the floor it holds a project to. */
const PYTHON_VERSION = '3.11';
const PYTHON_TARGET = 'py311';

/** Stated once, emitted into both the pip extra and the uv dependency group. */
const PYTHON_DEV_DEPENDENCIES = [
  '  "httpx>=0.27,<1",',
  '  "mypy>=1.11,<3",',
  '  "pytest>=8,<10",',
  '  "pytest-asyncio>=0.24,<2",',
  '  "ruff>=0.6,<1",',
] as const;

/** The runtime dependencies, stated once so `requirements.txt` cannot disagree with them. */
function pythonRuntimeDependencies(profile: PythonProjectProfile): string[] {
  return [
    `aid-runtime-python${pythonRuntimeRange(profile.runtimeVersion)}`,
    'fastapi>=0.115,<1',
    'uvicorn>=0.30,<1',
  ];
}

export interface PythonProjectProfile {
  /** The spec's `project.name`, normalized here rather than trusted from the spec. */
  name: string;
  description?: string;
  /** The `aid-runtime-python` release this generator writes code against. */
  runtimeVersion: string;
}

export interface TypeScriptProjectProfile {
  name: string;
  description?: string;
  /** The `@aid-framework/runtime` release this generator writes code against. */
  runtimeVersion: string;
}

/**
 * A PEP 503 project name: lowercase, with runs of anything else collapsed to one hyphen.
 * `[project].name` is validated by the installer, so a spec name such as `Support_Copilot`
 * is turned into `support-copilot` here instead of failing at `pip install`.
 */
function pythonProjectName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  // At most one hyphen can be leading or trailing, because the replace above collapses
  // runs. Slicing says that plainly; an anchored `^-+|-+$` is polynomial on a long run of
  // dashes, and a scanner has no way to know the invariant that keeps it short here.
  let trimmed = normalized;
  if (trimmed.startsWith('-')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('-')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed === '' ? 'aid-app' : trimmed;
}

/** The same normalization, for an npm package name. */
function npmProjectName(name: string): string {
  return pythonProjectName(name);
}

/** A TOML basic string cannot contain a raw quote or a newline, and prose can. */
function tomlString(value: string): string {
  return value.replace(/["\\]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * `>=0.1.199,<0.2` -- every patch of the minor the code was generated against.
 *
 * A caret would be wrong here: the scaffold is written once, so a constraint it emits has
 * to keep working for a project that is never regenerated, and `^0.1.199` in pip's
 * PEP 440 reading already means `<0.2`, but spelling it out says what is meant to a reader
 * who does not have to recall how caret behaves below 1.0.
 */
function pythonRuntimeRange(version: string): string {
  const [major, minor] = version.split('.');
  const nextMinor = Number(minor) + 1;
  return `>=${version},<${major}.${nextMinor}`;
}

/**
 * `^0.1.199` -- for npm, a caret on a `0.x` release already pins the minor, so it admits
 * patch releases of the runtime the generator was built against and nothing else.
 */
function npmRuntimeRange(version: string): string {
  return `^${version}`;
}

function defaultDescription(name: string): string {
  return `The ${name} service, compiled from app/app.spec.yaml by the AID Framework.`;
}

/**
 * `pyproject.toml`, the package marker that makes `app` importable, and one test that
 * gives `pytest` something to run.
 *
 * The test is not decoration. The scaffolded CI runs `pytest -q`, and pytest exits 5 --
 * `no tests ran` -- when it collects nothing, which would fail a project for having no
 * tests yet rather than for anything the developer did. `testpaths` points at `tests/`, so
 * the directory has to exist with at least one collected test. Importing the generated
 * schemas is the smallest assertion that is true of every spec: the module exists for any
 * non-empty declaration, and importing it proves the install worked.
 */
export function scaffoldPythonProject(profile: PythonProjectProfile): GeneratedFile[] {
  const name = pythonProjectName(profile.name);
  const description = tomlString(profile.description ?? defaultDescription(name));

  const pyproject = [
    '# Generated once by `aid gen` for the `py-fastapi` target, then yours.',
    '# A scaffold file is never overwritten and never recorded in aid.manifest.json,',
    '# so edit it freely: add a dependency, change the linter, drop the dev extra.',
    '',
    '[build-system]',
    'requires = ["setuptools>=68"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[project]',
    `name = "${name}"`,
    'version = "0.1.0"',
    `description = "${description}"`,
    `requires-python = ">=${PYTHON_VERSION}"`,
    'license = "Apache-2.0"',
    'authors = [{ name = "The AID Framework authors" }]',
    '# The generated app depends on the runtime for every behaviour it has -- the gateway,',
    '# the prompt registry, the tool executor, the pipeline, the eval gate. Nothing else is',
    '# needed: a generated pipeline is plain async, so there is no graph library here.',
    'dependencies = [',
    ...pythonRuntimeDependencies(profile).map((dependency) => `  "${dependency}",`),
    ']',
    '',
    '[project.optional-dependencies]',
    '# What the scaffolded CI installs: `pip install -e ".[dev]"`.',
    'dev = [',
    ...PYTHON_DEV_DEPENDENCIES,
    ']',
    '',
    '[dependency-groups]',
    '# The same list as PEP 735, which is what `uv sync` reads by default. Both spellings',
    "# are here so the install command is the developer's choice: `uv sync` / `uv run`,",
    '# `pip install -e ".[dev]"`, or `uv pip install -r requirements.txt` for a plain',
    '# environment. Keep the two in step if you add a dev tool.',
    'dev = [',
    ...PYTHON_DEV_DEPENDENCIES,
    ']',
    '',
    '[tool.setuptools.packages.find]',
    'include = ["app*"]',
    'namespaces = false',
    '',
    '# `app/evals/` holds data, not code, so it travels with the `app` package.',
    '[tool.setuptools.package-data]',
    'app = ["evals/*.json"]',
    '',
    '[tool.pytest.ini_options]',
    'testpaths = ["tests"]',
    'asyncio_mode = "auto"',
    'asyncio_default_fixture_loop_scope = "function"',
    'pythonpath = ["."]',
    'addopts = "-ra --strict-markers --strict-config"',
    '',
    '[tool.ruff]',
    'line-length = 100',
    `target-version = "${PYTHON_TARGET}"`,
    '',
    '[tool.ruff.lint.isort]',
    'known-first-party = ["app", "tests"]',
    '',
    '[tool.ruff.lint]',
    "# The runtime's own selection, so a generated project is held to the standard the",
    '# framework is rather than to a weaker one it can drift away from.',
    'select = [',
    '  "A",     # builtins shadowing',
    '  "ANN",   # annotations',
    '  "ASYNC", # async correctness',
    '  "B",     # bugbear',
    '  "C4",    # comprehensions',
    '  "DTZ",   # naive datetimes',
    '  "E",     # pycodestyle errors',
    '  "ERA",   # commented-out code',
    '  "F",     # pyflakes',
    '  "I",     # import sorting',
    '  "LOG",   # logging',
    '  "N",     # pep8-naming',
    '  "PT",    # pytest style',
    '  "PTH",   # pathlib over os.path',
    '  "RET",   # return simplification',
    '  "RUF",   # ruff-specific',
    '  "S",     # bandit',
    '  "SIM",   # simplify',
    '  "T20",   # no print()',
    '  "TID",   # tidy imports',
    '  "UP",    # pyupgrade',
    '  "W",     # pycodestyle warnings',
    ']',
    'ignore = [',
    '  # `Any` is unavoidable at the provider/tool boundary, where the payload is shaped',
    '  # by the remote model rather than by us.',
    '  "ANN401",',
    ']',
    '',
    '[tool.ruff.lint.per-file-ignores]',
    '# Generated code is emitted by the generator, never hand-edited. It reaches its',
    '# siblings and parents through relative imports, and its eval module exposes a',
    '# `main()` whose job is to print the gate summary for a CI log.',
    '"app/generated/**" = ["TID252", "T201", "ANN001", "ANN201"]',
    '# The business seeds import the generated tree relatively for the same reason.',
    '"app/business/**" = ["TID252"]',
    '"tests/**" = [',
    '  "ANN001", # fixtures and test callables take untyped parameters',
    '  "ANN201",',
    '  "ANN202",',
    '  "S101",   # assert is the point of a test',
    ']',
    '',
    '[tool.ruff.lint.flake8-tidy-imports]',
    'ban-relative-imports = "all"',
    '',
    '[tool.mypy]',
    `python_version = "${PYTHON_VERSION}"`,
    'files = ["app", "tests"]',
    'strict = true',
    'warn_unreachable = true',
    '',
    '[[tool.mypy.overrides]]',
    '# pydantic-ai ships type hints but no `py.typed` marker on every release line.',
    'module = ["pydantic_ai.*"]',
    'follow_untyped_imports = true',
    '',
  ].join('\n');

  const packageMarker = [
    '# Generated once by `aid gen`, then yours: `app` is a package so the generated tree',
    '# imports as `app.generated` and an editable install can find it.',
    '',
  ].join('\n');

  const requirements = [
    '# Generated once by `aid gen` for the `py-fastapi` target, then yours.',
    '# `pip install -r requirements.txt`, or `uv pip install -r requirements.txt`.',
    '#',
    '# `pyproject.toml` declares these same runtime dependencies plus a `dev` group, so',
    '# `pip install -e ".[dev]"` and `uv sync` install everything the scaffolded CI needs.',
    '# Keep the two files in step if you add a runtime dependency.',
    ...pythonRuntimeDependencies(profile),
    '',
  ].join('\n');

  const smokeTest = [
    '"""The test `aid gen` scaffolds so `pytest` has something to collect.',
    '',
    'The scaffolded CI runs `pytest -q`, which exits 5 when it collects nothing, so a',
    'project with no tests yet would fail for the wrong reason. This asserts what is true',
    'of every generated tree: the schemas module exists and imports.',
    '"""',
    '',
    'import importlib',
    '',
    '',
    'def test_the_generated_tree_imports() -> None:',
    '    module = importlib.import_module("app.generated.schemas")',
    '',
    '    assert module.__name__ == "app.generated.schemas"',
    '',
  ].join('\n');

  return [
    { path: 'pyproject.toml', content: pyproject, owner: 'scaffold' },
    { path: 'requirements.txt', content: requirements, owner: 'scaffold' },
    { path: 'app/__init__.py', content: packageMarker, owner: 'scaffold' },
    { path: 'tests/test_generated_tree.py', content: smokeTest, owner: 'scaffold' },
  ];
}

/**
 * `package.json` and the `tsconfig.json` the scaffolded lint step needs.
 *
 * The ts-vercel CI job typechecks with `tsc --noEmit -p tsconfig.json`, so a project with a
 * `package.json` and no `tsconfig.json` would install and then fail to lint. Both files are
 * scaffolded together for that reason: the manifest alone is not enough to make the job
 * pass, and a half-scaffolded project is worse than one that never ran the job.
 *
 * `@aid-framework/runtime` is pinned to the release the generator was built against rather
 * than to `workspace:*` as the repository's own examples do: a generated project is not a
 * member of this workspace, so a workspace specifier would not resolve from npm.
 */
export function scaffoldTypeScriptProject(profile: TypeScriptProjectProfile): GeneratedFile[] {
  const name = npmProjectName(profile.name);

  const packageJson = JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      description: profile.description ?? defaultDescription(name),
      license: 'Apache-2.0',
      type: 'module',
      engines: { node: `>=${SCAFFOLD_NODE_MAJOR}` },
      scripts: {
        build: 'tsc -p tsconfig.json',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
      dependencies: {
        '@aid-framework/runtime': npmRuntimeRange(profile.runtimeVersion),
        zod: '^4.3.6',
      },
      devDependencies: {
        '@types/node': '^26.6.6',
        typescript: '^7.0.2',
      },
    },
    null,
    2,
  );

  const tsconfig = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'node16',
        moduleResolution: 'node16',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        rootDir: '.',
        outDir: 'dist',
        types: ['node'],
      },
      include: ['app/**/*.ts', 'tests/**/*.ts'],
    },
    null,
    2,
  );

  return [
    { path: 'package.json', content: `${packageJson}\n`, owner: 'scaffold' },
    { path: 'tsconfig.json', content: `${tsconfig}\n`, owner: 'scaffold' },
  ];
}
