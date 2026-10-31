# `runtimes/`

One hand-written runtime library **per stack**. This is the real framework: the generated code is thin glue, and
the behavior lives here.

| Runtime | Stack | Generator it pairs with | Distribution |
| --- | --- | --- | --- |
| [`python/`](python/) | Python 3.11+ | `py-fastapi` | [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/) |
| [`typescript/`](typescript/) | Node.js 24+ | `ts-vercel` | [`@aid-framework/runtime`](https://www.npmjs.com/package/@aid-framework/runtime) |

Both are implemented and published. The TypeScript runtime mirrors the Python one module for module, so an
application generated for either language meets the same gateway semantics, the same pinned-model rules, the same
eval-gate arithmetic and the same retrieval surface. The eval gate in particular reproduces the same z-critical
table and N-run sampling, because a gate whose statistics differed per language would let a TypeScript regression
pass a Python baseline.

Each runtime provides the same capabilities, implemented idiomatically for its stack:

- **Model gateway** — provider adapters behind one interface, alias → **pinned-model** resolution, capability
  negotiation, ordered fallbacks, token/cost accounting with enforced budgets.
- **Prompt registry** — versioned prompts, typed rendering, few-shot assembly.
- **Tool executor** — declared tool definitions, argument validation, structured results.
- **Pipeline** — plain-async named steps over a frozen context, each step traced.
- **Agent runtime** — the agent loop, transfer vs. delegate, budgets with bounded degrade, memory, and a
  checkpointed human-in-the-loop pause.
- **Retrieval** — connectors, chunkers, embedders, vector stores, hybrid fusion, reranking and citations.
- **Eval harness** — datasets, metrics, and thresholds gated by **N-run sampling against a stored baseline**
  rather than by equality.
- **Observability & cost** — OTel GenAI spans per model call, with cost recorded on the span.

**Deferred in both:** streaming (the transport is request/response only; `Capability` includes it so a build can
require it, but calling the streaming entry point raises), escalation routing, a hosted rerank adapter,
prompt/semantic caching, rate limiting, and provider breadth beyond one HTTP adapter plus one fake. Each is
refused explicitly rather than approximated.

**Non-responsibility:** a runtime contains no app-specific prompts, tools, or rubrics. Those belong to the
generated app's `business/` tier.

Runtimes are versioned independently, and each declares the IR/target range and provider SDK ranges it supports.

For the design rationale, see [`docs/design.md`](../docs/design.md).
