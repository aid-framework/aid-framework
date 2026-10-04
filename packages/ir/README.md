# `@aid/ir` — the intermediate representation

The IR is **the crown jewel**: one stack-independent, normalized, versioned representation that every
generator consumes. Generators never read the spec directly.

**Responsibility**

- Define the IR shapes (types, models, prompts, tools, retrievers, embeddings, stores, memory, agents,
  pipelines, evals, guardrails, deployments, observability, runtime) — [`docs/design.md` §7.2](../../docs/design.md).
- Build the IR from a validated spec: resolve references, materialize defaults, expand enums, canonicalize
  naming, and assign stable IDs so regeneration is deterministic.
- Run build-time gates **before** codegen: referential integrity, normalization, capability negotiation,
  cost/latency sanity, security gates (fail-closed), and eval coverage (fail/warn loudly)
  — [`docs/design.md` §7.4](../../docs/design.md).
- Serialize the IR to JSON with an `irVersion`, and enforce the declared `irRange` for consumers.

**Design constraints:** closed-world and fully resolved (no unresolved refs at codegen time); explicit over
implied; capability-driven; versioned and serializable; a trait channel for stack specifics without polluting
core semantics.

**Status:** not implemented. Planned for Phase 0 (IR v0.x with validation and capability negotiation).

Reference: [`docs/design.md` §7](../../docs/design.md).
