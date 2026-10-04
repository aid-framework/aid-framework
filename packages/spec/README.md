# `@aid/spec` — the declarative spec

Owns the developer-facing DSL: the YAML spec format, its JSON Schema (for editor autocomplete and validation),
the parser, and the validator that runs before anything reaches the IR.

**Responsibility**

- Define the spec surface: `specVersion`, `project`, `types`, `models`, `prompts`, `tools`, `evals`,
  `pipelines` in spec v0.1; `retrievers`, `agents`, `guardrails`, `memory`, `deployments` in later phases
  (`docs/design.md` §6).
- Ship a JSON Schema so editors can validate and autocomplete specs.
- Parse YAML into a typed, position-aware document; report errors with file/line context.
- Validate the spec's own rules (referential integrity, required fields, version compatibility).

**Not responsible for:** cross-node semantic validation such as capability negotiation, cost sanity, or
security gates — those are build-time gates in the IR (`docs/design.md` §7.4).

**Status:** implemented for spec v0.1 (`specVersion`, `project`, `types`, `models`, `prompts`, `tools`,
`evals`, `pipelines`). Agents, retrievers, guardrails, memory, and deployments are defined by the design
doc but are not part of this version: using one produces an explicit `spec/not-supported` error naming the
phase it belongs to, rather than a generic schema failure.

Pipeline steps are limited to `generate`, `tool`, and `emit`. `tool` steps are invoked explicitly by the
pipeline, not selected by the model — that is what keeps Phase 0 on plain async control flow while still
exercising the tool, business-logic, auth, and tracing seams.

**Diagnostics are part of the contract.** Every code in `src/diagnostics.ts` is asserted in tests and
printed by `aid validate`; rename one and it is a breaking change. `spec/not-supported` (defined by the
design, deferred) and `spec/unknown-key` (defined by nothing, almost always a typo) are deliberately
distinct so the message never lies about which mistake it is.

**Local rules only.** This package reports the position of a problem and nothing else: it performs no
referential integrity, capability negotiation, cost sanity, or security checks, because those need to see
the whole program and therefore belong to the IR build gates.

```ts
import { checkSpecText, formatDiagnostics } from '@aid/spec';

const { ok, diagnostics } = checkSpecText(source, { file: 'aid.spec.yaml' });
if (!ok) process.stderr.write(formatDiagnostics(diagnostics));
```

Reference: [`docs/design.md` §6](../../docs/design.md), [`§7.4`](../../docs/design.md) for the gates this
package explicitly does not implement, [`§13`](../../docs/design.md) versioning.
