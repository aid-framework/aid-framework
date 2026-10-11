# `packages/generators/` — generator plugins

One generator plugin per target stack. Each consumes **only the IR** and emits small, declarative glue that
imports the matching runtime library. Generators do not implement behavior; the runtime does
([`docs/design.md` §4](../../docs/design.md), principle 1: *thin generated, fat runtime*).

**Currently Python only.** [`py-fastapi/`](py-fastapi/) is implemented for the Phase 0 scope, paired with the
[`../../runtimes/python/`](../../runtimes/python/) runtime. Further target plugins land later
([`docs/design.md` §14](../../docs/design.md)).

| Plugin | Emits against | Phase | Status |
| --- | --- | --- | --- |
| [`py-fastapi/`](py-fastapi/) | Pydantic AI (structured output) + OTel GenAI; plain-async control flow | Phase 0 | Implemented |

Planned but **not yet scaffolded**: `ts-vercel` (Vercel AI SDK + zod), `dotnet-semantickernel`
(Semantic Kernel), and `java-spring-ai` (Spring AI).

Every plugin implements the contract in [`../generator-sdk/`](../generator-sdk/) and must satisfy:

- **Golden-file tests** — fixture spec → expected file tree; any diff is reviewable.
- **Determinism** — generating twice from the same IR produces byte-identical output.
- **Capability negotiation** — fail loudly *before* codegen when the target cannot express a required feature
  rather than emitting broken code.

**Status:** `py-fastapi` is implemented and tested; the other targets are planned but not scaffolded.

Reference: [`docs/design.md` §5](../../docs/design.md) (architecture), [`§8`](../../docs/design.md),
[`§12`](../../docs/design.md), [`§14`](../../docs/design.md).
