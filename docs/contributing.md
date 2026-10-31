# Contributing

AID Framework is pre-alpha, so the highest-value contributions are design feedback, bug reports,
documentation and small focused changes. The authoritative version of this page is
[CONTRIBUTING.md](https://github.com/aid-framework/aid-framework/blob/main/CONTRIBUTING.md) in the
repository; this one covers the parts you need in order to run the gates.

## Sign off every commit

The project uses the **Developer Certificate of Origin**, not a CLA. You keep your copyright and
certify you have the right to submit the work under Apache-2.0.

```bash
git commit -s
```

The trailer must use your real name and a valid address, and a pull request without it will be
asked to amend before merge. To fix an existing commit, `git commit --amend -s --no-edit`; for a
range, `git rebase --signoff main`.

## Set up

Node 24 (see `.nvmrc`), pnpm through Corepack, and `uv` for anything that touches Python.

```bash
git clone https://github.com/aid-framework/aid-framework.git
cd aid-framework
corepack enable
pnpm install --frozen-lockfile
pnpm build          # the CLI and generators must be built before anything drives them
uv venv --python 3.11
uv pip install --python .venv -e "runtimes/python[dev]" -e "examples/support-copilot[dev]"
```

## The local gates

| Command | Covers |
| --- | --- |
| `pnpm check` | `lint && typecheck && test` - the gate CI runs |
| `pnpm build` | Compiles the TypeScript packages to `dist/` |
| `pnpm test` | Unit, spec-validation and release-gate tests |
| `pnpm e2e` | Regenerates `examples/support-copilot`, asserts it is byte-identical, boots it and answers a request |
| `pnpm lint` | Biome, markdownlint and config validation |
| `pnpm lint:actions` | actionlint over `.github/workflows` |
| `pnpm lint:licenses` | Dependency licence audit |
| `pnpm docs:check` | The generated reference pages still match their sources |
| `pnpm docs:links` | Every internal link and fragment in the built site resolves |
| `pnpm docs:a11y` | The built site keeps its accessibility and self-containment invariants |

The three `docs:*` gates read `site/.vitepress/dist`, so run `pnpm docs:build` first; CI runs
them in the same job, immediately after the build.

The Python trees have their own gates, run from each directory:

```bash
cd runtimes/python
../../.venv/bin/pytest
../../.venv/bin/ruff check . && ../../.venv/bin/ruff format --check . && ../../.venv/bin/mypy
```

`pnpm e2e` needs `pnpm build` first - it drives the compiled CLI exactly as a user would.

## What a change has to keep true

Four invariants account for most review comments:

1. **Generation is deterministic.** Generating twice from the same spec produces byte-identical
   output, and golden-file tests assert it. A change that reorders a map iteration or embeds a
   timestamp breaks the build. See [IR to generator](guide/ir-to-generator.md).
2. **A rule lives in exactly one layer.** If the CLI starts re-deriving a hash or a gate, that is the
   defect - not a shortcut. See [Runtime to CLI](guide/runtime-to-cli.md).
3. **Behaviour changes come with a measured threshold.** "It looks better" is not a gate; an eval
   with a threshold is. See [eval metrics](reference/eval-metrics.md).
4. **Generated code is never hand-edited.** Change the spec, the generator or the runtime. The
   injectable seams - `get_deps`, `setDeps` - exist so tests do not need to edit generated files; see
   [Serving](guide/serving.md).

## Pull requests

One logical change per PR, refactors split out from behaviour changes, and a description that says
what changed, why, and how you verified it. Codegen changes must keep the golden files and the
end-to-end check green; runtime or prompt changes that affect model output must include or update an
eval.

Generated files are marked `DO NOT EDIT` at the top and recorded in `aid.manifest.json`. If you find
yourself wanting to edit one, the change belongs in the spec or the generator - the drift check will
refuse the edit on the next `aid gen` anyway (see [Troubleshooting](troubleshooting.md)).

## Reporting bugs

Open an issue with a minimal spec fragment that reproduces the problem, the expected and actual
behaviour, and your environment. Security issues go through
[SECURITY.md](https://github.com/aid-framework/aid-framework/blob/main/SECURITY.md) rather than a
public issue.

## Licence

AID Framework is released under the
[Apache License 2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Third-party
attributions are recorded in
[NOTICE](https://github.com/aid-framework/aid-framework/blob/main/NOTICE); read the two together,
because Section 4(d) of the licence is what makes the notice file part of what a redistribution has
to carry.
