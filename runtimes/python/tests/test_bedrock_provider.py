"""The Bedrock adapter, against a `MockTransport`.

Bedrock differs from every keyed provider in two ways that cannot be tested
behaviourally. Requests are signed rather than keyed, so the test pins a
signature computed for a fixed clock; and credentials come from the role rather
than an argument, so the tests drive the environment instead.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from aid_runtime import (
    BedrockProvider,
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
from aid_runtime.providers import BEDROCK_SERVICE, default_bedrock_base_url, rfc3986

MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"
STATIC = {
    "access_key_id": "AKIDEXAMPLE",
    "secret_access_key": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
}


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
        return [request.content.decode() for request in self.requests]


def _model(max_output_tokens: int = 4096) -> ModelSpec:
    return ModelSpec(
        name=MODEL_ID,
        provider="bedrock",
        cost=CostProfile(input_per_1k_usd=0.003, output_per_1k_usd=0.015),
        context_window=200_000,
        max_output_tokens=max_output_tokens,
    )


def _provider(
    recorder: Recorder,
    *,
    region: str | None = "us-east-1",
    max_attempts: int = 3,
    base_url: str | None = None,
    extra_headers: dict[str, str] | None = None,
    **credentials: Any,
) -> BedrockProvider:
    options = {**STATIC, **credentials}
    return BedrockProvider(
        region=region,
        base_url=base_url,
        max_attempts=max_attempts,
        backoff_seconds=0.0,
        extra_headers=extra_headers,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
        **options,
    )


def _reply(
    *blocks: Any,
    stop_reason: str = "end_turn",
    usage: dict[str, int] | None = None,
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "output": {"message": {"content": list(blocks) or [{"text": "ok"}]}},
            "stopReason": stop_reason,
            "usage": usage or {"inputTokens": 12, "outputTokens": 3},
        },
    )


def _text(value: str) -> dict[str, Any]:
    return {"text": value}


def _ask(text: str) -> CompletionRequest:
    return CompletionRequest(messages=(Message(role="user", content=text),))


def _sent(recorder: Recorder, index: int = 0) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(recorder.bodies[index])
    return body


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.asyncio
async def test_posts_to_the_encoded_converse_endpoint_and_parses_the_answer() -> None:
    recorder = Recorder(_reply(_text("Paris")))
    response = await _provider(recorder).complete(_ask("capital?"), model=_model())

    assert response.text == "Paris"
    assert response.model == MODEL_ID
    assert response.provider == "bedrock"
    assert response.usage.input_tokens == 12
    assert response.usage.output_tokens == 3
    assert f"/model/{rfc3986(MODEL_ID)}/converse" in str(recorder.requests[0].url)
    assert "v1%3A0" in str(recorder.requests[0].url)
    assert rfc3986("a!b*c'd(e)f") == "a%21b%2Ac%27d%28e%29f"
    assert (
        default_bedrock_base_url("us-west-2") == "https://bedrock-runtime.us-west-2.amazonaws.com"
    )
    assert MODEL_ID  # the wire id contains a colon, which must be encoded
    assert BEDROCK_SERVICE == "bedrock"


@pytest.mark.asyncio
async def test_signs_a_request_with_sigv4_for_a_fixed_clock() -> None:
    # Recomputed independently from the canonical request; any change to the
    # canonical headers, scope or payload hash changes this string. The TypeScript
    # adapter pins the same string for the same request, so the two runtimes agree.
    recorder = Recorder(_reply(_text("ok")))
    provider = _provider(recorder, now=lambda: datetime(2026, 11, 2, 5, 17, 11, tzinfo=UTC))
    await provider.complete(_ask("hi"), model=_model())

    request = recorder.requests[0]
    assert request.headers["x-amz-date"] == "20261102T051711Z"
    assert request.headers["content-type"] == "application/json"
    assert request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261102/us-east-1/bedrock/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=4eaa3e075c1b4bce21a021fff3a031f6caa14511c1912c5bdc902246662767af"
    )


@pytest.mark.asyncio
async def test_signs_the_session_token_as_a_header() -> None:
    recorder = Recorder(_reply(_text("ok")))
    provider = _provider(
        recorder,
        session_token="token-1",  # noqa: S106 - a fake token, not a credential
        now=lambda: datetime(2026, 11, 2, 5, 17, 11, tzinfo=UTC),
    )
    await provider.complete(_ask("hi"), model=_model())

    request = recorder.requests[0]
    assert request.headers["x-amz-security-token"] == "token-1"
    assert (
        "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token"
        in request.headers["authorization"]
    )


@pytest.mark.asyncio
async def test_moves_the_system_prompt_to_a_top_level_array_and_joins_adjacent_systems() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(
            Message(role="system", content="be terse"),
            Message(role="system", content="cite sources"),
            Message(role="user", content="x"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    sent = _sent(recorder)
    assert sent["system"] == [{"text": "be terse\n\ncite sources"}]
    assert sent["messages"] == [{"role": "user", "content": [{"text": "x"}]}]


@pytest.mark.asyncio
async def test_omits_system_when_there_is_no_system_prompt() -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder).complete(_ask("x"), model=_model())

    assert "system" not in _sent(recorder)


@pytest.mark.asyncio
async def test_always_sends_inference_max_tokens_clamped_to_the_model_ceiling() -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder).complete(_ask("x"), model=_model())

    # Converse rejects a request without maxTokens, so it is not optional.
    assert _sent(recorder)["inferenceConfig"] == {"maxTokens": 4096}


@pytest.mark.asyncio
async def test_clamps_an_oversized_requested_max_tokens() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(Message(role="user", content="x"),), max_output_tokens=999_999
    )
    await _provider(recorder).complete(request, model=_model())

    assert _sent(recorder)["inferenceConfig"]["maxTokens"] == 4096


@pytest.mark.asyncio
async def test_sends_tools_as_tool_specs_with_a_json_input_schema() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(Message(role="user", content="x"),),
        temperature=0.2,
        stop=("\n\n",),
        tools=(ToolDefinition(name="lookup", description="d", parameters={"type": "object"}),),
    )
    await _provider(recorder).complete(request, model=_model())

    sent = _sent(recorder)
    assert sent["inferenceConfig"] == {
        "maxTokens": 4096,
        "temperature": 0.2,
        "stopSequences": ["\n\n"],
    }
    assert sent["toolConfig"] == {
        "tools": [
            {
                "toolSpec": {
                    "name": "lookup",
                    "description": "d",
                    "inputSchema": {"json": {"type": "object"}},
                }
            }
        ]
    }


@pytest.mark.asyncio
async def test_serialises_an_assistant_tool_call_turn_as_tool_use_blocks() -> None:
    recorder = Recorder(_reply(_text("ok")))
    call = ToolCall(id="call_1", name="lookup", arguments={"q": "x"})
    request = CompletionRequest(
        messages=(
            Message(role="user", content="go"),
            Message(role="assistant", content="thinking", tool_calls=(call,)),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    assert _sent(recorder)["messages"] == [
        {"role": "user", "content": [{"text": "go"}]},
        {
            "role": "assistant",
            "content": [
                {"text": "thinking"},
                {"toolUse": {"toolUseId": "call_1", "name": "lookup", "input": {"q": "x"}}},
            ],
        },
    ]


@pytest.mark.asyncio
async def test_merges_adjacent_tool_results_into_one_user_turn() -> None:
    # Converse requires alternating roles, so a second consecutive user turn of
    # tool results would be a validation error rather than a variant spelling.
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(
            Message(role="user", content="go"),
            Message(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(id="a", name="one", arguments={}),
                    ToolCall(id="b", name="two", arguments={}),
                ),
            ),
            Message(role="tool", content="first", tool_call_id="a"),
            Message(role="tool", content="second", tool_call_id="b"),
        )
    )
    await _provider(recorder).complete(request, model=_model())

    messages = _sent(recorder)["messages"]
    assert len(messages) == 3
    assert messages[2] == {
        "role": "user",
        "content": [
            {"toolResult": {"toolUseId": "a", "content": [{"text": "first"}]}},
            {"toolResult": {"toolUseId": "b", "content": [{"text": "second"}]}},
        ],
    }


@pytest.mark.asyncio
async def test_drops_an_empty_turn_which_converse_would_reject() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(
        messages=(Message(role="user", content="go"), Message(role="assistant", content=""))
    )
    await _provider(recorder).complete(request, model=_model())

    assert _sent(recorder)["messages"] == [{"role": "user", "content": [{"text": "go"}]}]


@pytest.mark.asyncio
async def test_refuses_a_tool_result_without_a_call_id() -> None:
    recorder = Recorder(_reply(_text("ok")))
    request = CompletionRequest(messages=(Message(role="tool", content="orphan"),))

    with pytest.raises(ProviderError, match="tool_call_id"):
        await _provider(recorder).complete(request, model=_model())
    assert recorder.requests == []


@pytest.mark.asyncio
async def test_parses_tool_use_blocks_into_tool_calls_and_reports_tool_calls() -> None:
    recorder = Recorder(
        _reply(
            _text("let me look"),
            {"toolUse": {"toolUseId": "call_9", "name": "lookup", "input": {"q": "x"}}},
            stop_reason="tool_use",
        )
    )
    response = await _provider(recorder).complete(_ask("x"), model=_model())

    assert response.text == "let me look"
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].id == "call_9"
    assert response.tool_calls[0].name == "lookup"
    assert response.tool_calls[0].arguments == {"q": "x"}
    assert response.finish_reason == "tool-calls"


@pytest.mark.asyncio
async def test_defaults_a_non_object_tool_input_to_an_empty_object() -> None:
    recorder = Recorder(
        _reply({"toolUse": {"toolUseId": "c", "name": "n", "input": "x"}}, stop_reason="tool_use")
    )
    response = await _provider(recorder).complete(_ask("x"), model=_model())

    assert response.tool_calls[0].arguments == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("wire", "expected"),
    [
        ("end_turn", "stop"),
        ("stop_sequence", "stop"),
        ("max_tokens", "length"),
        ("tool_use", "tool-calls"),
        ("guardrail_intervened", "content-filter"),
        ("content_filtered", "content-filter"),
        ("model_context_window_exceeded", "stop"),
    ],
)
async def test_maps_every_stop_reason(wire: str, expected: str) -> None:
    recorder = Recorder(_reply(_text(""), stop_reason=wire))
    response = await _provider(recorder).complete(_ask("x"), model=_model())

    assert response.finish_reason == expected


@pytest.mark.asyncio
async def test_retries_424_which_is_bedrock_specific() -> None:
    recorder = Recorder(httpx.Response(424, text="dependency failed"), _reply(_text("Paris")))
    response = await _provider(recorder, max_attempts=2).complete(_ask("x"), model=_model())

    assert response.text == "Paris"
    assert len(recorder.requests) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [429, 503])
async def test_retries_transient_statuses(status: int) -> None:
    recorder = Recorder(httpx.Response(status, text="busy"), _reply(_text("Paris")))
    response = await _provider(recorder, max_attempts=2).complete(_ask("x"), model=_model())

    assert response.text == "Paris"


@pytest.mark.asyncio
async def test_does_not_retry_403_which_is_a_permission_problem() -> None:
    recorder = Recorder(httpx.Response(403, text="denied"))

    with pytest.raises(ProviderError, match="returned 403"):
        await _provider(recorder, max_attempts=3).complete(_ask("x"), model=_model())
    assert len(recorder.requests) == 1


@pytest.mark.asyncio
async def test_reports_the_last_failure_after_exhausting_its_attempts() -> None:
    recorder = Recorder(httpx.Response(500, text="down"), httpx.Response(500, text="down"))

    with pytest.raises(ProviderError, match="returned 500"):
        await _provider(recorder, max_attempts=2).complete(_ask("x"), model=_model())
    assert len(recorder.requests) == 2


@pytest.mark.asyncio
async def test_reports_the_attempt_count_when_the_transport_itself_fails() -> None:
    recorder = Recorder()

    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("ECONNREFUSED", request=request)

    provider = BedrockProvider(
        region="us-east-1",
        max_attempts=2,
        backoff_seconds=0.0,
        access_key_id=STATIC["access_key_id"],
        secret_access_key=STATIC["secret_access_key"],
        client=httpx.AsyncClient(transport=httpx.MockTransport(explode)),
    )

    with pytest.raises(ProviderError, match="failed after 2 attempt"):
        await provider.complete(_ask("x"), model=_model())
    assert recorder.requests == []


@pytest.mark.asyncio
async def test_needs_a_region_because_model_ids_are_regional() -> None:
    recorder = Recorder(_reply(_text("ok")))
    provider = _provider(recorder, region=None)

    with pytest.raises(ProviderError, match="needs a region"):
        await provider.complete(_ask("x"), model=_model())
    assert recorder.requests == []


@pytest.mark.asyncio
async def test_falls_back_to_aws_region_then_aws_default_region(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder, region=None).complete(_ask("x"), model=_model())
    assert recorder.requests[0].url.host == "bedrock-runtime.eu-west-1.amazonaws.com"

    monkeypatch.delenv("AWS_REGION")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-south-1")
    other = Recorder(_reply(_text("ok")))
    await _provider(other, region=None).complete(_ask("x"), model=_model())
    assert other.requests[0].url.host == "bedrock-runtime.ap-south-1.amazonaws.com"


@pytest.mark.asyncio
async def test_reads_credentials_from_the_environment_when_none_are_passed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "ENVKEY")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "envsecret")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "envtoken")
    recorder = Recorder(_reply(_text("ok")))
    provider = BedrockProvider(
        region="us-east-1",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )
    await provider.complete(_ask("x"), model=_model())

    request = recorder.requests[0]
    assert "Credential=ENVKEY/" in request.headers["authorization"]
    assert request.headers["x-amz-security-token"] == "envtoken"


@pytest.mark.asyncio
async def test_refuses_to_sign_with_no_credentials_anywhere() -> None:
    recorder = Recorder(_reply(_text("ok")))
    provider = BedrockProvider(
        region="us-east-1",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )

    with pytest.raises(ProviderError, match="no credentials"):
        await provider.complete(_ask("x"), model=_model())
    assert recorder.requests == []


@pytest.mark.asyncio
async def test_uses_the_container_credentials_endpoint_and_caches_the_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/abc")
    recorder = Recorder(
        httpx.Response(
            200,
            json={
                "AccessKeyId": "TASKKEY",
                "SecretAccessKey": "tasksecret",
                "Token": "tasktoken",
                "Expiration": "2099-01-01T00:00:00Z",
            },
        ),
        _reply(_text("ok")),
        _reply(_text("ok")),
    )
    provider = BedrockProvider(
        region="us-east-1",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )

    await provider.complete(_ask("x"), model=_model())
    await provider.complete(_ask("x"), model=_model())

    # One credential fetch for both completions: a per-request STS round trip
    # would double the latency of every call.
    assert len(recorder.requests) == 3
    assert str(recorder.requests[0].url) == "http://169.254.170.2/v2/credentials/abc"
    assert "Credential=TASKKEY/" in recorder.requests[1].headers["authorization"]
    assert recorder.requests[1].headers["x-amz-security-token"] == "tasktoken"


@pytest.mark.asyncio
async def test_honours_the_full_credentials_uri(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://127.0.0.1:9911/creds")
    recorder = Recorder(
        httpx.Response(200, json={"AccessKeyId": "K", "SecretAccessKey": "S"}),
        _reply(_text("ok")),
    )
    provider = BedrockProvider(
        region="us-east-1",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )

    await provider.complete(_ask("x"), model=_model())

    assert str(recorder.requests[0].url) == "http://127.0.0.1:9911/creds"
    assert "x-amz-security-token" not in recorder.requests[1].headers


@pytest.mark.asyncio
async def test_refuses_credentials_without_a_key_pair(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/abc")
    recorder = Recorder(httpx.Response(200, json={"Token": "x"}))
    provider = BedrockProvider(
        region="us-east-1",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)),
    )

    with pytest.raises(ProviderResponseError, match="no AccessKeyId"):
        await provider.complete(_ask("x"), model=_model())


@pytest.mark.asyncio
async def test_reports_an_unreachable_credentials_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/abc")

    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("ECONNREFUSED", request=request)

    provider = BedrockProvider(
        region="us-east-1",
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(explode)),
    )

    with pytest.raises(ProviderError, match="could not reach the container credentials endpoint"):
        await provider.complete(_ask("x"), model=_model())


@pytest.mark.asyncio
async def test_honours_a_custom_base_url_and_strips_trailing_slashes() -> None:
    recorder = Recorder(_reply(_text("ok")))
    await _provider(recorder, base_url="https://example.test/").complete(_ask("x"), model=_model())

    assert (
        str(recorder.requests[0].url) == f"https://example.test/model/{rfc3986(MODEL_ID)}/converse"
    )


def test_refuses_a_non_positive_max_attempts() -> None:
    with pytest.raises(ValueError, match="at least 1"):
        BedrockProvider(max_attempts=0)


@pytest.mark.asyncio
async def test_rejects_a_body_that_is_not_json() -> None:
    recorder = Recorder(httpx.Response(200, text="{not json"))

    with pytest.raises(ProviderResponseError):
        await _provider(recorder).complete(_ask("x"), model=_model())


@pytest.mark.asyncio
async def test_rejects_a_body_that_is_not_an_object() -> None:
    recorder = Recorder(httpx.Response(200, text="[]"))

    with pytest.raises(ProviderResponseError, match="not an object"):
        await _provider(recorder).complete(_ask("x"), model=_model())


@pytest.mark.asyncio
async def test_rejects_a_body_with_no_content_blocks() -> None:
    recorder = Recorder(httpx.Response(200, json={"stopReason": "end_turn"}))

    with pytest.raises(ProviderResponseError, match="no content blocks"):
        await _provider(recorder).complete(_ask("x"), model=_model())


def test_claims_tool_calling_structured_output_and_embeddings_but_not_streaming() -> None:
    # Converse serves chat; embeddings ride `POST /model/{id}/invoke` because that
    # is where Titan lives, and `:predict`-style sizes are not involved. Streaming
    # is still absent: /converse-stream is a binary event stream this adapter
    # cannot read, and claiming it would let a spec bind a model that can only
    # fail when it is finally called.
    subject = BedrockProvider()
    assert Capability.TOOL_CALLING in subject.capabilities
    assert Capability.STRUCTURED_OUTPUT in subject.capabilities
    assert Capability.EMBEDDINGS in subject.capabilities
    assert Capability.STREAMING not in subject.capabilities


def test_names_itself_bedrock_by_default_and_honours_a_custom_name() -> None:
    assert BedrockProvider().name == "bedrock"
    assert BedrockProvider(name="stub").name == "stub"


@pytest.mark.asyncio
async def test_refuses_to_stream_rather_than_buffering() -> None:
    provider = BedrockProvider()

    with pytest.raises(ProviderError, match="does not stream"):
        async for _ in provider.stream(_ask("x"), model=_model()):
            pass


@pytest.mark.asyncio
async def test_closes_idempotently() -> None:
    subject = BedrockProvider()

    await subject.aclose()
    await subject.aclose()
