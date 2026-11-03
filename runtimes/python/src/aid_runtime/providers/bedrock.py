"""Amazon Bedrock's Converse API adapter.

Bedrock is not an endpoint that accepts an API key, so it cannot be an
OpenAI-compatible ``base_url``. Every request is SigV4-signed with credentials
the environment supplies, which also means an empty secret is a *valid*
configuration: on ECS the task role hands the container temporary credentials
through the container credentials endpoint, and no ``api_key_env`` exists.

Converse is the portable surface: one request shape covers every model Bedrock
serves, so this adapter knows nothing about Anthropic, Llama or Titan wire
dialects. Three translations are structural rather than cosmetic:

- Converse has no system role; the prompt is a top-level ``system`` array;
- ``inferenceConfig.maxTokens`` is required, so the adapter always sends one;
- tool results are ``toolResult`` blocks in a ``user`` turn, and adjacent results
  are merged into one turn so the conversation keeps alternating roles.

There is no ``stream``: ``/converse-stream`` frames events in AWS's binary
event-stream format (length-prefixed records with CRC32) rather than SSE, which
is out of scope for this adapter. ``STREAMING`` is therefore not advertised, and
the capability gate refuses a spec that asks for it instead of failing mid-run.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import os
from collections.abc import AsyncIterator, Callable, Sequence
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlparse

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
    "BEDROCK_SERVICE",
    "BedrockProvider",
    "default_bedrock_base_url",
    "rfc3986",
    "sigv4_headers",
]

BEDROCK_SERVICE = "bedrock"

# Bedrock's "dependency failed" is not a standard client error, so omitting it
# would make a transient model-side failure permanent.
_RETRYABLE_STATUS = frozenset({408, 409, 424, 425, 429, 500, 502, 503, 504})

_FINISH_REASONS: dict[str, FinishReason] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool-calls",
    "guardrail_intervened": "content-filter",
    "content_filtered": "content-filter",
}

# Refresh container credentials this long before they expire.
_CREDENTIAL_REFRESH_SECONDS = 5 * 60


def default_bedrock_base_url(region: str) -> str:
    """The regional runtime host, used when no base URL is configured."""
    return f"https://bedrock-runtime.{region}.amazonaws.com"


def rfc3986(value: str) -> str:
    """Percent-encode one path segment the way SigV4 defines it.

    ``quote`` leaves ``!*'()`` alone by default and AWS does not: a signature over a
    path the server decodes differently fails with ``SignatureDoesNotMatch``.
    """
    return quote(value, safe="")


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def sigv4_headers(
    *,
    url: str,
    body: str,
    region: str,
    credentials: dict[str, Any],
    moment: datetime,
    service: str = BEDROCK_SERVICE,
) -> dict[str, str]:
    """The SigV4 headers for one JSON ``POST`` to ``url``.

    Shared by the model adapter and the managed-guardrail adapter because both
    sign with the ``bedrock`` service name -- Converse is served by
    ``bedrock-runtime`` but signed as ``bedrock``, and ``ApplyGuardrail`` is served
    by ``bedrock`` itself. Keeping one signer means a fix to the canonical request
    cannot land in one caller and miss the other.
    """
    stamp = _amz_date(moment)
    date = stamp[:8]
    parsed = urlparse(url)
    host = parsed.netloc
    canonical_headers: list[tuple[str, str]] = [
        ("content-type", "application/json"),
        ("host", host),
        ("x-amz-date", stamp),
    ]
    token = credentials.get("session_token")
    if isinstance(token, str):
        canonical_headers.append(("x-amz-security-token", token))
    signed_headers = ";".join(header for header, _ in canonical_headers)
    canonical_request = "\n".join(
        [
            "POST",
            parsed.path,
            "",
            "".join(f"{header}:{value}\n" for header, value in canonical_headers),
            signed_headers,
            _sha256_hex(body),
        ]
    )
    scope = f"{date}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, _sha256_hex(canonical_request)])
    signing_key = _hmac(
        _hmac(
            _hmac(
                _hmac(f"AWS4{credentials['secret_access_key']}", date),
                region,
            ),
            service,
        ),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {
        "content-type": "application/json",
        "x-amz-date": stamp,
        "authorization": (
            f"AWS4-HMAC-SHA256 Credential={credentials['access_key_id']}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }
    if isinstance(token, str):
        headers["x-amz-security-token"] = token
    return headers


def _hmac(key: bytes | str, value: str) -> bytes:
    if isinstance(key, str):
        key = key.encode()
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


def _amz_date(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


class BedrockProvider:
    """Calls ``POST /model/{id}/converse`` on the regional Bedrock runtime."""

    def __init__(
        self,
        *,
        region: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        session_token: str | None = None,
        base_url: str | None = None,
        name: str = "bedrock",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
        extra_headers: dict[str, str] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._region = region
        self._static: dict[str, Any] | None = None
        if access_key_id is not None and secret_access_key is not None:
            self._static = {
                "access_key_id": access_key_id,
                "secret_access_key": secret_access_key,
            }
            if session_token is not None:
                self._static["session_token"] = session_token
        self._base_url = base_url.rstrip("/") if base_url is not None else None
        self._name = name
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._extra_headers = dict(extra_headers or {})
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._now = now or (lambda: datetime.now(UTC))
        self._cached: dict[str, Any] | None = None
        self._closed = False

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> frozenset[Capability]:
        return frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT})

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        body = json.dumps(self._build_payload(request, model), separators=(",", ":"))
        region = self._resolve_region()
        credentials = await self._credentials()
        url = self._endpoint(model, region)
        headers = self._headers(url, body, region, credentials, self._now())
        text = await self._post(url, headers, body)
        return self._parse(text, model)

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        """Refuse: ``/converse-stream`` is not SSE.

        Streaming here would mean decoding AWS's binary event-stream framing and
        computing per-frame CRC32 checksums. Until that exists, refusing is better
        than silently buffering a "stream" the caller believes is incremental.
        """
        del request, model
        raise ProviderError(
            f"{self._name} does not stream: Bedrock frames events in AWS's binary "
            "event-stream format, which this adapter does not decode; use complete()"
        )
        yield  # type: ignore[unreachable]  # pragma: no cover - keeps this an async generator

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    def _resolve_region(self) -> str:
        region = (
            self._region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        )
        if not region:
            raise ProviderError(
                f"{self._name} needs a region: pass region, or set AWS_REGION "
                "(Bedrock model ids are regional)"
            )
        return region

    def _endpoint(self, model: ModelSpec, region: str) -> str:
        base = self._base_url or default_bedrock_base_url(region)
        return f"{base}/model/{rfc3986(model.name)}/converse"

    async def _credentials(self) -> dict[str, Any]:
        """Static credentials, else the environment, else the container endpoint.

        Resolution is lazy so importing a generated app cannot fail when a role
        supplies credentials only once the process is running.
        """
        if self._static is not None:
            return self._static
        if self._cached is not None:
            expires_at = self._cached.get("expires_at")
            refresh_at = self._now().timestamp() + _CREDENTIAL_REFRESH_SECONDS
            if expires_at is None or expires_at > refresh_at:
                return self._cached

        access_key_id = os.environ.get("AWS_ACCESS_KEY_ID")
        secret_access_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
        if access_key_id and secret_access_key:
            credentials: dict[str, Any] = {
                "access_key_id": access_key_id,
                "secret_access_key": secret_access_key,
            }
            token = os.environ.get("AWS_SESSION_TOKEN")
            if token is not None:
                credentials["session_token"] = token
            return credentials

        relative = os.environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        full = os.environ.get("AWS_CONTAINER_CREDENTIALS_FULL_URI")
        url = f"http://169.254.170.2{relative}" if relative else full
        if url:
            fetched = await self._fetch_credentials(url)
            self._cached = fetched
            return fetched

        raise ProviderError(
            f"{self._name} has no credentials: set AWS_ACCESS_KEY_ID and "
            "AWS_SECRET_ACCESS_KEY, or run where AWS_CONTAINER_CREDENTIALS_RELATIVE_URI "
            "is set (a task role)"
        )

    async def _fetch_credentials(self, url: str) -> dict[str, Any]:
        try:
            response = await self._client.get(url)
        except httpx.TransportError as exc:
            raise ProviderError(
                f"{self._name} could not reach the container credentials endpoint: {exc}"
            ) from exc
        if response.status_code >= 400:
            raise ProviderError(
                f"{self._name} container credentials endpoint returned "
                f"{response.status_code}: {response.text[:500]}"
            )
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise ProviderResponseError(
                f"{self._name} credentials endpoint returned a non-JSON body",
                response.text,
            ) from exc
        if not _is_object(body):
            raise ProviderResponseError(
                f"{self._name} credentials endpoint returned no object", response.text
            )
        access_key_id = body.get("AccessKeyId")
        secret_access_key = body.get("SecretAccessKey")
        if not isinstance(access_key_id, str) or not isinstance(secret_access_key, str):
            raise ProviderResponseError(
                f"{self._name} credentials endpoint returned no AccessKeyId/SecretAccessKey",
                json.dumps(body, sort_keys=True),
            )
        credentials: dict[str, Any] = {
            "access_key_id": access_key_id,
            "secret_access_key": secret_access_key,
        }
        token = body.get("Token")
        if isinstance(token, str) and token:
            credentials["session_token"] = token
        expiration = body.get("Expiration")
        if isinstance(expiration, str):
            with contextlib.suppress(ValueError):
                credentials["expires_at"] = _parse_iso(expiration)
        return credentials

    def _headers(
        self,
        url: str,
        body: str,
        region: str,
        credentials: dict[str, Any],
        moment: datetime,
    ) -> dict[str, str]:
        return {
            **sigv4_headers(
                url=url,
                body=body,
                region=region,
                credentials=credentials,
                moment=moment,
                service=BEDROCK_SERVICE,
            ),
            **self._extra_headers,
        }

    def resolve_region(self) -> str:
        """The region this adapter signs for, or a :class:`ProviderError`."""
        return self._resolve_region()

    async def send(self, url: str, *, body: str, headers: dict[str, str]) -> httpx.Response:
        """One signed POST, uninterpreted: shared with the managed-guardrail adapter."""
        return await self._client.post(url, content=body, headers=headers)

    async def credentials(self) -> dict[str, Any]:
        """The SigV4 credentials, resolved lazily.

        Public because the managed-guardrail adapter signs with the same identity:
        a deployment that can invoke a model can also apply a guardrail, and
        reading the role twice would be two chances to read it differently.
        """
        return await self._credentials()

    def _build_payload(self, request: CompletionRequest, model: ModelSpec) -> dict[str, Any]:
        inference_config: dict[str, Any] = {"maxTokens": _max_tokens(request, model)}
        if request.temperature is not None:
            inference_config["temperature"] = request.temperature
        if request.stop:
            inference_config["stopSequences"] = list(request.stop)
        payload: dict[str, Any] = {
            "messages": _wire_messages(self._name, request.messages),
            "inferenceConfig": inference_config,
        }
        system = _system_prompt(request.messages)
        if system:
            payload["system"] = [{"text": system}]
        if request.tools:
            payload["toolConfig"] = {
                "tools": [
                    {
                        "toolSpec": {
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": {
                                "json": tool.parameters or {"type": "object", "properties": {}}
                            },
                        }
                    }
                    for tool in request.tools
                ]
            }
        return payload

    async def _post(self, url: str, headers: dict[str, str], body: str) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(url, content=body, headers=headers)
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
        output = body.get("output")
        message = output.get("message") if isinstance(output, dict) else None
        blocks = message.get("content") if isinstance(message, dict) else None
        if not isinstance(blocks, list):
            raise ProviderResponseError(f"{self._name} returned no content blocks", text)

        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            value = block.get("text")
            if isinstance(value, str):
                text_parts.append(value)
                continue
            tool_use = block.get("toolUse")
            if not isinstance(tool_use, dict):
                continue
            call_id = tool_use.get("toolUseId")
            call_name = tool_use.get("name")
            if not isinstance(call_id, str) or not call_id:
                continue
            if not isinstance(call_name, str) or not call_name:
                continue
            raw_input = tool_use.get("input")
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
                input_tokens=int(raw_usage.get("inputTokens") or 0),
                output_tokens=int(raw_usage.get("outputTokens") or 0),
            )

        return CompletionResponse(
            text="".join(text_parts),
            model=model.name,
            provider=self._name,
            usage=usage,
            tool_calls=tuple(calls),
            finish_reason=_finish_reason(body.get("stopReason"), bool(calls)),
        )


def _parse_iso(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _max_tokens(request: CompletionRequest, model: ModelSpec) -> int:
    """Converse requires the field; a request without a cap still needs a number."""
    if request.max_output_tokens is not None:
        return min(request.max_output_tokens, model.max_output_tokens)
    return model.max_output_tokens


def _system_prompt(messages: Sequence[Message]) -> str:
    """Converse takes one ``system`` array, so adjacent system turns are joined."""
    parts = [
        message.content for message in messages if message.role == "system" and message.content
    ]
    return "\n\n".join(parts)


def _wire_messages(name: str, messages: Sequence[Message]) -> list[dict[str, Any]]:
    """Translate the portable message list into the wire shape.

    An assistant turn carrying tool calls sends ``toolUse`` blocks, or the following
    ``toolResult`` has no caller; adjacent ``tool`` turns collapse into one ``user``
    turn, because Converse requires the conversation to alternate roles.
    """
    wire: list[dict[str, Any]] = []
    previous_was_tool_result = False
    for message in messages:
        if message.role == "system":
            continue
        if message.role == "tool":
            if message.tool_call_id is None:
                raise ProviderError(f"{name} cannot send a tool result without a tool_call_id")
            block = {
                "toolResult": {
                    "toolUseId": message.tool_call_id,
                    "content": [{"text": message.content}],
                }
            }
            if previous_was_tool_result and wire:
                wire[-1]["content"].append(block)
            else:
                wire.append({"role": "user", "content": [block]})
            previous_was_tool_result = True
            continue
        previous_was_tool_result = False
        if message.role == "user":
            # Converse rejects an empty text block, so an empty turn is dropped.
            if not message.content:
                continue
            wire.append({"role": "user", "content": [{"text": message.content}]})
            continue
        blocks: list[dict[str, Any]] = []
        if message.content:
            blocks.append({"text": message.content})
        blocks.extend(
            {
                "toolUse": {
                    "toolUseId": call.id,
                    "name": call.name,
                    "input": call.arguments,
                }
            }
            for call in message.tool_calls
        )
        if not blocks:
            continue
        wire.append({"role": "assistant", "content": blocks})
    return wire


def _finish_reason(raw: Any, saw_tool_call: bool) -> FinishReason:
    if not isinstance(raw, str):
        return "tool-calls" if saw_tool_call else "stop"
    return _FINISH_REASONS.get(raw, "stop")
