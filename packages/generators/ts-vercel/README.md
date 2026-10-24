# `ts-vercel` generator

The **Phase 1 second target**: turns the IR into a Next.js App Router service wired to the
[`@aid/runtime`](../../../runtimes/typescript/) runtime. Generated code is declarative glue — zod schemas, model
aliases, prompt templates, route handlers, tool adapters, retrieval bindings, eval definitions — and every
behaviour it calls already exists in the runtime ([`docs/design.md` §4](../../../docs/design.md), principle 1:
*thin generated, fat runtime*).

The only input is the IR. `plan` is a pure function of it: nothing here reads a spec file, a template
directory, the environment or the clock, so the same IR always produces the same bytes.

**Emits against** ([`§8.1`](../../../docs/design.md)):

| Key | Value | Why |
| --- | --- | --- |
| `structuredOutput` | `zod` | Response models are zod schemas, so a structured-output call is validated by the runtime's gateway |
| `tracing` | `otel-genai` | Spans follow the OTel GenAI semantic conventions |
| `orchestration` | *absent* | Control flow is **plain async**. Orchestration frameworks are deferred to Phase 2 ([`§14`](../../../docs/design.md)), and declaring nothing is what keeps the choice swappable |

## Deviation: no `emitsAgainst.vectorStore`

The frozen plan's L6 row asks for
`emitsAgainst = { structuredOutput: 'zod', tracing: 'otel-genai', vectorStore: 'pgvector' }`. **The third key is
not expressible, and this package does not declare it.** `EmitsAgainst` in
[`packages/generator-sdk/src/manifest.ts:56`](../../generator-sdk/src/manifest.ts) has exactly three members —
`orchestration?`, `structuredOutput?`, `tracing?` — and adding a fourth is an SDK change, which is outside this
layer.

The plan cites [`manifest.test.ts:135`](../../generator-sdk/test/manifest.test.ts) as evidence that
`emitsAgainst.vectorStore` is supported. That line is inside the test *"rejects an unknown emitsAgainst key and
an out-of-vocabulary value"*, and it asserts `manifestUnknownKey` **for** `{ vectorStore: 'pgvector' }`: the plan
cited the counter-example as if it were the example.

`pgvector` is nevertheless honoured — as the IR's store kind
([`packages/ir/src/shapes.ts:397-400`](../../ir/src/shapes.ts)), not as an `emitsAgainst` key. `validate.ts`
accepts `memory` and `pgvector` stores and refuses any other kind, and the emitted `retrieval/bindings.ts` passes
the kind through to the runtime, whose `PgVectorStore` adapter loads its driver lazily. So the **substance** of
the plan's declaration is present; the declared shape is the SDK's. This is the same fail-closed resolution
`py-fastapi` reached, and for the same reason: a manifest that does not parse is not a target.

A test pins the key set to an exact literal — `Object.keys(manifest.emitsAgainst).sort()` equals
`['structuredOutput', 'tracing']` — the same non-vacuous shape
[`py-fastapi/test/target.test.ts:137`](../py-fastapi/test/target.test.ts) uses, so adding or dropping a key fails
rather than silently passing.

## Capabilities: 6 declared, `streaming` not

| Declared | Honoured by |
| --- | --- |
| `http-trigger` | `routes/<pipeline>.ts`, a Fetch-shaped handler Next serves |
| `json-schema` | `schemas.ts`, zod schemas the runtime validates structured output with |
| `tool-calling` | `tools/**` and `contracts/**`, adapters over handlers you own |
| `otel` | `observability.ts`, the runtime tracer |
| `embeddings` | `retrieval/bindings.ts`, `retrieval/index.ts`, `retrieval/ingest/**` |
| `rerank` | the retriever binding's `rerank` spec, resolved by the runtime's `rerankerFor` |

`streaming` is **not** declared. `ModelGateway.stream` raises `FeatureDeferredError`, so declaring the capability
would be the fail-open the capability discipline forbids: a target must not advertise what it cannot emit.

**Emits** (24 files per generated app — [`§8.3`](../../../docs/design.md)):

- **Model gateway wiring** — `gateway/models.ts` and `gateway/index.ts`: one alias per declared model, with
  provider, model id and cost profile, validated against the runtime's adapter registry.
- **Prompt registry wiring** — `prompts/<prompt>.ts` and `prompts/index.ts`: the template, its version, and the
  typed values it interpolates.
- **One structured-output endpoint** — `requests.ts`, `schemas.ts`, `routes/<pipeline>.ts` and
  `pipelines/<pipeline>.ts`: the request shape, the response schema, the route handler, and the plain-async
  pipeline that renders the prompt, calls the gateway, runs the tool and shapes the response.
- **One tool** — `tools/<tool>.ts` plus `contracts/<tool>.ts`, and their two indexes: a zod-validated adapter
  over a handler you own. The handler itself is seeded once and then yours.
- **Retrieval** — `retrieval/bindings.ts`, `retrieval/index.ts` and `retrieval/ingest/**`: the embedding, store
  and retriever declarations, the `buildRetrievers` factory that resolves and validates the binding at startup,
  and one idempotent ingest entry point per retriever.
- **Evals** — `evals/<eval>.ts` and `evals/index.ts`: the dataset loader, the stored baseline, the metric list and
  the gate, delegating every statistic to `@aid/runtime`.
- **`observability.ts`** and **`deps.ts`** — tracer setup and the dependency container that the route and the eval
  both build from, so the eval measures the prompt the app actually renders.

Packaging, the Next `app/api/**` shim and the tests are **not** generated: `package.json`, `app/api/<path>/route.ts`
and `tests/**` are hand-written in the example, because a plan may only write into the two managed tiers below.

## Layout and ownership ([`§8.4`](../../../docs/design.md))

| Path | Owner | On regeneration |
| --- | --- | --- |
| `app/generated/**` | the generator | overwritten, never merged |
| `app/business/**` | you | created once if missing, then **never** touched |
| `app/aid.manifest.json` | the generator | rewritten from the plan; not a planned artifact itself |

A generated file whose bytes no longer match the hash recorded in the manifest is **drift**: regeneration reports
it as an error, leaves your edit in place, and writes the content it wanted beside it as `<path>.aid-rej`.
`--force` discards the edit instead (with a warning), and `--prune` deletes generated files the plan no longer
produces ([`§10`](../../../docs/design.md)).

## Accepted collision: `output.root: 'app'`

Decision A7 puts `generated/` and `business/` under `output.root: 'app'` for parity with the Python target, and
that root is also Next.js's own App Router directory. The plan names the collision, accepts it for parity with
the SDK's `managedRoots`, and flags it for review; **this package accepts it too rather than working around it.**
The consequences, stated plainly:

- `app/generated/**` and `app/business/**` sit beside your own routes, layouts and pages, in the directory the
  framework already owns. Nothing is lost, because the two managed tiers are disjoint from Next's file
  conventions (`route.ts`, `layout.tsx`, `page.tsx`), but it is a naming collision a reader must know about.
- A future `output.root` of `.` would remove it at the cost of parity; that is a plan decision, not this layer's.

## Deviation: the `app/api/**` shim is hand-written

A7 also asks the generator to emit "a thin emitted `app/api/<path>/route.ts` shim that Next actually serves".
**This package does not emit it**, for two independent mechanical reasons, either of which is sufficient:

1. **The plan validator refuses the path.** `validatePlan` accepts writes only under the manifest's managed roots
   (`app/generated`, `app/business`); `app/api/tickets/route.ts` is rejected with `generator/plan-owner-mismatch`.
   A test asserts exactly that rejection.
2. **The manifest's owner cross-check would break every later run.** `parseAidManifest` treats the first path
   segment as the owner, so a recorded `app/api/...` entry does not match the generator's root and the next
   `aid gen` fails to parse the manifest it wrote itself — a hard CLI break, not a cosmetic mismatch.

So the generator emits the real handler at `app/generated/routes/<pipeline>.ts`, which exports both
`handle<Pipeline>` and a `ROUTE` constant (`{ method, path }`), and the example hand-writes the three-line Next
shim at `app/api/tickets/answer/route.ts`. This mirrors `py-fastapi`, where `app/main.py` is likewise hand-written
because a plan may not write outside its tiers: the framework's mount point is yours, the handler is generated.

## No `next` dependency

Next is the **deployment target**, not a dependency of this repository. `next` pulls `caniuse-lite`, which is
CC-BY-4.0, and [`scripts/check-licenses.mjs`](../../../scripts/check-licenses.mjs) allows only
0BSD/Apache-2.0/BlueOak/BSD/CC0-1.0/ISC/MIT/MIT-0/MPL-2.0/Python-2.0/PSF-2.0/Unlicense/WTFPL. Adding Next would
mean weakening the license allowlist, which this layer does not do. The example therefore ships
`tests/server.ts`, a Node host that speaks the same Fetch-shaped contract as the emitted handler and looks up the
same `ROUTE` constant, so the end-to-end job can boot generated code and hit a real socket without a Next install.

**Determinism** ([`§8.2`](../../../docs/design.md)): output is path-sorted, LF-only, with one trailing newline, no
timestamps, no absolute paths and no machine names. `checkDeterminism` in the generator SDK is the lint that holds
this; a test in this package plans the example twice and compares bytes.

**Prompt templates** are the one place the two runtimes disagree about syntax: the IR stores `{{ name }}` mustaches
and the TypeScript runtime parses `str.format`-style `{name}` fields. `src/placeholders.ts` performs that
conversion once, `validate.ts` refuses a template the runtime cannot interpolate, and the emitter never re-indents
template content.

**Not responsible for:** runtime behaviour — the gateway, prompt registry, tool executor, tracing, retrieval, the
eval harness and the baseline statistics all live in [`runtimes/typescript/`](../../../runtimes/typescript/).

**Status:** implemented for the Phase 1 scope and reachable as `aid gen --target ts-vercel` through the two-entry
registry in [`packages/cli/src/targets.ts`](../../cli/src/targets.ts). `py-fastapi` remains the default target.

**Scope boundary:** the generator rejects what it cannot express rather than emitting something broken
([`§4`](../../../docs/design.md), capability negotiation) — `cursor-memory`, guardrails, multi-step agent loops,
streaming bodies, `llm-judge` as a required CI gate, latency and cost budgets, eval metrics selected by field or
value, non-`http` triggers, retriever `filters` and non-file sources. Each refusal has a plan diagnostic code.

**Tests:** `test/golden.test.ts` (the example's committed tree *is* the golden fixture), `test/drift.test.ts`
(regeneration safety across both tiers), `test/target.test.ts` (manifest, capability discipline, IR-only purity,
layout) and [`packages/cli/test/targets.test.ts`](../../cli/test/targets.test.ts) (the registry cross-check). The
example app is in [`examples/support-copilot-ts/`](../../../examples/support-copilot-ts/), and the end-to-end job
runs `pnpm e2e:ts` after the Python example's `pnpm e2e` in the same `e2e` job.

Reference: [`docs/design.md` §8](../../../docs/design.md) (generator plugin model),
[`§9`](../../../docs/design.md) (runtime libraries), [`§6.1`](../../../docs/design.md) (example spec),
[`§12`](../../../docs/design.md) (testing), [`§14`](../../../docs/design.md) (roadmap).
