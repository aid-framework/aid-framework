# CLI

The command-line interface that drives the whole loop: scaffold, generate, run, ingest, evaluate, trace, and
eject.

**Responsibility**

- Implement the commands in [`docs/design.md` §11](../../docs/design.md): `init`, `gen`, `dev`, `ingest`,
  `eval`, `trace`, `cost`, `guard`, `migrate`, `eject`, `doctor`.
- Orchestrate `spec → IR → generator plugins`, and surface validation and capability errors with actionable
  file/line context.
- Provide `--dry-run` (via the generator SDK's pure `plan()` phase) and `--force`, plus `--json` on every
  command and CI-friendly exit codes.

The CLI owns **no** AI behavior of its own; it is a thin driver over [`../spec/`](../spec/),
[`../ir/`](../ir/), and [`../generators/`](../generators/).

> **Naming:** the command is **`aid`** — `aid init`, `aid gen`, `aid eval`, and so on. The command surface is
> specified in [`docs/design.md` §11](../../docs/design.md); the framework name and architecture are in
> [`§5`](../../docs/design.md).

**Status:** not implemented. Phase 0 covers `init`, `gen --dry-run`, and `validate`.

Reference: [`docs/design.md` §11](../../docs/design.md).
