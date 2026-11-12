"""The local JSONL trace sink.

The sink exists so the CLI can read traces without the application installing an
exporter, so these tests assert on the bytes actually written. A test against a mock
writer would prove nothing about whether a file appears, which is the only thing the
feature promises.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aid_runtime import (
    ATTRIBUTES,
    GEN_AI_OPERATION_CHAT,
    TRACE_DIR_ENV,
    CompletionRequest,
    ModelGateway,
    local_trace_enabled,
)
from aid_runtime.local_trace import finish_span, wrap_span
from aid_runtime.tracing import CONTENT_ENV, agent_span, get_tracer, llm_span, record_cost


class BoomError(Exception):
    """A failure with an unmistakable message."""


def _raise_boom() -> None:
    raise BoomError("boom")


def _lines(directory: Path) -> list[dict[str, Any]]:
    (path,) = directory.glob("trace-*.jsonl")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _clear(directory: Path) -> None:
    for leftover in directory.glob("trace-*.jsonl"):
        leftover.unlink()


def test_the_sink_is_off_unless_a_directory_is_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(TRACE_DIR_ENV, raising=False)

    assert local_trace_enabled() is False
    span = get_tracer().start_span("unrecorded")
    assert wrap_span(span, name="unrecorded", kind="CLIENT") is span


def test_nothing_is_written_without_the_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(TRACE_DIR_ENV, raising=False)

    with llm_span(model="m", provider="p"):
        pass

    assert list(tmp_path.iterdir()) == []


def test_one_line_per_span(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))

    with llm_span(model="m", provider="p") as span:
        record_cost(span, 0.25)

    (record,) = _lines(tmp_path)
    assert record["name"] == f"{GEN_AI_OPERATION_CHAT} m"
    assert record["kind"] == "CLIENT"
    assert record["parent_span_id"] is None
    assert len(str(record["trace_id"])) == 32
    assert len(str(record["span_id"])) == 16
    assert record["attributes"][ATTRIBUTES["system"]] == "p"
    assert record["attributes"][ATTRIBUTES["cost_usd"]] == 0.25
    assert record["status"] is None
    assert float(str(record["duration_ms"])) >= 0


def test_a_child_span_points_at_its_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))

    with agent_span(agent_id="support", engine="native"), llm_span(model="m", provider="p"):
        pass

    # The inner span ends first, so it is the first line.
    call, agent = _lines(tmp_path)
    assert call["parent_span_id"] == agent["span_id"]
    assert call["trace_id"] == agent["trace_id"]
    assert agent["parent_span_id"] is None


def test_a_failure_is_recorded_once_with_an_error_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))

    with pytest.raises(BoomError, match="boom"), llm_span(model="m", provider="p"):
        _raise_boom()

    (record,) = _lines(tmp_path)
    assert record["status"]["code"] == "ERROR"
    assert record["status"]["message"] == "boom"
    (event,) = record["events"]
    assert event["name"] == "exception"
    assert event["attributes"]["exception.message"] == "boom"


def test_attributes_json_cannot_hold_are_coerced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))

    span = get_tracer().start_span("coerced")
    recorded = wrap_span(
        span,
        name="coerced",
        kind="CLIENT",
        attributes={"tuple": (1, "two"), "infinite": math.inf, "object": Path("a/b")},
    )
    finish_span(recorded)

    (record,) = _lines(tmp_path)
    assert record["attributes"]["tuple"] == [1, "two"]
    assert record["attributes"]["infinite"] == "inf"
    assert record["attributes"]["object"] == str(Path("a/b"))


def test_ending_twice_writes_one_line(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))

    with llm_span(model="m", provider="p") as span:
        span.end()
        span.end()

    assert len(_lines(tmp_path)) == 1


def test_the_opentelemetry_path_still_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("aid-runtime-tests")

    with llm_span(model="m", provider="p", tracer=tracer):
        pass

    (recorded,) = exporter.get_finished_spans()
    assert recorded.name == f"{GEN_AI_OPERATION_CHAT} m"
    (line,) = _lines(tmp_path)
    assert line["name"] == recorded.name


async def test_the_gateway_captures_payloads_only_when_asked(
    gateway: ModelGateway, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A real gateway call is the only thing that proves the wiring, not the helper."""
    monkeypatch.delenv(CONTENT_ENV, raising=False)
    monkeypatch.setenv(TRACE_DIR_ENV, str(tmp_path))
    await gateway.generate("small", CompletionRequest.prompt("what is it"))

    calls = [record for record in _lines(tmp_path) if record["kind"] == "CLIENT"]
    assert calls
    assert all(ATTRIBUTES["input_text"] not in call["attributes"] for call in calls)
    assert all(ATTRIBUTES["output_text"] not in call["attributes"] for call in calls)

    # A second run in a clean directory, so the assertion isolates the captured call.
    _clear(tmp_path)

    monkeypatch.setenv(CONTENT_ENV, "1")
    await gateway.generate("small", CompletionRequest.prompt("what is it"))

    (captured,) = [record for record in _lines(tmp_path) if record["kind"] == "CLIENT"]
    assert captured["attributes"][ATTRIBUTES["input_text"]] == "user: what is it"
    assert str(captured["attributes"][ATTRIBUTES["output_text"]]).strip()
