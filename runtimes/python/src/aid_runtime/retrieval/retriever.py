"""Ingesting a corpus and retrieving from it.

This is the module a later layer's generated code calls: ``ingest`` once per
refresh, ``retrieve`` per query. It is deliberately not a command-line entry point
-- the generated module is the intended surface, and a runtime that also shipped a
``__main__`` would grow a second, competing one.

Both halves are orchestration over injected seams. Nothing here chooses a model by
name, because the binding already carries the resolved model id, the vector width and
the store kind; resolving any of those at run time is exactly what the pinning rule
forbids.

Cost is charged to the existing ledger using the existing profile. The IR quotes
embedding prices per MTok and :class:`~aid_runtime.types.CostProfile` quotes per 1k
tokens; that conversion happens once, in
:func:`~aid_runtime.retrieval.types.pinned_embedding`, so no call site repeats it.

Candidates: the retriever fetches more than ``topK`` candidates from each ranking
before fusing, because fusion and reranking both reorder, and a fused list built from
only ``topK`` inputs has nothing to reorder. ``topK`` is applied to the *result*,
which is what the IR field means.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.cost import Budget, CostLedger, LedgerEntry
from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval.chunking import chunker_for
from aid_runtime.retrieval.citations import RetrievalResult, RetrievedItem, cite
from aid_runtime.retrieval.connectors import Connector, SourceDocument, open_connector
from aid_runtime.retrieval.embedding import Embedder, EmbeddingBatch, embedder_for
from aid_runtime.retrieval.hybrid import fuse, lexical_ranking
from aid_runtime.retrieval.rerank import Reranker, reranker_for
from aid_runtime.retrieval.stores import SearchHit, StoreRecord, VectorStore, create_store
from aid_runtime.retrieval.types import RefreshMode, RetrieverBinding, ScoredChunk
from aid_runtime.types import TokenUsage

__all__ = [
    "DEFAULT_CANDIDATE_FACTOR",
    "IngestReport",
    "Retriever",
]

#: How many candidates per ranking are fetched before fusion. Four is a round number
#: with a defensible property: it lets a passage ranked 4th lexically and 1st by
#: vector similarity reach the top of the fused list, which is the case fusion exists
#: to fix.
DEFAULT_CANDIDATE_FACTOR = 4

#: Texts per embedding request. Batching bounds one request's payload, which is what
#: matters; a fixed size keeps the request count a function of the corpus.
_BATCH_SIZE = 64


class IngestReport(BaseModel):
    """What one ingest wrote.

    ``chunk_ids`` is the load-bearing field for idempotence: it is sorted, so two
    ingests of identical input compare equal without depending on the order the
    filesystem happened to yield. ``cost_usd`` is what *this* ingest charged, not the
    ledger's running total, so ingesting twice reads as two separate spends.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    retriever: str = Field(min_length=1)
    documents: int = Field(ge=0)
    chunks: int = Field(ge=0)
    written: int = Field(ge=0)
    tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0.0)
    chunk_ids: tuple[str, ...]

    @property
    def is_empty(self) -> bool:
        return self.chunks == 0


class Retriever:
    """A bound retriever: its source, its chunker, its embedder, its store.

    Seams are injectable and default from the binding. Tests inject the fake
    embedder and an in-memory store; generated code passes the real ones.
    """

    def __init__(
        self,
        binding: RetrieverBinding,
        *,
        embedder: Embedder | None = None,
        store: VectorStore | None = None,
        reranker: Reranker | None = None,
        connector: Connector | None = None,
        ledger: CostLedger | None = None,
        budget: Budget | None = None,
        base_dir: str | None = None,
        candidate_factor: int = DEFAULT_CANDIDATE_FACTOR,
    ) -> None:
        if binding.refresh_mode is not RefreshMode.FULL:
            raise FeatureDeferredError(
                f"refresh mode {binding.refresh_mode.value!r} is declared but not implemented: "
                "spec v0.1 reindexes the whole source, and incremental refresh needs change "
                "detection the runtime does not have"
            )
        if candidate_factor < 1:
            raise ConfigurationError("candidate_factor must be at least 1")
        self._binding = binding
        self._embedder = embedder or embedder_for(binding.embedding)
        self._store = store or create_store(
            binding.store_kind,
            uri=binding.store_uri,
            dimensions=binding.embedding.dimensions,
        )
        self._reranker = reranker or reranker_for(binding.rerank)
        self._connector = connector
        self._base_dir = base_dir
        self._ledger = ledger
        self._budget = budget
        self._candidate_factor = candidate_factor
        self._closed = False

    @property
    def binding(self) -> RetrieverBinding:
        return self._binding

    @property
    def store(self) -> VectorStore:
        return self._store

    async def ingest(self, documents: Sequence[SourceDocument] | None = None) -> IngestReport:
        """Chunk a source, embed it, and write it.

        Idempotent by construction: chunk ids are content hashes and the store
        upserts on them, so ingesting the same input twice replaces rather than
        duplicates. Re-ingesting is therefore a legitimate way to refresh a corpus.
        """
        source_documents = tuple(documents) if documents is not None else await self._read_source()
        chunker = chunker_for(self._binding.chunking)
        chunks = [chunk for document in source_documents for chunk in chunker.chunk(document)]

        records: list[StoreRecord] = []
        tokens = 0
        cost = 0.0
        for start in range(0, len(chunks), _BATCH_SIZE):
            batch = chunks[start : start + _BATCH_SIZE]
            embedded, batch_cost = await self._embed(tuple(chunk.text for chunk in batch))
            tokens += embedded.usage.input_tokens
            cost += batch_cost
            records.extend(
                StoreRecord(chunk=chunk, vector=vector)
                for chunk, vector in zip(batch, embedded.vectors, strict=True)
            )

        written = await self._store.upsert(records)
        return IngestReport(
            retriever=self._binding.retriever_id,
            documents=len(source_documents),
            chunks=len(chunks),
            written=written,
            tokens=tokens,
            cost_usd=cost,
            chunk_ids=tuple(sorted(chunk.chunk_id for chunk in chunks)),
        )

    async def retrieve(self, query: str, *, top_k: int | None = None) -> RetrievalResult:
        """Search the store for ``query`` and return ranked, cited passages."""
        wanted = top_k if top_k is not None else self._binding.top_k
        if wanted < 1:
            raise ConfigurationError("top_k must be at least 1")

        batch, _ = await self._embed((query,))
        vector = batch.vectors[0]
        candidates = wanted * self._candidate_factor
        hits = await self._store.search(vector, top_k=candidates, metric=self._binding.index.metric)
        ranked = await self._rank(query, hits, candidates)
        items = _to_items(ranked)
        if self._reranker is not None:
            top_n = self._binding.rerank.top_n if self._binding.rerank is not None else wanted
            items = await self._reranker.rerank(query, items, top_n=top_n)
        return RetrievalResult(
            retriever=self._binding.retriever_id,
            query=query,
            items=items[:wanted],
        )

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._store.aclose()
        await self._embedder.aclose()
        if self._connector is not None:
            await self._connector.aclose()

    async def _read_source(self) -> tuple[SourceDocument, ...]:
        if self._connector is None:
            self._connector = open_connector(self._binding.source, base_dir=self._base_dir)
        return await self._connector.documents()

    async def _embed(self, texts: Sequence[str]) -> tuple[EmbeddingBatch, float]:
        """Embed a batch, charge it to the ledger, and report what it cost.

        The cost is returned as well as charged so a caller can report what one
        operation spent: the ledger's total is cumulative across every call the
        process made, and reporting that as this ingest's cost would double-count.
        """
        batch = await self._embedder.embed(texts, model=self._binding.embedding)
        usage = TokenUsage(
            input_tokens=batch.usage.input_tokens,
            output_tokens=batch.usage.output_tokens,
        )
        # Priced through CostProfile rather than a ModelSpec: a ModelSpec requires a
        # context window and an output ceiling, and fabricating those to reuse a
        # pricing helper would put invented numbers in a generated artifact.
        cost = self._binding.embedding.cost.cost_usd(usage)
        if self._ledger is not None:
            self._ledger.charge(
                self._budget,
                LedgerEntry(
                    alias=self._binding.embed_model,
                    model=self._binding.embedding.model_id,
                    provider=self._binding.embedding.provider,
                    usage=usage,
                    cost_usd=cost,
                ),
            )
        return batch, cost

    async def _rank(
        self,
        query: str,
        hits: Sequence[SearchHit],
        candidates: int,
    ) -> tuple[ScoredChunk, ...]:
        """The candidate ranking: vector only, or fused with a lexical ranking.

        Fusion is skipped when ``index.hybrid`` is false, and that is the whole
        meaning of the flag -- not "use a different metric", but "do not consult the
        lexical ranking at all".
        """
        if not self._binding.index.hybrid:
            return tuple(ScoredChunk(chunk=hit.record.chunk, score=hit.score) for hit in hits)

        corpus = await self._store.corpus()
        by_id: dict[str, StoreRecord] = {record.chunk.chunk_id: record for record in corpus}
        for hit in hits:
            by_id.setdefault(hit.record.chunk.chunk_id, hit.record)
        lexical = lexical_ranking(
            [record.chunk.text for record in corpus],
            [record.chunk.chunk_id for record in corpus],
            query,
            top_k=candidates,
        )
        fused = fuse(
            [
                [hit.record.chunk.chunk_id for hit in hits],
                [entry.chunk_id for entry in lexical],
            ]
        )
        return tuple(
            ScoredChunk(chunk=by_id[entry.chunk_id].chunk, score=entry.score)
            for entry in fused
            if entry.chunk_id in by_id
        )


def _to_items(ranked: Sequence[ScoredChunk]) -> tuple[RetrievedItem, ...]:
    """Attach provenance and assign contiguous 1-based ranks."""
    return tuple(
        RetrievedItem(
            chunk=scored.chunk,
            score=scored.score,
            rank=rank,
            citation=cite(scored.chunk),
        )
        for rank, scored in enumerate(ranked, start=1)
    )
