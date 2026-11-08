"""Reading a corpus an engine indexed, rather than one this process indexed.

A managed knowledge base inverts the retrieval pipeline. Locally, this runtime reads a
source, chunks it, embeds it and writes vectors; the retriever owns every step after the
source. With a managed base the engine owns all of them, and the runtime is left with one
operation -- *retrieve* -- plus the obligation to say when that operation cannot be
trusted.

Two decisions this module owns.

**Retrieve, never retrieve-and-generate.** Bedrock's ``RetrieveAndGenerate`` and Vertex's
``vertexRagStore`` tool both generate an answer inside the service. Using either would
create a second generation path that no model gate, no guardrail stage and no cost ledger
covers, so the runtime would be serving tokens it never measured. ``Retrieve`` and
``:retrieveContexts`` return passages, which is exactly what the existing ``retrieval``
step already consumes.

**A completed ingestion is a precondition, not an assumption.** A fresh ``apply`` creates
an empty corpus; the ingestion job fills it minutes later. A retrieve in that window
returns *nothing*, which a caller reads as "the corpus has no answer" rather than "the
corpus was never indexed". :meth:`BedrockKnowledgeBaseClient.retrieve` therefore asks for
the newest ingestion job once per base and refuses with
:class:`~aid_runtime.errors.ConfigurationError` naming the base when none has completed.
Vertex AI's ``ragCorpora`` exposes no comparable field -- an import is a long-running
operation the caller holds, not a property of the corpus -- so there the guarantee comes
from the fixture client and from the deployment gating traffic on the import. That
limitation is stated rather than hidden behind a poll that could never return false.

**Filters are refused, not dropped.** The spec carries filter expressions as opaque
strings, and the two engines disagree about what a string means. Bedrock's ``Retrieve``
takes a structured filter document; Vertex's takes an expression in its own language.
Translating between them is a compiler the plan excludes, and a filter that cannot be
applied is worse than no declaration: retrieving the *unfiltered* corpus silently widens
a tenant-scoped query to every tenant. Both clients therefore declare
``supports_filter_expressions = False``, the retriever refuses such a binding at
construction, and the py-fastapi validator refuses it at plan time. ``filterable`` still
matters -- it is what the deployment copies into the metadata sidecar a Bedrock S3 source
needs before any filter can match -- but nothing at run time pretends to apply one.

The client is a protocol, and one implementation reads a JSON fixture. That is what lets
``aid dev``, ``aid guard`` and the eval gate exercise a managed retriever with no
credentials and no network, which is the same reason the embedding seam has a fake.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import httpx

from aid_runtime.errors import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.providers.bedrock import BedrockProvider, rfc3986, sigv4_headers
from aid_runtime.providers.vertex import (
    DEFAULT_VERTEX_LOCATION,
    METADATA_TOKEN_URL,
    VERTEX_TOKEN_ENV,
    default_vertex_base_url,
)
from aid_runtime.retrieval.types import KnowledgeBaseEngine, KnowledgeBaseSpec

__all__ = [
    "FIXTURE_ENV",
    "BedrockKnowledgeBaseClient",
    "FixtureKnowledgeBaseClient",
    "KnowledgeBaseClient",
    "KnowledgeChunk",
    "KnowledgeResult",
    "VertexKnowledgeBaseClient",
    "knowledge_base_client_for",
    "knowledge_base_env_id",
]

#: Names a JSON file the fixture client serves results from. Set by ``aid dev`` and by a
#: gate, so a managed retriever runs with no credentials and no network.
FIXTURE_ENV = "AID_KNOWLEDGE_BASE_FIXTURE"

_BEDROCK_PREFIX = "BEDROCK_KNOWLEDGE_BASE"
_VERTEX_PREFIX = "VERTEX_RAG_CORPUS"
_BEDROCK_SERVICE = "bedrock-agent-runtime"
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
_MAX_ERROR_BODY = 500

#: ``GET .../ingestionjobs?maxResults=1&sortOrder=DESCENDING``. The canonical query string
#: is sorted by key, which this literal already is, so it can be signed and sent as one.
_LATEST_JOB_QUERY = "maxResults=1&sortOrder=DESCENDING"


@dataclass(frozen=True, slots=True)
class KnowledgeChunk:
    """One passage the engine returned.

    ``source_uri`` is the engine's own location for the document, kept separate from
    ``chunk_id`` because two passages of one document share the former and must not share
    the latter. ``position`` is the engine's ordinal within its result list, which is what
    keeps two byte-identical passages distinct.
    """

    text: str
    source_uri: str
    title: str | None = None
    position: int = 0
    score: float = 0.0
    metadata: Mapping[str, str] = field(default_factory=dict)

    @property
    def chunk_id(self) -> str:
        """Stable identity derived from what the engine returned.

        A managed engine assigns no chunk id this side can recompute, so identity is
        hashed from the source, the position and the text. It is therefore stable across
        a replay of the same answer and unique across the passages of one answer, which
        is all a citation list needs.
        """
        payload = f"{self.source_uri}\x00{self.position}\x00{self.text}".encode()
        return "kb_" + hashlib.sha256(payload).hexdigest()[:24]


@dataclass(frozen=True, slots=True)
class KnowledgeResult:
    """What one retrieve call returned, and what it cost.

    ``cost_usd`` is ``None`` when the engine's rate is unverified. The retriever charges
    nothing in that case: recording a zero would make ``aid cost`` report a free call
    rather than an unpriced one, and those are different claims.
    """

    chunks: tuple[KnowledgeChunk, ...]
    cost_usd: float | None = None


def knowledge_base_env_id(base: KnowledgeBaseSpec) -> str:
    """The environment name a deployment exports the base's service id under.

    Named per base, not per engine: two bases on one provider are two resources, and one
    shared name would make the second silently read the first. The CLI emits the same
    spelling into the generated infrastructure, and a test pins the two together.
    """
    prefix = _BEDROCK_PREFIX if base.engine is KnowledgeBaseEngine.AWS_BEDROCK else _VERTEX_PREFIX
    slug = re.sub(r"[^A-Za-z0-9]+", "_", base.id).strip("_").upper()
    return f"{prefix}_{slug}"


class KnowledgeBaseClient(Protocol):
    """The one operation the retriever makes, so a test double signs nothing."""

    #: Whether ``retrieve`` may be handed ``filters``. A client that cannot apply the
    #: spec's expressions sets this false, and the retriever refuses the binding instead
    #: of letting a filter be dropped.
    supports_filter_expressions: bool

    async def retrieve(
        self,
        base: KnowledgeBaseSpec,
        query: str,
        *,
        top_k: int,
        filters: Sequence[str] = (),
    ) -> KnowledgeResult:
        """One retrieve against the base, with the filters the caller asked for."""

    async def aclose(self) -> None:
        """Release whatever the client holds open."""


class _HttpKnowledgeBaseClient:
    """Shared retry and teardown for the two hosted clients."""

    supports_filter_expressions = False

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None,
        timeout_seconds: float,
        max_attempts: int,
        backoff_seconds: float,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _send(
        self,
        method: str,
        url: str,
        *,
        body: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.request(
                    method, url, content=body, headers=dict(headers or {})
                )
            except httpx.TransportError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code >= 400:
                raise ProviderError(
                    f"the knowledge base returned {response.status_code}: "
                    f"{response.text[:_MAX_ERROR_BODY]}"
                )
            return response.text
        raise ProviderError(f"the knowledge base could not be reached: {last_error}")

    @staticmethod
    def _json(body: str, *, what: str = "knowledge base") -> Mapping[str, Any]:
        try:
            answer = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ProviderResponseError(f"the {what} returned a non-JSON body", body) from exc
        if not isinstance(answer, Mapping):
            raise ProviderResponseError(f"the {what} returned no object", body)
        return answer


class BedrockKnowledgeBaseClient(_HttpKnowledgeBaseClient):
    """``POST /knowledgebases/{id}/retrieve`` on ``bedrock-agent-runtime``, with SigV4.

    Readiness is checked lazily and cached: the first retrieve for a base asks AWS for the
    newest ingestion job, and only a ``COMPLETE`` job lets the call through. Caching keeps
    the check off the hot path; a restarted process re-checks, which is the conservative
    direction.
    """

    def __init__(
        self,
        *,
        provider: BedrockProvider | None = None,
        region: str | None = None,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 15.0,
        max_attempts: int = 2,
        backoff_seconds: float = 0.25,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        super().__init__(
            client=client,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            backoff_seconds=backoff_seconds,
        )
        self._base_url = base_url.rstrip("/") if base_url is not None else None
        self._now = now or (lambda: datetime.now(UTC))
        self._owns_provider = provider is None
        self._provider = provider or BedrockProvider(
            region=region,
            timeout_seconds=timeout_seconds,
            max_attempts=1,
            client=client,
            name="bedrock-knowledge-base",
        )
        self._ready: set[str] = set()

    def _resolve(self, base: KnowledgeBaseSpec) -> str:
        value = os.environ.get(knowledge_base_env_id(base))
        if not value:
            raise ConfigurationError(
                f"knowledge base {base.id!r} has no service id: the deployment writes "
                f"{knowledge_base_env_id(base)}, and the app only names the resource"
            )
        return value

    async def aclose(self) -> None:
        if self._owns_provider:
            await self._provider.aclose()
        await super().aclose()

    async def retrieve(
        self,
        base: KnowledgeBaseSpec,
        query: str,
        *,
        top_k: int,
        filters: Sequence[str] = (),
    ) -> KnowledgeResult:
        knowledge_base_id = self._resolve(base)
        await self._ensure_ingested(knowledge_base_id)
        payload = json.dumps(
            {
                "retrievalQuery": {"text": query},
                "retrievalConfiguration": {"vectorSearchConfiguration": {"numberOfResults": top_k}},
            },
            separators=(",", ":"),
        )
        body = await self._post(self._url(knowledge_base_id, "retrieve"), payload)
        return KnowledgeResult(
            chunks=_bedrock_chunks(self._json(body)),
            cost_usd=base.retrieve_cost_per_query_usd,
        )

    async def _ensure_ingested(self, knowledge_base_id: str) -> None:
        if knowledge_base_id in self._ready:
            return
        data_source = await self._first_data_source(knowledge_base_id)
        body = await self._get(
            self._url(
                knowledge_base_id,
                f"datasources/{rfc3986(data_source)}/ingestionjobs",
            ),
            query=_LATEST_JOB_QUERY,
        )
        status = _first_status(self._json(body).get("ingestionJobSummaries"))
        if status != "COMPLETE":
            raise ConfigurationError(
                f"knowledge base {knowledge_base_id!r} has no completed ingestion job "
                f"(latest status: {status or 'none'}); the corpus is empty until one "
                "finishes, and an empty corpus reads as 'the answer is not in the corpus'"
            )
        self._ready.add(knowledge_base_id)

    async def _first_data_source(self, knowledge_base_id: str) -> str:
        body = await self._get(self._url(knowledge_base_id, "datasources"))
        answer = self._json(body)
        summaries = answer.get("dataSourceSummaries")
        if not isinstance(summaries, Sequence) or isinstance(summaries, (str, bytes)):
            raise ProviderResponseError("the knowledge base returned no data sources", body)
        first = next((entry for entry in summaries if isinstance(entry, Mapping)), None)
        data_source_id = first.get("dataSourceId") if first is not None else None
        if not isinstance(data_source_id, str) or not data_source_id:
            raise ConfigurationError(
                f"knowledge base {knowledge_base_id!r} has no data source, so nothing "
                "was ever uploaded to it"
            )
        return data_source_id

    def _url(self, knowledge_base_id: str, suffix: str) -> str:
        region = self._provider.resolve_region()
        base = self._base_url or f"https://{_BEDROCK_SERVICE}.{region}.amazonaws.com"
        return f"{base}/knowledgebases/{rfc3986(knowledge_base_id)}/{suffix}"

    async def _get(self, url: str, *, query: str = "") -> str:
        headers = sigv4_headers(
            url=url,
            body="",
            region=self._provider.resolve_region(),
            credentials=await self._provider.credentials(),
            moment=self._now(),
            service=_BEDROCK_SERVICE,
            method="GET",
            query=query,
        )
        return await self._send("GET", f"{url}?{query}" if query else url, headers=headers)

    async def _post(self, url: str, payload: str) -> str:
        headers = sigv4_headers(
            url=url,
            body=payload,
            region=self._provider.resolve_region(),
            credentials=await self._provider.credentials(),
            moment=self._now(),
            service=_BEDROCK_SERVICE,
        )
        return await self._send("POST", url, body=payload, headers=headers)


def _first_status(summaries: Any) -> str | None:
    if not isinstance(summaries, Sequence) or isinstance(summaries, (str, bytes)):
        return None
    for entry in summaries:
        if isinstance(entry, Mapping):
            status = entry.get("status")
            if isinstance(status, str):
                return status
    return None


def _bedrock_chunks(answer: Mapping[str, Any]) -> tuple[KnowledgeChunk, ...]:
    results = answer.get("retrievalResults")
    if not isinstance(results, Sequence) or isinstance(results, (str, bytes)):
        return ()
    chunks: list[KnowledgeChunk] = []
    for position, entry in enumerate(results):
        if not isinstance(entry, Mapping):
            continue
        content = entry.get("content")
        text = content.get("text") if isinstance(content, Mapping) else None
        if not isinstance(text, str):
            continue
        score = entry.get("score")
        chunks.append(
            KnowledgeChunk(
                text=text,
                source_uri=_bedrock_uri(entry.get("location")),
                position=position,
                score=float(score) if isinstance(score, (int, float)) else 0.0,
                metadata=_string_map(entry.get("metadata")),
            )
        )
    return tuple(chunks)


def _bedrock_uri(location: Any) -> str:
    if not isinstance(location, Mapping):
        return ""
    for value in location.values():
        if isinstance(value, Mapping):
            uri = value.get("uri")
            if isinstance(uri, str):
                return uri
    return ""


def _string_map(value: Any) -> Mapping[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): str(item) for key, item in value.items()}


class VertexKnowledgeBaseClient(_HttpKnowledgeBaseClient):
    """``:retrieveContexts`` on a Vertex AI RAG corpus, with an OAuth2 bearer token.

    The token is resolved per call from an explicit value, ``GOOGLE_ACCESS_TOKEN``, or the
    metadata server, which is the same order the Vertex model adapter uses -- a service
    that can call a Gemini model on Vertex can therefore also read its corpus.
    """

    def __init__(
        self,
        *,
        project: str | None = None,
        location: str | None = None,
        access_token: str | None = None,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 15.0,
        max_attempts: int = 2,
        backoff_seconds: float = 0.25,
    ) -> None:
        super().__init__(
            client=client,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            backoff_seconds=backoff_seconds,
        )
        self._project = project
        self._location = location
        self._access_token = access_token
        self._base_url = base_url.rstrip("/") if base_url is not None else None

    async def retrieve(
        self,
        base: KnowledgeBaseSpec,
        query: str,
        *,
        top_k: int,
        filters: Sequence[str] = (),
    ) -> KnowledgeResult:
        corpus = os.environ.get(knowledge_base_env_id(base))
        if not corpus:
            raise ConfigurationError(
                f"knowledge base {base.id!r} has no corpus id: the deployment writes "
                f"{knowledge_base_env_id(base)}, and the app only names the resource"
            )
        location = self._resolve_location()
        project = self._resolve_project()
        payload = json.dumps(
            {"query": {"text": query, "ragRetrievalConfig": {"topK": top_k}}},
            separators=(",", ":"),
        )
        url = (
            f"{self._base_url or default_vertex_base_url(location)}/v1/projects/"
            f"{rfc3986(project)}/locations/{rfc3986(location)}/ragCorpora/"
            f"{rfc3986(corpus)}:retrieveContexts"
        )
        body = await self._send(
            "POST",
            url,
            body=payload,
            headers={
                "authorization": f"Bearer {await self._resolve_token()}",
                "content-type": "application/json",
            },
        )
        return KnowledgeResult(
            chunks=_vertex_chunks(self._json(body)),
            cost_usd=base.retrieve_cost_per_query_usd,
        )

    def _resolve_project(self) -> str:
        if self._project:
            return self._project
        for key in ("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_PROJECT_ID"):
            value = os.environ.get(key)
            if value:
                return value
        raise ConfigurationError(
            "a Vertex RAG corpus needs a project: set GOOGLE_CLOUD_PROJECT, or the "
            "deployment's own project variable"
        )

    def _resolve_location(self) -> str:
        if self._location:
            return self._location
        for key in ("GOOGLE_CLOUD_REGION", "VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION"):
            value = os.environ.get(key)
            if value:
                return value
        return DEFAULT_VERTEX_LOCATION

    async def _resolve_token(self) -> str:
        if self._access_token:
            return self._access_token
        token = os.environ.get(VERTEX_TOKEN_ENV)
        if token:
            return token
        try:
            response = await self._client.get(
                METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"}
            )
        except httpx.TransportError as exc:
            raise ConfigurationError(
                f"no OAuth2 token: set {VERTEX_TOKEN_ENV}, or run where the metadata "
                "server can mint one"
            ) from exc
        answer = self._json(response.text, what="metadata server")
        value = answer.get("access_token")
        if not isinstance(value, str) or not value:
            raise ProviderResponseError(
                "the metadata server returned no access token", json.dumps(answer)
            )
        return value


def _vertex_chunks(answer: Mapping[str, Any]) -> tuple[KnowledgeChunk, ...]:
    """Vertex nests each passage under ``contexts[].chunk.text``.

    ``sourceUri`` sits on the context, not the chunk, so provenance is read one level up
    from the text it describes.
    """
    contexts = answer.get("contexts")
    entries = contexts.get("contexts") if isinstance(contexts, Mapping) else None
    if not isinstance(entries, Sequence) or isinstance(entries, (str, bytes)):
        return ()
    chunks: list[KnowledgeChunk] = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, Mapping):
            continue
        chunk = entry.get("chunk")
        text = chunk.get("text") if isinstance(chunk, Mapping) else None
        if not isinstance(text, str):
            text = entry.get("text")
        if not isinstance(text, str):
            continue
        score = chunk.get("relevanceScore") if isinstance(chunk, Mapping) else None
        uri = entry.get("sourceUri")
        chunks.append(
            KnowledgeChunk(
                text=text,
                source_uri=uri if isinstance(uri, str) else "",
                title=entry.get("sourceDisplayName")
                if isinstance(entry.get("sourceDisplayName"), str)
                else None,
                position=position,
                score=float(score) if isinstance(score, (int, float)) else 0.0,
            )
        )
    return tuple(chunks)


class FixtureKnowledgeBaseClient:
    """A ``KnowledgeBaseClient`` that reads recorded answers from one JSON file.

    The file is keyed by knowledge base id:

    .. code-block:: json

        {"bases": {"product-docs": {"ready": true,
          "chunks": [{"text": "...", "sourceUri": "s3://bucket/doc.md", "score": 0.9}]}}}

    ``ready`` is what makes the missing-ingestion failure testable offline: a fixture can
    describe a base that was deployed but never indexed, and the retriever then fails with
    the same message the hosted client raises.
    """

    supports_filter_expressions = False

    def __init__(
        self,
        payload: Mapping[str, Any] | None = None,
        *,
        path: str | Path | None = None,
    ) -> None:
        if payload is None:
            if path is None:
                raise ConfigurationError(
                    f"a fixture knowledge base needs a payload or a path; set {FIXTURE_ENV} "
                    "to the JSON file the run should read"
                )
            try:
                raw = Path(path).read_text(encoding="utf-8")
            except OSError as exc:
                raise ConfigurationError(
                    f"the knowledge base fixture {path!s} cannot be read: {exc}"
                ) from exc
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ConfigurationError(
                    f"the knowledge base fixture {path!s} is not valid JSON: {exc}"
                ) from exc
        if not isinstance(payload, Mapping):
            raise ConfigurationError("a knowledge base fixture must be a JSON object")
        bases = payload.get("bases")
        if not isinstance(bases, Mapping):
            raise ConfigurationError(
                "a knowledge base fixture must carry a 'bases' object keyed by base id"
            )
        self._bases: Mapping[str, Any] = bases

    async def aclose(self) -> None:
        return None

    async def retrieve(
        self,
        base: KnowledgeBaseSpec,
        query: str,
        *,
        top_k: int,
        filters: Sequence[str] = (),
    ) -> KnowledgeResult:
        entry = self._bases.get(base.id)
        if not isinstance(entry, Mapping):
            raise ConfigurationError(
                f"knowledge base {base.id!r} has no fixture entry; add one under "
                f"'bases.{base.id}' or run against the real engine"
            )
        if entry.get("ready") is not True:
            raise ConfigurationError(
                f"knowledge base {base.id!r} has no completed ingestion job "
                f"(latest status: {entry.get('status') or 'none'}); the corpus is empty "
                "until one finishes, and an empty corpus reads as 'the answer is not in "
                "the corpus'"
            )
        chunks = _fixture_chunks(entry.get("chunks"))
        return KnowledgeResult(
            chunks=chunks[:top_k],
            cost_usd=base.retrieve_cost_per_query_usd,
        )


def _fixture_chunks(value: Any) -> tuple[KnowledgeChunk, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    chunks: list[KnowledgeChunk] = []
    for position, entry in enumerate(value):
        if not isinstance(entry, Mapping):
            continue
        text = entry.get("text")
        if not isinstance(text, str):
            continue
        score = entry.get("score")
        source_uri = entry.get("sourceUri")
        title = entry.get("title")
        chunks.append(
            KnowledgeChunk(
                text=text,
                source_uri=source_uri if isinstance(source_uri, str) else "",
                title=title if isinstance(title, str) else None,
                position=position,
                score=float(score) if isinstance(score, (int, float)) else 0.0,
                metadata=_string_map(entry.get("metadata")),
            )
        )
    return tuple(chunks)


def knowledge_base_client_for(
    base: KnowledgeBaseSpec,
    *,
    fixture: str | Path | None = None,
    client: httpx.AsyncClient | None = None,
    region: str | None = None,
    project: str | None = None,
    location: str | None = None,
    access_token: str | None = None,
    base_url: str | None = None,
    timeout_seconds: float = 15.0,
) -> KnowledgeBaseClient:
    """Pick the adapter for one base.

    A fixture path -- explicit, or ``AID_KNOWLEDGE_BASE_FIXTURE`` -- wins over the engine,
    for the same reason ``fake`` wins in :func:`~aid_runtime.retrieval.embedding.embedder_for`:
    a gate has to run keyless and offline, and the engine's identity is not a thing the
    spec may lie about to get there.
    """
    path = fixture if fixture is not None else os.environ.get(FIXTURE_ENV)
    if path:
        return FixtureKnowledgeBaseClient(path=path)
    if base.engine is KnowledgeBaseEngine.AWS_BEDROCK:
        return BedrockKnowledgeBaseClient(
            region=region,
            base_url=base_url,
            client=client,
            timeout_seconds=timeout_seconds,
        )
    return VertexKnowledgeBaseClient(
        project=project,
        location=location,
        access_token=access_token,
        base_url=base_url,
        client=client,
        timeout_seconds=timeout_seconds,
    )
