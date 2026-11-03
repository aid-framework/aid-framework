"""Gemini API adapter -- the public Gemini service, not Vertex AI.

Same wire as Vertex (``contents`` of ``parts``, ``functionDeclarations``,
``systemInstruction``), so the translation lives in ``gemini_wire``. What differs is
everything around it: one API key instead of an OAuth2 token, a fixed host with no
project or location, and the ``v1beta`` endpoint.

The API key travels in ``x-goog-api-key`` rather than a query string. Google's own
docs offer ``?key=`` as well, but a query string ends up in access logs, proxy
history and error reports far more readily than a header does.

A wrong key comes back as ``400 FAILED_PRECONDITION``, so 400 is never retried.
"""

from __future__ import annotations

import os

import httpx

from aid_runtime.errors import ProviderError, ProviderResponseError
from aid_runtime.providers.gemini_wire import (
    GeminiWireClient,
    build_payload,
    decode_body,
    read_candidate,
)
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    ModelSpec,
    TokenUsage,
)

__all__ = ["DEFAULT_GEMINI_BASE_URL", "GEMINI_API_KEY_ENV", "GeminiProvider"]

DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
GEMINI_API_KEY_ENV = "GEMINI_API_KEY"


class GeminiProvider(GeminiWireClient):
    """Gemini over ``generateContent`` / ``streamGenerateContent``.

    ``DEFAULT_RETRYABLE_STATUS`` deliberately omits 400: this service answers
    ``400 FAILED_PRECONDITION`` for a bad API key, and retrying that only spends money.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        name: str = "gemini",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            name=name,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            backoff_seconds=backoff_seconds,
            client=client,
        )
        self._api_key = api_key
        self._base_url = base_url

    @property
    def capabilities(self) -> frozenset[Capability]:
        return frozenset(
            {Capability.STREAMING, Capability.STRUCTURED_OUTPUT, Capability.TOOL_CALLING}
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        body = await self._post(self._url(model, stream=False), build_payload(request, model))
        return self._parse(body, model)

    def _url(self, model: ModelSpec, *, stream: bool) -> str:
        base = (self._base_url or DEFAULT_GEMINI_BASE_URL).rstrip("/")
        method = "streamGenerateContent?alt=sse" if stream else "generateContent"
        return f"{base}/v1beta/models/{model.name}:{method}"

    async def _headers(self) -> dict[str, str]:
        return {
            "x-goog-api-key": self._key(),
            "content-type": "application/json",
        }

    def _key(self) -> str:
        if self._api_key:
            return self._api_key
        env_key = os.environ.get(GEMINI_API_KEY_ENV)
        if env_key:
            return env_key
        raise ProviderError(
            f"{self._name} has no API key: set model provider 'apiKeyEnv' or {GEMINI_API_KEY_ENV}"
        )

    def _parse(self, text: str, model: ModelSpec) -> CompletionResponse:
        body = decode_body(text, self._name)
        result, calls, reason, usage = read_candidate(body, model)
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
