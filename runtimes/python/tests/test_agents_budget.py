"""D1: a breach is a hard failure unless the agent opts into one bounded step down.

The pair of tests below is the whole decision: one document, one ceiling, and the
only difference is ``onBudgetExhausted``. If either half passed without the loop
reading that field, the field would not be doing anything.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer

from agent_support import (
    CHEAP_COST,
    STRONG_COST,
    agent_def,
    build,
    document,
    model_def,
    prompt_def,
    recording_tool,
    solo,
    tool_def,
)
from aid_runtime import (
    ATTRIBUTES,
    AgentBudgetDegradedError,
    BudgetExceededError,
    ScriptedTurn,
    Tool,
)

PROMPT = "Answer in one sentence."
QUESTION = "How long does delivery take?"
STRONG = "strong"
CHEAP = "cheap"
#: A long tool observation, so the second step's prompt is far dearer than the
#: first and a second breach is unambiguous rather than a rounding coincidence.
LONG = "y" * 2000


def _ladder(*, on_budget_exhausted: str | None, budget: float | None) -> dict[str, Any]:
    """``strong`` with ``cheap`` declared as its fallback: a two-rung alias ladder."""
    return document(
        models=[
            model_def(STRONG, cost=STRONG_COST, fallbacks=[CHEAP]),
            model_def(CHEAP, cost=CHEAP_COST),
        ],
        prompts=[prompt_def("main", PROMPT)],
        agents=[
            agent_def(
                "solo",
                model=STRONG,
                max_cost_budget=budget,
                on_budget_exhausted=on_budget_exhausted,
            )
        ],
    )


def _tool_ladder(*, on_budget_exhausted: str | None, budget: float | None) -> dict[str, Any]:
    """The same ladder, with a tool so the loop can take a second step."""
    doc = _ladder(on_budget_exhausted=on_budget_exhausted, budget=budget)
    doc["tools"] = [tool_def("t1", "search")]
    doc["agents"][0]["tools"] = ["t1"]
    return doc


def _projection(doc: dict[str, Any], *, tools: Sequence[Tool] = ()) -> dict[str, float]:
    return build(doc, tools=tools).projections(prompt=PROMPT, text=QUESTION)


def _between_dear_and_cheap() -> float:
    """A dollar ceiling that ``strong`` busts and ``cheap`` meets."""
    projection = _projection(_ladder(on_budget_exhausted=None, budget=None))
    return (projection[STRONG] + projection[CHEAP]) / 2


def _tracer() -> tuple[Tracer, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("aid-runtime-tests"), exporter


def _agent_span_attributes(exporter: InMemorySpanExporter) -> dict[str, Any]:
    (span,) = [span for span in exporter.get_finished_spans() if span.name == "invoke_agent solo"]
    assert span.attributes is not None
    return dict(span.attributes)


async def test_a_breach_is_a_hard_failure_by_default() -> None:
    ceiling = _between_dear_and_cheap()
    harness = build(
        _ladder(on_budget_exhausted=None, budget=ceiling),
        script=[ScriptedTurn.answer("two days")],
    )

    with pytest.raises(BudgetExceededError):
        await harness.runtime.run("solo", QUESTION)

    # Refused before the call, so nothing was spent: the projection is the check.
    assert harness.aliases_charged() == ()
    assert harness.provider.calls == []


async def test_the_same_ceiling_is_survivable_only_because_degrade_was_declared() -> None:
    ceiling = _between_dear_and_cheap()
    harness = build(
        _ladder(on_budget_exhausted="degrade", budget=ceiling),
        script=[ScriptedTurn.answer("two days")],
    )

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert result.answer == "two days"
    assert result.degraded == ((STRONG, CHEAP),)
    assert [(step.alias, step.degraded_from) for step in result.steps] == [(CHEAP, STRONG)]
    # One charge, on the cheap alias: the dear one was never billed.
    assert harness.aliases_charged() == (CHEAP,)
    # One attempt. A degrade that retried the dear alias would show two.
    assert len(harness.provider.calls) == 1


async def test_degrade_steps_down_once_and_a_second_breach_is_a_hard_failure() -> None:
    tool, recorder = recording_tool(answer=LONG)
    doc = _tool_ladder(on_budget_exhausted="degrade", budget=None)
    # A ceiling a few times the cheap step-one projection: enough for step one to
    # be billed, far below what step two projects once it carries the observation.
    doc["agents"][0]["maxCostBudget"] = _projection(doc, tools=[tool])[CHEAP] * 10
    harness = build(
        doc,
        tools=[tool],
        script=[
            ScriptedTurn.tool("search", {"query": "delivery"}),
            ScriptedTurn.answer("unreachable"),
        ],
    )

    with pytest.raises(BudgetExceededError):
        await harness.runtime.run("solo", QUESTION)

    # Step one degraded, ran, and was billed on the cheap alias. Step two breached
    # again and was refused before its request went out: exactly one rung down,
    # then a hard failure -- never a loop.
    assert recorder.calls == 1
    assert harness.aliases_charged() == (CHEAP,)
    assert len(harness.provider.calls) == 1


async def test_the_degrade_is_visible_on_the_agent_span() -> None:
    tracer, exporter = _tracer()
    ceiling = _between_dear_and_cheap()
    harness = build(
        _ladder(on_budget_exhausted="degrade", budget=ceiling),
        script=[ScriptedTurn.answer("two days")],
        tracer=tracer,
    )

    await harness.runtime.run("solo", QUESTION)

    attributes = _agent_span_attributes(exporter)
    assert attributes[ATTRIBUTES["agent_budget_degraded"]] is True
    assert attributes[ATTRIBUTES["agent_budget_from"]] == STRONG
    assert attributes[ATTRIBUTES["agent_budget_to"]] == CHEAP
    assert attributes[ATTRIBUTES["agent_status"]] == "completed"


async def test_the_agent_span_carries_no_degrade_when_the_ceiling_held() -> None:
    tracer, exporter = _tracer()
    harness = build(
        _ladder(on_budget_exhausted="degrade", budget=None),
        script=[ScriptedTurn.answer("two days")],
        tracer=tracer,
    )

    result = await harness.runtime.run("solo", QUESTION)

    assert result.degraded == ()
    attributes = _agent_span_attributes(exporter)
    assert ATTRIBUTES["agent_budget_degraded"] not in attributes
    assert harness.aliases_charged() == (STRONG,)


async def test_degrade_with_nowhere_to_step_fails_closed_at_run_time() -> None:
    """The gate refuses this at build time; the runtime must not pretend either."""
    doc = solo(prompt=PROMPT, alias=STRONG, models=[model_def(STRONG, cost=STRONG_COST)])
    doc["agents"][0]["onBudgetExhausted"] = "degrade"
    doc["agents"][0]["maxCostBudget"] = _projection(doc)[STRONG] / 2
    harness = build(doc, script=[ScriptedTurn.answer("two days")])

    with pytest.raises(AgentBudgetDegradedError, match="ir/agents-budget-degrade"):
        await harness.runtime.run("solo", QUESTION)


async def test_a_token_ceiling_is_enforced_by_the_charge_not_the_projection() -> None:
    harness = build(
        solo(prompt=PROMPT, max_tokens_budget=1), script=[ScriptedTurn.answer("two days")]
    )

    with pytest.raises(BudgetExceededError):
        await harness.runtime.run("solo", QUESTION)


async def test_a_generous_token_ceiling_lets_the_run_finish() -> None:
    harness = build(
        solo(prompt=PROMPT, max_tokens_budget=10_000), script=[ScriptedTurn.answer("two days")]
    )

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed


async def test_a_token_only_ceiling_never_degrades() -> None:
    """Only dollars can be improved by a cheaper alias, so `fits` is always true."""
    harness = build(
        solo(prompt=PROMPT, on_budget_exhausted="degrade", max_tokens_budget=10_000),
        script=[ScriptedTurn.answer("two days")],
    )

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert result.degraded == ()
    assert harness.aliases_charged() == ("cheap",)
