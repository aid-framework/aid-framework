"""The Vertex adapter, against a `MockTransport`.

Vertex differs from the keyed providers in two ways worth pinning: the token is
resolved from the environment or the metadata server rather than passed at call
time, and streaming is a real SSE stream rather than a refused capability.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import pytest

from aid_runtime import (
    Capability,
    CompletionRequest,
    CostProfile,
    Message,
    ModelSpec,
    ProviderError,
    ProviderResponseError,
    ToolCall,
    ToolDefinition,
    VertexProvider,
)
from aid_runtime.providers import (
    DEFAULT_VERTEX_LOCATION,
    METADATA_TOKEN_URL,
    default_vertex_base_url,
)

MODEL_ID = "gemini-2.0-flash-001"
PROJECT = "aid-test"
LOCATION = "europe-west4"


class Recorder:
    """A transport handler that records requests and replays queued responses."""

    def __init__(self, *responses: httpx.Response) -> None:
        self.requests: list[httpx.Request] = []
        self._responses = list(responses)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError("the adapter sent more requests than the test queued responses")
        return self._responses.pop(0)

    @property
    def bodies(self) -> list[str]:
        return [request.content.decode() for request in self.requests if request.method == "POST"]


def _model(max_output_tokens: int = 4096) -> ModelSpec:
    return ModelSpec(
        name=MODEL_ID,
        provider="google",
        cost=CostProfile(input_per_1k_usd=0.0001, output_per_1k_usd=0.0004),
        context_window=1_000_000,
        max_output_tokens=max_output_tokens,
    )


def _provider(
    recorder: Recorder,
    *,
    project: str | None = PROJECT,
    location: str | None = LOCATION,
    access_token: str | None = "token-123",  # noqa: S107
    max_attempts: int = 3,
    base_url: str | None = None,
    token_provider: Callable[[], Awaitable[str]] | None = None,
) -> VertexProvider:
    return VertexProvider(
        project=project,
        location=location,
        access_token=access_token,
        base_url=base_url,
        max_attempts=max_attempts,
        backoff_seconds=0.0,
        token_provider=token_provider,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )


def _reply(
    *parts: Any,
    finish_reason: str = "STOP",
    usage: dict[str, int] | None = None,
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "candidates": [
                {
                    "content": {"role": "model", "parts": list(parts) or [{"text": "ok"}]},
                    "finishReason": finish_reason,
                }
            ],
            "usageMetadata": usage or {"promptTokenCount": 12, "candidatesTokenCount": 3},
        },
    )


def _text(value: str) -> dict[str, Any]:
    return {"text": value}


def _sse(*events: dict[str, Any]) -> str:
    """An SSE body, one `data:` line per event -- the shape Vertex streams."""
    return "\n\n".join(f"data: {json.dumps(event)}" for event in events)


def _ask(text: str) -> CompletionRequest:
    return CompletionRequest(messages=(Message(role="user", content=text),))


def _sent(recorder: Recorder, index: int = 0) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(recorder.bodies[index])
    return body


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "GOOGLE_ACCESS_TOKEN",
        "VERTEX_ACCESS_TOKEN",
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "GOOGLE_PROJECT_ID",
        "GOOGLE_CLOUD_REGION",
        "VERTEX_LOCATION",
        "GOOGLE_CLOUD_LOCATION",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.asyncio
async def test_posts_to_the_generate_content_endpoint_with_the_resolved_model() -> None:
    recorder = Recorder(_reply(_text("Paris")))
    response = await _provider(recorder).complete(_ask("capital?"), model=_model())

    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url) == (
        f"https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{LOCATION}/publishers/google/models/{MODEL_ID}:generateContent"
    )
    assert request.headers["authorization"] == "Bearer token-123"
    assert response.text == "Paris"
    assert response.provider == "google"
    assert response.model == MODEL_ID
    assert response.usage.input_tokens == 12
    assert response.usage.output_tokens == 3
    assert response.finish_reason == "stop"


@pytest.mark.asyncio
async def test_advertises_streaming_embeddings_and_the_negotiated_capabilities() -> None:
    # Embeddings are served by `:predict` on the same regional host and token, so
    # the adapter carries the method rather than a second client.
    capabilities = _provider(Recorder()).capabilities
    assert capabilities == frozenset(
        {
            Capability.STREAMING,
            Capability.STRUCTURED_OUTPUT,
            Capability.TOOL_CALLING,
            Capability.EMBEDDINGS,
        }
    )


@pytest.mark.asyncio
async def test_defaults_the_location_but_requires_a_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder, location=None).complete(_ask("hi"), model=_model())
    assert f"{DEFAULT_VERTEX_LOCATION}-aiplatform.googleapis.com" in str(recorder.requests[0].url)

    with pytest.raises(ProviderError, match="GOOGLE_CLOUD_PROJECT"):
        await _provider(Recorder(), project=None).complete(_ask("hi"), model=_model())


@pytest.mark.asyncio
async def test_reads_project_and_location_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "from-env")
    monkeypatch.setenv("GOOGLE_CLOUD_REGION", "asia-northeast1")
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder, project=None, location=None).complete(_ask("hi"), model=_model())
    assert "/projects/from-env/locations/asia-northeast1/" in str(recorder.requests[0].url)


@pytest.mark.asyncio
async def test_reads_the_bearer_token_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_ACCESS_TOKEN", "env-token")
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder, access_token=None).complete(_ask("hi"), model=_model())
    assert recorder.requests[0].headers["authorization"] == "Bearer env-token"


@pytest.mark.asyncio
async def test_mints_a_token_from_the_metadata_server_and_caches_it() -> None:
    recorder = Recorder(
        httpx.Response(200, json={"access_token": "minted", "expires_in": 3600}),
        _reply(_text("one")),
        _reply(_text("two")),
    )
    provider = _provider(recorder, access_token=None)
    await provider.complete(_ask("hi"), model=_model())
    await provider.complete(_ask("hi"), model=_model())

    metadata = [r for r in recorder.requests if str(r.url) == METADATA_TOKEN_URL]
    assert len(metadata) == 1
    assert metadata[0].headers["metadata-flavor"] == "Google"
    assert recorder.requests[1].headers["authorization"] == "Bearer minted"


@pytest.mark.asyncio
async def test_a_missing_metadata_server_is_reported_as_missing_credentials() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no metadata server", request=request)

    provider = VertexProvider(
        project=PROJECT,
        access_token=None,
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
    )
    with pytest.raises(ProviderError, match="GOOGLE_ACCESS_TOKEN"):
        await provider.complete(_ask("hi"), model=_model())


@pytest.mark.asyncio
async def test_uses_an_injected_token_provider_for_tests_and_custom_auth() -> None:
    async def token() -> str:
        return "injected"

    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder, access_token=None, token_provider=token).complete(
        _ask("hi"), model=_model()
    )
    assert recorder.requests[0].headers["authorization"] == "Bearer injected"


@pytest.mark.asyncio
async def test_moves_system_turns_into_system_instruction() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(
            Message(role="system", content="be terse"),
            Message(role="system", content="answer in French"),
            Message(role="user", content="capital?"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    sent = _sent(recorder)
    assert sent["systemInstruction"] == {"parts": [{"text": "be terse\nanswer in French"}]}
    assert sent["contents"] == [{"role": "user", "parts": [{"text": "capital?"}]}]


@pytest.mark.asyncio
async def test_omits_system_instruction_when_there_is_no_system_turn() -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder).complete(_ask("hi"), model=_model())
    assert "systemInstruction" not in _sent(recorder)


@pytest.mark.asyncio
async def test_sends_temperature_and_a_clamped_output_ceiling() -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder).complete(
        CompletionRequest(
            messages=(Message(role="user", content="hi"),),
            max_output_tokens=99_999,
            temperature=0.2,
        ),
        model=_model(max_output_tokens=2048),
    )
    assert _sent(recorder)["generationConfig"] == {
        "maxOutputTokens": 2048,
        "temperature": 0.2,
    }


@pytest.mark.asyncio
async def test_sends_stop_sequences() -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder).complete(
        CompletionRequest(messages=(Message(role="user", content="hi"),), stop=("END",)),
        model=_model(),
    )
    assert _sent(recorder)["generationConfig"]["stopSequences"] == ["END"]


@pytest.mark.asyncio
async def test_sends_tools_as_function_declarations() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(Message(role="user", content="hi"),),
        tools=(
            ToolDefinition(
                name="weather",
                description="look it up",
                parameters={"type": "object", "properties": {"city": {"type": "string"}}},
            ),
        ),
    )
    await _provider(recorder).complete(request, model=_model())
    assert _sent(recorder)["tools"] == [
        {
            "functionDeclarations": [
                {
                    "name": "weather",
                    "description": "look it up",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                }
            ]
        }
    ]


@pytest.mark.asyncio
async def test_parses_a_function_call_into_a_tool_call() -> None:
    recorder = Recorder(
        _reply(
            {"functionCall": {"name": "weather", "args": {"city": "Paris"}}}, finish_reason="STOP"
        )
    )
    response = await _provider(recorder).complete(_ask("weather?"), model=_model())
    assert response.text == ""
    assert response.tool_calls == (
        ToolCall(id=f"{MODEL_ID}-call-0", name="weather", arguments={"city": "Paris"}),
    )
    assert response.finish_reason == "tool-calls"


@pytest.mark.asyncio
async def test_replays_an_assistant_tool_call_and_its_result_as_gemini_parts() -> None:
    recorder = Recorder(_reply(_text("sunny")))
    request = CompletionRequest(
        messages=(
            Message(role="user", content="weather?"),
            Message(
                role="assistant",
                content="",
                tool_calls=(ToolCall(id="c1", name="weather", arguments={"city": "Paris"}),),
            ),
            Message(role="tool", content="22C", tool_call_id="c1", name="weather"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    assert _sent(recorder)["contents"] == [
        {"role": "user", "parts": [{"text": "weather?"}]},
        {
            "role": "model",
            "parts": [{"functionCall": {"name": "weather", "args": {"city": "Paris"}}}],
        },
        {
            "role": "user",
            "parts": [{"functionResponse": {"name": "weather", "response": {"content": "22C"}}}],
        },
    ]


@pytest.mark.asyncio
async def test_maps_provider_finish_reasons_to_the_runtime_vocabulary() -> None:
    for raw, expected in (
        ("MAX_TOKENS", "length"),
        ("SAFETY", "content-filter"),
        ("RECITATION", "content-filter"),
        ("MALFORMED_FUNCTION_CALL", "error"),
    ):
        recorder = Recorder(_reply(_text("x"), finish_reason=raw))
        response = await _provider(recorder).complete(_ask("hi"), model=_model())
        assert response.finish_reason == expected, raw


@pytest.mark.asyncio
async def test_retries_a_retryable_status_then_succeeds() -> None:
    recorder = Recorder(httpx.Response(429, text="slow down"), _reply(_text("ok")))
    response = await _provider(recorder).complete(_ask("hi"), model=_model())
    assert response.text == "ok"
    assert len(recorder.requests) == 2


@pytest.mark.asyncio
async def test_raises_with_the_provider_detail_on_a_client_error() -> None:
    recorder = Recorder(httpx.Response(400, text="bad request"))
    with pytest.raises(ProviderError, match="400"):
        await _provider(recorder).complete(_ask("hi"), model=_model())


@pytest.mark.asyncio
async def test_reports_a_non_json_body_as_a_provider_response_error() -> None:
    recorder = Recorder(httpx.Response(200, text="not json"))
    with pytest.raises(ProviderResponseError):
        await _provider(recorder).complete(_ask("hi"), model=_model())


@pytest.mark.asyncio
async def test_reports_a_body_with_no_candidates() -> None:
    recorder = Recorder(httpx.Response(200, json={"candidates": []}))
    with pytest.raises(ProviderResponseError, match="no candidates"):
        await _provider(recorder).complete(_ask("hi"), model=_model())


@pytest.mark.asyncio
async def test_streams_sse_deltas_and_ends_with_usage_and_finish_reason() -> None:
    events = _sse(
        {"candidates": [{"content": {"parts": [_text("Pa")]}}]},
        {
            "candidates": [{"content": {"parts": [_text("ris")]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 2},
        },
    )
    recorder = Recorder(httpx.Response(200, text=events))
    chunks = [c async for c in _provider(recorder).stream(_ask("capital?"), model=_model())]

    assert [c.delta for c in chunks] == ["Pa", "ris", ""]
    assert chunks[-1].finish_reason == "stop"
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.input_tokens == 7
    assert chunks[-1].usage.output_tokens == 2
    assert ":streamGenerateContent?alt=sse" in str(recorder.requests[0].url)


@pytest.mark.asyncio
async def test_streams_without_any_usage_still_terminates_with_a_zero_usage_chunk() -> None:
    recorder = Recorder(
        httpx.Response(200, text=_sse({"candidates": [{"content": {"parts": [_text("x")]}}]}))
    )
    chunks = [c async for c in _provider(recorder).stream(_ask("hi"), model=_model())]
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.total_tokens == 0


@pytest.mark.asyncio
async def test_stream_raises_on_a_streamed_error_status() -> None:
    recorder = Recorder(httpx.Response(400, text="nope"))
    with pytest.raises(ProviderError, match="400"):
        [c async for c in _provider(recorder).stream(_ask("hi"), model=_model())]


def test_the_default_base_url_is_location_scoped() -> None:
    assert default_vertex_base_url("us-central1") == "https://us-central1-aiplatform.googleapis.com"
