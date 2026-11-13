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

``stream`` uses ``ConverseStream`` on the same host and identity, so it reuses
this adapter's region, credential chain and signature. Bedrock does not speak
SSE: ``/converse-stream`` frames events in AWS's binary event-stream format --
length-prefixed records with a CRC32 over the prelude and one over the whole
message -- so the adapter decodes and checksums frames and turns
``contentBlockDelta.text``, ``messageStop`` and ``metadata.usage`` into
:class:`StreamChunk`. Tool calls are not reported, because :class:`StreamChunk`
has no field for them; a caller that needs tool calls uses :meth:`complete`.

``EMBEDDINGS`` *is* advertised: Titan models answer on ``InvokeModel``, which is
the uninterpreted sibling of ``complete`` sharing this adapter's region,
credential chain, signature and retry.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import zlib
from collections.abc import AsyncIterator, Callable, Iterator, Sequence
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
    method: str = "POST",
    query: str = "",
) -> dict[str, str]:
    """The SigV4 headers for one request to ``url``.

    Shared by the model adapter, the managed-guardrail adapter and the managed
    knowledge-base adapter because all three sign with the same identity. Converse is
    served by ``bedrock-runtime`` but signed as ``bedrock``, ``ApplyGuardrail`` is served
    by ``bedrock`` itself, and ``Retrieve`` is served by ``bedrock-agent-runtime``; the
    service name is therefore a parameter rather than a constant. Keeping one signer
    means a fix to the canonical request cannot land in one caller and miss the others.

    ``method`` and ``query`` exist for the knowledge-base adapter, whose readiness check
    is a ``GET`` with a query string. Both are part of the canonical request, so a caller
    that changed either without signing it would produce a signature AWS rejects.
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
            method,
            parsed.path,
            query,
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


# AWS frames an event as total_length | headers_length | prelude CRC32 | headers |
# payload | message CRC32, every integer big-endian and each CRC32 computed over the
# bytes before it. Frames are neither length-delimited by a separator nor aligned, so
# the decoder buffers until a whole frame is present.
_PRELUDE_BYTES = 12
_MESSAGE_CRC_BYTES = 4


def _crc32(value: bytes) -> int:
    return zlib.crc32(value) & 0xFFFFFFFF


class EventStreamDecoder:
    """Decode AWS's binary event-stream bytes into ``{headers, payload}`` messages.

    Both checksums are verified. A frame that is corrupt, truncated mid-prelude or a
    length that no frame could have raises rather than being parsed into an event that
    looks plausible and silently corrupts the answer.
    """

    def __init__(self, name: str = "bedrock") -> None:
        self._name = name
        self._buffer = bytearray()

    def feed(self, data: bytes) -> Iterator[dict[str, Any]]:
        """Append bytes and yield every complete message now available."""
        self._buffer.extend(data)
        while True:
            message = self._take()
            if message is None:
                return
            yield message

    def _take(self) -> dict[str, Any] | None:
        if len(self._buffer) < _PRELUDE_BYTES:
            return None
        total = int.from_bytes(self._buffer[0:4], "big")
        headers_length = int.from_bytes(self._buffer[4:8], "big")
        if _crc32(bytes(self._buffer[0:8])) != int.from_bytes(self._buffer[8:12], "big"):
            raise ProviderResponseError(
                f"{self._name} streamed a frame whose prelude checksum does not match",
                self._buffer[:12].hex(),
            )
        if total < _PRELUDE_BYTES + _MESSAGE_CRC_BYTES or (
            headers_length > total - _PRELUDE_BYTES - _MESSAGE_CRC_BYTES
        ):
            raise ProviderResponseError(
                f"{self._name} streamed a frame with impossible lengths",
                f"total_length={total} headers_length={headers_length}",
            )
        if len(self._buffer) < total:
            return None
        frame = bytes(self._buffer[:total])
        del self._buffer[:total]
        body = frame[:-_MESSAGE_CRC_BYTES]
        trailer = int.from_bytes(frame[-_MESSAGE_CRC_BYTES:], "big")
        if _crc32(body) != trailer:
            raise ProviderResponseError(
                f"{self._name} streamed a frame whose message checksum does not match",
                frame.hex()[:500],
            )
        payload = frame[_PRELUDE_BYTES + headers_length : -_MESSAGE_CRC_BYTES]
        return {
            "headers": _event_headers(self._name, frame, headers_length),
            "payload": _event_payload(self._name, payload),
        }


def _event_payload(name: str, payload: bytes) -> dict[str, Any]:
    if not payload:
        return {}
    try:
        body = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ProviderResponseError(
            f"{name} streamed an event whose payload is not JSON",
            payload[:500].decode(errors="replace"),
        ) from exc
    if not isinstance(body, dict):
        raise ProviderResponseError(
            f"{name} streamed an event whose payload is not a JSON object",
            payload[:500].decode(errors="replace"),
        )
    return body


def _event_headers(name: str, frame: bytes, headers_length: int) -> dict[str, Any]:
    """Read the frame's headers: name length, name, value type, then the typed value."""
    headers: dict[str, Any] = {}
    offset = _PRELUDE_BYTES
    end = _PRELUDE_BYTES + headers_length
    while offset < end:
        name_length = frame[offset]
        offset += 1
        header = frame[offset : offset + name_length].decode(errors="replace")
        offset += name_length
        value_type = frame[offset]
        offset += 1
        if value_type == 0:
            headers[header] = True
        elif value_type == 1:
            headers[header] = False
        elif value_type in {2, 6, 7}:
            length = int.from_bytes(frame[offset : offset + 2], "big")
            offset += 2
            raw = frame[offset : offset + length]
            offset += length
            headers[header] = raw if value_type == 6 else raw.decode(errors="replace")
        elif value_type in {3, 4, 5, 8}:
            width = {3: 2, 4: 4, 5: 8, 8: 8}[value_type]
            headers[header] = int.from_bytes(frame[offset : offset + width], "big", signed=True)
            offset += width
        elif value_type == 9:
            headers[header] = frame[offset : offset + 16].hex()
            offset += 16
        else:
            raise ProviderResponseError(
                f"{name} streamed a header with an unknown value type {value_type}", header
            )
    if offset > end:
        raise ProviderResponseError(
            f"{name} streamed a frame whose headers run past their own length",
            f"headers_length={headers_length} read={offset - _PRELUDE_BYTES}",
        )
    return headers


def _converse_stream_chunk(name: str, message: dict[str, Any]) -> StreamChunk | None:
    """One decoded frame as the portable chunk type, or ``None`` for frames to skip."""
    headers = message.get("headers") or {}
    payload = message.get("payload") or {}
    if headers.get(":message-type") in {"exception", "error"}:
        kind = headers.get(":exception-type") or headers.get(":error-code") or "error"
        raise ProviderResponseError(
            f"{name} streamed an error event ({kind}): {payload.get('message')}",
            json.dumps(payload, separators=(",", ":"))[:500],
        )
    event = headers.get(":event-type")
    if event == "contentBlockDelta":
        delta = payload.get("delta")
        text = delta.get("text") if isinstance(delta, dict) else None
        return StreamChunk(delta=text) if isinstance(text, str) else None
    if event == "messageStop":
        return StreamChunk(finish_reason=_finish_reason(payload.get("stopReason"), False))
    if event == "metadata":
        raw = payload.get("usage")
        if not isinstance(raw, dict):
            return None
        return StreamChunk(
            usage=TokenUsage(
                input_tokens=int(raw.get("inputTokens") or 0),
                output_tokens=int(raw.get("outputTokens") or 0),
            )
        )
    return None


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
        # Embeddings are served by InvokeModel on this same host and identity, so the
        # method that backs them is on this adapter rather than a separate client.
        # Streaming is ConverseStream: the same call over AWS's binary event-stream
        # framing instead of a whole body.
        return frozenset(
            {
                Capability.TOOL_CALLING,
                Capability.STRUCTURED_OUTPUT,
                Capability.EMBEDDINGS,
                Capability.STREAMING,
            }
        )

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
        """Stream one call from ``/converse-stream``.

        One attempt, like the sibling adapters: a stream that has already emitted text
        cannot be replayed, so a failure is raised once rather than retried mid-stream.
        Tool calls are not reported here because :class:`StreamChunk` has no field for
        them; the gateway that needs tool calls uses :meth:`complete`.
        """
        body = json.dumps(self._build_payload(request, model), separators=(",", ":"))
        region = self._resolve_region()
        credentials = await self._credentials()
        url = self._endpoint(model, region, "converse-stream")
        headers = self._headers(url, body, region, credentials, self._now())
        decoder = EventStreamDecoder(self._name)
        try:
            async with self._client.stream("POST", url, content=body, headers=headers) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise ProviderError(
                        f"{self._name} returned {response.status_code}: {response.text[:500]}"
                    )
                async for raw in response.aiter_bytes():
                    for message in decoder.feed(raw):
                        chunk = _converse_stream_chunk(self._name, message)
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

    def _endpoint(self, model: ModelSpec, region: str, operation: str = "converse") -> str:
        base = self._base_url or default_bedrock_base_url(region)
        return f"{base}/model/{rfc3986(model.name)}/{operation}"

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

    async def invoke_model(self, model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """One signed ``InvokeModel`` call, uninterpreted.

        Converse is the portable *chat* surface; embeddings are not on it. Titan
        embeddings answer on ``/model/{id}/invoke`` from the same host and under the
        same identity, so this adapter owns the path rather than a second client
        re-deriving the region, the credential chain and the signature.
        """
        body = json.dumps(payload, separators=(",", ":"))
        region = self._resolve_region()
        credentials = await self._credentials()
        base = self._base_url or default_bedrock_base_url(region)
        url = f"{base}/model/{rfc3986(model_id)}/invoke"
        headers = self._headers(url, body, region, credentials, self._now())
        text = await self._post(url, headers, body)
        try:
            answer = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderResponseError(
                f"{self._name} returned a body that is not JSON", text
            ) from exc
        if not isinstance(answer, dict):
            raise ProviderResponseError(
                f"{self._name} returned a JSON body that is not an object", text
            )
        return answer

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
