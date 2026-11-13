"""Redacting an agent run: the boundary the loop does not have, and the one it does.

A pipeline redacts where it renders. An agent run never renders, so the loop binds the
same field names somewhere else: every tool call arrives as a mapping keyed by declared
argument names, and the gateway -- the only code that writes model text to a span --
redacts the copy it records with whatever bindings the request carries.

These assertions are about the *recorded* copy. The model must keep receiving the real
value, because redaction is a recording decision; and a value that enters only through
free text is recorded as written, because no field name matches prose. That second
assertion is the limit, tested rather than described, so it cannot quietly turn into a
claim that nothing leaks.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer

from agent_support import ADMIN_ONLY, build, solo, tool_def
from aid_runtime import ATTRIBUTES, ScriptedTurn, Tool
from aid_runtime.agents import HumanDecision, Principal, RunStatus
from aid_runtime.tracing import CONTENT_ENV

EMAIL = "ada@example.com"
QUESTION = "Refund this order."

#: A tool whose single argument is named after the field the document withholds. The name
#: is what binds: the loop reads it off the call, not off the tool.
EMAIL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"email": {"type": "string"}},
    "required": ["email"],
}


def _email_tool() -> Tool:
    def handler(email: str = "") -> str:
        return f"notified:{email}"

    return Tool.of("notify", handler, description="notify a customer", parameters=EMAIL_SCHEMA)


def _document(*, hitl: bool = False) -> dict[str, Any]:
    agent_fields: dict[str, Any] = {"tools": ["t1"]}
    if hitl:
        agent_fields["hitl"] = {"when": ADMIN_ONLY, "channel": "ops"}
    doc = solo(
        prompt="You are a helpful assistant.",
        tool_specs=[tool_def("t1", "notify")],
        **agent_fields,
    )
    doc["observability"] = {"redact": ["email"]}
    return doc


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> InMemorySpanExporter:
    """Record payloads, and route the gateway's spans into this test's exporter.

    Content is off by default and the gateway resolves a process-wide tracer, so both
    have to be arranged for a test that is about what a span keeps.
    """
    monkeypatch.setenv(CONTENT_ENV, "1")
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer: Tracer = provider.get_tracer("aid-runtime-tests")
    monkeypatch.setattr("aid_runtime.gateway.get_tracer", lambda name=None: tracer)
    return exporter


def _recorded_content(exporter: InMemorySpanExporter) -> list[str]:
    """Every recorded payload, as the trace wrote it."""
    texts: list[str] = []
    for span in exporter.get_finished_spans():
        attributes = dict(span.attributes or {})
        texts.append(str(attributes.get(ATTRIBUTES["input_text"], "")))
        texts.append(str(attributes.get(ATTRIBUTES["output_text"], "")))
    return [text for text in texts if text]


async def test_a_tool_argument_is_withheld_from_the_recorded_copy(
    captured: InMemorySpanExporter,
) -> None:
    """The value travels through a declared argument name, so the loop can bind it."""
    harness = build(
        _document(),
        tools=[_email_tool()],
        script=[
            ScriptedTurn.tool("notify", {"email": EMAIL}),
            ScriptedTurn.answer("notified"),
        ],
    )

    result = await harness.runtime.run("solo", QUESTION)

    assert result.status is RunStatus.COMPLETED
    recorded = _recorded_content(captured)
    assert recorded, "the run recorded no content, so nothing was tested"
    assert all(EMAIL not in text for text in recorded)
    assert any("[redacted:email]" in text for text in recorded)


async def test_the_model_still_receives_the_value_it_must_act_on() -> None:
    """Redaction is a recording decision: the provider call is untouched."""
    harness = build(
        _document(),
        tools=[_email_tool()],
        script=[
            ScriptedTurn.tool("notify", {"email": EMAIL}),
            ScriptedTurn.answer("notified"),
        ],
    )

    await harness.runtime.run("solo", QUESTION)

    # The second request replays the tool call, which is where the value appears.
    replayed = harness.provider.calls[1].messages
    call = next(message for message in replayed if message.tool_calls).tool_calls[0]
    assert call.arguments == {"email": EMAIL}
    assert harness.provider.calls[1].redactions == (("email", EMAIL),)


async def test_a_value_that_appears_only_in_free_text_is_recorded_as_written(
    captured: InMemorySpanExporter,
) -> None:
    """The stated limit, asserted: no declared name matches prose, so nothing binds."""
    harness = build(
        _document(),
        tools=[_email_tool()],
        script=[ScriptedTurn.answer("noted")],
    )

    await harness.runtime.run("solo", f"the customer is {EMAIL}")

    assert harness.provider.calls[0].redactions == ()
    assert any(EMAIL in text for text in _recorded_content(captured))


async def test_a_resumed_run_relearns_bindings_from_the_checkpoint_transcript(
    captured: InMemorySpanExporter,
) -> None:
    """A pause hands the caller a checkpoint, so the bindings must be re-derived."""
    admin = Principal(roles=frozenset({"admin"}))
    harness = build(
        _document(hitl=True),
        tools=[_email_tool()],
        script=[
            ScriptedTurn.tool("notify", {"email": EMAIL}),
            ScriptedTurn.answer("notified"),
        ],
    )

    paused = await harness.runtime.run("solo", QUESTION, principal=admin)
    assert paused.checkpoint is not None
    resumed = await harness.runtime.resume(paused.checkpoint, HumanDecision.APPROVE)

    assert resumed.status is RunStatus.COMPLETED
    recorded = _recorded_content(captured)
    assert recorded, "the resume recorded no content, so nothing was tested"
    assert all(EMAIL not in text for text in recorded)
