"""Turning text into vectors.

Two adapters, and that is the whole Phase 1 surface: one deterministic fake and one
OpenAI-compatible HTTP client. The fake is not a testing afterthought -- it is the
adapter the eval gate runs against, because a gate that needed an API key could not
run offline in CI. That is the same reason the spec DSL already has
``provider: fake`` ("deterministic and keyless, which is what lets the eval gate run
offline").

The pinning rule lives in the seam, not in the adapters: ``embed`` takes a
:class:`~aid_runtime.retrieval.types.PinnedEmbedding` and uses its ``model_id`` and
``dimensions``. Nothing here resolves an alias, and the fake hashes the *pinned*
model id into its vector, so a silently changed pin produces different vectors
rather than a store full of incomparable ones.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

import httpx
from pydantic import BaseModel, ConfigDict

from aid_runtime.errors import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.providers.http import DEFAULT_BASE_URL
from aid_runtime.retrieval.types import PinnedEmbedding
from aid_runtime.types import TokenUsage

__all__ = [
    "Embedder",
    "EmbeddingBatch",
    "FakeDeterministicEmbedder",
    "OpenAICompatibleEmbedder",
    "embedder_for",
    "estimate_tokens",
]

#: Statuses worth a second attempt: the request was well-formed and the server was
#: momentarily unwilling. Mirrors the chat provider's set so retry behaviour is one
#: rule in this runtime rather than one rule per adapter.
_RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})

#: Rough tokeniser. Deliberately the same arithmetic as
#: ``cost.estimate_prompt_cost_usd`` (4 characters per token, rounded up), so an
#: offline estimate and an offline charge cannot disagree about what a text costs.
_CHARS_PER_TOKEN = 4


class EmbeddingBatch(BaseModel):
    """Vectors plus the usage that prices them."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    vectors: tuple[tuple[float, ...], ...]
    usage: TokenUsage


@runtime_checkable
class Embedder(Protocol):
    """Text to vectors, with the model pinned by the caller.

    ``aclose`` must be idempotent, matching
    :class:`~aid_runtime.providers.base.Provider`: a client's lifetime is owned by
    the caller, so closing twice is a caller's mistake that must stay harmless.
    """

    @property
    def name(self) -> str: ...

    async def embed(self, texts: Sequence[str], *, model: PinnedEmbedding) -> EmbeddingBatch: ...

    async def aclose(self) -> None: ...


def estimate_tokens(text: str) -> int:
    """The offline token estimate used for the fake's usage and for budgets."""
    return (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


class FakeDeterministicEmbedder:
    """Keyless, offline, and byte-identical across runs and platforms.

    Vectors come from SHAKE-128, a hash-based extensible output function, rather
    than from a seeded PRNG. The reason is the same property the rest of this
    runtime depends on: re-ingesting a corpus has to reproduce the vectors exactly,
    and re-embedding a *query* has to reproduce what ingest stored. A PRNG seeded
    per call would be stable too, but a hash makes "same text, same vector" true by
    construction rather than by discipline, and it cannot drift if a vector is later
    requested one element at a time.

    Similarity is meaningless here, and that is the deliberate limitation rather
    than a bug. Lexical retrieval still works over these vectors because the store
    keeps the text and hybrid search reads it; what the fake proves is the
    *pipeline*, and what it deliberately does not prove is embedding quality.
    """

    def __init__(self, *, name: str = "fake-embedder") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    async def embed(self, texts: Sequence[str], *, model: PinnedEmbedding) -> EmbeddingBatch:
        return EmbeddingBatch(
            vectors=tuple(self._vector(text, model) for text in texts),
            usage=TokenUsage(
                input_tokens=sum(estimate_tokens(text) for text in texts),
                output_tokens=0,
            ),
        )

    async def aclose(self) -> None:
        return None

    def _vector(self, text: str, model: PinnedEmbedding) -> tuple[float, ...]:
        # The pinned model id is part of the input so the same text under a different
        # pin embeds differently: a changed pin must invalidate stored vectors rather
        # than silently mix two vector spaces in one table.
        seed = f"{model.model_id}:{model.dimensions}\x00{text}"
        raw = hashlib.shake_128(seed.encode("utf-8")).digest(model.dimensions * 2)
        values = [
            (int.from_bytes(raw[index * 2 : index * 2 + 2], "big") / 32767.5) - 1.0
            for index in range(model.dimensions)
        ]
        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        return tuple(value / norm for value in values)


class OpenAICompatibleEmbedder:
    """One POST to ``/embeddings`` on any OpenAI-compatible endpoint.

    Deliberately narrow: the runtime has exactly one hosted embedding adapter, and
    breadth of vendor coverage is a later concern than a correct seam. Retry,
    timeouts, error classification and client ownership all mirror
    :class:`~aid_runtime.providers.http.OpenAICompatibleProvider` so a caller learns
    the rules once.
    """

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        name: str = "openai-compatible-embedder",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ConfigurationError(f"base_url must be an absolute http(s) URL, got {base_url!r}")
        if max_attempts < 1:
            raise ConfigurationError("max_attempts must be at least 1")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._name = name
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._extra_headers = dict(extra_headers or {})
        # Eager, like the chat provider: the caller may inject a client (a test's
        # transport, or a shared pool). Whoever constructed it closes it, so
        # ownership is tracked rather than assumed.
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._closed = False

    @property
    def name(self) -> str:
        return self._name

    async def embed(self, texts: Sequence[str], *, model: PinnedEmbedding) -> EmbeddingBatch:
        body = await self._post("/embeddings", {"model": model.model_id, "input": list(texts)})
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
            # A real bearer token, not the chat provider's redacted placeholder: a
            # request that claims to be authenticated and is not fails with a 401 that
            # reads like a credentials problem at the far end.
            headers["authorization"] = f"Bearer {self._api_key}"
        return headers

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(url, json=payload, headers=self._headers())
            except httpx.TransportError as error:
                last_error = error
            else:
                if response.status_code < 400:
                    return _as_object(response, self._name)
                failure = ProviderError(
                    f"{self._name} returned HTTP {response.status_code}: {response.text[:200]}"
                )
                # A status outside the retryable set is a decision, not a hiccup:
                # retrying a 400 only wastes the caller's time.
                if response.status_code not in _RETRYABLE_STATUS:
                    raise failure
                last_error = failure
            if attempt < self._max_attempts:
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
        # Chained rather than formatted away: the transport error carries the reason
        # (DNS, TLS, refused connection), and a caller catching the ProviderError
        # should still be able to see it, as the chat provider's callers can.
        raise ProviderError(
            f"{self._name} failed after {self._max_attempts} attempt(s): {last_error}"
        ) from last_error

    def _parse(self, body: dict[str, Any], model: PinnedEmbedding) -> EmbeddingBatch:
        entries = body.get("data")
        if not isinstance(entries, list) or not entries:
            raise ProviderResponseError(f"{self._name} returned no embeddings")

        ordered: list[tuple[int, Any]] = []
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise ProviderResponseError(f"{self._name} returned a non-object embedding entry")
            index = entry.get("index", position)
            if not isinstance(index, int):
                raise ProviderResponseError(f"{self._name} returned a non-integer embedding index")
            ordered.append((index, entry.get("embedding")))
        ordered.sort(key=lambda pair: pair[0])

        vectors: list[tuple[float, ...]] = []
        for _, vector in ordered:
            if not isinstance(vector, list):
                raise ProviderResponseError(f"{self._name} returned a non-list embedding")
            try:
                values = tuple(float(value) for value in vector)
            except (TypeError, ValueError) as error:
                raise ProviderResponseError(
                    f"{self._name} returned a non-numeric embedding"
                ) from error
            if len(values) != model.dimensions:
                raise ProviderResponseError(
                    f"{self._name} returned {len(values)} dimensions for {model.model_id!r} but "
                    f"{model.dimensions} are pinned; the pin and the response must agree"
                )
            vectors.append(values)

        usage = body.get("usage")
        found = usage.get("prompt_tokens") if isinstance(usage, dict) else None
        prompt_tokens = found if isinstance(found, int) else 0
        return EmbeddingBatch(
            vectors=tuple(vectors),
            usage=TokenUsage(input_tokens=prompt_tokens, output_tokens=0),
        )


def _as_object(response: httpx.Response, name: str) -> dict[str, Any]:
    try:
        body = response.json()
    except json.JSONDecodeError as error:
        raise ProviderResponseError(f"{name} returned a body that is not JSON") from error
    if not isinstance(body, dict):
        raise ProviderResponseError(f"{name} returned a JSON body that is not an object")
    return body


def embedder_for(
    model: PinnedEmbedding,
    *,
    api_key: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    client: httpx.AsyncClient | None = None,
) -> Embedder:
    """Pick the adapter for a pinned embedding model.

    This selects a *provider*, never a model: the model id and its width arrive
    already pinned, and are passed straight through to whichever adapter is chosen.
    ``fake`` is chosen for the same reason the spec can declare it -- so a gate runs
    keyless and offline.
    """
    if model.provider == "fake":
        return FakeDeterministicEmbedder()
    return OpenAICompatibleEmbedder(base_url=base_url, api_key=api_key, client=client)
