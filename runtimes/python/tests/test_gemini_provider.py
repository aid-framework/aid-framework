"""The public Gemini API adapter, against a `MockTransport`.

The wire is Vertex's; what these tests pin is everything Vertex does not have: the
key header, the fixed host, the missing-key error, and the retry rule that must not
treat `400 FAILED_PRECONDITION` (a bad key) as a hiccup. One test builds the same
request through both adapters and asserts the bodies are identical.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from aid_runtime import (
    Capability,
    CompletionRequest,
    CostProfile,
    GeminiProvider,
    Message,
    ModelSpec,
    ProviderError,
    ProviderResponseError,
    ToolCall,
    ToolDefinition,
    VertexProvider,
)
from aid_runtime.providers import DEFAULT_GEMINI_BASE_URL, GEMINI_API_KEY_ENV

MODEL_ID = "gemini-2.5-flash"


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


def _model(provider: str = "gemini") -> ModelSpec:
    return ModelSpec(
        name=MODEL_ID,
        provider=provider,
        cost=CostProfile(input_per_1k_usd=0.0001, output_per_1k_usd=0.0004),
        context_window=1_000_000,
        max_output_tokens=4096,
    )


def _provider(
    recorder: Recorder,
    *,
    api_key: str | None = "key-123",
    base_url: str | None = None,
    max_attempts: int = 3,
) -> GeminiProvider:
    return GeminiProvider(
        api_key=api_key,
        base_url=base_url,
        max_attempts=max_attempts,
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )


def _reply(*parts: Any, finish_reason: str = "STOP") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "candidates": [
                {
                    "content": {"role": "model", "parts": list(parts) or [{"text": "ok"}]},
                    "finishReason": finish_reason,
                }
            ],
            "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 3},
        },
    )


def _ask(text: str = "capital of France?") -> CompletionRequest:
    return CompletionRequest(messages=(Message(role="user", content=text),))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(GEMINI_API_KEY_ENV, raising=False)


@pytest.mark.asyncio
async def test_posts_to_the_v1beta_endpoint_with_the_key_header() -> None:
    recorder = Recorder(_reply({"text": "Paris"}))
    response = await _provider(recorder).complete(_ask(), model=_model())

    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url) == (
        f"{DEFAULT_GEMINI_BASE_URL}/v1beta/models/{MODEL_ID}:generateContent"
    )
    assert request.headers["x-goog-api-key"] == "key-123"
    assert "authorization" not in request.headers
    assert response.text == "Paris"
    assert response.provider == "gemini"
    assert response.usage.input_tokens == 12
    assert response.finish_reason == "stop"


@pytest.mark.asyncio
async def test_reads_the_key_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(GEMINI_API_KEY_ENV, "from-env")
    recorder = Recorder(_reply())
    await _provider(recorder, api_key=None).complete(_ask(), model=_model())

    assert recorder.requests[0].headers["x-goog-api-key"] == "from-env"


@pytest.mark.asyncio
async def test_a_missing_key_is_a_provider_error_naming_the_variable() -> None:
    recorder = Recorder(_reply())
    with pytest.raises(ProviderError, match=GEMINI_API_KEY_ENV):
        await _provider(recorder, api_key=None).complete(_ask(), model=_model())
    assert recorder.requests == []


def test_advertises_streaming_and_the_negotiated_capabilities() -> None:
    provider = GeminiProvider(api_key="k")
    assert provider.capabilities == frozenset(
        {Capability.STREAMING, Capability.STRUCTURED_OUTPUT, Capability.TOOL_CALLING}
    )
    assert provider.name == "gemini"


def test_default_base_url_can_be_overridden() -> None:
    provider = GeminiProvider(api_key="k", base_url="http://stub/")
    assert (
        provider._url(_model(), stream=False)
        == f"http://stub/v1beta/models/{MODEL_ID}:generateContent"
    )


@pytest.mark.asyncio
async def test_does_not_retry_a_bad_key() -> None:
    """Gemini answers 400 FAILED_PRECONDITION for a bad key; retrying only spends money."""
    recorder = Recorder(httpx.Response(400, json={"error": {"status": "FAILED_PRECONDITION"}}))
    with pytest.raises(ProviderError, match="400"):
        await _provider(recorder).complete(_ask(), model=_model())
    assert len(recorder.requests) == 1


@pytest.mark.asyncio
async def test_retries_a_retryable_status_then_succeeds() -> None:
    recorder = Recorder(httpx.Response(429, text="slow down"), _reply({"text": "Paris"}))
    response = await _provider(recorder).complete(_ask(), model=_model())

    assert len(recorder.requests) == 2
    assert recorder.bodies[0] == recorder.bodies[1]
    assert response.text == "Paris"


@pytest.mark.asyncio
async def test_maps_safety_and_length_finish_reasons() -> None:
    for reason, expected in (("SAFETY", "content-filter"), ("MAX_TOKENS", "length")):
        recorder = Recorder(_reply({"text": ""}, finish_reason=reason))
        response = await _provider(recorder).complete(_ask(), model=_model())
        assert response.finish_reason == expected


@pytest.mark.asyncio
async def test_parses_a_function_call_into_a_tool_call() -> None:
    recorder = Recorder(
        _reply(
            {"functionCall": {"name": "lookup", "args": {"city": "Paris"}}},
            finish_reason="STOP",
        )
    )
    response = await _provider(recorder).complete(_ask(), model=_model())

    assert response.finish_reason == "tool-calls"
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "lookup"
    assert response.tool_calls[0].arguments == {"city": "Paris"}


@pytest.mark.asyncio
async def test_reports_a_non_json_body_and_a_body_with_no_candidates() -> None:
    recorder = Recorder(httpx.Response(200, text="not json"))
    with pytest.raises(ProviderResponseError, match="not JSON"):
        await _provider(recorder).complete(_ask(), model=_model())

    recorder = Recorder(httpx.Response(200, json={"candidates": []}))
    with pytest.raises(ProviderResponseError, match="no candidates"):
        await _provider(recorder).complete(_ask(), model=_model())


@pytest.mark.asyncio
async def test_the_request_body_is_identical_to_vertexs() -> None:
    """One wire, two endpoints: the same request must serialise the same way."""
    request = CompletionRequest(
        messages=(
            Message(role="system", content="be terse"),
            Message(role="user", content="capital?"),
            Message(
                role="assistant",
                content="",
                tool_calls=(ToolCall(id="c1", name="lookup", arguments={"city": "Paris"}),),
            ),
            Message(role="tool", name="lookup", content='{"answer": "Paris"}'),
        ),
        tools=(
            ToolDefinition(
                name="lookup",
                description="look a city up",
                parameters={"type": "object", "properties": {"city": {"type": "string"}}},
            ),
        ),
        temperature=0.2,
        max_output_tokens=256,
        stop=("END",),
    )

    gemini_recorder = Recorder(_reply())
    await _provider(gemini_recorder).complete(request, model=_model("gemini"))

    vertex_recorder = Recorder(_reply())
    vertex = VertexProvider(
        project="aid-test",
        location="us-central1",
        access_token="token",  # noqa: S106
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(vertex_recorder.handle)),
    )
    await vertex.complete(request, model=_model("google"))

    assert gemini_recorder.bodies[0] == vertex_recorder.bodies[0]
