"""The Anthropic adapter, against a `MockTransport`.

The point of these tests is the dialect, not the HTTP: which fields Anthropic
requires, how a tool result is expressed, and how its SSE events become chunks.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from aid_runtime import (
    AnthropicProvider,
    Capability,
    CompletionRequest,
    CostProfile,
    Message,
    ModelSpec,
    ProviderError,
    ProviderResponseError,
    ToolCall,
    ToolDefinition,
)
from aid_runtime.providers import ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_BASE_URL

BASE_URL = "https://api.example.test/v1"
API_KEY = "sk-ant-test-not-a-real-key"


class Recorder:
    """A transport handler that records requests and replays queued responses."""

    def __init__(self, *responses: httpx.Response) -> None:
        self.requests: list[httpx.Request] = []
        self.payloads: list[dict[str, Any]] = []
        self._responses = list(responses)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.payloads.append(json.loads(request.content))
        if not self._responses:
            raise AssertionError("the adapter sent more requests than the test queued responses")
        return self._responses.pop(0)


def _model(max_output_tokens: int = 4096) -> ModelSpec:
    return ModelSpec(
        name="claude-test-model",
        provider="anthropic",
        cost=CostProfile(input_per_1k_usd=0.1, output_per_1k_usd=0.2),
        context_window=8000,
        max_output_tokens=max_output_tokens,
    )


def _provider(
    recorder: Recorder,
    *,
    api_key: str | None = None,
    max_attempts: int = 3,
    extra_headers: dict[str, str] | None = None,
) -> AnthropicProvider:
    return AnthropicProvider(
        base_url=BASE_URL,
        api_key=api_key,
        max_attempts=max_attempts,
        backoff_seconds=0.0,
        extra_headers=extra_headers,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )


def _reply(*blocks: Any, **extra: Any) -> httpx.Response:
    body: dict[str, Any] = {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-test-model",
        "content": list(blocks) or [{"type": "text", "text": "ok"}],
        "stop_reason": extra.pop("stop_reason", "end_turn"),
        "usage": extra.pop("usage", {"input_tokens": 5, "output_tokens": 7}),
    }
    body.update(extra)
    return httpx.Response(200, json=body)


def _text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def _sse(*events: dict[str, Any]) -> httpx.Response:
    body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
    return httpx.Response(200, content=body.encode("utf-8"))


def _start(block: dict[str, Any]) -> dict[str, Any]:
    return {"type": "content_block_start", "index": 0, "content_block": block}


def _text_delta(text: str) -> dict[str, Any]:
    return {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": text},
    }


def _json_delta(partial: str) -> dict[str, Any]:
    return {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "input_json_delta", "partial_json": partial},
    }


def _status(code: int, text: str = "nope") -> httpx.Response:
    return httpx.Response(code, text=text)


async def test_the_request_targets_the_messages_endpoint() -> None:
    recorder = Recorder(_reply())
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    (request,) = recorder.requests
    assert request.method == "POST"
    assert str(request.url) == f"{BASE_URL}/messages"
    assert request.headers["content-type"] == "application/json"
    assert result.text == "ok"


async def test_the_key_is_sent_as_x_api_key_with_a_pinned_wire_version() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder, api_key=API_KEY).complete(
        CompletionRequest.prompt("hi"), model=_model()
    )

    headers = recorder.requests[0].headers
    assert headers["x-api-key"] == API_KEY
    assert headers["anthropic-version"] == ANTHROPIC_VERSION
    assert "authorization" not in headers


async def test_no_key_header_without_a_key() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert "x-api-key" not in recorder.requests[0].headers


async def test_extra_headers_are_sent_alongside_the_request() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder, extra_headers={"x-tenant": "acme"}).complete(
        CompletionRequest.prompt("hi"), model=_model()
    )

    assert recorder.requests[0].headers["x-tenant"] == "acme"


async def test_the_system_prompt_is_a_top_level_field_not_a_message() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder).complete(
        CompletionRequest.prompt("hi", system="be nice"), model=_model()
    )

    payload = recorder.payloads[0]
    assert payload["system"] == "be nice"
    assert payload["messages"] == [{"role": "user", "content": "hi"}]


async def test_adjacent_system_turns_are_joined_into_one_system_field() -> None:
    recorder = Recorder(_reply())
    request = CompletionRequest(
        messages=(
            Message.system("be nice"),
            Message.system("be brief"),
            Message.user("hi"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    assert recorder.payloads[0]["system"] == "be nice\n\nbe brief"


async def test_no_system_field_is_sent_when_the_transcript_has_none() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert "system" not in recorder.payloads[0]


async def test_max_tokens_is_always_sent_because_the_api_requires_it() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert recorder.payloads[0]["max_tokens"] == 4096


async def test_max_tokens_is_clamped_to_the_pinned_model_ceiling() -> None:
    recorder = Recorder(_reply(), _reply())
    provider = _provider(recorder)
    model = _model(max_output_tokens=100)

    await provider.complete(
        CompletionRequest(messages=(Message.user("hi"),), max_output_tokens=50), model=model
    )
    await provider.complete(
        CompletionRequest(messages=(Message.user("hi"),), max_output_tokens=4000), model=model
    )

    assert recorder.payloads[0]["max_tokens"] == 50
    assert recorder.payloads[1]["max_tokens"] == 100


async def test_temperature_and_stop_are_forwarded_only_when_they_are_set() -> None:
    recorder = Recorder(_reply(), _reply())
    provider = _provider(recorder)

    await provider.complete(
        CompletionRequest(messages=(Message.user("hi"),), temperature=0.0, stop=("END",)),
        model=_model(),
    )
    await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert recorder.payloads[0]["temperature"] == 0.0
    assert recorder.payloads[0]["stop_sequences"] == ["END"]
    assert "temperature" not in recorder.payloads[1]
    assert "stop_sequences" not in recorder.payloads[1]


async def test_tools_are_encoded_with_an_input_schema_not_a_function_wrapper() -> None:
    recorder = Recorder(_reply())
    definition = ToolDefinition(name="weather", description="Report the weather.")
    await _provider(recorder).complete(
        CompletionRequest(messages=(Message.user("hi"),), tools=(definition,)), model=_model()
    )

    assert recorder.payloads[0]["tools"] == [
        {
            "name": "weather",
            "description": "Report the weather.",
            "input_schema": {"type": "object", "properties": {}},
        }
    ]


async def test_an_assistant_tool_turn_becomes_a_tool_use_block() -> None:
    recorder = Recorder(_reply())
    call = ToolCall(id="toolu_1", name="weather", arguments={"city": "Lima"})
    request = CompletionRequest(
        messages=(
            Message.user("what is the weather?"),
            Message.assistant_tool_calls("checking", (call,)),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    assert recorder.payloads[0]["messages"][1] == {
        "role": "assistant",
        "content": [
            _text("checking"),
            {"type": "tool_use", "id": "toolu_1", "name": "weather", "input": {"city": "Lima"}},
        ],
    }


async def test_a_tool_turn_becomes_a_tool_result_block_on_a_user_message() -> None:
    recorder = Recorder(_reply())
    call = ToolCall(id="toolu_1", name="weather", arguments={})
    request = CompletionRequest(
        messages=(
            Message.user("what is the weather?"),
            Message.assistant_tool_calls("", (call,)),
            Message.tool("toolu_1", "sunny"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    assert recorder.payloads[0]["messages"][2] == {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "sunny"}],
    }


async def test_adjacent_tool_results_are_merged_into_one_user_turn() -> None:
    recorder = Recorder(_reply())
    calls = (
        ToolCall(id="toolu_1", name="weather", arguments={}),
        ToolCall(id="toolu_2", name="time", arguments={}),
    )
    request = CompletionRequest(
        messages=(
            Message.user("weather and time?"),
            Message.assistant_tool_calls("", calls),
            Message.tool("toolu_1", "sunny"),
            Message.tool("toolu_2", "noon"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    turns = recorder.payloads[0]["messages"]
    assert turns[2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "sunny"},
            {"type": "tool_result", "tool_use_id": "toolu_2", "content": "noon"},
        ],
    }
    assert len(turns) == 3


async def test_a_text_turn_after_a_tool_result_stays_a_separate_turn() -> None:
    recorder = Recorder(_reply())
    request = CompletionRequest(
        messages=(
            Message.user("hi"),
            Message.tool("toolu_1", "sunny"),
            Message.user("thanks"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    turns = recorder.payloads[0]["messages"]
    assert [turn["role"] for turn in turns] == ["user", "user", "user"]
    assert turns[2]["content"] == "thanks"


async def test_every_text_block_is_concatenated() -> None:
    recorder = Recorder(_reply(_text("hello "), _text("there")))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "hello there"


async def test_tool_use_blocks_are_mapped_onto_tool_calls() -> None:
    recorder = Recorder(
        _reply(
            _text("checking"),
            {"type": "tool_use", "id": "toolu_1", "name": "weather", "input": {"city": "Lima"}},
            stop_reason="tool_use",
        )
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "checking"
    assert result.finish_reason == "tool-calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].id == "toolu_1"
    assert result.tool_calls[0].name == "weather"
    assert result.tool_calls[0].arguments == {"city": "Lima"}


async def test_unusable_blocks_are_skipped_without_failing_the_call() -> None:
    recorder = Recorder(
        _reply(
            "not-an-object",
            {"type": "thinking", "thinking": "hmm"},
            {"type": "tool_use", "id": "", "name": "weather", "input": {}},
            {"type": "tool_use", "id": "toolu_2", "name": "kept", "input": "not-a-mapping"},
            _text("text survives"),
        )
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "text survives"
    assert [call.name for call in result.tool_calls] == ["kept"]
    assert result.tool_calls[0].arguments == {}


async def test_the_response_is_mapped_onto_the_runtime_types() -> None:
    recorder = Recorder(_reply(_text("hello there")))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "hello there"
    assert result.model == "claude-test-model"
    assert result.provider == "anthropic"
    assert result.usage.input_tokens == 5
    assert result.usage.output_tokens == 7
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()


async def test_missing_usage_is_reported_as_zero_rather_than_omitted() -> None:
    recorder = Recorder(httpx.Response(200, json={"content": [_text("x")]}))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.usage.input_tokens == 0
    assert result.usage.output_tokens == 0


async def test_a_response_model_overrides_the_pinned_name() -> None:
    recorder = Recorder(_reply(model="claude-test-model-2026-01-01"))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.model == "claude-test-model-2026-01-01"


async def test_every_stop_reason_the_api_defines_is_mapped() -> None:
    codes = {
        "end_turn": "stop",
        "stop_sequence": "stop",
        "max_tokens": "length",
        "tool_use": "tool-calls",
        "refusal": "content-filter",
        "something-new": "stop",
    }
    recorder = Recorder(*(_reply(stop_reason=code) for code in codes))
    provider = _provider(recorder)

    for code, expected in codes.items():
        result = await provider.complete(CompletionRequest.prompt("hi"), model=_model())
        assert result.finish_reason == expected, code


async def test_a_body_without_content_blocks_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json={"type": "message"}))
    with pytest.raises(ProviderResponseError, match="no content blocks"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())


async def test_a_retryable_status_is_retried_and_then_succeeds() -> None:
    recorder = Recorder(_status(429, "slow down"), _reply(_text("recovered")))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert len(recorder.requests) == 2
    assert result.text == "recovered"


async def test_a_retryable_status_on_the_last_attempt_is_surfaced_as_it_is() -> None:
    recorder = Recorder(_status(529), _status(529), _status(529, "overloaded"))
    with pytest.raises(ProviderError, match="returned 529: overloaded"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert len(recorder.requests) == 3


async def test_a_client_error_is_not_retried_and_carries_the_body() -> None:
    recorder = Recorder(_status(400, "bad model name"))
    with pytest.raises(ProviderError) as excinfo:
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert len(recorder.requests) == 1
    assert "400" in str(excinfo.value)
    assert "bad model name" in str(excinfo.value)


async def test_one_attempt_means_no_retry() -> None:
    recorder = Recorder(_status(429))
    with pytest.raises(ProviderError, match="returned 429"):
        await _provider(recorder, max_attempts=1).complete(
            CompletionRequest.prompt("hi"), model=_model()
        )

    assert len(recorder.requests) == 1


async def test_a_transport_error_is_retried_and_then_succeeds() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("connection refused")
        return _reply(_text("second try"))

    provider = AnthropicProvider(
        base_url=BASE_URL,
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    result = await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert len(calls) == 2
    assert result.text == "second try"


async def test_a_persistent_transport_error_fails_with_its_cause() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    provider = AnthropicProvider(
        base_url=BASE_URL,
        max_attempts=2,
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(ProviderError, match="failed after 2 attempt") as excinfo:
        await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert isinstance(excinfo.value.__cause__, httpx.ConnectError)


async def test_a_non_json_body_is_reported_with_its_content() -> None:
    recorder = Recorder(httpx.Response(200, text="<html>gateway</html>"))
    with pytest.raises(ProviderResponseError) as excinfo:
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert "non-JSON" in str(excinfo.value)
    assert "gateway" in str(excinfo.value)


async def test_a_json_body_that_is_not_an_object_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json=[1, 2, 3]))
    with pytest.raises(ProviderResponseError, match="non-object body"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())


async def test_streaming_maps_text_deltas_and_the_terminal_usage() -> None:
    recorder = Recorder(
        _sse(
            {
                "type": "message_start",
                "message": {"usage": {"input_tokens": 5, "output_tokens": 0}},
            },
            _start(_text("")),
            _text_delta("He"),
            _text_delta("llo"),
            {"type": "content_block_stop", "index": 0},
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 7},
            },
            {"type": "message_stop"},
        )
    )
    provider = _provider(recorder)

    chunks = [
        chunk async for chunk in provider.stream(CompletionRequest.prompt("hi"), model=_model())
    ]

    assert "".join(chunk.delta for chunk in chunks) == "Hello"
    assert recorder.payloads[0]["stream"] is True
    assert chunks[0].usage is not None
    assert chunks[0].usage.input_tokens == 5
    terminal = [chunk for chunk in chunks if chunk.finish_reason][-1]
    assert terminal.finish_reason == "stop"
    assert terminal.usage is not None
    assert terminal.usage.output_tokens == 7


async def test_streaming_ignores_events_it_cannot_represent() -> None:
    recorder = Recorder(
        _sse(
            {"type": "ping"},
            _start({"type": "tool_use"}),
            _json_delta("{"),
            _text_delta(""),
        )
    )
    provider = _provider(recorder)

    chunks = [
        chunk async for chunk in provider.stream(CompletionRequest.prompt("hi"), model=_model())
    ]

    assert chunks == []


async def test_streaming_tool_use_reports_the_finish_reason_without_the_call() -> None:
    recorder = Recorder(
        _sse(
            _start({"type": "tool_use", "id": "toolu_1", "name": "weather"}),
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        )
    )
    provider = _provider(recorder)

    chunks = [
        chunk async for chunk in provider.stream(CompletionRequest.prompt("hi"), model=_model())
    ]

    assert [chunk.finish_reason for chunk in chunks] == ["tool-calls"]


async def test_a_stream_error_status_is_raised_before_any_chunk() -> None:
    recorder = Recorder(_status(400, "bad model name"))
    provider = _provider(recorder)

    with pytest.raises(ProviderError, match="400"):
        async for _ in provider.stream(CompletionRequest.prompt("hi"), model=_model()):
            pass


async def test_a_stream_with_non_json_data_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, content=b"data: {not json\n\n"))
    provider = _provider(recorder)

    with pytest.raises(ProviderResponseError, match="non-JSON"):
        async for _ in provider.stream(CompletionRequest.prompt("hi"), model=_model()):
            pass


async def test_a_stream_failure_is_not_retried() -> None:
    recorder = Recorder(_status(503, "down"), _sse({"type": "message_stop"}))
    provider = _provider(recorder)

    with pytest.raises(ProviderError, match="503"):
        async for _ in provider.stream(CompletionRequest.prompt("hi"), model=_model()):
            pass

    assert len(recorder.requests) == 1


def test_the_adapter_declares_tool_calling_structured_output_and_streaming() -> None:
    provider = AnthropicProvider(base_url=BASE_URL)

    assert provider.capabilities == frozenset(
        {Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT, Capability.STREAMING}
    )


def test_the_adapter_does_not_advertise_embeddings() -> None:
    assert Capability.EMBEDDINGS not in AnthropicProvider(base_url=BASE_URL).capabilities


def test_the_default_base_url_is_anthropics_and_carries_no_version_path() -> None:
    assert DEFAULT_ANTHROPIC_BASE_URL == "https://api.anthropic.com/v1"
    assert AnthropicProvider()._base_url == "https://api.anthropic.com/v1"


def test_the_base_url_must_be_an_absolute_http_url() -> None:
    with pytest.raises(ValueError, match="must be an absolute http"):
        AnthropicProvider(base_url="api.anthropic.com/v1")


def test_the_attempt_limit_must_be_positive() -> None:
    with pytest.raises(ValueError, match="max_attempts must be at least 1"):
        AnthropicProvider(base_url=BASE_URL, max_attempts=0)


def test_the_provider_name_is_configurable() -> None:
    assert AnthropicProvider(base_url=BASE_URL, name="bedrock-anthropic").name == (
        "bedrock-anthropic"
    )
    assert AnthropicProvider(base_url=BASE_URL).name == "anthropic"


async def test_a_trailing_slash_in_the_base_url_does_not_double_up() -> None:
    recorder = Recorder(_reply())
    provider = AnthropicProvider(
        base_url=f"{BASE_URL}/",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )
    await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert str(recorder.requests[0].url) == f"{BASE_URL}/messages"


async def test_aclose_is_idempotent() -> None:
    provider = AnthropicProvider(base_url=BASE_URL, backoff_seconds=0.0)

    await provider.aclose()
    await provider.aclose()


async def test_aclose_leaves_a_caller_supplied_client_open() -> None:
    recorder = Recorder(_reply(), _reply())
    async with httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)) as client:
        provider = AnthropicProvider(base_url=BASE_URL, backoff_seconds=0.0, client=client)
        await provider.aclose()

        result = await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "ok"
