"""Vertex AI adapter for Gemini models.

Vertex speaks its own dialect: ``contents`` of ``parts`` rather than messages,
Google-shaped tool declarations, and a dedicated streaming endpoint. It is
authenticated with an OAuth2 bearer token, not an API key -- the token is
resolved once per call from an explicit value, an environment variable, or the
GCE metadata server that Cloud Run and Cloud Functions provide.

Deliberately no cryptography dependency: on GCP the metadata server mints the
token, and off GCP a developer supplies one (``gcloud auth print-access-token``).
A service-account JSON file would need RS256 signing, which is a dependency the
runtime does not otherwise carry.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
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

__all__ = [
    "DEFAULT_VERTEX_LOCATION",
    "METADATA_TOKEN_URL",
    "VERTEX_TOKEN_ENV",
    "VertexProvider",
    "default_vertex_base_url",
]

DEFAULT_VERTEX_LOCATION = "us-central1"
METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"  # noqa: S105
)
VERTEX_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN"  # noqa: S105

_RETRYABLE_STATUS = frozenset({408, 409, 424, 425, 429, 500, 502, 503, 504})
_FINISH_REASONS: dict[str, FinishReason] = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "SAFETY": "content-filter",
    "RECITATION": "content-filter",
    "BLOCKLIST": "content-filter",
    "PROHIBITED_CONTENT": "content-filter",
    "SPII": "content-filter",
    "MALFORMED_FUNCTION_CALL": "error",
}


def default_vertex_base_url(location: str) -> str:
    return f"https://{location}-aiplatform.googleapis.com"


class VertexProvider:
    """Gemini on Vertex AI over ``generateContent`` / ``streamGenerateContent``."""

    def __init__(
        self,
        *,
        project: str | None = None,
        location: str | None = None,
        access_token: str | None = None,
        base_url: str | None = None,
        name: str = "google",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
        token_provider: Callable[[], Awaitable[str]] | None = None,
    ) -> None:
        self._name = name
        self._project = project
        self._location = location
        self._access_token = access_token
        self._base_url = base_url
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._client = client
        self._owns_client = client is None
        self._token_provider = token_provider
        self._cached_token: tuple[str, float] | None = None

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> frozenset[Capability]:
        return frozenset(
            {Capability.STREAMING, Capability.STRUCTURED_OUTPUT, Capability.TOOL_CALLING}
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        body = await self._post(self._url(model, stream=False), self._build_payload(request, model))
        return self._parse(body, model)

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        client = self._ensure_client()
        headers = await self._headers()
        payload = self._build_payload(request, model)
        url = self._url(model, stream=True)

        usage: TokenUsage | None = None
        finish: FinishReason | None = None
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as response:
                    if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
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
                        text, _calls, reason, chunk_usage = _read_candidate(chunk, model)
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

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True
        return self._client

    def _resolve_project(self) -> str:
        if self._project:
            return self._project
        for key in ("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_PROJECT_ID"):
            value = _env(key)
            if value:
                return value
        raise ProviderError(
            f"{self._name} needs a project: set model provider 'project' or GOOGLE_CLOUD_PROJECT"
        )

    def _resolve_location(self) -> str:
        if self._location:
            return self._location
        for key in ("GOOGLE_CLOUD_REGION", "VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION"):
            value = _env(key)
            if value:
                return value
        return DEFAULT_VERTEX_LOCATION

    def _url(self, model: ModelSpec, *, stream: bool) -> str:
        location = self._resolve_location()
        base = (self._base_url or default_vertex_base_url(location)).rstrip("/")
        project = self._resolve_project()
        method = "streamGenerateContent?alt=sse" if stream else "generateContent"
        return (
            f"{base}/v1/projects/{project}/locations/{location}"
            f"/publishers/google/models/{model.name}:{method}"
        )

    async def _token(self) -> str:
        if self._access_token:
            return self._access_token
        env_token = _env(VERTEX_TOKEN_ENV) or _env("VERTEX_ACCESS_TOKEN")
        if env_token:
            return env_token
        if self._cached_token is not None:
            token, expires_at = self._cached_token
            if expires_at - asyncio.get_running_loop().time() > 60:
                return token
        token, expires_in = await self._mint_token()
        self._cached_token = (token, asyncio.get_running_loop().time() + expires_in)
        return token

    async def _mint_token(self) -> tuple[str, float]:
        if self._token_provider is not None:
            return await self._token_provider(), 300.0

        client = self._ensure_client()
        try:
            response = await client.get(METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"})
        except httpx.TransportError as exc:
            raise ProviderError(
                f"{self._name} has no credentials: set {VERTEX_TOKEN_ENV} or run on GCP "
                f"where the metadata server mints a token ({exc})"
            ) from exc
        if response.status_code >= 400:
            raise ProviderError(
                f"{self._name} metadata token request returned {response.status_code}: "
                f"{response.text[:200]}"
            )
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise ProviderResponseError(
                f"{self._name} metadata token is not JSON", response.text
            ) from exc
        token = body.get("access_token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token:
            raise ProviderResponseError(
                f"{self._name} metadata response had no access_token", response.text
            )
        expires_in = body.get("expires_in", 300)
        return token, float(expires_in) if isinstance(expires_in, (int, float)) else 300.0

    async def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {await self._token()}",
            "content-type": "application/json",
        }

    def _build_payload(self, request: CompletionRequest, model: ModelSpec) -> dict[str, Any]:
        generation_config: dict[str, Any] = {"maxOutputTokens": _max_tokens(request, model)}
        if request.temperature is not None:
            generation_config["temperature"] = request.temperature
        if request.stop:
            generation_config["stopSequences"] = list(request.stop)
        payload: dict[str, Any] = {
            "contents": _wire_contents(request.messages),
            "generationConfig": generation_config,
        }
        system = _system_prompt(request.messages)
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

            if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
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

    def _parse(self, text: str, model: ModelSpec) -> CompletionResponse:
        try:
            body = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderResponseError(
                f"{self._name} returned a body that is not JSON", text
            ) from exc
        if not isinstance(body, dict):
            raise ProviderResponseError(
                f"{self._name} returned a JSON body that is not an object", text
            )
        result, calls, reason, usage = _read_candidate(body, model)
        if result == "" and not calls and reason is None:
            raise ProviderResponseError(f"{self._name} returned no candidates", text)
        return CompletionResponse(
            text=result,
            model=model.name,
            provider=self._name,
            usage=usage or TokenUsage(input_tokens=0, output_tokens=0),
            tool_calls=tuple(calls),
            finish_reason=reason or ("tool-calls" if calls else "stop"),
        )


def _read_candidate(
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
        reason = _FINISH_REASONS.get(raw_reason, "stop")

    usage: TokenUsage | None = None
    raw_usage = body.get("usageMetadata")
    if isinstance(raw_usage, dict):
        usage = TokenUsage(
            input_tokens=int(raw_usage.get("promptTokenCount") or 0),
            output_tokens=int(raw_usage.get("candidatesTokenCount") or 0),
        )

    # Gemini reports the reason alongside the call; the call is the better signal.
    if calls and reason in (None, "stop"):
        reason = "tool-calls"
    return "".join(text_parts), calls, reason, usage


def _wire_contents(messages: tuple[Message, ...]) -> list[dict[str, Any]]:
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


def _system_prompt(messages: tuple[Message, ...]) -> str:
    return "\n".join(message.content for message in messages if message.role == "system")


def _max_tokens(request: CompletionRequest, model: ModelSpec) -> int:
    if request.max_output_tokens is not None:
        return min(request.max_output_tokens, model.max_output_tokens)
    return model.max_output_tokens


def _env(key: str) -> str | None:
    value = os.environ.get(key)
    return value if value else None
