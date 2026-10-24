# `@aid/runtime` (TypeScript)

The TypeScript runtime for the AID framework. It mirrors the Python runtime in
`runtimes/python/aid_runtime` module for module, so an application generated for
either language meets the same gateway semantics, the same pinned-model rules, the
same eval-gate arithmetic and the same retrieval surface.

## What is in the package

| Area | Module | Notes |
| --- | --- | --- |
| Types | `types` | `Message`, `ModelSpec`, `PinnedModel`, `TokenUsage`, requests and responses |
| Errors | `errors` | One `AidRuntimeError` base so an application catches framework refusals in one place |
| Cost | `cost` | `Budget`, `CostLedger`, spend summaries |
| Tracing | `tracing` | OpenTelemetry GenAI semantic-convention span attributes |
| Prompts | `prompts` | Versioned registry with ordered version resolution |
| Tools | `tools` | Schema-validated dispatch with a documented JSON-schema subset |
| Pipelines | `pipeline` | Sequential reducer over an immutable context |
| Structured output | `structured` | Parse and repair loop over zod schemas |
| Gateway | `gateway` | Pinned aliases, capability checks, fallback chains, budget enforcement |
| Providers | `providers/*` | Deterministic fake and OpenAI-compatible HTTP adapter |
| Evals | `evals/*` | Datasets, metrics, N-run sampling and the statistical gate |
| Retrieval | `retrieval/*` | Chunkers, embedders, stores, hybrid search, reranking, citations, gate |

## Deliberate parity notes

The eval gate reproduces the Python runtime's arithmetic exactly: the same
z-critical table, the same baseline comparison and the same N-run sampling
semantics. A gate whose statistics differed per language would let a TypeScript
regression pass a Python baseline.

Two things are intentionally not byte-identical, and both are documented at the
point of difference:

- `providers/fake.ts` derives its accuracy draw from a SHA-256 hash of
  `seed:index:prompt` rather than CPython's Mersenne Twister, because the Mersenne
  Twister's string seeding is a CPython implementation detail with no portable
  equivalent. The draw is still deterministic and still varies per call index,
  which is the property the gate depends on.
- `tools.ts` takes an explicit JSON-Schema subset instead of inferring a schema
  from handler reflection, because JavaScript has no `inspect.signature`.

## Determinism

`FakeDeterministicEmbedder` hashes with SHAKE-128 and `chunkIdFor` hashes with
SHA-256, so re-ingesting a corpus reproduces byte-identical ids and vectors.

## Build

```sh
corepack pnpm install
corepack pnpm build
```
