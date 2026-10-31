# `@aid-framework/generator-py-fastapi`

The Python target for [AID Framework](https://github.com/aid-framework/aid-framework). It compiles an IR into a
FastAPI service whose behaviour lives in [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/),
and whose prompts and tool handlers live in a `business/` tier the compiler never touches.

```text
app.spec.yaml ──aid gen──▶ app/generated/  (compiler)
                           app/business/   (you)
```

## Install

```sh
npm install --save-dev @aid-framework/generator-py-fastapi
```

Requires Node.js 24 or newer. In practice you pull it in through
[`@aid-framework/cli`](https://www.npmjs.com/package/@aid-framework/cli), which is also Node.

## Use it

Declare the target, then generate:

```yaml
project:
  name: support-copilot
  targets:
    - py-fastapi
```

```sh
npx aid gen
```

```text
py-fastapi: 16 created, 0 updated, 0 unchanged, 0 kept
```

With no `--target`, `aid gen` emits the first target the spec declares, so a Python-only project never has to name
its own target.

## What it emits

| Path | Contents |
| --- | --- |
| `app/generated/__init__.py` | Package marker |
| `app/generated/deps.py` | The FastAPI app object and dependency wiring |
| `app/generated/requests.py` | Request models per HTTP-served pipeline |
| `app/generated/schemas.py` | Pydantic models derived from the IR's `types` |
| `app/generated/gateway/models.py` | `ModelSpec` values and pinned aliases from the IR |
| `app/generated/observability.py` | Tracer setup |
| `app/generated/contracts/` | The protocol each business module must satisfy |
| `app/generated/pipelines/` | One module per pipeline: the step wiring, as ordinary async code |
| `app/generated/prompts/` | The registry the IR's prompts resolve into |
| `app/generated/tools/` | Tool definitions and dispatch |
| `app/generated/evals/` | The eval dataset and gate thresholds |
| `app/generated/routes/` | HTTP routes for pipelines with an `http` trigger |
| `app/business/`, `app/business/prompts/`, `app/business/tools/` | Your seam — created once, then never touched |

The exact file set follows the spec: a spec that declares no retrievers emits no retrieval modules, and a spec
with no HTTP trigger emits no routes.

### Serving it

The generator owns the routes; the application decides what to mount and how to run it. That entry point is
hand-written — `app/main.py`:

```python
from fastapi import FastAPI

from app.generated.routes.answer_ticket import answer_ticket_router

app = FastAPI(title="support-copilot", version="0.1.0")
app.include_router(answer_ticket_router)
```

```sh
pip install aid-runtime-python "fastapi>=0.115,<1" "uvicorn>=0.30,<1"
uvicorn app.main:app --reload
```

`deps.py` provides `build_deps()` and `get_deps()` — the process-wide container of the gateway, prompt registry
and tool executor. It does not create an ASGI app: mounting is yours, so a regeneration cannot take it away.

The generator never writes `main.py` or a `pyproject.toml`, because packaging and mounting are application
decisions rather than spec content.

## Capabilities

The manifest declares what this target can honour, and the IR's `capability` gate rejects a spec that needs
anything else:

```text
http-trigger, json-schema, streaming, tool-calling, otel,
embeddings, rerank, guardrails, agents, cursor-memory
```

It emits against **Pydantic** for structured output and **`otel-genai`** for tracing.

Declaring a capability is not a claim that every field in that section is expressible. A declaration this target
cannot honour is rejected at generation time with a diagnostic naming the field, rather than silently dropped.

## The `business/` seam

Everything in `generated/` is replaced on the next `aid gen`. `business/` is created only if it is missing and is
never written again — that is where prompts, tool handlers and domain logic belong.

`app/generated/contracts/` is the contract between the two: it declares what each business module must provide, so
a missing or misnamed handler is a type error in your editor instead of an exception in production.

## Determinism

Given the same IR, this generator produces byte-identical output — no timestamps, no absolute paths, no host
names. That is what makes `generated/` diffable and golden-file tests meaningful, and it is enforced by the
generator's own tests rather than by convention.

## Programmatic use

```ts
import { PACKAGE, TARGET, manifest, plan } from '@aid-framework/generator-py-fastapi';
import type { Generator } from '@aid-framework/generator-sdk';
```

The generator satisfies the `Generator` contract from
[`@aid-framework/generator-sdk`](https://www.npmjs.com/package/@aid-framework/generator-sdk): `plan(ir)` is pure
and `emit(plan)` returns the file set, with all regeneration safety supplied by the SDK.

## Related packages

- [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/) — the runtime the emitted code imports
- [`@aid-framework/runtime`](https://www.npmjs.com/package/@aid-framework/runtime) — the TypeScript runtime
- [`@aid-framework/generator-ts-vercel`](https://www.npmjs.com/package/@aid-framework/generator-ts-vercel) — the
  TypeScript target
- [`@aid-framework/cli`](https://www.npmjs.com/package/@aid-framework/cli) — `aid`

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
