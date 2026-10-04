# Contributing to AID Framework

Thanks for your interest in AID Framework! This project is at an early, pre-alpha stage, so the highest-value
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

```
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

> **TODO (Phase 0): there is nothing to install or build yet.** The toolchains are not wired up and no
> package in this repository is buildable today. This section is a placeholder that will be filled in as
> `packages/` and `runtimes/` become real.

The toolchains we expect to require are:

| Stack | Toolchain (planned) |
|-------|---------------------|
| Spec / IR / CLI / generator SDK | Node.js 20+ with TypeScript and pnpm |
| Python runtime & `py-fastapi` target | Python 3.11+ with `uv` |

```bash
# TODO(phase-0): every command below except clone is a placeholder.
# The repository has no build, lint, or test task yet.
git clone https://github.com/aid-framework/aid-framework.git
cd aid-framework
# TODO(phase-0): pnpm install
# TODO(phase-0): uv sync
# TODO(phase-0): <build> / <lint> / <test>
```

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
6. **Keep main green.** CI runs both regimes — golden files *and* evals, plus cost and latency gates.
7. **Be patient and kind.** This is a young project; reviewers may ask design questions before merging code.

## Reporting bugs

Open a GitHub issue with a minimal reproduction (ideally a spec fragment), the expected vs. actual behavior,
and your environment. For sensitive issues, follow [`SECURITY.md`](SECURITY.md) instead of filing publicly.
