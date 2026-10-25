"""Shapes the retrieval runtime shares across its modules.

Two families live here and the split is deliberate.

* The **IR mirror** models (``SourceSpec``, ``ChunkingSpec``, ``IndexSpec``,
  ``RerankSpec``, ``RefreshSpec``, ``RetrieverSpec``, ``EmbeddingSpec``,
  ``VectorStoreSpec``) reproduce the L1 IR's ``retrievers`` / ``embeddings`` /
  ``stores`` entries field for field. Field names are Pythonic; the IR's
  camelCase spelling is carried as a pydantic *alias*, so an IR fragment
  validates against these models unchanged and the two vocabularies cannot drift
  without a test going red. Enum *values* are the IR's own strings
  (``recursive``, ``pgvector``, ``cosine``) and are never re-spelled.
* The **resolved** models (``PinnedEmbedding``, ``RetrieverBinding``) are what
  generated code binds with literals. They carry the exact embedding model id
  rather than an alias, so a run is reproducible from the generated source alone
  and nothing is resolved at run time.
* The **store records** (``StoreRecord``, ``SearchHit``) are the payloads the store
  adapters read and write. They live here rather than in ``stores`` so the pgvector
  adapter can build them without importing ``stores``, which imports ``pgvector``
  back lazily; the module graph then has no cycle.
"""

from __future__ import annotations

import hashlib
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.types import CostProfile

__all__ = [
    "Chunk",
    "ChunkingSpec",
    "ChunkingStrategy",
    "DistanceMetric",
    "EmbeddingCostProfile",
    "EmbeddingSpec",
    "IndexSpec",
    "PinnedEmbedding",
    "RefreshMode",
    "RefreshSpec",
    "RerankSpec",
    "RetrievalMetricSpec",
    "RetrieverBinding",
    "RetrieverSpec",
    "ScoredChunk",
    "SearchHit",
    "SourceKind",
    "SourceSpec",
    "StoreKind",
    "StoreRecord",
    "VectorStoreSpec",
    "binding_from_spec",
    "chunk_id_for",
    "pinned_embedding",
]

#: The IR spells several fields in camelCase. Accepting both spellings is what
#: lets one model validate an IR fragment *and* be built from generated Python.
_IR_RECORD = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

#: The runtime's own records are constructed by us, never parsed from IR JSON,
#: so they need no aliases and refuse anything unexpected.
_RUNTIME_RECORD = ConfigDict(frozen=True, extra="forbid")


class DistanceMetric(StrEnum):
    """``retriever.index.metric``."""

    COSINE = "cosine"
    DOT = "dot"
    L2 = "l2"


class SourceKind(StrEnum):
    """``retriever.source.kind``.

    ``FILE`` is the only kind the Phase 1 connector implements; the rest are part
    of the IR contract and fail loudly rather than silently indexing nothing.
    """

    FILE = "file"
    S3 = "s3"
    HTTP = "http"
    DB = "db"
    MCP = "mcp"


class ChunkingStrategy(StrEnum):
    """``retriever.chunking.strategy``."""

    FIXED = "fixed"
    RECURSIVE = "recursive"
    SEMANTIC = "semantic"
    CODE = "code"


class StoreKind(StrEnum):
    """``vectorStore.kind``."""

    MEMORY = "memory"
    PGVECTOR = "pgvector"
    QDRANT = "qdrant"
    PINECONE = "pinecone"
    WEAVIATE = "weaviate"
    CUSTOM = "custom"


class RefreshMode(StrEnum):
    """``retriever.refresh.mode``. Only ``FULL`` is implemented."""

    FULL = "full"
    INCREMENTAL = "incremental"


class SourceSpec(BaseModel):
    """``retriever.source``."""

    model_config = _IR_RECORD

    kind: SourceKind
    uri: str
    glob: str | None = None


class ChunkingSpec(BaseModel):
    """``retriever.chunking``."""

    model_config = _IR_RECORD

    strategy: ChunkingStrategy
    size: int = Field(gt=0)
    overlap: int = Field(ge=0)
    keep_metadata: tuple[str, ...] = Field(alias="keepMetadata")


class IndexSpec(BaseModel):
    """``retriever.index``."""

    model_config = _IR_RECORD

    metric: DistanceMetric
    hybrid: bool
    params: dict[str, Any] | None = None


class RerankSpec(BaseModel):
    """``retriever.rerank``."""

    model_config = _IR_RECORD

    model: str
    top_n: int = Field(gt=0, alias="topN")


class RefreshSpec(BaseModel):
    """``retriever.refresh``."""

    model_config = _IR_RECORD

    mode: RefreshMode
    schedule: str | None = None


class RetrieverSpec(BaseModel):
    """One entry of the IR's ``retrievers`` map."""

    model_config = _IR_RECORD

    id: str = Field(min_length=1)
    source: SourceSpec
    chunking: ChunkingSpec
    embed_model: str = Field(alias="embedModel")
    store: str
    index: IndexSpec
    top_k: int = Field(gt=0, alias="topK")
    rerank: RerankSpec | None = None
    filters: tuple[str, ...] | None = None
    refresh: RefreshSpec
    traits: tuple[str, ...]


class EmbeddingCostProfile(BaseModel):
    """``embedding.costProfile`` -- USD per **million** tokens.

    Not interchangeable with :class:`~aid_runtime.types.CostProfile`, which prices
    per *thousand* tokens because it predates the IR. :func:`pinned_embedding` is
    the single place the two are converted, so the factor of 1000 is stated once
    rather than assumed at every call site.
    """

    model_config = _IR_RECORD

    input_per_mtok: float = Field(ge=0.0, alias="inputPerMTok")
    output_per_mtok: float = Field(ge=0.0, alias="outputPerMTok")


class EmbeddingSpec(BaseModel):
    """One entry of the IR's ``embeddings`` map.

    ``id`` is the *alias* a retriever's ``embedModel`` names -- the resolution the
    runtime must never repeat at run time.
    """

    model_config = _IR_RECORD

    id: str = Field(min_length=1)
    provider: str
    model_id: str = Field(alias="modelId")
    dimensions: int | None = Field(default=None, gt=0)
    cost_profile: EmbeddingCostProfile | None = Field(default=None, alias="costProfile")
    traits: tuple[str, ...]


class VectorStoreSpec(BaseModel):
    """One entry of the IR's ``stores`` map."""

    model_config = _IR_RECORD

    id: str = Field(min_length=1)
    kind: StoreKind
    uri: str | None = None
    dimensions: int | None = Field(default=None, gt=0)
    traits: tuple[str, ...]


class RetrievalMetricSpec(BaseModel):
    """The IR's ``retrieval`` metric variant: ``{kind, expectDocs, k}``."""

    model_config = _IR_RECORD

    kind: Literal["retrieval"] = "retrieval"
    expect_docs: tuple[str, ...] = Field(alias="expectDocs")
    k: int = Field(gt=0)


class PinnedEmbedding(BaseModel):
    """An ``embedModel`` alias already resolved to an exact embedding model.

    The same contract as :class:`~aid_runtime.types.PinnedModel`: a baseline
    recorded against ``text-embedding-3-small`` means nothing if the alias floats
    to another revision, so the resolved id, the dimensions and the price are all
    *recorded inputs* rather than lookups a run performs.
    """

    model_config = _RUNTIME_RECORD

    alias: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    dimensions: int = Field(gt=0)
    cost: CostProfile


class RetrieverBinding(BaseModel):
    """A retriever as generated code binds it, with every alias resolved.

    ``embed_model`` keeps the declared alias purely so cost can be attributed to
    the name the spec used; ``embedding`` is the resolved model actually called.
    ``store_kind`` is resolved from the store entry, because a run must not
    discover at search time which backend it wrote to.

    ``store_uri`` is deliberately kept *unresolved*: a hosted store's location is a
    deployment secret, which is why the IR writes ``env:PGVECTOR_URL`` rather than a
    DSN. The name is pinned in code; the value is read from the environment at run
    time, and an environment variable is not an alias.
    """

    model_config = _RUNTIME_RECORD

    retriever_id: str = Field(min_length=1)
    source: SourceSpec
    chunking: ChunkingSpec
    embed_model: str = Field(min_length=1)
    embedding: PinnedEmbedding
    store: str = Field(min_length=1)
    store_kind: StoreKind
    store_uri: str | None = None
    index: IndexSpec
    top_k: int = Field(gt=0)
    rerank: RerankSpec | None = None
    refresh_mode: RefreshMode = RefreshMode.FULL
    traits: tuple[str, ...] = ()


class Chunk(BaseModel):
    """One indexed passage.

    ``chunk_id`` hashes the document id, the chunk's position *and* its text.
    That is what makes ingest idempotent: identical input re-chunks to identical
    ids, so a second ingest replaces rather than duplicates. Position is part of
    the hash on purpose -- two byte-identical paragraphs in one document must stay
    two chunks instead of colliding into one.
    """

    model_config = _RUNTIME_RECORD

    chunk_id: str = Field(min_length=1)
    doc_id: str = Field(min_length=1)
    uri: str = ""
    index: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    text: str
    metadata: dict[str, str] = Field(default_factory=dict)


class StoreRecord(BaseModel):
    """One chunk and its vector, exactly as it is written to a store."""

    model_config = _RUNTIME_RECORD

    chunk: Chunk
    vector: tuple[float, ...]


class SearchHit(BaseModel):
    """A record and its similarity to the query, higher being better."""

    model_config = _RUNTIME_RECORD

    record: StoreRecord
    score: float


class ScoredChunk(BaseModel):
    """A chunk with the score that ranked it."""

    model_config = _RUNTIME_RECORD

    chunk: Chunk
    score: float


def chunk_id_for(doc_id: str, index: int, text: str) -> str:
    """The content hash that identifies a chunk.

    Shared by every chunker so the id scheme cannot differ between strategies; a
    strategy that changed the id scheme would silently duplicate a corpus on
    re-ingest instead of replacing it.
    """
    digest = hashlib.sha256()
    for part in (doc_id, str(index), text):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return f"sha256:{digest.hexdigest()}"


def pinned_embedding(
    spec: EmbeddingSpec, *, alias: str, dimensions: int | None = None
) -> PinnedEmbedding:
    """Resolve an IR embedding entry into the pinned form generated code carries.

    ``dimensions`` may be supplied when the IR entry omits it (the schema makes it
    optional); it is an error to have neither, because an unpinned width would let
    a store accept vectors a later run cannot compare against.
    """
    width = dimensions if dimensions is not None else spec.dimensions
    if width is None:
        raise ConfigurationError(
            f"embedding {spec.id!r} pins no dimensions and none were supplied; the vector "
            "width must be recorded with the pinned model so stores stay comparable"
        )
    profile = spec.cost_profile
    # costProfile quotes USD per MTok; CostProfile quotes USD per 1k tokens.
    scale = 1_000.0
    return PinnedEmbedding(
        alias=alias,
        provider=spec.provider,
        model_id=spec.model_id,
        dimensions=width,
        cost=CostProfile(
            input_per_1k_usd=(profile.input_per_mtok / scale) if profile else 0.0,
            output_per_1k_usd=(profile.output_per_mtok / scale) if profile else 0.0,
        ),
    )


def binding_from_spec(
    spec: RetrieverSpec,
    *,
    embedding: EmbeddingSpec,
    store: VectorStoreSpec,
    dimensions: int | None = None,
) -> RetrieverBinding:
    """Bind one IR retriever entry to the embedding and store it names.

    ``embedModel`` names an *embeddings entry id*, not a provider model, and
    ``store`` names a *stores entry id*. Both are checked here rather than
    trusted, because a mistyped reference in generated code would otherwise
    surface as an empty or mis-scored corpus far from its cause.
    """
    if spec.embed_model != embedding.id:
        raise ConfigurationError(
            f"retriever {spec.id!r} names embedModel {spec.embed_model!r} but embedding "
            f"{embedding.id!r} was supplied"
        )
    if spec.store != store.id:
        raise ConfigurationError(
            f"retriever {spec.id!r} names store {spec.store!r} but store {store.id!r} was supplied"
        )
    if spec.filters:
        # The spec validator already refuses filters; the runtime checks too,
        # because generated code is reachable without the validator having run.
        raise FeatureDeferredError(
            f"retriever {spec.id!r} declares filters, which spec v0.1 does not implement: a "
            "filter would have to be pushed into every store adapter's query"
        )
    pinned = pinned_embedding(embedding, alias=spec.embed_model, dimensions=dimensions)
    if store.dimensions is not None and store.dimensions != pinned.dimensions:
        raise ConfigurationError(
            f"store {store.id!r} is declared {store.dimensions}-dimensional but retriever "
            f"{spec.id!r} pins {pinned.dimensions} dimensions via embedModel "
            f"{spec.embed_model!r}; the two must agree before anything is indexed"
        )
    return RetrieverBinding(
        retriever_id=spec.id,
        source=spec.source,
        chunking=spec.chunking,
        embed_model=spec.embed_model,
        embedding=pinned,
        store=spec.store,
        store_kind=store.kind,
        store_uri=store.uri,
        index=spec.index,
        top_k=spec.top_k,
        rerank=spec.rerank,
        refresh_mode=spec.refresh.mode,
        traits=spec.traits,
    )
