# `@aid/generator-sdk` — generator plugin interface

Defines what a generator plugin *is*, so third-party and first-party targets are built the same way.

**Responsibility**

- Define the `Generator` contract: `name`, `target`, `version`, `irRange`, `capabilities`, `emitsAgainst`,
  `output`, `plan()`, `emit()`, and an optional `optionsSchema` — [`docs/design.md` §8.1](../../docs/design.md).
- Enforce the two-phase model: `plan(ir) -> Plan` is pure and writes nothing; `emit(plan) -> GeneratedFile[]`
  performs the write. This is what makes `--dry-run`, drift detection, and deterministic testing possible.
- Enforce the **determinism contract**: no timestamps, host names, or random IDs; stable ordering by stable
  ID; formatter-normalized output ([`docs/design.md` §8.2](../../docs/design.md)).
- Define the manifest format (`path`, `owner`, `sha256`, `generator`, `generatorVersion`) and the helpers
  generators use to record it ([`docs/design.md` §10](../../docs/design.md)).

**Not responsible for:** emitting any specific target's code (see [`../generators/`](../generators/)) or for
the behavior of generated apps (see [`../../runtimes/`](../../runtimes/)).

**Status:** not implemented. Interface shapes are drafted in the design doc; implementation is Phase 0.

Reference: [`docs/design.md` §8](../../docs/design.md).
