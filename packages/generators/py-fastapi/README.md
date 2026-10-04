# `py-fastapi` generator

The **Phase 0 reference target**: generates a FastAPI AI service from the IR, emitting against **Pydantic AI**
for structured output, **LangGraph or plain async** for agent loops, and **OTel GenAI** semantic conventions
for tracing.

**Emits** (per generated app — [`docs/design.md` §8.3](../../../docs/design.md)): model gateway wiring, prompt
registry, structured-output endpoints, retrieval bindings, agent wiring, pipeline step graphs, guardrail
middleware, an eval harness, the manifest, and the stack files (`pyproject.toml`, entrypoint, config).

**Emits against:** Pydantic AI; OTel GenAI. Wraps their stable public APIs only, so the orchestration library
stays swappable ([`docs/design.md` §4](../../../docs/design.md), principle 5).

**Not responsible for:** runtime behavior — that lives in [`../../../runtimes/python/`](../../../runtimes/python/).

**Status:** not implemented. The Phase 0 exit criterion is *spec → running traced AI endpoint with a passing
eval gate* ([`docs/design.md` §14](../../../docs/design.md)).

Reference: [`docs/design.md` §8](../../../docs/design.md) (generator plugin model),
[`§9`](../../../docs/design.md) (runtime libraries), [`§6.1`](../../../docs/design.md) (example spec).
