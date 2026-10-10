"""The one HTTP provider adapter, against a `MockTransport`.

No network is touched: the adapter's job is to shape a request and to interpret a
reply, and both are asserted on the bytes that would have gone over the wire.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from aid_runtime import (
    Capability,
    CompletionRequest,
    CostProfile,
    Message,
    ModelSpec,
    OpenAICompatibleProvider,
    ProviderError,
    ProviderResponseError,
    ToolDefinition,
)

BASE_URL = "https://api.example.test/v1"
API_KEY = "sk-test-not-a-real-key"


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
        name="http-test-model",
        provider="openai-compatible",
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
) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        base_url=BASE_URL,
        api_key=api_key,
        max_attempts=max_attempts,
        backoff_seconds=0.0,
        extra_headers=extra_headers,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )


def _reply(content: str = "ok", **extra: Any) -> httpx.Response:
    body: dict[str, Any] = {
        "model": "http-test-model",
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 7},
    }
    body.update(extra)
    return httpx.Response(200, json=body)


def _status(code: int, text: str = "nope") -> httpx.Response:
    return httpx.Response(code, text=text)


async def test_the_request_targets_the_chat_completions_endpoint() -> None:
    recorder = Recorder(_reply())
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    (request,) = recorder.requests
    assert request.method == "POST"
    assert str(request.url) == f"{BASE_URL}/chat/completions"
    assert request.headers["content-type"] == "application/json"
    assert result.text == "ok"


async def test_the_payload_carries_the_pinned_model_and_the_transcript() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder).complete(
        CompletionRequest.prompt("hi", system="be nice"), model=_model()
    )

    payload = recorder.payloads[0]
    assert payload["model"] == "http-test-model"
    assert payload["messages"] == [
        {"role": "system", "content": "be nice"},
        {"role": "user", "content": "hi"},
    ]
    assert "temperature" not in payload
    assert "max_tokens" not in payload
    assert "tools" not in payload
    assert "stop" not in payload


async def test_temperature_is_forwarded_only_when_it_is_set() -> None:
    recorder = Recorder(_reply(), _reply())
    provider = _provider(recorder)

    await provider.complete(
        CompletionRequest(messages=(Message.user("hi"),), temperature=0.0), model=_model()
    )
    await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert recorder.payloads[0]["temperature"] == 0.0
    assert "temperature" not in recorder.payloads[1]


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


async def test_tools_and_stop_sequences_are_encoded_for_the_wire() -> None:
    recorder = Recorder(_reply())
    definition = ToolDefinition(name="weather", description="Report the weather.")
    request = CompletionRequest(
        messages=(Message.user("hi"),), tools=(definition,), stop=("STOP", "\n\n")
    )

    await _provider(recorder).complete(request, model=_model())

    payload = recorder.payloads[0]
    assert payload["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "weather",
                "description": "Report the weather.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    assert payload["stop"] == ["STOP", "\n\n"]


async def test_the_api_key_is_sent_as_an_authorization_header() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder, api_key=API_KEY).complete(
        CompletionRequest.prompt("hi"), model=_model()
    )

    (request,) = recorder.requests
    assert API_KEY in request.headers["authorization"]


async def test_no_authorization_header_without_an_api_key() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert "authorization" not in recorder.requests[0].headers


async def test_extra_headers_are_sent_alongside_the_request() -> None:
    recorder = Recorder(_reply())
    await _provider(recorder, extra_headers={"x-tenant": "acme"}).complete(
        CompletionRequest.prompt("hi"), model=_model()
    )

    assert recorder.requests[0].headers["x-tenant"] == "acme"


async def test_the_response_is_mapped_onto_the_runtime_types() -> None:
    recorder = Recorder(_reply("hello there"))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "hello there"
    assert result.model == "http-test-model"
    assert result.provider == "openai-compatible"
    assert result.usage.input_tokens == 5
    assert result.usage.output_tokens == 7
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()


async def test_missing_usage_is_reported_as_zero_rather_than_omitted() -> None:
    recorder = Recorder(httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]}))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.usage.input_tokens == 0
    assert result.usage.output_tokens == 0


async def test_a_reply_without_content_is_an_empty_string() -> None:
    recorder = Recorder(httpx.Response(200, json={"choices": [{"message": {}}]}))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == ""


async def test_tool_calls_are_decoded_from_json_string_arguments() -> None:
    recorder = Recorder(
        httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_abc",
                                    "type": "function",
                                    "function": {
                                        "name": "weather",
                                        "arguments": '{"city": "Lima"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.finish_reason == "tool-calls"
    assert len(result.tool_calls) == 1
    call = result.tool_calls[0]
    assert call.id == "call_abc"
    assert call.name == "weather"
    assert call.arguments == {"city": "Lima"}


async def test_a_tool_call_without_an_id_is_given_a_positional_one() -> None:
    recorder = Recorder(
        httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "tool_calls": [{"function": {"name": "weather", "arguments": "{}"}}]
                        }
                    }
                ]
            },
        )
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.tool_calls[0].id == "call_0"


async def test_malformed_tool_arguments_become_an_empty_mapping() -> None:
    recorder = Recorder(
        httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "tool_calls": [
                                {
                                    "id": "a",
                                    "function": {"name": "weather", "arguments": "{not json"},
                                },
                                {"id": "b", "function": {"name": "weather"}},
                                {"id": "c", "function": {"name": "weather", "arguments": "[1, 2]"}},
                            ]
                        }
                    }
                ]
            },
        )
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert [call.arguments for call in result.tool_calls] == [{}, {}, {}]


async def test_unusable_tool_call_entries_are_skipped_without_failing_the_call() -> None:
    recorder = Recorder(
        httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "text survives",
                            "tool_calls": [
                                "not-an-object",
                                {"id": "a", "function": "not-an-object"},
                                {"id": "b", "function": {"name": ""}},
                                {"id": "c", "function": {"name": "kept", "arguments": "{}"}},
                            ],
                        }
                    }
                ]
            },
        )
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "text survives"
    assert [call.name for call in result.tool_calls] == ["kept"]


async def test_tool_calls_that_are_not_a_list_are_ignored() -> None:
    recorder = Recorder(
        httpx.Response(200, json={"choices": [{"message": {"content": "x", "tool_calls": {}}}]})
    )
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.tool_calls == ()


async def test_every_finish_reason_the_conventions_define_is_mapped() -> None:
    codes = {
        "stop": "stop",
        "length": "length",
        "tool_calls": "tool-calls",
        "content_filter": "content-filter",
        "error": "error",
        "something-new": "stop",
    }
    responses = [
        httpx.Response(
            200, json={"choices": [{"message": {"content": "x"}, "finish_reason": code}]}
        )
        for code in codes
    ]
    recorder = Recorder(*responses)
    provider = _provider(recorder)

    for code, expected in codes.items():
        result = await provider.complete(CompletionRequest.prompt("hi"), model=_model())
        assert result.finish_reason == expected, code


async def test_a_retryable_status_is_retried_and_then_succeeds() -> None:
    recorder = Recorder(_status(429, "slow down"), _reply("recovered"))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert len(recorder.requests) == 2
    assert result.text == "recovered"


async def test_a_server_error_is_retried_up_to_the_attempt_limit() -> None:
    recorder = Recorder(_status(503), _status(503), _reply("third time"))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert len(recorder.requests) == 3
    assert result.text == "third time"


async def test_a_retryable_status_on_the_last_attempt_is_surfaced_as_it_is() -> None:
    recorder = Recorder(_status(429), _status(429), _status(429, "still busy"))
    with pytest.raises(ProviderError, match="returned 429: still busy"):
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
        return _reply("second try")

    provider = OpenAICompatibleProvider(
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

    provider = OpenAICompatibleProvider(
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


async def test_a_reply_with_no_choices_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json={"choices": []}))
    with pytest.raises(ProviderResponseError, match="no choices"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())


async def test_a_choice_that_is_not_an_object_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json={"choices": ["nope"]}))
    with pytest.raises(ProviderResponseError, match="malformed choice"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())


async def test_a_choice_without_a_message_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json={"choices": [{"finish_reason": "stop"}]}))
    with pytest.raises(ProviderResponseError, match="choice without a message"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())


async def test_non_string_content_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json={"choices": [{"message": {"content": 42}}]}))
    with pytest.raises(ProviderResponseError, match="non-string content"):
        await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())


async def test_a_response_model_overrides_the_pinned_name() -> None:
    recorder = Recorder(_reply(model="http-test-model-2026-01-01"))
    result = await _provider(recorder).complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.model == "http-test-model-2026-01-01"


async def test_the_adapter_declares_tool_and_structured_output_but_not_streaming() -> None:
    provider = OpenAICompatibleProvider(base_url=BASE_URL)

    assert provider.capabilities == frozenset(
        {Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT}
    )
    assert Capability.STREAMING not in provider.capabilities


def test_the_base_url_must_be_an_absolute_http_url() -> None:
    with pytest.raises(ValueError, match="must be an absolute http"):
        OpenAICompatibleProvider(base_url="api.example.test/v1")


def test_the_attempt_limit_must_be_positive() -> None:
    with pytest.raises(ValueError, match="max_attempts must be at least 1"):
        OpenAICompatibleProvider(base_url=BASE_URL, max_attempts=0)


def test_the_provider_name_is_configurable() -> None:
    assert OpenAICompatibleProvider(base_url=BASE_URL, name="vllm").name == "vllm"
    assert OpenAICompatibleProvider(base_url=BASE_URL).name == "openai-compatible"


async def test_a_trailing_slash_in_the_base_url_does_not_double_up() -> None:
    recorder = Recorder(_reply())
    provider = OpenAICompatibleProvider(
        base_url=f"{BASE_URL}/",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )
    await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert str(recorder.requests[0].url) == f"{BASE_URL}/chat/completions"


async def test_aclose_is_idempotent() -> None:
    provider = OpenAICompatibleProvider(base_url=BASE_URL, backoff_seconds=0.0)

    await provider.aclose()
    await provider.aclose()


async def test_aclose_leaves_a_caller_supplied_client_open() -> None:
    recorder = Recorder(_reply(), _reply())
    async with httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)) as client:
        provider = OpenAICompatibleProvider(base_url=BASE_URL, backoff_seconds=0.0, client=client)
        await provider.aclose()

        result = await provider.complete(CompletionRequest.prompt("hi"), model=_model())

    assert result.text == "ok"
