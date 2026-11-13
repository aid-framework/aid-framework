"""OpenTelemetry tracing using the GenAI semantic conventions.

Attribute names come from the OpenTelemetry GenAI conventions (``gen_ai.*``) so
spans land in any OTLP backend already understood as model telemetry. Attributes
the conventions do not cover -- which pinned alias produced the call, and what it
cost -- are namespaced under ``aid.*`` rather than smuggled into a ``gen_ai.*``
key with the wrong meaning.

Only the OpenTelemetry *API* is a runtime dependency, so every call here is a no-op in a
process that installed no provider. That is deliberate: a library must not decide a host
application's telemetry destination. Installing an exporter is the application's decision
and happens through :func:`aid_runtime.telemetry.configure_export`, which is what makes the
spans written here leave the process.
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator, Sequence
from typing import Any, Protocol

from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from aid_runtime.local_trace import finish_span, wrap_span
from aid_runtime.types import TokenUsage

__all__ = [
    "ATTRIBUTES",
    "CONTENT_ENV",
    "GEN_AI_OPERATION_CHAT",
    "MAX_CONTENT_CHARS",
    "GuardrailEvent",
    "agent_span",
    "aid_attributes",
    "content_capture_enabled",
    "get_tracer",
    "llm_span",
    "record_attributes",
    "record_content",
    "record_cost",
    "record_exception",
    "record_guardrail",
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
    # Guardrails. An event per hit rather than one attribute, for the same reason
    # HITL uses events: several guardrails can fire at one stage, and a single
    # attribute would keep only the last one while still looking complete.
    "guardrail_id": "aid.guardrail.id",
    "guardrail_stage": "aid.guardrail.stage",
    "guardrail_action": "aid.guardrail.action",
    "guardrail_policies": "aid.guardrail.policies",
    # Payload text. Written only when ``AID_TRACE_CONTENT`` asks for it; see
    # :func:`record_content` for why the default is off.
    "input_text": "aid.input.text",
    "output_text": "aid.output.text",
}

#: The environment variable that opts in to recording prompt and completion text.
CONTENT_ENV = "AID_TRACE_CONTENT"

#: Longest payload fragment a span records. A dataset needs enough of the input to
#: name the case, not a full transcript, and an unbounded attribute would put a
#: megabyte into one JSONL line.
MAX_CONTENT_CHARS = 4000

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
        recorded = wrap_span(
            span,
            name=f"{operation} {model}",
            kind=SpanKind.CLIENT.name,
            attributes=attributes,
        )
        try:
            yield recorded
        except BaseException as exc:
            record_exception(recorded, exc)
            raise
        finally:
            finish_span(recorded)


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


def content_capture_enabled() -> bool:
    """Whether ``AID_TRACE_CONTENT`` asks for prompt and completion text on spans."""
    return os.environ.get(CONTENT_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def record_content(span: Span, *, input_text: str | None, output_text: str | None) -> None:
    """Attach the prompt and the completion to a span **only** when asked to.

    Everything else this runtime records is a fact about a call -- a model, a token
    count, a price. Payloads are what a user said and what a model answered, so they
    stay out of the trace unless the operator names :data:`CONTENT_ENV`. Three
    reasons the default matters:

    - The sink writes to a local directory that a repository may commit and a CI log
      may echo, so text that is off by default cannot leak by accident.
    - Redaction happens before this call, in the caller that rendered the prompt: the
      gateway replaces every value the spec withholds with ``[redacted:<name>]`` in the
      text it hands to this function, so what arrives here is already the recordable
      form. This function does not redact, and must not: it receives prose, not the
      field bindings a value could be recognised by.
    - ``aid trace export --dataset`` is the one reader that wants the text, and it
      can only build a case from a run that recorded one.

    Empty and whitespace-only text is skipped, so a span that carried nothing does
    not look like a decided empty answer.
    """
    if not content_capture_enabled():
        return
    for key, value in (
        ("input_text", input_text),
        ("output_text", output_text),
    ):
        if value is None or value.strip() == "":
            continue
        span.set_attribute(ATTRIBUTES[key], value[:MAX_CONTENT_CHARS])


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
    attributes = aid_attributes(agent_id=agent_id, agent_engine=engine)
    with active.start_as_current_span(
        f"invoke_agent {agent_id}",
        kind=SpanKind.INTERNAL,
        attributes=attributes,
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        recorded = wrap_span(
            span,
            name=f"invoke_agent {agent_id}",
            kind=SpanKind.INTERNAL.name,
            attributes=attributes,
        )
        try:
            yield recorded
        except BaseException as exc:
            record_exception(recorded, exc)
            raise
        finally:
            finish_span(recorded)


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


class GuardrailEvent(Protocol):
    """The fields :func:`record_guardrail` reads from a fired guardrail.

    Structural on purpose. Importing ``GuardrailRecord`` would close a module cycle --
    ``guardrails`` imports the decision client, which imports this module, which would
    import ``guardrails`` again -- and a protocol keeps the annotation honest without
    the import.
    """

    @property
    def guardrail(self) -> str: ...

    @property
    def stage(self) -> str: ...

    @property
    def action(self) -> str: ...

    @property
    def policies(self) -> Sequence[str]: ...


def record_guardrail(span: Span, record: GuardrailEvent) -> None:
    """Record one guardrail hit as an ``aid.guardrail`` span event."""
    span.add_event(
        "aid.guardrail",
        {
            ATTRIBUTES["guardrail_id"]: record.guardrail,
            ATTRIBUTES["guardrail_stage"]: record.stage,
            ATTRIBUTES["guardrail_action"]: record.action,
            ATTRIBUTES["guardrail_policies"]: ",".join(record.policies),
        },
    )


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
