# `packages/`

The framework's own source packages: the spec language, the IR, the generator plugin SDK, the generator
plugins, and the CLI. These are the pieces that turn a declarative spec into generated applications.

Every package here is published to npm under the `@aid-framework` scope.

| Package | Responsibility | npm |
| --------- | ---------------- | --- |
| [`spec/`](spec/) | Declarative spec language: JSON Schema, position-aware parser, structural validator. | [`@aid-framework/spec`](https://www.npmjs.com/package/@aid-framework/spec) |
| [`ir/`](ir/) | Stack-independent IR: builder, canonical serializer, capability derivation, and the sixteen build-time gates. | [`@aid-framework/ir`](https://www.npmjs.com/package/@aid-framework/ir) |
| [`generator-sdk/`](generator-sdk/) | Generator plugin contract: manifest, ownership, drift algorithm, determinism rules. | [`@aid-framework/generator-sdk`](https://www.npmjs.com/package/@aid-framework/generator-sdk) |
| [`generators/`](generators/) | One plugin per target stack: `py-fastapi` and `ts-vercel`. | see [`generators/`](generators/) |
| [`cli/`](cli/) | The `aid` command that drives the whole loop. | [`@aid-framework/cli`](https://www.npmjs.com/package/@aid-framework/cli) |

Layering is one-directional and enforced: `spec ← ir ← generator-sdk ← generators ← cli`. A package never
imports one above it.

Runtime libraries live outside `packages/`, under [`../runtimes/`](../runtimes/), because they are shipped to
users' applications rather than used by the framework itself. Example specs live under
[`../examples/`](../examples/).

For the design rationale, see [`docs/design.md`](../docs/design.md).
