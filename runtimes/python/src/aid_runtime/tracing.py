"""OpenTelemetry tracing using the GenAI semantic conventions.

Attribute names come from the OpenTelemetry GenAI conventions (``gen_ai.*``) so
spans land in any OTLP backend already understood as model telemetry. Attributes
the conventions do not cover -- which pinned alias produced the call, and what it
cost -- are namespaced under ``aid.*`` rather than smuggled into a ``gen_ai.*``
key with the wrong meaning.

Only the OpenTelemetry *API* is a runtime dependency. With no tracer provider
installed every call here is a no-op, which is the correct behaviour for a library
that must not decide a host application's telemetry setup for it.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from aid_runtime.types import TokenUsage

__all__ = [
    "ATTRIBUTES",
    "GEN_AI_OPERATION_CHAT",
    "agent_span",
    "aid_attributes",
    "get_tracer",
    "llm_span",
    "record_attributes",
    "record_cost",
    "record_exception",
    "record_usage",
]

GEN_AI_OPERATION_CHAT = "chat"

#: The GenAI semantic-convention attribute keys this runtime writes.
ATTRIBUTES: dict[str, str] = {
    "system": "gen_ai.system",
    "operation": "gen_ai.operation.name",
    "request_model": "gen_ai.request.model",
    "request_temperature": "gen_ai.request.temperature",
    "request_max_tokens": "gen_ai.request.max_tokens",
    "response_model": "gen_ai.response.model",
    "response_finish_reasons": "gen_ai.response.finish_reasons",
    "input_tokens": "gen_ai.usage.input_tokens",
    "output_tokens": "gen_ai.usage.output_tokens",
    # Framework-specific, deliberately outside the gen_ai namespace.
    "alias": "aid.model.alias",
    "cost_usd": "aid.cost.usd",
    "attempts": "aid.gateway.attempts",
    "tool_names": "aid.tool.names",
    # Agent loop. ``agent_status`` is the run's terminal state, recorded on the
    # agent span so a paused run is distinguishable from a completed one without
    # reading the loop's return value.
    "agent_id": "aid.agent.id",
    "agent_engine": "aid.agent.engine",
    "agent_steps": "aid.agent.steps",
    "agent_status": "aid.agent.status",
    "agent_transfer_to": "aid.agent.transfer.to",
    "agent_delegate_to": "aid.agent.delegate.to",
    "agent_budget_degraded": "aid.agent.budget.degraded",
    "agent_budget_from": "aid.agent.budget.from",
    "agent_budget_to": "aid.agent.budget.to",
    # Human-in-the-loop: who was asked, on what channel, at which step, and what
    # they decided. A pause is an ordinary outcome, not an error.
    "hitl_channel": "aid.hitl.channel",
    "hitl_when": "aid.hitl.when",
    "hitl_decision": "aid.hitl.decision",
    "hitl_step": "aid.hitl.step",
    "hitl_phase": "aid.hitl.phase",
    "memory_scope": "aid.memory.scope",
    "memory_entries": "aid.memory.entries",
    "memory_tokens": "aid.memory.tokens",
}

_TRACER_NAME = "aid_runtime"


def get_tracer(name: str = _TRACER_NAME) -> trace.Tracer:
    return trace.get_tracer(name)


@contextlib.contextmanager
def llm_span(
    *,
    model: str,
    provider: str,
    operation: str = GEN_AI_OPERATION_CHAT,
    alias: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tracer: trace.Tracer | None = None,
) -> Iterator[Span]:
    """Open a CLIENT span for one model call and close it with an error status."""
    active = tracer or get_tracer()
    attributes: dict[str, Any] = {
        ATTRIBUTES["system"]: provider,
        ATTRIBUTES["operation"]: operation,
        ATTRIBUTES["request_model"]: model,
    }
    if temperature is not None:
        attributes[ATTRIBUTES["request_temperature"]] = temperature
    if max_tokens is not None:
        attributes[ATTRIBUTES["request_max_tokens"]] = max_tokens
    if alias is not None:
        attributes[ATTRIBUTES["alias"]] = alias

    with active.start_as_current_span(
        f"{operation} {model}",
        kind=SpanKind.CLIENT,
        attributes=attributes,
        # The exception is recorded once, explicitly, from the ``except`` below.
        # Left at their defaults these would record it a second time and overwrite
        # the status description with the exception's repr.
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        try:
            yield span
        except BaseException as exc:
            record_exception(span, exc)
            raise


def record_usage(span: Span, usage: TokenUsage) -> None:
    span.set_attribute(ATTRIBUTES["input_tokens"], usage.input_tokens)
    span.set_attribute(ATTRIBUTES["output_tokens"], usage.output_tokens)


def record_attributes(span: Span, **values: Any) -> None:
    """Attach ``aid.*`` attributes by short name, skipping ``None`` values.

    A recorded ``None`` would look like a decided empty value, so an attribute
    that does not apply is omitted rather than nulled.
    """
    for key, value in aid_attributes(**values).items():
        if value is not None:
            span.set_attribute(key, value)


@contextlib.contextmanager
def agent_span(
    *,
    agent_id: str,
    engine: str,
    tracer: trace.Tracer | None = None,
) -> Iterator[Span]:
    """Open an INTERNAL span for one agent's turn.

    INTERNAL, not CLIENT: an agent is not a remote service, and the model calls it
    makes open their own CLIENT child spans.
    """
    active = tracer or get_tracer()
    with active.start_as_current_span(
        f"invoke_agent {agent_id}",
        kind=SpanKind.INTERNAL,
        attributes=aid_attributes(agent_id=agent_id, agent_engine=engine),
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        try:
            yield span
        except BaseException as exc:
            record_exception(span, exc)
            raise


def record_hitl(
    span: Span,
    *,
    phase: str,
    channel: str = "",
    decision: str | None = None,
    when: str | None = None,
    step: int | None = None,
) -> None:
    """Record one pause or resume of a human-in-the-loop gate.

    An event, not only attributes: a run can pause and resume more than once, and a
    span attribute would silently keep the last decision while the span still looked
    like it paused exactly once. ``phase`` is ``pause`` or ``resume``.
    """
    attributes: dict[str, Any] = {
        ATTRIBUTES["hitl_phase"]: phase,
        ATTRIBUTES["hitl_channel"]: channel,
    }
    if when is not None:
        attributes[ATTRIBUTES["hitl_when"]] = when
    if decision is not None:
        attributes[ATTRIBUTES["hitl_decision"]] = decision
    if step is not None:
        attributes[ATTRIBUTES["hitl_step"]] = step
    span.add_event("aid.hitl", attributes)


def record_cost(span: Span, cost_usd: float, *, alias: str | None = None) -> None:
    span.set_attribute(ATTRIBUTES["cost_usd"], cost_usd)
    if alias is not None:
        span.set_attribute(ATTRIBUTES["alias"], alias)


def record_exception(span: Span, exc: BaseException) -> None:
    span.record_exception(exc)
    span.set_status(Status(StatusCode.ERROR, str(exc)))


def aid_attributes(**values: Any) -> dict[str, Any]:
    """Map short names from :data:`ATTRIBUTES` to their namespaced keys.

    Unmapped names pass through, so a caller can attach a bespoke ``aid.*``
    attribute without editing this module.
    """
    return {ATTRIBUTES.get(key, key): value for key, value in values.items()}
