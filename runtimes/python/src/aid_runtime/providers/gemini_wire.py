"""The Gemini wire dialect shared by the Vertex and Gemini API adapters.

Both services take the same request body -- ``contents`` of ``parts``, Google-shaped
tool declarations, ``systemInstruction``, ``generationConfig`` -- and answer with the
same ``candidates`` and ``usageMetadata``. They differ only in the endpoint, the
credentials and the embedding method, so the translation and the retry loop live here
once and each adapter supplies its URL and auth headers. A test builds one request
through both adapters and asserts the bodies are byte-identical, which is what keeps
these functions honest.

This module is internal: it is not re-exported from ``aid_runtime``.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from aid_runtime.errors import ProviderError, ProviderResponseError
from aid_runtime.types import (
    CompletionRequest,
    FinishReason,
    Message,
    ModelSpec,
    StreamChunk,
    TokenUsage,
    ToolCall,
)

__all__ = [
    "DEFAULT_RETRYABLE_STATUS",
    "GeminiWireClient",
    "build_payload",
    "decode_body",
    "finish_reason",
    "read_candidate",
    "system_prompt",
    "usage",
    "wire_contents",
]

DEFAULT_RETRYABLE_STATUS = frozenset({408, 409, 424, 425, 429, 500, 502, 503, 504})

FINISH_REASONS: dict[str, FinishReason] = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "SAFETY": "content-filter",
    "RECITATION": "content-filter",
    "BLOCKLIST": "content-filter",
    "PROHIBITED_CONTENT": "content-filter",
    "SPII": "content-filter",
    "MALFORMED_FUNCTION_CALL": "error",
}


def build_payload(request: CompletionRequest, model: ModelSpec) -> dict[str, Any]:
    """Translate a completion request into the body both Gemini endpoints accept."""
    generation_config: dict[str, Any] = {"maxOutputTokens": _max_tokens(request, model)}
    if request.temperature is not None:
        generation_config["temperature"] = request.temperature
    if request.stop:
        generation_config["stopSequences"] = list(request.stop)
    payload: dict[str, Any] = {
        "contents": wire_contents(request.messages),
        "generationConfig": generation_config,
    }
    system = system_prompt(request.messages)
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    if request.tools:
        payload["tools"] = [
            {
                "functionDeclarations": [
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters or {"type": "object", "properties": {}},
                    }
                    for tool in request.tools
                ]
            }
        ]
    return payload


def wire_contents(messages: tuple[Message, ...]) -> list[dict[str, Any]]:
    """Render the message list as ``contents``; system turns move to ``systemInstruction``."""
    contents: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            continue
        if message.role == "tool":
            contents.append(
                {
                    "role": "user",
                    "parts": [
                        {
                            "functionResponse": {
                                "name": message.name or "tool",
                                "response": {"content": message.content},
                            }
                        }
                    ],
                }
            )
            continue
        parts: list[dict[str, Any]] = []
        if message.content:
            parts.append({"text": message.content})
        for call in message.tool_calls:
            parts.append({"functionCall": {"name": call.name, "args": call.arguments}})
        if not parts:
            parts.append({"text": ""})
        contents.append(
            {"role": "model" if message.role == "assistant" else "user", "parts": parts}
        )
    return contents


def system_prompt(messages: tuple[Message, ...]) -> str:
    return "\n".join(message.content for message in messages if message.role == "system")


def finish_reason(raw: str) -> FinishReason:
    return FINISH_REASONS.get(raw, "stop")


def usage(body: dict[str, Any]) -> TokenUsage | None:
    raw = body.get("usageMetadata")
    if not isinstance(raw, dict):
        return None
    return TokenUsage(
        input_tokens=int(raw.get("promptTokenCount") or 0),
        output_tokens=int(raw.get("candidatesTokenCount") or 0),
    )


def read_candidate(
    body: dict[str, Any], model: ModelSpec
) -> tuple[str, list[ToolCall], FinishReason | None, TokenUsage | None]:
    """Read the first candidate into text, calls, finish reason and usage."""
    candidates = body.get("candidates")
    candidate = candidates[0] if isinstance(candidates, list) and candidates else None
    content = candidate.get("content") if isinstance(candidate, dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None

    text_parts: list[str] = []
    calls: list[ToolCall] = []
    if isinstance(parts, list):
        for index, part in enumerate(parts):
            if not isinstance(part, dict):
                continue
            value = part.get("text")
            if isinstance(value, str):
                text_parts.append(value)
                continue
            call = part.get("functionCall")
            if not isinstance(call, dict):
                continue
            name = call.get("name")
            if not isinstance(name, str) or not name:
                continue
            arguments = call.get("args")
            calls.append(
                ToolCall(
                    id=f"{model.name}-call-{index}",
                    name=name,
                    arguments=arguments if isinstance(arguments, dict) else {},
                )
            )

    reason: FinishReason | None = None
    raw_reason = candidate.get("finishReason") if isinstance(candidate, dict) else None
    if isinstance(raw_reason, str):
        reason = finish_reason(raw_reason)

    # Gemini reports the reason alongside the call; the call is the better signal.
    if calls and reason in (None, "stop"):
        reason = "tool-calls"
    return "".join(text_parts), calls, reason, usage(body)


def decode_body(text: str, provider: str) -> dict[str, Any]:
    """Parse a non-streamed body, refusing anything that is not a JSON object."""
    try:
        body = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProviderResponseError(f"{provider} returned a body that is not JSON", text) from exc
    if not isinstance(body, dict):
        raise ProviderResponseError(f"{provider} returned a JSON body that is not an object", text)
    return body


def _max_tokens(request: CompletionRequest, model: ModelSpec) -> int:
    if request.max_output_tokens is not None:
        return min(request.max_output_tokens, model.max_output_tokens)
    return model.max_output_tokens


class GeminiWireClient:
    """The HTTP half of the Gemini dialect; adapters supply ``_url`` and ``_headers``.

    The retry policy is per adapter because a status means different things to each
    service: a transport failure or a 429 is worth another attempt on both, but the
    Gemini API also answers ``400 FAILED_PRECONDITION`` for a bad key, so callers must
    be able to narrow ``_retryable_status`` without touching this loop.
    """

    def __init__(
        self,
        *,
        name: str,
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._name = name
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._client = client
        self._owns_client = client is None
        self._retryable_status = DEFAULT_RETRYABLE_STATUS

    @property
    def name(self) -> str:
        return self._name

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True
        return self._client

    def _url(self, model: ModelSpec, *, stream: bool) -> str:
        raise NotImplementedError

    async def _headers(self) -> dict[str, str]:
        raise NotImplementedError

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        client = self._ensure_client()
        headers = await self._headers()
        payload = build_payload(request, model)
        url = self._url(model, stream=True)

        usage: TokenUsage | None = None
        finish: FinishReason | None = None
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as response:
                    if (
                        response.status_code in self._retryable_status
                        and attempt < self._max_attempts
                    ):
                        last_error = ProviderError(f"{self._name} returned {response.status_code}")
                        await response.aread()
                        await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                        continue
                    if response.status_code >= 400:
                        detail = (await response.aread()).decode("utf-8", "replace")
                        raise ProviderError(
                            f"{self._name} returned {response.status_code}: {detail[:500]}"
                        )
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[len("data:") :].strip()
                        if not data or data == "[DONE]":
                            continue
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError as exc:
                            raise ProviderResponseError(
                                f"{self._name} streamed non-JSON", data
                            ) from exc
                        if not isinstance(chunk, dict):
                            continue
                        text, _calls, reason, chunk_usage = read_candidate(chunk, model)
                        if chunk_usage is not None:
                            usage = chunk_usage
                        if reason is not None:
                            finish = reason
                        if text:
                            yield StreamChunk(delta=text)
            except httpx.TransportError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            else:
                yield StreamChunk(
                    finish_reason=finish or "stop",
                    usage=usage or TokenUsage(input_tokens=0, output_tokens=0),
                )
                return

        raise ProviderError(
            f"{self._name} failed after {self._max_attempts} attempt(s): {last_error}"
        ) from last_error

    async def _post(self, url: str, payload: dict[str, Any]) -> str:
        client = self._ensure_client()
        headers = await self._headers()
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await client.post(url, json=payload, headers=headers)
            except httpx.TransportError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue

            if response.status_code in self._retryable_status and attempt < self._max_attempts:
                last_error = ProviderError(
                    f"{self._name} returned {response.status_code}: {response.text[:500]}"
                )
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue

            if response.status_code >= 400:
                raise ProviderError(
                    f"{self._name} returned {response.status_code}: {response.text[:500]}"
                )
            return response.text

        raise ProviderError(
            f"{self._name} failed after {self._max_attempts} attempt(s): {last_error}"
        ) from last_error
