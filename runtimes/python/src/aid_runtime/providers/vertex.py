"""Vertex AI adapter for Gemini models.

Vertex speaks its own dialect: ``contents`` of ``parts`` rather than messages,
Google-shaped tool declarations, and a dedicated streaming endpoint. That wire
translation is shared with the Gemini API adapter in ``gemini_wire``; this module
keeps only what is Vertex-specific -- the project/location URL and the OAuth2 token.

It is authenticated with an OAuth2 bearer token, not an API key -- the token is
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
from collections.abc import Awaitable, Callable
from typing import Any

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


def default_vertex_base_url(location: str) -> str:
    return f"https://{location}-aiplatform.googleapis.com"


class VertexProvider(GeminiWireClient):
    """Gemini on Vertex AI over ``generateContent`` / ``streamGenerateContent``.

    Embeddings ride the same adapter: ``:predict`` shares the regional host, the
    project/location path and the bearer token, and only the request and response
    envelopes differ.
    """

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
        super().__init__(
            name=name,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            backoff_seconds=backoff_seconds,
            client=client,
        )
        self._project = project
        self._location = location
        self._access_token = access_token
        self._base_url = base_url
        self._token_provider = token_provider
        self._cached_token: tuple[str, float] | None = None

    @property
    def capabilities(self) -> frozenset[Capability]:
        # Embeddings are served by `:predict` under the same project, location and
        # bearer token, so this adapter carries the method instead of a second client.
        return frozenset(
            {
                Capability.STREAMING,
                Capability.STRUCTURED_OUTPUT,
                Capability.TOOL_CALLING,
                Capability.EMBEDDINGS,
            }
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        body = await self._post(self._url(model, stream=False), build_payload(request, model))
        return self._parse(body, model)

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

    def project(self) -> str:
        """The project this adapter bills and addresses, resolved lazily."""
        return self._resolve_project()

    def location(self) -> str:
        """The region this adapter addresses, resolved lazily."""
        return self._resolve_location()

    async def predict(self, model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """One ``:predict`` call, uninterpreted.

        Public because embedding is the same operation against the same identity:
        re-resolving the project, the location and the token elsewhere is three
        chances for the embedder to address a different deployment than the chat
        model.
        """
        location = self._resolve_location()
        base = (self._base_url or default_vertex_base_url(location)).rstrip("/")
        url = (
            f"{base}/v1/projects/{self._resolve_project()}/locations/{location}"
            f"/publishers/google/models/{model_id}:predict"
        )
        return decode_body(await self._post(url, payload), self._name)

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

    async def access_token(self) -> str:
        """The bearer token this provider would send.

        Public so a second Google API a deployment calls -- Model Armor is one --
        reuses the same environment override, metadata mint and refresh window
        instead of growing a second token cache with its own expiry bug.
        """
        return await self._token()

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


def _env(key: str) -> str | None:
    value = os.environ.get(key)
    return value if value else None
