"""OTel GenAI tracing.

These assertions read attributes back from a real ``TracerProvider``, because the
no-op tracer a library gets by default silently discards everything -- a test that
passed against it would prove nothing about what gets recorded.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode, Tracer

from aid_runtime import ATTRIBUTES, GEN_AI_OPERATION_CHAT, TokenUsage, aid_attributes
from aid_runtime.tracing import (
    get_tracer,
    llm_span,
    record_cost,
    record_exception,
    record_usage,
)


class BoomError(Exception):
    """A stand-in for a provider failure."""


def _recording_tracer() -> tuple[Tracer, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("aid-runtime-tests"), exporter


def _attributes_of(exporter: InMemorySpanExporter) -> dict[str, Any]:
    (recorded,) = exporter.get_finished_spans()
    assert recorded.attributes is not None
    return dict(recorded.attributes)


def test_attribute_names_follow_the_genai_semantic_conventions() -> None:
    assert ATTRIBUTES["system"] == "gen_ai.system"
    assert ATTRIBUTES["operation"] == "gen_ai.operation.name"
    assert ATTRIBUTES["request_model"] == "gen_ai.request.model"
    assert ATTRIBUTES["request_temperature"] == "gen_ai.request.temperature"
    assert ATTRIBUTES["request_max_tokens"] == "gen_ai.request.max_tokens"
    assert ATTRIBUTES["response_model"] == "gen_ai.response.model"
    assert ATTRIBUTES["response_finish_reasons"] == "gen_ai.response.finish_reasons"
    assert ATTRIBUTES["input_tokens"] == "gen_ai.usage.input_tokens"
    assert ATTRIBUTES["output_tokens"] == "gen_ai.usage.output_tokens"


def test_framework_specific_attributes_stay_out_of_the_genai_namespace() -> None:
    framework = {value for value in ATTRIBUTES.values() if not value.startswith("gen_ai.")}

    assert framework == {
        "aid.model.alias",
        "aid.cost.usd",
        "aid.gateway.attempts",
        "aid.tool.names",
    }


def test_a_span_carries_the_request_it_was_opened_for() -> None:
    tracer, exporter = _recording_tracer()

    with llm_span(
        model="fake-small-1",
        provider="fake",
        alias="small",
        temperature=0.2,
        max_tokens=64,
        tracer=tracer,
    ) as span:
        record_usage(span, TokenUsage(input_tokens=12, output_tokens=34))
        record_cost(span, 0.000123)

    (recorded,) = exporter.get_finished_spans()
    assert recorded.name == "chat fake-small-1"
    assert recorded.kind is SpanKind.CLIENT

    attributes = _attributes_of(exporter)
    assert attributes["gen_ai.system"] == "fake"
    assert attributes["gen_ai.operation.name"] == "chat"
    assert attributes["gen_ai.request.model"] == "fake-small-1"
    assert attributes["gen_ai.request.temperature"] == 0.2
    assert attributes["gen_ai.request.max_tokens"] == 64
    assert attributes["aid.model.alias"] == "small"
    assert attributes["gen_ai.usage.input_tokens"] == 12
    assert attributes["gen_ai.usage.output_tokens"] == 34
    assert attributes["aid.cost.usd"] == 0.000123


def test_unset_sampling_and_alias_attributes_are_omitted_entirely() -> None:
    tracer, exporter = _recording_tracer()

    with llm_span(model="m", provider="p", tracer=tracer):
        pass

    attributes = _attributes_of(exporter)
    assert "gen_ai.request.temperature" not in attributes
    assert "gen_ai.request.max_tokens" not in attributes
    assert "aid.model.alias" not in attributes


def test_a_custom_operation_names_the_span_and_the_attribute() -> None:
    tracer, exporter = _recording_tracer()

    with llm_span(model="m", provider="p", operation="embeddings", tracer=tracer):
        pass

    (recorded,) = exporter.get_finished_spans()
    assert recorded.name == "embeddings m"
    assert _attributes_of(exporter)["gen_ai.operation.name"] == "embeddings"


def test_the_default_operation_is_chat() -> None:
    assert GEN_AI_OPERATION_CHAT == "chat"


def test_record_cost_does_not_clear_an_alias_it_was_not_given() -> None:
    tracer, exporter = _recording_tracer()

    with llm_span(model="m", provider="p", alias="small", tracer=tracer) as span:
        record_cost(span, 0.25, alias="small")
        record_cost(span, 0.5)

    attributes = _attributes_of(exporter)
    assert attributes["aid.cost.usd"] == 0.5
    assert attributes["aid.model.alias"] == "small"


def test_a_failing_call_is_recorded_exactly_once_on_the_span() -> None:
    tracer, exporter = _recording_tracer()

    with pytest.raises(BoomError, match="boom"), llm_span(model="m", provider="p", tracer=tracer):
        raise BoomError("boom")

    (recorded,) = exporter.get_finished_spans()
    assert recorded.status.status_code is StatusCode.ERROR
    assert recorded.status.description == "boom"

    # Exactly one event: the span must not record the exception a second time on
    # the way out of its own context manager.
    assert len(recorded.events) == 1
    assert recorded.events[0].name == "exception"
    event_attributes = recorded.events[0].attributes
    assert event_attributes is not None
    assert event_attributes["exception.type"] == f"{BoomError.__module__}.{BoomError.__qualname__}"
    assert event_attributes["exception.message"] == "boom"


def test_record_exception_sets_the_error_status_and_adds_an_event() -> None:
    tracer, exporter = _recording_tracer()

    with tracer.start_as_current_span(
        "direct", record_exception=False, set_status_on_exception=False
    ) as span:
        record_exception(span, ValueError("nope"))

    (recorded,) = exporter.get_finished_spans()
    assert recorded.status.status_code is StatusCode.ERROR
    assert recorded.status.description == "nope"
    assert [event.name for event in recorded.events] == ["exception"]


def test_a_returning_span_is_left_ok() -> None:
    tracer, exporter = _recording_tracer()

    with llm_span(model="m", provider="p", tracer=tracer):
        pass

    (recorded,) = exporter.get_finished_spans()
    assert recorded.status.status_code is StatusCode.UNSET
    assert len(recorded.events) == 0


def test_the_module_default_tracer_is_usable_without_a_provider_installed() -> None:
    tracer = get_tracer("aid-runtime-tests")

    with llm_span(model="m", provider="p", tracer=tracer) as span:
        record_usage(span, TokenUsage(input_tokens=1, output_tokens=2))
        record_cost(span, 0.01)
        record_exception(span, BoomError("never recorded"))


def test_aid_attributes_renames_known_keys_and_passes_others_through() -> None:
    mapped = aid_attributes(alias="small", cost_usd=0.5, attempts=2, tenant_id="acme")

    assert mapped == {
        "aid.model.alias": "small",
        "aid.cost.usd": 0.5,
        "aid.gateway.attempts": 2,
        "tenant_id": "acme",
    }
