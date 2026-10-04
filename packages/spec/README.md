# `@aid/spec` — the declarative spec

Owns the developer-facing DSL: the YAML spec format, its JSON Schema (for editor autocomplete and validation),
the parser, and the validator that runs before anything reaches the IR.

**Responsibility**

- Define the spec surface: `models`, `prompts`, `tools`, `retrievers`, `agents`, `pipelines`, `evals`,
  `guardrails`, `memory`, `deployments` (`docs/design.md` §6).
- Ship a JSON Schema so editors can validate and autocomplete specs.
- Parse YAML into a typed, position-aware document; report errors with file/line context.
- Validate the spec's own rules (referential integrity, required fields, version compatibility).

**Not responsible for:** cross-node semantic validation such as capability negotiation, cost sanity, or
security gates — those are build-time gates in the IR (`docs/design.md` §7.4).

**Status:** not implemented. Planned for Phase 0 (spec v0.1: models, prompts, tools, one pipeline + JSON
Schema).

Reference: [`docs/design.md` §6](../../docs/design.md), [`§13`](../../docs/design.md) versioning.
