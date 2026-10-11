"""Where vectors live and how they are searched.

Two adapters behind one protocol: in-memory and pgvector. The in-memory store is not
a stand-in for a "real" one -- it is the adapter every gate runs against, so it is
the one whose behaviour is the contract. The pgvector adapter is covered by the same
expectations and by nothing else: it is locally provisioned, and no required gate
touches a database.

Similarity is always reported as *higher is better*, including for L2, where the raw
quantity is a distance. A store that inverted its sign for one metric would make
every caller responsible for remembering which metric it asked for, and fusion and
reranking downstream would silently rank backwards.

Lexical search is deliberately absent from the store. The store owns the vector
index; BM25 lives in :mod:`aid_runtime.retrieval.hybrid` and reads the corpus through
:meth:`VectorStore.corpus`. That keeps one lexical implementation instead of one per
backend, at the cost of fetching the corpus per query -- a Phase 1 simplification,
correct at test scale and worth revisiting when a corpus outgrows memory.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval.types import Chunk, DistanceMetric, StoreKind

__all__ = [
    "InMemoryVectorStore",
    "SearchHit",
    "StoreRecord",
    "VectorStore",
    "create_store",
    "similarity",
]


class StoreRecord(BaseModel):
    """One chunk and its vector, exactly as it is written to a store."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    chunk: Chunk
    vector: tuple[float, ...]


class SearchHit(BaseModel):
    """A record and its similarity to the query, higher being better."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    record: StoreRecord
    score: float


def similarity(
    left: Sequence[float],
    right: Sequence[float],
    *,
    metric: DistanceMetric,
) -> float:
    """Similarity of two equal-length vectors under ``metric``.

    Always oriented so that a larger number means a better match.
    """
    if len(left) != len(right):
        raise ConfigurationError(
            f"cannot compare vectors of {len(left)} and {len(right)} dimensions; the query and "
            "the stored vectors must share the embedding's pinned width"
        )
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    if metric is DistanceMetric.DOT:
        return dot
    if metric is DistanceMetric.L2:
        return -math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right, strict=True)))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        # A zero vector has no direction, so cosine similarity is undefined rather
        # than zero; returning 0.0 keeps it last without inventing a ranking.
        return 0.0
    return dot / (left_norm * right_norm)


@runtime_checkable
class VectorStore(Protocol):
    """A vector index the retriever can ingest into and search.

    ``aclose`` must be idempotent, matching the other seams in this runtime.
    """

    @property
    def kind(self) -> StoreKind: ...

    async def upsert(self, records: Sequence[StoreRecord]) -> int:
        """Write records, keyed by ``chunk_id``. Returns the number written."""
        ...

    async def search(
        self, vector: Sequence[float], *, top_k: int, metric: DistanceMetric
    ) -> tuple[SearchHit, ...]: ...

    async def corpus(self) -> tuple[StoreRecord, ...]:
        """Every stored record.

        Exists for the lexical half of hybrid search, and for assertions about a
        store's contents after re-ingest.
        """
        ...

    async def aclose(self) -> None: ...


class InMemoryVectorStore:
    """A dict keyed by ``chunk_id``.

    The key choice is what makes ingest idempotent: re-ingesting identical input
    recomputes identical ids and overwrites in place, so the store's contents are a
    function of the input rather than of how many times it was ingested.
    """

    def __init__(self, *, kind: StoreKind = StoreKind.MEMORY) -> None:
        self._kind = kind
        self._records: dict[str, StoreRecord] = {}
        self._closed = False

    @property
    def kind(self) -> StoreKind:
        return self._kind

    async def upsert(self, records: Sequence[StoreRecord]) -> int:
        for record in records:
            self._records[record.chunk.chunk_id] = record
        return len(records)

    async def search(
        self, vector: Sequence[float], *, top_k: int, metric: DistanceMetric
    ) -> tuple[SearchHit, ...]:
        if top_k < 1:
            raise ConfigurationError("top_k must be at least 1")
        hits = [
            SearchHit(record=record, score=similarity(vector, record.vector, metric=metric))
            for record in self._records.values()
        ]
        # Ties break on chunk id, never on insertion order: two runs that ingest the
        # same corpus in a different order must produce the same ranking.
        hits.sort(key=lambda hit: (-hit.score, hit.record.chunk.chunk_id))
        return tuple(hits[:top_k])

    async def corpus(self) -> tuple[StoreRecord, ...]:
        return tuple(self._records[chunk_id] for chunk_id in sorted(self._records))

    async def aclose(self) -> None:
        self._closed = True


def create_store(
    kind: StoreKind,
    *,
    uri: str | None = None,
    dimensions: int | None = None,
) -> VectorStore:
    """Select a store adapter.

    Imported lazily so that importing this package never pulls in a database driver:
    the driver is an optional extra, and CI installs only the dev extra.
    """
    if kind is StoreKind.MEMORY:
        return InMemoryVectorStore()
    if kind is StoreKind.PGVECTOR:
        from aid_runtime.retrieval.pgvector import PgVectorStore

        return PgVectorStore(uri=uri, dimensions=dimensions)
    raise FeatureDeferredError(
        f"vector store kind {kind.value!r} is declared in the IR but has no adapter in this "
        "runtime; Phase 1 ships 'memory' and 'pgvector'"
    )
