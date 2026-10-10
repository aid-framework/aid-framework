# `runtimes/`

One hand-written runtime library **per stack**. This is the real framework: the generated code is thin glue,
and the behavior lives here ([`docs/design.md` §4](../docs/design.md), principle 1;
[`§9`](../docs/design.md)).

**Currently Python only.** The design targets more stacks ([`docs/design.md` §14](../docs/design.md)), but
repository bootstrap scaffolds a single runtime — [`python/`](python/) — paired with the `py-fastapi`
generator. Additional stacks will land together with their generators rather than being stubbed out ahead of
them.

Each runtime eventually provides the same capabilities, implemented idiomatically for its stack. Phase 0
implements the first group below; the rest are deferred by [`§14`](../docs/design.md) and are listed here so
the target shape stays visible.

**Phase 0:**

- **Model gateway** — provider adapters behind one interface, alias → **pinned-model** resolution, capability
  negotiation, ordered fallbacks, retries/backoff, and token/cost accounting with enforced budgets.
- **Prompt registry** — versioned prompts, typed rendering, few-shot assembly.
- **Tool executor** — declared tool definitions, argument validation, structured results.
- **Pipeline** — plain-async named steps over a frozen context, each step traced.
- **Eval harness** — datasets, metrics including LLM-as-judge, and thresholds gated by **N-run sampling
  against a stored baseline** rather than by equality.
- **Observability & cost** — OTel GenAI spans per model call, with cost recorded on the span.

**Deferred, per [`§14`](../docs/design.md):** streaming (the capability is declared, the transport is
request/response only), escalation routing, retrieval (connectors, chunkers, embedders, vector stores,
reranking, citation assembly), a memory tier, a guardrails engine, prompt/semantic caching, rate limiting and
token buckets, and a latency p95 budget. Multi-provider breadth is one HTTP provider plus one fake; Anthropic,
Azure and Bedrock adapters are not Phase 0.

**Non-responsibility:** a runtime contains no app-specific prompts, tools, or rubrics. Those belong to the
generated app's `business/` tier ([`docs/design.md` §8.4](../docs/design.md), the seam).

| Runtime | Stack | Generator it pairs with | Phase | Status |
| --- | --- | --- | --- | --- |
| [`python/`](python/) | Python 3.11+ | `py-fastapi` | Phase 0 | Implemented (Phase 0 scope) |

Planned but **not yet scaffolded**: TypeScript/Node (Vercel AI SDK), .NET (Semantic Kernel), and Java
(Spring AI) — see [`docs/design.md` §14](../docs/design.md).

Runtimes are versioned independently, and each declares the IR/target range and provider SDK ranges it
supports ([`docs/design.md` §13](../docs/design.md), versioning).

Reference: [`docs/design.md` §9](../docs/design.md).
