# Contributing to AID Framework

Thanks for your interest in AID Framework! The project is early and pre-1.0, so the highest-value
contributions right now are design feedback, bug reports, docs, and small, focused changes.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Design feedback** — read [`docs/design.md`](docs/design.md) and open an issue with questions, gaps, or
  pushback. The design document is the source of truth and is expected to change.
- **Bugs and features** — open an issue describing the problem, the expected behavior, and (if relevant) the
  spec that reproduces it.
- **Code and docs** — send a focused pull request (see below). Prompts, tools, rubrics, generators, runtimes,
  docs, and tests are all in scope.

## Developer Certificate of Origin (DCO)

AID Framework uses the **Developer Certificate of Origin (DCO)**, **not a Contributor License Agreement
(CLA)**. You keep the copyright to your contribution; you simply certify that you have the right to submit it
under the project's license (Apache-2.0).

Certify every commit by signing off with `git commit -s`, which appends:

```text
Signed-off-by: Your Name <your.email@example.com>
```

The sign-off must use your real name and a valid email address. To sign off a commit you already made:

```bash
git commit --amend -s --no-edit
```

To sign off a range of commits:

```bash
git rebase --signoff main
```

The full DCO text is at <https://developercertificate.org/>:

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the right to submit it under the open
> source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my knowledge, is covered under an
> appropriate open source license and I have the right under that license to submit that work with
> modifications, whether created in whole or in part by me, under the same open source license (unless I am
> permitted to submit under a different license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who certified (a), (b) or (c) and I
> have not modified it.
>
> (d) I understand and agree that this project and the contribution are public and that a record of the
> contribution (including all personal information I submit with it, including my sign-off) is maintained
> indefinitely and may be redistributed consistent with this project or the open source license(s) involved.

Pull requests whose commits are not signed off will be asked to amend before merge.

## Development setup

Phase 0 has landed: the spec DSL, the IR, the generator SDK, the `py-fastapi` generator, the `aid` CLI, the
Python runtime, and one example app are implemented and tested. You need Node.js 24 (see `.nvmrc`), pnpm,
and [uv](https://docs.astral.sh/uv/) for anything that touches Python — the runtime, the example, and the
eval and end-to-end gates.

Enable pnpm through Corepack instead of installing it globally:

```bash
git clone https://github.com/aid-framework/aid-framework.git
cd aid-framework
corepack enable
pnpm install --frozen-lockfile
```

Then, from the repository root:

| Command | What it does |
| --- | --- |
| `pnpm build` | Compile the TypeScript packages to `dist/` |
| `pnpm typecheck` | Type-check sources, tests, and the `scripts/` helpers |
| `pnpm test` | Run the unit, spec-validation, and release-gate tests |
| `pnpm test:coverage` | The same tests with the coverage thresholds enforced |
| `pnpm e2e` | Regenerate `examples/support-copilot`, assert the result is byte-identical to the committed snapshot, then boot it and answer a real request |
| `pnpm lint` | Biome, markdownlint, and config validation |
| `pnpm lint:actions` | actionlint over `.github/workflows` |
| `pnpm lint:licenses` | Dependency licence audit |
| `pnpm check` | `pnpm lint && pnpm typecheck && pnpm test` — the full local gate |
| `pnpm format` | Apply Biome formatting |

`pnpm check` is the gate CI runs, so run it before opening a pull request — but it is not the whole of CI.
The Python side has its own gates, and `pnpm e2e` needs the runtime and the example importable, so install
both once:

```bash
uv venv --python 3.11
uv pip install --python .venv -e "runtimes/python[dev]" -e "examples/support-copilot[dev]"
```

Then, from the directory each gate is scoped to (CI runs them as separate jobs):

```bash
# runtimes/python
cd runtimes/python
../../.venv/bin/pytest
../../.venv/bin/ruff check . && ../../.venv/bin/ruff format --check . && ../../.venv/bin/mypy

# examples/support-copilot
cd examples/support-copilot
../../.venv/bin/pytest

# the end-to-end check, from the repository root
AID_PYTHON=.venv/bin/python pnpm e2e
```

`pnpm e2e` needs `pnpm build` first: it drives the compiled CLI, exactly as a user would.

Golden-file tests assert that generation is **deterministic** — generating twice from the same spec must
produce byte-identical output — and the end-to-end check extends that from "twice" to "the committed
snapshot": it regenerates the example, compares the trees byte for byte, and then boots the regenerated app
and answers a real request, so generated code that merely looks plausible still fails the build
(`docs/design.md` §8.2, §12).

## Repository layout

See the table in [`README.md`](README.md). In short:

- `packages/spec` — spec DSL and JSON Schema (`docs/design.md` §6)
- `packages/ir` — the intermediate representation (`docs/design.md` §7)
- `packages/generator-sdk` — generator plugin interface (`docs/design.md` §8)
- `packages/generators/*` — one plugin per target stack
- `packages/cli` — the CLI (`docs/design.md` §11)
- `runtimes/*` — per-stack runtime libraries (`docs/design.md` §9)
- `examples/` — example specs and generated apps

## Pull request expectations

1. **Keep it focused.** One logical change per PR. Split refactors out from behavior changes.
2. **Sign off every commit** (`git commit -s`). See the DCO section above.
3. **Explain the change.** Describe what changed, why, and how you verified it. Link the issue it closes.
4. **Test at the right level.**
   - Codegen changes (spec, IR, generators) must keep **golden-file tests** passing and must remain
     **deterministic** — generating twice from the same input must produce byte-identical output
     (`docs/design.md` §8.2, §12).
   - Runtime or prompt changes that affect model behavior must include or update an **eval** with a
     threshold. "It looks better" is not a gate; a measured threshold is (`docs/design.md` §12).
5. **Never hand-edit generated code.** Files under `generated/` are generator-owned. Change the spec,
   generator, or runtime instead; use the eject path if you truly need to own an artifact
   (`docs/design.md` §10).
6. **Keep main green.** CI runs both regimes — golden files *and* evals — plus the end-to-end check that
   regenerates the example and boots it. Cost and latency gates are not wired up yet.
7. **Be patient and kind.** This is a young project; reviewers may ask design questions before merging code.

## Reporting bugs

Open a GitHub issue with a minimal reproduction (ideally a spec fragment), the expected vs. actual behavior,
and your environment. For sensitive issues, follow [`SECURITY.md`](SECURITY.md) instead of filing publicly.
