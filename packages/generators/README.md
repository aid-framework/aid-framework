# `packages/generators/` — generator plugins

One generator plugin per target stack. Each consumes **only the IR** and emits small, declarative glue that
imports the matching runtime library. Generators do not implement behavior; the runtime does — *thin generated,
fat runtime*.

| Plugin | Emits | Runtime | npm |
| --- | --- | --- | --- |
| [`py-fastapi/`](py-fastapi/) | FastAPI + Pydantic; OTel GenAI; plain-async control flow | [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/) | [`@aid-framework/generator-py-fastapi`](https://www.npmjs.com/package/@aid-framework/generator-py-fastapi) |
| [`ts-vercel/`](ts-vercel/) | Next.js / Vercel functions + zod; OTel GenAI; plain-async control flow | [`@aid-framework/runtime`](https://www.npmjs.com/package/@aid-framework/runtime) | [`@aid-framework/generator-ts-vercel`](https://www.npmjs.com/package/@aid-framework/generator-ts-vercel) |

Both are implemented and published at the same version as the rest of the framework. A spec declares the targets
it is for, and `aid gen --target <name>` selects among the declared ones.

Every plugin implements the contract in [`../generator-sdk/`](../generator-sdk/) and must satisfy:

- **Golden-file tests** — fixture spec → expected file tree; any diff is reviewable.
- **Determinism** — generating twice from the same IR produces byte-identical output.
- **Capability negotiation** — fail loudly *before* codegen when the target cannot express a required feature,
  rather than emitting broken code. `ts-vercel`, for example, does not declare `streaming`, so a streaming
  deployment is rejected at build time.

A new target means a new directory here plus a manifest; the SDK supplies ownership, drift detection and
manifest writing, so a plugin contains no regeneration logic of its own.

For the design rationale, see [`docs/design.md`](../../docs/design.md).
