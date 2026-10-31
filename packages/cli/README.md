# `@aid-framework/cli`

The `aid` command: scaffold, validate, compile, index and evaluate an AI application from a single declarative
spec file.

You write `app/app.spec.yaml`. `aid` checks it, compiles it into a runnable service, and gates its behaviour.
Nothing in the generated tree is hand-written, and nothing you write is ever overwritten.

## Install

```sh
npm install --save-dev @aid-framework/cli
```

Requires Node.js 24 or newer. Or run it without installing:

```sh
npx @aid-framework/cli --help
```

## Quick start

```sh
npx aid init my-app
cd my-app
npx aid validate
npx aid gen
```

Three commands, and the generated app exists:

```text
my-app/
  README.md
  app/
    app.spec.yaml
    business/         ← yours: prompts, tool handlers, domain logic
    generated/        ← the compiler's: never hand-edit
    aid.manifest.json ← provenance and per-file hashes
```

### Serving it

The generator owns the routes; the application decides what to mount and how to run it. That entry point is
yours, and it is a few lines — `app/main.py`:

```python
from fastapi import FastAPI

from app.generated.routes.answer_ticket import answer_ticket_router

app = FastAPI(title="my-app", version="0.1.0")
app.include_router(answer_ticket_router)
```

Install the runtime and the server, then run it:

```sh
pip install aid-runtime-python "fastapi>=0.115,<1" "uvicorn>=0.30,<1"
uvicorn app.main:app --reload
```

`aid gen` never writes `main.py` or a `pyproject.toml`: mounting and packaging are application decisions, and a
generator that guessed them would overwrite your choice on the next run.

The starter spec declares no pipelines, so a fresh `init` generates the structure but no routes. Add a pipeline
to `app/app.spec.yaml` and regenerate, and one router module appears per HTTP-served pipeline.

## Commands

| Command | What it does |
| --- | --- |
| `aid init [dir]` | Scaffold a project: a starter spec and a README |
| `aid validate [spec]` | Parse the spec, build the IR, run every build-time gate |
| `aid gen [spec]` | Compile the spec and reconcile the tree with it |
| `aid ingest [spec]` | Index a retriever corpus into the store the spec declares |
| `aid eval [spec]` | Run the eval gate, or record the baseline it measures against |
| `aid doctor [spec]` | Diagnose the tree against the spec: drift, provenance and version mismatches, missing and outdated generated files. Reports; writes nothing |

Every command accepts `--help` for its own options and `--json` for machine-readable output.

## Exit codes

The exit code is the contract, because it is what CI reads:

| Code | Meaning |
| --- | --- |
| `0` | The project is as asked |
| `1` | The spec, a gate, the target, or the working tree said no |
| `2` | The invocation was wrong, or the CLI failed internally |

`1` and `2` are deliberately distinct. A red build caused by a spec problem is fixed in the spec; a red build
caused by `2` is fixed in the invocation or is a bug. Collapsing them sends people to the wrong file.

## `--json`

Every command answers `--json` with **exactly one** JSON document on stdout. Human-readable text and progress go
to stderr, so `aid validate --json | jq` works without filtering.

```sh
npx aid validate --json | jq -r '.diagnostics[] | select(.severity=="error") | .code'
```

## The spec path

Given no argument, a command reads `app/app.spec.yaml` — the path `aid init` creates and the path the generators
compile into. Pass a path to override it:

```sh
npx aid validate path/to/other.spec.yaml
```

## Targets

A spec declares the targets it is for, and `aid gen` emits one target at a time:

```yaml
project:
  name: my-app
  targets:
    - py-fastapi
    - ts-vercel
```

```sh
npx aid gen                        # the first declared target
npx aid gen --target ts-vercel     # any other declared target
```

`--target` selects among the targets the spec declares; it cannot invent one. Naming a target the spec does not
declare fails with `target-unsupported` and lists what is declared. That is stricter on purpose — a spec is the
statement of intent, and silently generating a stack it did not ask for would make the spec a lie.

| Target | Emits | Runtime |
| --- | --- | --- |
| `py-fastapi` | FastAPI service, Pydantic models | [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/) |
| `ts-vercel` | Next.js / Vercel functions, zod models | [`@aid-framework/runtime`](https://www.npmjs.com/package/@aid-framework/runtime) |

## `aid gen`: planning, then reconciling

`gen` never writes blindly. It plans the full file set from the IR, compares that plan against the tree, and only
then reconciles.

| Tier | Owner | On regeneration |
| --- | --- | --- |
| `app/generated/` | the compiler | overwritten — never hand-edit |
| `app/business/` | you | created once if missing, then never touched |

Preview without writing anything:

```sh
npx aid gen --dry-run
```

```text
py-fastapi: dry run, 16 created, 0 updated, 0 unchanged, 0 kept
created:
  app/business/prompts/__init__.py
  app/generated/deps.py
  app/generated/requests.py
  app/generated/schemas.py
  ...
```

The counts are `created` / `updated` / `unchanged` / `kept`, so a no-op regeneration says so instead of looking
like progress.

### When a generated file has been edited by hand

`gen` records a SHA-256 for every file it writes in `aid.manifest.json`. If a `generated/` file on disk no
longer matches its recorded hash, a human edited it, and `gen` **refuses to overwrite** it. It writes the new
content beside it as `<path>.aid-rej` and reports the conflict with both hashes.

The choice is yours to make explicitly:

```sh
npx aid gen --force     # discard the hand edit and overwrite
```

or move the file into `business/` and point the business seam at it. Either way the edit is not lost silently,
which is the failure mode that matters: a generator that overwrites unconditionally destroys the only signal it
has that a human disagreed with it.

## `aid eval`: gating behaviour, not bytes

A generated service varies between runs — the model is not deterministic, and pretending otherwise produces tests
that are either always red or measuring nothing. `aid eval` therefore samples and compares distributions:

```sh
npx aid eval --record     # record a baseline from the current behaviour
npx aid eval              # gate the current behaviour against it
```

## What the CLI is not

It is not a runtime. It reads the spec, compiles it, and reports; the generated app imports the runtime package
for its target and runs without the CLI installed. `@aid-framework/cli` is a `devDependency` for exactly that
reason.

## API

The CLI is also importable, so a build tool can drive it without a subprocess:

```ts
import { main, runCli } from '@aid-framework/cli';

process.exitCode = await runCli(process.argv.slice(2));
```

| Export | Purpose |
| --- | --- |
| `runCli(argv)` | Run a command and return its exit code |
| `main` | The command dispatcher |
| `EXIT_OK`, `EXIT_REJECTED`, `EXIT_USAGE` | The exit-code constants (`0`, `1`, `2`) |

## Related packages

- [`@aid-framework/spec`](https://www.npmjs.com/package/@aid-framework/spec) — the spec language
- [`@aid-framework/ir`](https://www.npmjs.com/package/@aid-framework/ir) — the IR and its build-time gates
- [`@aid-framework/generator-py-fastapi`](https://www.npmjs.com/package/@aid-framework/generator-py-fastapi)
- [`@aid-framework/generator-ts-vercel`](https://www.npmjs.com/package/@aid-framework/generator-ts-vercel)

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
