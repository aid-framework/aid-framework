# `packages/generators/` — generator plugins

One generator plugin per target stack. Each consumes **only the IR** and emits small, declarative glue that
imports the matching runtime library. Generators do not implement behavior; the runtime does
([`docs/design.md` §4](../../docs/design.md), principle 1: *thin generated, fat runtime*).

**Currently Python only.** Repository bootstrap scaffolds the `py-fastapi` target, paired with the
[`../../runtimes/python/`](../../runtimes/python/) runtime. Further target plugins land later
([`docs/design.md` §14](../../docs/design.md)).

| Plugin | Emits against | Phase | Status |
| --- | --- | --- | --- |
| [`py-fastapi/`](py-fastapi/) | Pydantic AI (+ LangGraph or plain async) | Phase 0 | Not implemented |

Planned but **not yet scaffolded**: `ts-vercel` (Vercel AI SDK + zod), `dotnet-semantickernel`
(Semantic Kernel), and `java-spring-ai` (Spring AI).

Every plugin implements the contract in [`../generator-sdk/`](../generator-sdk/) and must satisfy:

- **Golden-file tests** — fixture spec → expected file tree; any diff is reviewable.
- **Determinism** — generating twice from the same IR produces byte-identical output.
- **Capability negotiation** — fail loudly *before* codegen when the target cannot express a required feature
  rather than emitting broken code.

**Status:** the plugins are directory placeholders. Adding real generator code is a Phase 0 follow-up, not
part of repository bootstrap.

Reference: [`docs/design.md` §5](../../docs/design.md) (architecture), [`§8`](../../docs/design.md),
[`§12`](../../docs/design.md), [`§14`](../../docs/design.md).
