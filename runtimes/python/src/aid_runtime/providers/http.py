"""A single OpenAI-compatible HTTP provider adapter.

One adapter, deliberately. Anthropic, Azure, Bedrock and friends all speak
slightly different dialects, and the framework's value is the IR seam and the
eval gate, not the breadth of vendor plumbing. Anything OpenAI-compatible --
vLLM, Ollama's compatibility endpoint, LiteLLM, OpenAI itself -- works through
this one class via ``base_url``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from aid_runtime.errors import ProviderError, ProviderResponseError
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    FinishReason,
    ModelSpec,
    TokenUsage,
    ToolCall,
)

__all__ = ["OpenAICompatibleProvider"]

DEFAULT_BASE_URL = "https://api.openai.com/v1"

# 429 and 5xx are the retryable classes: the request was well-formed but the
# endpoint declined for a reason that may not repeat.
_RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


class OpenAICompatibleProvider:
    """Calls ``POST {base_url}/chat/completions`` and maps the response back."""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        name: str = "openai-compatible",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError(f"base_url must be an absolute http(s) URL, got {base_url!r}")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._name = name
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._extra_headers = dict(extra_headers or {})
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._closed = False

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> frozenset[Capability]:
        # Streaming is intentionally absent: the capability is part of the IR
        # contract but no adapter implements it yet.
        return frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT})

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        payload = self._build_payload(request, model)
        body = await self._post("/chat/completions", payload)
        return self._parse(body, model)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json", **self._extra_headers}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        return headers

    def _build_payload(self, request: CompletionRequest, model: ModelSpec) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model.name,
            "messages": [message.model_dump(mode="json") for message in request.messages],
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            payload["max_tokens"] = min(request.max_output_tokens, model.max_output_tokens)
        if request.tools:
            payload["tools"] = [tool.as_openai_tool() for tool in request.tools]
        if request.stop:
            payload["stop"] = list(request.stop)
        return payload

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(url, json=payload, headers=self._headers())
            except httpx.TransportError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue

            if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
                last_error = ProviderError(f"{self._name} returned {response.status_code}")
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue

            if response.status_code >= 400:
                raise ProviderError(
                    f"{self._name} returned {response.status_code}: {response.text[:500]}"
                )

            try:
                decoded = response.json()
            except json.JSONDecodeError as exc:
                raise ProviderResponseError(
                    f"{self._name} returned non-JSON", response.text
                ) from exc
            if not isinstance(decoded, dict):
                raise ProviderResponseError(
                    f"{self._name} returned a non-object body", response.text
                )
            return decoded

        raise ProviderError(
            f"{self._name} failed after {self._max_attempts} attempt(s): {last_error}"
        ) from last_error

    def _parse(self, body: dict[str, Any], model: ModelSpec) -> CompletionResponse:
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ProviderResponseError(
                f"{self._name} returned no choices", json.dumps(body, sort_keys=True)
            )
        first = choices[0]
        if not isinstance(first, dict):
            raise ProviderResponseError(f"{self._name} returned a malformed choice")
        message = first.get("message")
        if not isinstance(message, dict):
            raise ProviderResponseError(
                f"{self._name} returned a choice without a message",
                json.dumps(first, sort_keys=True),
            )

        text = message.get("content")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise ProviderResponseError(f"{self._name} returned non-string content")

        tool_calls = self._parse_tool_calls(message.get("tool_calls"))

        raw_usage = body.get("usage")
        usage = TokenUsage(input_tokens=0, output_tokens=0)
        if isinstance(raw_usage, dict):
            usage = TokenUsage(
                input_tokens=int(raw_usage.get("prompt_tokens") or 0),
                output_tokens=int(raw_usage.get("completion_tokens") or 0),
            )

        return CompletionResponse(
            text=text,
            model=str(body.get("model") or model.name),
            provider=self._name,
            usage=usage,
            tool_calls=tool_calls,
            finish_reason=_finish_reason(first.get("finish_reason")),
        )

    def _parse_tool_calls(self, raw: Any) -> tuple[ToolCall, ...]:
        if not isinstance(raw, list):
            return ()
        calls: list[ToolCall] = []
        for index, item in enumerate(raw):
            if not isinstance(item, dict):
                continue
            function = item.get("function")
            if not isinstance(function, dict):
                continue
            name = function.get("name")
            if not isinstance(name, str) or not name:
                continue
            calls.append(
                ToolCall(
                    id=str(item.get("id") or f"call_{index}"),
                    name=name,
                    arguments=_decode_arguments(function.get("arguments")),
                )
            )
        return tuple(calls)


_FINISH_REASONS: dict[str, FinishReason] = {
    "stop": "stop",
    "length": "length",
    "tool_calls": "tool-calls",
    "content_filter": "content-filter",
    "error": "error",
}


def _finish_reason(raw: Any) -> FinishReason:
    return _FINISH_REASONS.get(raw, "stop") if isinstance(raw, str) else "stop"


def _decode_arguments(raw: Any) -> dict[str, Any]:
    """Tool arguments arrive as a JSON *string*; a malformed one is an empty dict.

    Returning ``{}`` rather than raising keeps the failure in the tool executor,
    where it is reported to the model as a retryable tool error instead of
    aborting the whole turn.
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}
