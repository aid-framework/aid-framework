# `packages/`

The framework's own source packages: the spec DSL, the IR, the generator plugin SDK, the generator plugins,
and the CLI. These are the pieces that turn a declarative spec into generated applications.

> **Status:** skeleton only. No package here is implemented yet — see the Phase 0 scope in
> [`docs/design.md` §14](../docs/design.md). [`docs/design.md`](../docs/design.md) is authoritative.

| Package | Responsibility | Design ref |
| --------- | ---------------- | ------------ |
| [`spec/`](spec/) | Declarative spec DSL, JSON Schema, parser, and validator. | §6 |
| [`ir/`](ir/) | Stack-independent IR: types, builder, normalization, validation. | §7 |
| [`generator-sdk/`](generator-sdk/) | Generator plugin interface, plan/emit contract, determinism rules. | §8 |
| [`generators/`](generators/) | One plugin per target stack (currently `py-fastapi`). | §5, §8 |
| [`cli/`](cli/) | The command-line interface that drives the whole loop. | §11 |

Runtime libraries live outside `packages/`, under [`../runtimes/`](../runtimes/), because they are shipped to
users' applications rather than used by the framework itself. Example specs live under
[`../examples/`](../examples/).
