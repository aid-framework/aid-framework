# `runtimes/`

One hand-written runtime library **per stack**. This is the real framework: the generated code is thin glue,
and the behavior lives here ([`docs/design.md` §4](../docs/design.md), principle 1;
[`§9`](../docs/design.md)).

**Currently Python only.** The design targets more stacks ([`docs/design.md` §14](../docs/design.md)), but
repository bootstrap scaffolds a single runtime — [`python/`](python/) — paired with the `py-fastapi`
generator. Additional stacks will land together with their generators rather than being stubbed out ahead of
them.

Each runtime provides the same capabilities, implemented idiomatically for its stack:

- **Model gateway** — provider adapters with a unified streaming interface, alias → pinned-model resolution,
  capability negotiation, ordered fallbacks, escalation routing, retries/backoff, rate limiting, prompt and
  semantic caches, token and cost accounting.
- **Prompt registry** — versioned prompts, typed rendering, few-shot assembly, structured-output enforcement
  with a parse-repair loop.
- **Retrieval** — connectors, chunkers, embedders, vector-store adapters, hybrid search, reranking, context
  assembly with citations.
- **Agent runtime** — loop over an ecosystem orchestration library, tool-schema generation, tool executor,
  step/token/cost budgets, handoffs, human-in-the-loop interrupts, memory.
- **Guardrails engine** — stage-aware policy evaluation at input/output/retrieval/tool-call.
- **Eval harness** — datasets, metrics including LLM-as-judge, thresholds, baseline diffing, CI gating.
- **Observability & cost** — OTel GenAI spans per LLM/retrieval/tool call, replay, PII redaction, cost and
  latency reporting.

**Non-responsibility:** a runtime contains no app-specific prompts, tools, or rubrics. Those belong to the
generated app's `business/` tier ([`docs/design.md` §8.4](../docs/design.md), the seam).

| Runtime | Stack | Generator it pairs with | Phase | Status |
|---------|-------|-------------------------|-------|--------|
| [`python/`](python/) | Python 3.11+ | `py-fastapi` | Phase 0 | Not implemented |

Planned but **not yet scaffolded**: TypeScript/Node (Vercel AI SDK), .NET (Semantic Kernel), and Java
(Spring AI) — see [`docs/design.md` §14](../docs/design.md).

**Status:** directory skeletons only — no runtime code exists yet. Runtimes are versioned independently, and
each declares the IR/target range and provider SDK ranges it supports
([`docs/design.md` §13](../docs/design.md), versioning).

Reference: [`docs/design.md` §9](../docs/design.md).
