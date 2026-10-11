"""Builders shared by the retrieval tests.

These sit beside the tests rather than in ``conftest.py`` so the retrieval surface's
own factories stay visible in the modules that use them, and so the shared fixtures
file keeps describing the chat runtime it was written for.

Parameters are snake_case while the calls pass the IR's camelCase field names. That
is deliberate: the aliases are what generated code emits, and a helper that built
these with the Python spellings would keep passing after an alias was renamed.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

from aid_runtime.retrieval import (
    Chunk,
    ChunkingSpec,
    ChunkingStrategy,
    Citation,
    DistanceMetric,
    EmbeddingCostProfile,
    EmbeddingSpec,
    IndexSpec,
    PinnedEmbedding,
    RefreshMode,
    RefreshSpec,
    RerankSpec,
    RetrievalCase,
    RetrievalMetricSpec,
    RetrievalResult,
    RetrievedItem,
    RetrieverBinding,
    RetrieverSpec,
    SourceDocument,
    SourceKind,
    SourceSpec,
    StoreKind,
    VectorStoreSpec,
    binding_from_spec,
    chunk_id_for,
    cite,
    pinned_embedding,
)

RETRIEVER_ID = "docs"
STORE_ID = "docs"
EMBED_ID = "embed"
EMBED_ALIAS = "embed-small"
MODEL_ID = "text-embedding-3-small"

#: Vectors are small here on purpose: nothing in these tests depends on embedding
#: quality, and a narrow width keeps a failing assertion readable.
DIMENSIONS = 32


def embedding_spec(
    *,
    model_id: str = MODEL_ID,
    dimensions: int | None = DIMENSIONS,
    provider: str = "fake",
    input_per_mtok: float = 0.02,
    output_per_mtok: float = 0.0,
    cost_profile: bool = True,
) -> EmbeddingSpec:
    """An IR ``embeddings`` entry, with a plausible cost profile by default."""
    profile = (
        EmbeddingCostProfile(inputPerMTok=input_per_mtok, outputPerMTok=output_per_mtok)
        if cost_profile
        else None
    )
    return EmbeddingSpec(
        id=EMBED_ID,
        provider=provider,
        modelId=model_id,
        dimensions=dimensions,
        costProfile=profile,
        traits=("embeddings",),
    )


def pinned(
    *,
    model_id: str = MODEL_ID,
    dimensions: int = DIMENSIONS,
    provider: str = "fake",
    alias: str = EMBED_ALIAS,
    cost_profile: bool = True,
) -> PinnedEmbedding:
    """The pinned form generated code carries."""
    return pinned_embedding(
        embedding_spec(
            model_id=model_id, dimensions=dimensions, provider=provider, cost_profile=cost_profile
        ),
        alias=alias,
    )


def store_spec(
    *,
    kind: StoreKind = StoreKind.MEMORY,
    uri: str | None = None,
    dimensions: int | None = DIMENSIONS,
) -> VectorStoreSpec:
    return VectorStoreSpec(id=STORE_ID, kind=kind, uri=uri, dimensions=dimensions, traits=())


def retriever_spec(
    *,
    source_uri: str = "./docs",
    glob: str | None = "**/*.md",
    hybrid: bool = False,
    top_k: int = 3,
    rerank_model: str | None = None,
    strategy: ChunkingStrategy = ChunkingStrategy.FIXED,
    size: int = 120,
    overlap: int = 0,
    keep_metadata: Sequence[str] = (),
    metric: DistanceMetric = DistanceMetric.COSINE,
    filters: Sequence[str] | None = None,
    refresh_mode: RefreshMode = RefreshMode.FULL,
) -> RetrieverSpec:
    """An IR ``retrievers`` entry naming the embedding and store above."""
    return RetrieverSpec(
        id=RETRIEVER_ID,
        source=SourceSpec(kind=SourceKind.FILE, uri=source_uri, glob=glob),
        chunking=ChunkingSpec(
            strategy=strategy, size=size, overlap=overlap, keepMetadata=tuple(keep_metadata)
        ),
        embedModel=EMBED_ID,
        store=STORE_ID,
        index=IndexSpec(metric=metric, hybrid=hybrid),
        topK=top_k,
        rerank=RerankSpec(model=rerank_model, topN=top_k) if rerank_model is not None else None,
        filters=None if filters is None else tuple(filters),
        refresh=RefreshSpec(mode=refresh_mode),
        traits=("retrieval",),
    )


def binding(
    *,
    glob: str | None = "**/*.md",
    hybrid: bool = False,
    top_k: int = 3,
    rerank_model: str | None = None,
    strategy: ChunkingStrategy = ChunkingStrategy.FIXED,
    size: int = 120,
    overlap: int = 0,
    keep_metadata: Sequence[str] = (),
    metric: DistanceMetric = DistanceMetric.COSINE,
    store_kind: StoreKind = StoreKind.MEMORY,
    store_uri: str | None = None,
    dimensions: int = DIMENSIONS,
    refresh_mode: RefreshMode = RefreshMode.FULL,
) -> RetrieverBinding:
    """A binding built the way generated code builds one: through the IR."""
    return binding_from_spec(
        retriever_spec(
            glob=glob,
            hybrid=hybrid,
            top_k=top_k,
            rerank_model=rerank_model,
            strategy=strategy,
            size=size,
            overlap=overlap,
            keep_metadata=keep_metadata,
            metric=metric,
            refresh_mode=refresh_mode,
        ),
        embedding=embedding_spec(dimensions=dimensions),
        store=store_spec(kind=store_kind, uri=store_uri, dimensions=dimensions),
    )


def write_docs(root: Path, files: Mapping[str, str]) -> Path:
    """Write a corpus under ``root`` and return it."""
    for name, body in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return root


def document(
    doc_id: str,
    text: str,
    *,
    uri: str | None = None,
    metadata: Mapping[str, str] | None = None,
) -> SourceDocument:
    return SourceDocument(
        doc_id=doc_id,
        uri=uri if uri is not None else doc_id,
        text=text,
        metadata=dict(metadata or {}),
    )


def chunk(
    doc_id: str,
    text: str,
    *,
    index: int = 0,
    uri: str | None = None,
    metadata: Mapping[str, str] | None = None,
) -> Chunk:
    return Chunk(
        chunk_id=chunk_id_for(doc_id, index, text),
        doc_id=doc_id,
        uri=uri if uri is not None else doc_id,
        index=index,
        start=0,
        end=len(text),
        text=text,
        metadata=dict(metadata or {}),
    )


def result(
    query: str,
    chunks: Iterable[Chunk],
    *,
    scores: Sequence[float] | None = None,
    retriever: str = RETRIEVER_ID,
    citations: Sequence[Citation] | None = None,
) -> RetrievalResult:
    """A rank-ordered result, so a metric can be scored without a store."""
    ordered = tuple(chunks)
    ranked = (
        tuple(scores)
        if scores is not None
        else tuple(1.0 / rank for rank in range(1, len(ordered) + 1))
    )
    named = tuple(citations) if citations is not None else tuple(cite(item) for item in ordered)
    return RetrievalResult(
        retriever=retriever,
        query=query,
        items=tuple(
            RetrievedItem(
                chunk=item, score=ranked[position], rank=position + 1, citation=named[position]
            )
            for position, item in enumerate(ordered)
        ),
    )


def retrieval_case(
    case_id: str,
    query: str,
    expect: Sequence[str],
    *,
    k: int = 3,
) -> RetrievalCase:
    """A case built through the IR's ``retrieval`` metric node, as codegen would."""
    return RetrievalCase.from_spec(
        case_id=case_id,
        query=query,
        spec=RetrievalMetricSpec(kind="retrieval", expectDocs=tuple(expect), k=k),
    )
