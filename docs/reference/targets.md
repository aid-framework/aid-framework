---
description: "The generator targets and their capability matrix, read from each generator manifest and checked against the IR capability gate."
---

# Targets

A target is a generator plugin. A spec declares the targets it is for; `aid gen` emits one target at a time. Each row below is read from the generator's own manifest, which a test checks against the declaration the IR capability gate consumes.

## Capability matrix

A declared capability is a promise: there is an emitter for it, the target's runtime implements it, and a committed example exercises it. A capability that is absent is one the generator rejects at plan time rather than silently drops.

| Capability | `py-fastapi` | `ts-vercel` |
| --- | --- | --- |
| `agents` | yes | yes |
| `cursor-memory` | yes | yes |
| `embeddings` | yes | yes |
| `guardrails` | yes | yes |
| `http-trigger` | yes | yes |
| `json-schema` | yes | yes |
| `otel` | yes | yes |
| `rerank` | yes | yes |
| `streaming` | yes | no |
| `tool-calling` | yes | yes |

## Manifests

### `py-fastapi`

| Field | Value |
| --- | --- |
| Package | `@aid-framework/generator-py-fastapi` |
| Manifest version | `0.1.0` |
| IR range | `^0.1.0` |
| Capabilities | `http-trigger`, `json-schema`, `streaming`, `tool-calling`, `otel`, `embeddings`, `rerank`, `guardrails`, `agents`, `cursor-memory` |
| Emits against | `structuredOutput`: `pydantic`; `tracing`: `otel-genai` |
| Output root | `app` |
| Generated directory | `app/generated` |
| Business directory | `app/business` |

### `ts-vercel`

| Field | Value |
| --- | --- |
| Package | `@aid-framework/generator-ts-vercel` |
| Manifest version | `0.1.0` |
| IR range | `^0.1.0` |
| Capabilities | `http-trigger`, `json-schema`, `tool-calling`, `otel`, `embeddings`, `rerank`, `guardrails`, `agents`, `cursor-memory` |
| Emits against | `structuredOutput`: `zod`; `tracing`: `otel-genai` |
| Output root | `app` |
| Generated directory | `app/generated` |
| Business directory | `app/business` |

## What a declaration does not promise

Each generator also rejects the parts of a declared collection its runtime cannot honour. A target claiming `agents` is not a claim that every agent field is expressible; `aid validate` reports the specific rejection with the field path. The [spec reference](./spec.md) is the full key list.

---

This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.

Next: [the spec reference](./spec.md) or [the CLI reference](./cli.md).
