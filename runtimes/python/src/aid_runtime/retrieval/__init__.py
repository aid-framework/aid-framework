"""The retrieval runtime: connectors, chunkers, embedders, stores, fusion, citations.

The package is one pipeline in source order. A connector yields documents, a chunker
splits them, an embedder vectorizes them, a store holds them, and retrieval goes back
out through the store, optionally fusing, optionally reranking, and always attaching
citations.

Every seam is a protocol with a deterministic implementation and, where the plan
allows one, a hosted implementation. Embedding is the one seam with several hosted
adapters -- :class:`OpenAICompatibleEmbedder`, :class:`GeminiEmbedder`,
:class:`BedrockEmbedder` and :class:`VertexEmbedder` -- selected by the pinned
provider, alongside :class:`FakeDeterministicEmbedder`, which is what lets a gate run
offline. There is no hosted reranker: the only reranker is the deterministic
:class:`LexicalReranker`.

Import safety is deliberate. :class:`PgVectorStore` is exported from here, but the
``psycopg`` driver is imported inside its connect path, never at module scope, so
``import aid_runtime`` works without the ``pgvector`` extra installed -- which is the
only state CI is ever in, since CI installs the ``dev`` extra and ``pgvector`` is not
part of it. Reaching for the driver without the extra raises ``ConfigurationError``
naming the extra, rather than ``ImportError`` from three frames down.
"""

from __future__ import annotations

from aid_runtime.retrieval.chunking import (
    Chunker,
    CodeChunker,
    FixedChunker,
    RecursiveChunker,
    SemanticChunker,
    chunk_document,
    chunker_for,
)
from aid_runtime.retrieval.citations import (
    Citation,
    RetrievalResult,
    RetrievedItem,
    assemble_context,
    cite,
)
from aid_runtime.retrieval.connectors import (
    Connector,
    FileConnector,
    HttpConnector,
    S3Connector,
    SourceDocument,
    open_connector,
)
from aid_runtime.retrieval.embedding import (
    BedrockEmbedder,
    Embedder,
    EmbeddingBatch,
    FakeDeterministicEmbedder,
    GeminiEmbedder,
    OpenAICompatibleEmbedder,
    VertexEmbedder,
    embedder_for,
    estimate_tokens,
)
from aid_runtime.retrieval.filters import (
    FILTER_OPERATORS,
    Filter,
    compile_filters,
    matches,
    matches_all,
    parse_filter,
)
from aid_runtime.retrieval.gate import RetrievalGate
from aid_runtime.retrieval.hybrid import (
    RankedId,
    bm25_scores,
    fuse,
    lexical_ranking,
    rrf_score,
    tokenize,
)
from aid_runtime.retrieval.knowledge_base import (
    DEFAULT_SYNC_TIMEOUT_SECONDS,
    FIXTURE_ENV,
    BedrockKnowledgeBaseClient,
    FixtureKnowledgeBaseClient,
    KnowledgeBaseClient,
    KnowledgeChunk,
    KnowledgeResult,
    SyncResult,
    SyncSupport,
    VertexKnowledgeBaseClient,
    knowledge_base_client_for,
    knowledge_base_env_id,
    sync_support,
)
from aid_runtime.retrieval.metrics import (
    CitationGrounding,
    MeanReciprocalRank,
    RecallAtK,
    RetrievalCase,
    RetrievalMetric,
    retrieval_metrics,
)
from aid_runtime.retrieval.pgvector import PgVectorStore, resolve_uri
from aid_runtime.retrieval.rerank import LexicalReranker, Reranker, lexical_score, reranker_for
from aid_runtime.retrieval.retriever import DEFAULT_CANDIDATE_FACTOR, IngestReport, Retriever
from aid_runtime.retrieval.stores import (
    InMemoryVectorStore,
    SearchHit,
    StoreRecord,
    VectorStore,
    create_store,
    similarity,
)
from aid_runtime.retrieval.types import (
    Chunk,
    ChunkingSpec,
    ChunkingStrategy,
    DistanceMetric,
    EmbeddingCostProfile,
    EmbeddingSpec,
    IndexSpec,
    KnowledgeBaseEngine,
    KnowledgeBaseSpec,
    KnowledgeChunkingSpec,
    KnowledgeDataSourceKind,
    KnowledgeDataSourceSpec,
    KnowledgeVectorStoreSpec,
    ManagedRetrieverBinding,
    ManagedRetrieverSpec,
    PinnedEmbedding,
    RefreshMode,
    RefreshSpec,
    RerankSpec,
    RetrievalMetricSpec,
    RetrieverBinding,
    RetrieverSpec,
    ScoredChunk,
    SourceKind,
    SourceSpec,
    StoreKind,
    VectorStoreSpec,
    binding_from_managed_spec,
    binding_from_spec,
    chunk_id_for,
    pinned_embedding,
)

__all__ = [
    "DEFAULT_CANDIDATE_FACTOR",
    "DEFAULT_SYNC_TIMEOUT_SECONDS",
    "FILTER_OPERATORS",
    "FIXTURE_ENV",
    "BedrockEmbedder",
    "BedrockKnowledgeBaseClient",
    "Chunk",
    "Chunker",
    "ChunkingSpec",
    "ChunkingStrategy",
    "Citation",
    "CitationGrounding",
    "CodeChunker",
    "Connector",
    "DistanceMetric",
    "Embedder",
    "EmbeddingBatch",
    "EmbeddingCostProfile",
    "EmbeddingSpec",
    "FakeDeterministicEmbedder",
    "FileConnector",
    "Filter",
    "FixedChunker",
    "FixtureKnowledgeBaseClient",
    "GeminiEmbedder",
    "HttpConnector",
    "InMemoryVectorStore",
    "IndexSpec",
    "IngestReport",
    "KnowledgeBaseClient",
    "KnowledgeBaseEngine",
    "KnowledgeBaseSpec",
    "KnowledgeChunk",
    "KnowledgeChunkingSpec",
    "KnowledgeDataSourceKind",
    "KnowledgeDataSourceSpec",
    "KnowledgeResult",
    "KnowledgeVectorStoreSpec",
    "LexicalReranker",
    "ManagedRetrieverBinding",
    "ManagedRetrieverSpec",
    "MeanReciprocalRank",
    "OpenAICompatibleEmbedder",
    "PgVectorStore",
    "PinnedEmbedding",
    "RankedId",
    "RecallAtK",
    "RecursiveChunker",
    "RefreshMode",
    "RefreshSpec",
    "RerankSpec",
    "Reranker",
    "RetrievalCase",
    "RetrievalGate",
    "RetrievalMetric",
    "RetrievalMetricSpec",
    "RetrievalResult",
    "RetrievedItem",
    "Retriever",
    "RetrieverBinding",
    "RetrieverSpec",
    "S3Connector",
    "ScoredChunk",
    "SearchHit",
    "SemanticChunker",
    "SourceDocument",
    "SourceKind",
    "SourceSpec",
    "StoreKind",
    "StoreRecord",
    "SyncResult",
    "SyncSupport",
    "VectorStore",
    "VectorStoreSpec",
    "VertexEmbedder",
    "VertexKnowledgeBaseClient",
    "assemble_context",
    "binding_from_managed_spec",
    "binding_from_spec",
    "bm25_scores",
    "chunk_document",
    "chunk_id_for",
    "chunker_for",
    "cite",
    "compile_filters",
    "create_store",
    "embedder_for",
    "estimate_tokens",
    "fuse",
    "knowledge_base_client_for",
    "knowledge_base_env_id",
    "lexical_ranking",
    "lexical_score",
    "matches",
    "matches_all",
    "open_connector",
    "parse_filter",
    "pinned_embedding",
    "reranker_for",
    "resolve_uri",
    "retrieval_metrics",
    "rrf_score",
    "similarity",
    "sync_support",
    "tokenize",
]
