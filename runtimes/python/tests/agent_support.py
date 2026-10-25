"""Builders for the IR documents and runtimes the agent tests drive.

The agent tests all start from an emitted IR document rather than from
:class:`RuntimeSpec` directly, because the seam *is* part of what L2 delivers: a
runtime that only worked on hand-built specs would prove nothing about the
documents the compiler emits.

Prices here are the IR's USD per million tokens. The seam divides by 1000, so a
test that wants to reason about money reads the gateway's own projection
(:meth:`Harness.projections`) instead of re-deriving it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from opentelemetry.trace import Tracer

from aid_runtime import AgentRuntime, FakeProvider, ScriptedTurn
from aid_runtime.agents import MemoryStore
from aid_runtime.cost import CostLedger
from aid_runtime.gateway import ModelGateway
from aid_runtime.tools import Tool
from aid_runtime.types import CompletionRequest, Message

PROVIDER = "fake"

#: USD per million tokens. ``strong`` is 20x ``mid`` and ``mid`` is 10x ``cheap``,
#: which leaves room to place a budget strictly between any two projections.
STRONG_COST: dict[str, float] = {"inputPerMTok": 10.0, "outputPerMTok": 30.0}
MID_COST: dict[str, float] = {"inputPerMTok": 5.0, "outputPerMTok": 16.0}
CHEAP_COST: dict[str, float] = {"inputPerMTok": 0.5, "outputPerMTok": 1.5}

SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "additionalProperties": False,
}

ADMIN_ONLY: dict[str, Any] = {
    "kind": "call",
    "name": "hasRole",
    "args": [{"kind": "string", "value": "admin"}],
}


def model_def(
    model_id: str,
    *,
    cost: Mapping[str, float] | None = None,
    fallbacks: Sequence[str] = (),
    capabilities: Sequence[str] = ("tool-calling",),
) -> dict[str, Any]:
    return {
        "id": model_id,
        "modelId": f"{model_id}-1",
        "provider": PROVIDER,
        "capabilities": list(capabilities),
        "limits": {"contextTokens": 128_000, "maxOutputTokens": 4_096},
        "costProfile": dict(cost if cost is not None else CHEAP_COST),
        "fallbacks": list(fallbacks),
    }


def prompt_def(prompt_id: str, template: str) -> dict[str, Any]:
    return {"id": prompt_id, "version": 1, "template": template, "variables": {}}


def tool_def(tool_id: str, name: str, *, requires_confirmation: bool = False) -> dict[str, Any]:
    return {
        "id": tool_id,
        "name": name,
        "description": f"{name} tool",
        "requiresConfirmation": requires_confirmation,
        "sideEffects": "write" if requires_confirmation else "read",
    }


def memory_def(
    memory_id: str,
    *,
    kind: str = "buffer",
    scope: str = "thread",
    token_budget: int = 200,
    backend: str | None = None,
    summarize_model: str | None = None,
    ttl: str | None = None,
    redact: Sequence[str] = (),
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": memory_id,
        "kind": kind,
        "scope": scope,
        "tokenBudget": token_budget,
        "redact": list(redact),
    }
    if backend is not None:
        entry["backend"] = backend
    if summarize_model is not None:
        entry["summarizeModel"] = summarize_model
    if ttl is not None:
        entry["ttl"] = ttl
    return entry


def agent_def(
    agent_id: str,
    *,
    prompt: str = "main",
    model: str = "cheap",
    max_steps: int = 4,
    tools: Sequence[str] = (),
    handoffs: Sequence[str] = (),
    delegates: Sequence[str] = (),
    memory: Sequence[str] = (),
    max_cost_budget: float | None = None,
    max_tokens_budget: int | None = None,
    on_budget_exhausted: str | None = None,
    engine: str = "native",
    hitl: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": agent_id,
        "name": agent_id,
        "instructions": prompt,
        "model": model,
        "maxSteps": max_steps,
        "tools": list(tools),
        "handoffs": list(handoffs),
        "delegates": list(delegates),
        "memory": list(memory),
        "engine": engine,
    }
    if max_cost_budget is not None:
        entry["maxCostBudget"] = max_cost_budget
    if max_tokens_budget is not None:
        entry["maxTokensBudget"] = max_tokens_budget
    if on_budget_exhausted is not None:
        entry["onBudgetExhausted"] = on_budget_exhausted
    if hitl is not None:
        entry["humanInTheLoop"] = dict(hitl)
    return entry


def document(
    *,
    models: Sequence[Mapping[str, Any]],
    prompts: Sequence[Mapping[str, Any]],
    agents: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]] = (),
    memory: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    return {
        "version": "0.2.0",
        "models": [dict(entry) for entry in models],
        "prompts": [dict(entry) for entry in prompts],
        "tools": [dict(entry) for entry in tools],
        "memory": [dict(entry) for entry in memory],
        "agents": [dict(entry) for entry in agents],
    }


def solo(
    *,
    prompt: str = "You are a helpful assistant.",
    alias: str = "cheap",
    tool_specs: Sequence[Mapping[str, Any]] = (),
    memory: Sequence[Mapping[str, Any]] = (),
    models: Sequence[Mapping[str, Any]] | None = None,
    **agent_fields: Any,
) -> dict[str, Any]:
    """A one-agent document: prompt ``main``, agent ``solo``.

    ``memory`` is the document's collection; the agent references every entry in
    it, because a one-agent document has nothing else to reference them.
    """
    return document(
        models=list(models) if models is not None else [model_def(alias)],
        prompts=[prompt_def("main", prompt)],
        tools=tool_specs,
        memory=memory,
        agents=[
            agent_def(
                "solo",
                model=alias,
                memory=[str(entry["id"]) for entry in memory],
                **agent_fields,
            )
        ],
    )


@dataclass(slots=True)
class Recorder:
    """What a tool handler actually received. Empty means it never ran."""

    queries: list[str] = field(default_factory=list)

    @property
    def calls(self) -> int:
        return len(self.queries)


def recording_tool(name: str = "search", *, answer: str = "sunny") -> tuple[Tool, Recorder]:
    """A tool that records its executions, so "did not run" is observable.

    Whether the call needs a human is an IR property of the tool entry, not of
    the registered :class:`Tool`, so it is declared in the document instead.
    """
    recorder = Recorder()

    def handler(query: str = "") -> str:
        recorder.queries.append(query)
        return f"{answer}:{query}"

    return Tool.of(name, handler, description=f"{name} tool", parameters=SEARCH_SCHEMA), recorder


@dataclass(slots=True)
class Harness:
    """One runtime plus the fakes it was built with."""

    runtime: AgentRuntime
    provider: FakeProvider
    ledger: CostLedger

    @property
    def gateway(self) -> ModelGateway:
        return self.runtime.gateway

    def projections(self, *, prompt: str, text: str) -> dict[str, float]:
        """The gateway's own prompt projection for each alias of this document.

        Tests place a dollar ceiling between two aliases with this rather than
        multiplying prices by token counts: the number a budget is compared to
        must be the number the gateway computes, or the test is measuring its own
        arithmetic instead of the runtime's.
        """
        request = CompletionRequest(messages=(Message.system(prompt), Message.user(text)))
        return {
            alias: self.gateway.projected_cost_usd(alias, request)
            for alias in sorted(self.runtime.spec.models)
        }

    def aliases_charged(self) -> tuple[str, ...]:
        return tuple(entry.alias for entry in self.ledger.entries)


def build(
    doc: Mapping[str, Any],
    *,
    script: Sequence[ScriptedTurn] = (),
    tools: Sequence[Tool] = (),
    stores: Mapping[str, MemoryStore] | None = None,
    memory_store: MemoryStore | None = None,
    tracer: Tracer | None = None,
    ledger: CostLedger | None = None,
    provider: FakeProvider | None = None,
) -> Harness:
    fake = provider if provider is not None else FakeProvider(name=PROVIDER, script=script)
    runtime = AgentRuntime.from_ir(
        doc,
        providers={PROVIDER: fake},
        tools=tools,
        stores=stores,
        memory_store=memory_store,
        ledger=ledger,
        tracer=tracer,
    )
    return Harness(runtime=runtime, provider=fake, ledger=runtime.gateway.ledger)
