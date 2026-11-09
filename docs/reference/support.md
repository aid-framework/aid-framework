---
description: "The shipped provider, cloud and target matrix, generated from the declarations the compiler enforces."
---

# Support

This page is read from the declarations the compiler enforces, not maintained by hand: the provider set is `SERVED_PROVIDERS` (what the normalize gate accepts) and the cloud matrix is `CLOUD_TARGETS` (what the infra planner refuses outside of). If a provider or cloud is missing here, a spec that names it is rejected at plan time rather than quietly generated.

## Model providers

Every provider below is served by `py-fastapi` and `ts-vercel` and is accepted by the normalize gate.

| Provider | Served by |
| --- | --- |
| `anthropic` | `py-fastapi`, `ts-vercel` |
| `bedrock` | `py-fastapi`, `ts-vercel` |
| `gemini` | `py-fastapi`, `ts-vercel` |
| `google` | `py-fastapi`, `ts-vercel` |
| `openai` | `py-fastapi`, `ts-vercel` |
| `openai-compatible` | `py-fastapi`, `ts-vercel` |
| `fake` | `py-fastapi`, `ts-vercel` |

## Clouds and deployment targets

A `yes` means the infra planner emits a module for that target on that cloud. A dash means it refuses the plan with a named diagnostic; it does not emit unvalidated HCL. Every emitted module is byte-asserted against a committed fixture and validated with `tofu validate` in CI.

| Target | `aws` | `gcp` |
| --- | --- | --- |
| `batch` | yes | yes |
| `container` | yes | yes |
| `edge` | yes | — |
| `serverless` | yes | yes |

The emitted infrastructure is OpenTofu. A plan targets one cloud at a time, because two providers in one state is a blast radius rather than a feature.

## Spec language

The current spec language version is `0.18`.
A construct that needs a later version is reported as `spec/not-supported`, naming the version it needs, instead of being ignored.

## Conformance

The corpus holds 77 cases over 41 operations, run against every target. A case that a target cannot satisfy is a declared capability boundary, not a skipped test.

---

Next: [the generator targets](./targets.md), [the CLI reference](./cli.md), or [the conformance index](./conformance.md).
