"""HITL: a pause that survives the process and a resume that continues the run.

The loop stops *before* the held tool runs, records the question, and continues
from the checkpoint when a human answers. Nothing here is a UI; the point is that
the pause is a real, serialisable state and that the two answers -- approve and
reject -- are observably different.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer

from agent_support import (
    ADMIN_ONLY,
    agent_def,
    build,
    document,
    model_def,
    prompt_def,
    recording_tool,
    solo,
    tool_def,
)
from aid_runtime import ATTRIBUTES, ConfigurationError, ScriptedTurn
from aid_runtime.agents import AgentCheckpoint, HumanDecision, Principal, RunStatus, StepKind

SOLO_PROMPT = "You are a helpful assistant."
FRONT_PROMPT = "You triage requests and move them to the right agent."
WORKER_PROMPT = "You answer one question and stop."
QUESTION = "Refund this order."
REJECTED = "rejected by the human approver"
ADMIN = Principal(roles=frozenset({"admin"}))


def _supervised() -> dict[str, Any]:
    """One agent, one tool, and a policy that asks a human for it."""
    return solo(
        prompt=SOLO_PROMPT,
        tool_specs=[tool_def("t1", "search")],
        tools=["t1"],
        hitl={"when": ADMIN_ONLY, "channel": "ops"},
    )


def _delegating() -> dict[str, Any]:
    """``front`` delegates to a supervised ``worker``: a pause with a caller above it."""
    return document(
        models=[model_def("cheap")],
        prompts=[prompt_def("front", FRONT_PROMPT), prompt_def("worker", WORKER_PROMPT)],
        tools=[tool_def("t1", "search")],
        agents=[
            agent_def("front", prompt="front", delegates=["worker"], tools=[]),
            agent_def(
                "worker", prompt="worker", tools=["t1"], hitl={"when": ADMIN_ONLY, "channel": "ops"}
            ),
        ],
    )


def _tracer() -> tuple[Tracer, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("aid-runtime-tests"), exporter


def _hitl_events(span_name: str, exporter: InMemorySpanExporter) -> list[dict[str, Any]]:
    spans = [span for span in exporter.get_finished_spans() if span.name == span_name]
    return [
        dict(event.attributes or {})
        for span in spans
        for event in span.events
        if event.name == "aid.hitl"
    ]


async def test_a_held_tool_pauses_the_loop_before_it_runs() -> None:
    tool, recorder = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")],
    )

    result = await harness.runtime.run("solo", QUESTION, principal=ADMIN)

    assert result.status is RunStatus.PAUSED
    assert not result.completed
    assert result.answer == ""
    assert result.checkpoint is not None
    # The pause is reported as a step that asked for tools, so a trace reader sees
    # which step was held instead of a run that simply stopped.
    assert [(step.index, step.kind) for step in result.steps] == [(1, StepKind.TOOLS)]
    assert recorder.calls == 0
    assert result.approval is not None
    assert result.approval.channel == "ops"
    assert [call.name for call in result.approval.calls] == ["search"]


async def test_approval_runs_the_held_tool_without_replaying_the_model() -> None:
    tool, recorder = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")],
    )
    paused = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    assert paused.checkpoint is not None

    result = await harness.runtime.resume(paused.checkpoint, HumanDecision.APPROVE)

    assert result.completed
    assert result.answer == "done"
    assert recorder.queries == ["order"]
    # The whole run is reported, not only the part after the resume.
    assert [(step.index, step.kind) for step in result.steps] == [
        (1, StepKind.TOOLS),
        (2, StepKind.ANSWER),
    ]
    observation = next(
        message for message in harness.provider.calls[1].messages if message.role == "tool"
    )
    assert observation.content == "sunny:order"


async def test_rejection_is_an_observation_and_the_agent_keeps_going() -> None:
    tool, recorder = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[
            ScriptedTurn.tool("search", {"query": "order"}),
            ScriptedTurn.answer("I could not check that."),
        ],
    )
    paused = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    assert paused.checkpoint is not None

    result = await harness.runtime.resume(paused.checkpoint, "reject")

    assert result.completed
    assert result.answer == "I could not check that."
    # Rejection is not a crash and not a silent skip: the tool did not run, and the
    # model was told so in the one place it can read.
    assert recorder.calls == 0
    observation = next(
        message for message in harness.provider.calls[1].messages if message.role == "tool"
    )
    assert observation.content == REJECTED


async def test_a_run_that_pauses_twice_still_resumes() -> None:
    tool, recorder = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[
            ScriptedTurn.tool("search", {"query": "one"}),
            ScriptedTurn.tool("search", {"query": "two"}),
            ScriptedTurn.answer("done"),
        ],
    )
    first = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    assert first.checkpoint is not None

    second = await harness.runtime.resume(first.checkpoint, "approve", principal=ADMIN)
    assert second.status is RunStatus.PAUSED
    assert second.checkpoint is not None
    assert second.checkpoint.step == 2
    assert recorder.queries == ["one"]

    third = await harness.runtime.resume(second.checkpoint, "approve", principal=ADMIN)
    assert third.completed
    assert recorder.queries == ["one", "two"]
    assert [step.index for step in third.steps] == [1, 2, 3]


async def test_a_pause_inside_a_delegate_returns_control_to_the_caller() -> None:
    tool, recorder = recording_tool(answer="sunny")
    harness = build(
        _delegating(),
        tools=[tool],
        script=[
            ScriptedTurn.tool("delegate_to_worker", {"message": "check the order"}),
            ScriptedTurn.tool("search", {"query": "order"}),
            ScriptedTurn.answer("worker answer"),
            ScriptedTurn.answer("front answer"),
        ],
    )

    paused = await harness.runtime.run("front", QUESTION, principal=ADMIN)

    assert paused.status is RunStatus.PAUSED
    assert paused.checkpoint is not None
    # The pause happens inside the delegate, so the question names the delegate and
    # the checkpoint carries the link back to the caller that is waiting for it.
    assert paused.checkpoint.agent_id == "worker"
    assert paused.checkpoint.caller is not None
    assert paused.checkpoint.caller.agent_id == "front"

    result = await harness.runtime.resume(paused.checkpoint, "approve", principal=ADMIN)

    # Control returned to the caller, and the delegate's answer arrived as one
    # observation -- the caller still authored the final answer.
    assert result.completed
    assert result.agent_id == "front"
    assert result.answer == "front answer"
    assert recorder.queries == ["order"]
    handed_back = next(
        message for message in harness.provider.calls[-1].messages if message.role == "tool"
    )
    assert handed_back.content == "worker answer"


async def test_the_caller_side_checkpoint_is_not_resumable() -> None:
    """Only the checkpoint holding the question is resumable, never the caller link."""
    tool, _ = recording_tool()
    harness = build(
        _delegating(),
        tools=[tool],
        script=[
            ScriptedTurn.tool("delegate_to_worker", {"message": "check the order"}),
            ScriptedTurn.tool("search", {"query": "order"}),
        ],
    )
    paused = await harness.runtime.run("front", QUESTION, principal=ADMIN)
    assert paused.checkpoint is not None
    assert paused.checkpoint.caller is not None

    with pytest.raises(ConfigurationError, match="carries the caller link"):
        await harness.runtime.resume(paused.checkpoint.caller, "approve", principal=ADMIN)


async def test_a_checkpoint_survives_a_fresh_process() -> None:
    tool, recorder = recording_tool()
    document_ = _supervised()
    first = build(
        document_,
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")],
    )
    paused = await first.runtime.run("solo", QUESTION, principal=ADMIN)
    assert paused.checkpoint is not None
    spent = paused.cost_usd
    assert spent > 0

    # Nothing but the serialised checkpoint crosses the process boundary.
    restored = AgentCheckpoint.model_validate_json(paused.checkpoint.model_dump_json())
    second = build(document_, tools=[tool], script=[ScriptedTurn.answer("done")])

    result = await second.runtime.resume(restored, "approve", principal=ADMIN)

    assert result.completed
    assert recorder.queries == ["order"]
    # The paused spend is carried into the new ledger as an auditable entry, so the
    # resumed run does not get a ceiling it has already partly spent.
    assert [entry.alias for entry in second.ledger.entries] == ["restored", "cheap"]
    assert second.ledger.entries[0].cost_usd == pytest.approx(spent)
    assert second.ledger.cost_usd == pytest.approx(spent + result.cost_usd)


async def test_the_pause_and_the_resume_are_both_on_the_trace() -> None:
    tracer, exporter = _tracer()
    tool, _ = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")],
        tracer=tracer,
    )
    paused = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    assert paused.checkpoint is not None
    await harness.runtime.resume(paused.checkpoint, "approve", principal=ADMIN)

    events = _hitl_events("invoke_agent solo", exporter)

    # A paused run and a resumed run are two spans; the event carries which is which,
    # because a span attribute would keep only the last answer of a run that paused twice.
    assert [event[ATTRIBUTES["hitl_phase"]] for event in events] == ["pause", "resume"]
    assert events[0][ATTRIBUTES["hitl_channel"]] == "ops"
    assert events[0][ATTRIBUTES["hitl_step"]] == 1
    assert events[1][ATTRIBUTES["hitl_decision"]] == "approve"
    assert events[1][ATTRIBUTES["hitl_channel"]] == "ops"
