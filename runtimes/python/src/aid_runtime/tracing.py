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
    "aid_attributes",
    "get_tracer",
    "llm_span",
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
