"""Anthropic's Messages API adapter.

A second dialect, not a second abstraction: the runtime's shapes go in, one HTTP
call goes out. The differences from the OpenAI-compatible adapter that actually
matter are here and nowhere else:

- the system prompt is a top-level ``system`` field, not a message;
- ``max_tokens`` is required, so the adapter always sends one;
- a tool result is a ``user`` message containing a ``tool_result`` block, and the
  assistant turn that asked for it carries a ``tool_use`` block with the same id;
- ``stop_reason`` is ``end_turn`` / ``max_tokens`` / ``tool_use`` / ``stop_sequence``.

There is no embeddings endpoint, so ``EMBEDDINGS`` is deliberately not advertised:
a spec that binds an embedding model to this provider should fail negotiation
rather than fail at call time.

Authentication is ``x-api-key`` plus a dated ``anthropic-version`` header, which
is why this cannot be expressed as ``OpenAICompatibleProvider`` with a different
``base_url``.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx

from aid_runtime.errors import ProviderError, ProviderResponseError
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    FinishReason,
    Message,
    ModelSpec,
    StreamChunk,
    TokenUsage,
    ToolCall,
)

__all__ = ["ANTHROPIC_VERSION", "DEFAULT_ANTHROPIC_BASE_URL", "AnthropicProvider"]

DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"

# Pinned rather than configurable: a wire version is a compatibility claim, and
# letting an env var change it would make the adapter's tests test something else.
ANTHROPIC_VERSION = "2023-06-01"

# 529 is Anthropic's "overloaded" status and is not an HTTP standard code, so it has
# to be listed explicitly or a busy provider would look like a client error.
_RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 529})

_FINISH_REASONS: dict[str, FinishReason] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool-calls",
    "refusal": "content-filter",
}


# A thinking-only or otherwise empty assistant turn is legal in Anthropic's API;
# without this the request would be rejected for sending an empty text block.
def _text_block(text: str) -> dict[str, Any] | None:
    return {"type": "text", "text": text} if text else None


class AnthropicProvider:
    """Calls ``POST {base_url}/messages`` and maps the response back."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = DEFAULT_ANTHROPIC_BASE_URL,
        name: str = "anthropic",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
        api_version: str = ANTHROPIC_VERSION,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError(f"base_url must be an absolute http(s) URL, got {base_url!r}")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._name = name
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._api_version = api_version
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
        return frozenset(
            {
                Capability.TOOL_CALLING,
                Capability.STRUCTURED_OUTPUT,
                Capability.STREAMING,
            }
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        payload = self._build_payload(request, model)
        body = await self._post("/messages", payload)
        return self._parse(body, model)

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        """Stream one call as Anthropic's named SSE events.

        One attempt, like the OpenAI adapter: a stream that has already emitted text
        cannot be replayed, so an error is raised once rather than retried mid-stream.

        Tool calls are not reported here because :class:`StreamChunk` has no field for
        them; the gateway that needs tool calls uses :meth:`complete`.
        """
        payload = self._build_payload(request, model)
        payload["stream"] = True
        url = f"{self._base_url}/messages"
        try:
            async with self._client.stream(
                "POST", url, json=payload, headers=self._headers()
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise ProviderError(
                        f"{self._name} returned {response.status_code}: {response.text[:500]}"
                    )
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if not data:
                        continue
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError as exc:
                        raise ProviderResponseError(
                            f"{self._name} streamed non-JSON", data
                        ) from exc
                    if not isinstance(event, dict):
                        raise ProviderResponseError(
                            f"{self._name} streamed a non-object body", data
                        )
                    chunk = self._parse_stream_event(event)
                    if chunk is not None:
                        yield chunk
        except httpx.TransportError as exc:
            raise ProviderError(f"{self._name} stream failed: {exc}") from exc

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {
            "content-type": "application/json",
            "anthropic-version": self._api_version,
            **self._extra_headers,
        }
        if self._api_key:
            headers["x-api-key"] = self._api_key
        return headers

    def _build_payload(self, request: CompletionRequest, model: ModelSpec) -> dict[str, Any]:
        system, messages = _split_system(request.messages)
        payload: dict[str, Any] = {
            "model": model.name,
            "max_tokens": _max_tokens(request, model),
            "messages": messages,
        }
        if system:
            payload["system"] = system
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.stop:
            payload["stop_sequences"] = list(request.stop)
        if request.tools:
            payload["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.parameters or {"type": "object", "properties": {}},
                }
                for tool in request.tools
            ]
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
        blocks = body.get("content")
        if not isinstance(blocks, list):
            raise ProviderResponseError(
                f"{self._name} returned no content blocks", json.dumps(body, sort_keys=True)
            )

        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text":
                value = block.get("text")
                if isinstance(value, str):
                    text_parts.append(value)
            elif kind == "tool_use":
                call_id = block.get("id")
                call_name = block.get("name")
                if (
                    isinstance(call_id, str)
                    and call_id
                    and isinstance(call_name, str)
                    and call_name
                ):
                    raw_input = block.get("input")
                    calls.append(
                        ToolCall(
                            id=call_id,
                            name=call_name,
                            arguments=raw_input if isinstance(raw_input, dict) else {},
                        )
                    )

        raw_usage = body.get("usage")
        usage = TokenUsage(input_tokens=0, output_tokens=0)
        if isinstance(raw_usage, dict):
            usage = TokenUsage(
                input_tokens=int(raw_usage.get("input_tokens") or 0),
                output_tokens=int(raw_usage.get("output_tokens") or 0),
            )

        return CompletionResponse(
            text="".join(text_parts),
            model=str(body.get("model") or model.name),
            provider=self._name,
            usage=usage,
            tool_calls=tuple(calls),
            finish_reason=_finish_reason(body.get("stop_reason")),
        )

    def _parse_stream_event(self, event: dict[str, Any]) -> StreamChunk | None:
        kind = event.get("type")

        if kind == "message_start":
            message = event.get("message")
            raw_usage = message.get("usage") if isinstance(message, dict) else None
            if isinstance(raw_usage, dict):
                return StreamChunk(
                    usage=TokenUsage(
                        input_tokens=int(raw_usage.get("input_tokens") or 0),
                        output_tokens=0,
                    )
                )
            return None

        if kind == "content_block_delta":
            delta = event.get("delta")
            if isinstance(delta, dict) and delta.get("type") == "text_delta":
                text = delta.get("text")
                if isinstance(text, str) and text:
                    return StreamChunk(delta=text)
            return None

        if kind == "message_delta":
            delta = event.get("delta")
            raw_usage = event.get("usage")
            finish: FinishReason | None = None
            if isinstance(delta, dict):
                reason = delta.get("stop_reason")
                if isinstance(reason, str) and reason:
                    finish = _finish_reason(reason)
            usage = None
            if isinstance(raw_usage, dict):
                usage = TokenUsage(
                    input_tokens=int(raw_usage.get("input_tokens") or 0),
                    output_tokens=int(raw_usage.get("output_tokens") or 0),
                )
            if finish is None and usage is None:
                return None
            return StreamChunk(finish_reason=finish, usage=usage)

        return None


def _max_tokens(request: CompletionRequest, model: ModelSpec) -> int:
    """Anthropic requires the field; a request without a cap still needs a number.

    The model's own ceiling is the smallest value that cannot truncate something the
    model was willing to write, so it is the default rather than an arbitrary 1024.
    """
    if request.max_output_tokens is not None:
        return min(request.max_output_tokens, model.max_output_tokens)
    return model.max_output_tokens


def _split_system(
    messages: Sequence[Message],
) -> tuple[str, list[dict[str, Any]]]:
    """Hoist system prompts and fold tool results into user turns.

    Anthropic has no ``tool`` role: an observation is a ``user`` message whose content
    is a ``tool_result`` block. Adjacent results are merged into one turn, because the
    API expects every ``tool_use`` of an assistant turn to be answered together.
    """
    system_parts: list[str] = []
    turns: list[dict[str, Any]] = []

    for message in messages:
        if message.role == "system":
            if message.content:
                system_parts.append(message.content)
            continue

        if message.role == "tool":
            results: list[dict[str, Any]] = [
                {
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id or "",
                    "content": message.content,
                }
            ]
            last = turns[-1] if turns else None
            if (
                last is not None
                and last.get("role") == "user"
                and isinstance(last.get("content"), list)
                and all(block.get("type") == "tool_result" for block in last["content"])
            ):
                last["content"].extend(results)
            else:
                turns.append({"role": "user", "content": results})
            continue

        if message.role == "assistant" and message.tool_calls:
            blocks: list[dict[str, Any]] = []
            text = _text_block(message.content)
            if text is not None:
                blocks.append(text)
            blocks.extend(
                {
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": call.arguments,
                }
                for call in message.tool_calls
            )
            turns.append({"role": "assistant", "content": blocks})
            continue

        turns.append({"role": message.role, "content": message.content})

    return "\n\n".join(system_parts), turns


def _finish_reason(raw: Any) -> FinishReason:
    return _FINISH_REASONS.get(raw, "stop") if isinstance(raw, str) else "stop"
