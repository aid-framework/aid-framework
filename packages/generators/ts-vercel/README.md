# `@aid-framework/generator-ts-vercel`

The TypeScript / Vercel target for [AID Framework](https://github.com/aid-framework/aid-framework). It compiles an
IR into a Next.js app whose behaviour lives in [`@aid-framework/runtime`](https://www.npmjs.com/package/@aid-framework/runtime),
with a `business/` tier the compiler creates once and never touches again.

```text
app.spec.yaml ──aid gen --target ts-vercel──▶ app/generated/  (compiler)
                                              app/business/   (you)
```

## Install

```sh
npm install --save-dev @aid-framework/generator-ts-vercel
```

Requires Node.js 24 or newer. In practice you pull it in through
[`@aid-framework/cli`](https://www.npmjs.com/package/@aid-framework/cli).

## Use it

A spec generates one target at a time, so a project that ships both stacks declares both:

```yaml
project:
  name: support-copilot
  targets:
    - py-fastapi
    - ts-vercel
```

```sh
npx aid gen --target ts-vercel
```

```text
ts-vercel: 20 created, 0 updated, 0 unchanged, 0 kept
```

`--target` selects among the targets the spec declares. Naming an undeclared one fails with `target-unsupported`
and lists what is declared, because generating a stack the spec never asked for would make the spec a lie.

## What it emits

| Path | Contents |
| --- | --- |
| `app/generated/index.ts` | The package's public surface |
| `app/generated/deps.ts` | Wiring: gateway, registry, executor, pipelines |
| `app/generated/control.ts` | The composite-step helpers the pipelines use |
| `app/generated/schemas.ts` | zod schemas derived from the IR's `types` |
| `app/generated/gateway/models.ts` | `ModelSpec` values and pinned aliases from the IR |
| `app/generated/observability.ts` | Tracer setup |
| `app/generated/guardrails.ts` | The guardrail policies the IR declares |
| `app/generated/contracts/` | The interface each business module must satisfy |
| `app/generated/pipelines/` | One module per pipeline, as ordinary async code |
| `app/generated/prompts/` | The registry the IR's prompts resolve into |
| `app/generated/tools/` | Tool definitions and dispatch |
| `app/generated/evals/` | The eval dataset and gate thresholds |
| `app/generated/retrieval/` | Retriever bindings, plus `ingest/` for corpus indexing |
| `app/generated/routes/` | Request handlers for pipelines with an `http` trigger |
| `app/business/`, `app/business/prompts/`, `app/business/tools/` | Your seam — created once, then never touched |

The exact file set follows the spec: a spec that declares no retrievers emits no `retrieval/` modules.

### A note on `app/`

The output root is `app/`, which is also Next.js's own directory convention. That collision is deliberate and
accepted for parity with the other target's layout: the generated tree sits at the project's `app/`, alongside
whatever Next puts there. If you already have a Next project at that root, generate into a fresh directory rather
than merging the two.

## Capabilities

```text
http-trigger, json-schema, tool-calling, otel,
embeddings, rerank, guardrails, agents, cursor-memory
```

It emits against **zod** for structured output and **`otel-genai`** for tracing.

Note the absence of `streaming`: this target does not declare it, so the IR's `deploy/streaming` gate rejects a
spec that asks for a streaming deployment here rather than emitting an endpoint that cannot stream.

## The `business/` seam

Everything in `generated/` is replaced on the next `aid gen`. `business/` is created only if missing and is never
written again — that is where prompts, tool handlers and domain logic belong.

`app/generated/contracts/` carries the interfaces the business modules implement, so a missing or misnamed export
is a type error at build time instead of a runtime surprise.

## Determinism

Given the same IR, this generator produces byte-identical output — no timestamps, no absolute paths, no host
names, and import order derived from stable ids rather than from filesystem walk order. That makes `generated/`
diffable and keeps a regeneration from producing a diff it did not mean.

## Programmatic use

```ts
import { manifest, plan } from '@aid-framework/generator-ts-vercel';
import type { Generator } from '@aid-framework/generator-sdk';
```

The generator satisfies the `Generator` contract from
[`@aid-framework/generator-sdk`](https://www.npmjs.com/package/@aid-framework/generator-sdk): `plan(ir)` is pure
and `emit(plan)` returns the file set. Ownership, drift detection and manifest writing are the SDK's, so this
package contains no regeneration logic of its own.

## Related packages

- [`@aid-framework/runtime`](https://www.npmjs.com/package/@aid-framework/runtime) — the runtime the emitted code
  imports
- [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/) — the Python runtime
- [`@aid-framework/generator-py-fastapi`](https://www.npmjs.com/package/@aid-framework/generator-py-fastapi) — the
  Python target
- [`@aid-framework/cli`](https://www.npmjs.com/package/@aid-framework/cli) — `aid`

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
