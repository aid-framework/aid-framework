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

from aid_runtime.agents.guardrails import (
    ACTION_BLOCK,
    ACTION_ESCALATE,
    ACTION_REDACT,
    GuardrailEngine,
    GuardrailRecord,
)
from aid_runtime.agents.ir import GuardrailDefinition
from aid_runtime.cost import Budget, CostLedger, LedgerEntry
from aid_runtime.errors import ConfigurationError, FeatureDeferredError, GuardrailBlockedError
from aid_runtime.retrieval.chunking import chunker_for
from aid_runtime.retrieval.citations import RetrievalResult, RetrievedItem, cite
from aid_runtime.retrieval.connectors import Connector, SourceDocument, open_connector
from aid_runtime.retrieval.embedding import Embedder, EmbeddingBatch, embedder_for
from aid_runtime.retrieval.filters import Filter, compile_filters, matches_all
from aid_runtime.retrieval.hybrid import fuse, lexical_ranking
from aid_runtime.retrieval.knowledge_base import KnowledgeBaseClient, knowledge_base_client_for
from aid_runtime.retrieval.rerank import Reranker, reranker_for
from aid_runtime.retrieval.stores import SearchHit, StoreRecord, VectorStore, create_store
from aid_runtime.retrieval.types import (
    Chunk,
    ManagedRetrieverBinding,
    RefreshMode,
    RetrieverBinding,
    ScoredChunk,
)
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

    ``written`` counts chunks upserted and ``reused`` counts chunks an incremental
    ingest found already stored and therefore did not embed; ``written + reused`` is
    ``chunks``. ``removed`` counts chunks deleted because their document no longer
    yields them. All three are zero-or-more, and all but ``written`` are zero for a
    ``full`` refresh, which never reads the index and never deletes from it.

    ``tokens`` and ``cost_usd`` include the semantic chunker's boundary pass. That pass
    embeds every unit before a chunk exists, so reporting only the chunk embeddings
    would undercount what the ingest actually spent.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    retriever: str = Field(min_length=1)
    documents: int = Field(ge=0)
    chunks: int = Field(ge=0)
    written: int = Field(ge=0)
    tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0.0)
    chunk_ids: tuple[str, ...]
    reused: int = Field(default=0, ge=0)
    removed: int = Field(default=0, ge=0)

    @property
    def is_empty(self) -> bool:
        return self.chunks == 0


class Retriever:
    """A bound retriever: its source, its chunker, its embedder, its store -- or, for a
    managed knowledge base, the client that asks the engine.

    Seams are injectable and default from the binding. Tests inject the fake embedder and
    an in-memory store; generated code passes the real ones. A managed binding has no
    embedder or store to inject, and takes a ``knowledge_base_client`` instead.
    """

    def __init__(
        self,
        binding: RetrieverBinding | ManagedRetrieverBinding,
        *,
        embedder: Embedder | None = None,
        store: VectorStore | None = None,
        reranker: Reranker | None = None,
        connector: Connector | None = None,
        ledger: CostLedger | None = None,
        budget: Budget | None = None,
        base_dir: str | None = None,
        candidate_factor: int = DEFAULT_CANDIDATE_FACTOR,
        guardrails: Sequence[GuardrailDefinition] = (),
        knowledge_base_client: KnowledgeBaseClient | None = None,
    ) -> None:
        if candidate_factor < 1:
            raise ConfigurationError("candidate_factor must be at least 1")
        self._binding = binding
        self._reranker = reranker or reranker_for(binding.rerank)
        self._ledger = ledger
        self._budget = budget
        self._candidate_factor = candidate_factor
        self._guardrails = tuple(guardrails)
        self._guardrail_engine = GuardrailEngine()
        self._closed = False
        if isinstance(binding, ManagedRetrieverBinding):
            client = knowledge_base_client or knowledge_base_client_for(binding.knowledge_base)
            if binding.filters and not client.supports_filter_expressions:
                raise FeatureDeferredError(
                    f"retriever {binding.retriever_id!r} declares filters and knowledge base "
                    f"{binding.knowledge_base.id!r} runs on "
                    f"{binding.knowledge_base.engine.value!r}, whose retrieve API does not take "
                    "the expression the spec carries; serving the call unfiltered would return "
                    "the whole corpus"
                )
            self._knowledge_base_client: KnowledgeBaseClient | None = client
            self._embedder = None
            self._store = None
            self._connector = None
            self._base_dir = None
            return
        self._knowledge_base_client = None
        # Parsed once here so a malformed selector fails at construction, and so the
        # per-query path never re-parses. A syntax error names the grammar.
        self._filters = compile_filters(binding.filters or ())
        self._embedder = embedder or embedder_for(binding.embedding)
        self._store = store or create_store(
            binding.store_kind,
            uri=binding.store_uri,
            dimensions=binding.embedding.dimensions,
        )
        self._connector = connector
        self._base_dir = base_dir

    @property
    def binding(self) -> RetrieverBinding | ManagedRetrieverBinding:
        return self._binding

    @property
    def is_managed(self) -> bool:
        return self._knowledge_base_client is not None

    @property
    def store(self) -> VectorStore:
        if self._store is None:
            raise ConfigurationError(
                f"retriever {self._binding.retriever_id!r} reads a managed knowledge base, so "
                "it has no local store: the engine owns the index"
            )
        return self._store

    async def ingest(self, documents: Sequence[SourceDocument] | None = None) -> IngestReport:
        """Chunk a source, embed it, and write it.

        Idempotent by construction: chunk ids are content hashes and the store
        upserts on them, so ingesting the same input twice replaces rather than
        duplicates. Re-ingesting is therefore a legitimate way to refresh a corpus.

        ``refresh.mode`` decides what the second run redoes. ``full`` -- the default --
        embeds and upserts every chunk and never reads or deletes from the index, so
        dropping a document from the source leaves its vectors behind. ``incremental``
        instead reconciles the index with the source: a chunk the store already holds
        keeps its vector, a stored chunk the source no longer yields is deleted, and
        only new chunks are embedded.

        Incremental therefore treats what it is given as the *whole* corpus, whether
        that came from the connector or from an explicit ``documents`` argument. Passing
        a subset of the corpus in incremental mode deletes the rest, exactly as narrowing
        the source glob would; the mode is a reconciliation, not a merge.

        Refused for a managed retriever. The engine ingests from its own data source, so
        a local ingest would write vectors the retriever never reads -- work that costs
        money and changes nothing, which is the worst kind of silent success.
        """
        if self._knowledge_base_client is not None:
            raise ConfigurationError(
                f"retriever {self._binding.retriever_id!r} reads a managed knowledge base, "
                "which ingests from its data source inside the engine; there is no local "
                "index to fill, and writing one would be read by nothing"
            )
        local = self._local
        incremental = local.refresh_mode is RefreshMode.INCREMENTAL
        source_documents = tuple(documents) if documents is not None else await self._read_source()
        chunker = chunker_for(
            local.chunking, embedder=self._embedder, model=local.embedding
        )
        chunks: list[Chunk] = []
        # A chunker reports one document's boundary work, so a corpus has to be summed
        # here: reading `chunker.usage` after the loop would report only the last
        # document.
        boundary_input = 0
        boundary_output = 0
        for document in source_documents:
            document_chunks = await chunker.chunk(document)
            boundary_input += chunker.usage.input_tokens
            boundary_output += chunker.usage.output_tokens
            chunks.extend(document_chunks)

        to_embed = chunks
        removed = 0
        if incremental:
            stored = set(await self.store.chunk_ids())
            current = {chunk.chunk_id for chunk in chunks}
            if stale := sorted(stored - current):
                removed = await self.store.delete(stale)
            to_embed = [chunk for chunk in chunks if chunk.chunk_id not in stored]

        records: list[StoreRecord] = []
        # A semantic chunker embeds every unit before it can cut, so its boundary pass
        # is work this ingest caused and must report. The size chunkers report zero.
        boundary_usage = TokenUsage(input_tokens=boundary_input, output_tokens=boundary_output)
        tokens = boundary_usage.input_tokens
        cost = self._charge_embedding(boundary_usage) if boundary_usage.total_tokens else 0.0
        for start in range(0, len(to_embed), _BATCH_SIZE):
            batch = to_embed[start : start + _BATCH_SIZE]
            embedded, batch_cost = await self._embed(tuple(chunk.text for chunk in batch))
            tokens += embedded.usage.input_tokens
            cost += batch_cost
            records.extend(
                StoreRecord(chunk=chunk, vector=vector)
                for chunk, vector in zip(batch, embedded.vectors, strict=True)
            )

        written = await self.store.upsert(records)
        return IngestReport(
            retriever=local.retriever_id,
            documents=len(source_documents),
            chunks=len(chunks),
            written=written,
            reused=len(chunks) - len(to_embed),
            removed=removed,
            tokens=tokens,
            cost_usd=cost,
            chunk_ids=tuple(sorted(chunk.chunk_id for chunk in chunks)),
        )

    async def retrieve(self, query: str, *, top_k: int | None = None) -> RetrievalResult:
        """Search for ``query`` and return ranked, cited passages."""
        wanted = top_k if top_k is not None else self._binding.top_k
        if wanted < 1:
            raise ConfigurationError("top_k must be at least 1")
        if self._knowledge_base_client is not None:
            return await self._retrieve_managed(query, wanted)

        batch, _ = await self._embed((query,))
        vector = batch.vectors[0]
        local = self._local
        filters = self._filters
        hits = await self._search_vector(vector, wanted, local, filters)
        candidates = max(len(hits), wanted * self._candidate_factor)
        ranked = await self._rank(query, hits, candidates, filters)
        items = _to_items(ranked)
        if self._reranker is not None:
            top_n = local.rerank.top_n if local.rerank is not None else wanted
            items = await self._reranker.rerank(query, items, top_n=top_n)
        guarded, records = self._guard_retrieval(items[:wanted])
        return RetrievalResult(
            retriever=local.retriever_id,
            query=query,
            items=guarded,
            guardrails=records,
        )

    def _guard_retrieval(
        self, items: Sequence[RetrievedItem]
    ) -> tuple[tuple[RetrievedItem, ...], tuple[GuardrailRecord, ...]]:
        """Run the ``retrieval`` stage over each returned passage.

        Per item, not over the concatenation: a redaction has to rewrite the one
        passage it matched, and a joined string cannot be split back into passages
        without guessing where each ended.

        A retriever has no channel to ask a person on, so ``escalate`` blocks here
        instead of pausing. Turning it into a silent pass would be the exact failure
        mode the stage exists to prevent, and the agent loop -- which does have a
        channel -- is where an escalation can pause a run.
        """
        if not self._guardrails:
            return tuple(items), ()
        guarded: list[RetrievedItem] = []
        records: list[GuardrailRecord] = []
        for item in items:
            verdict = self._guardrail_engine.check_retrieval(self._guardrails, (item.chunk.text,))
            records.extend(verdict.records)
            deciding = verdict.deciding
            if deciding is None:
                guarded.append(item)
                continue
            if deciding.action == ACTION_BLOCK:
                raise GuardrailBlockedError(deciding.guardrail, "retrieval", deciding.message)
            if deciding.action == ACTION_ESCALATE:
                raise GuardrailBlockedError(
                    deciding.guardrail,
                    "retrieval",
                    f"{deciding.message} (a retriever has no human channel, so an "
                    "escalation here blocks rather than passing unchecked)",
                )
            if deciding.action == ACTION_REDACT:
                item = item.model_copy(
                    update={"chunk": item.chunk.model_copy(update={"text": verdict.text})}
                )
            guarded.append(item)
        return tuple(guarded), tuple(records)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._knowledge_base_client is not None:
            await self._knowledge_base_client.aclose()
            return
        await self.store.aclose()
        embedder = self._embedder
        if embedder is not None:
            await embedder.aclose()
        if self._connector is not None:
            await self._connector.aclose()

    async def _retrieve_managed(self, query: str, wanted: int) -> RetrievalResult:
        """Ask the engine, then run the same rerank and guardrail stages as a local search.

        The chunk mapping goes through :class:`ScoredChunk` and :func:`_to_items` rather
        than straight to ``RetrievedItem`` so citations are derived the one way they are
        derived everywhere: a managed passage then cites identically to a local one, and
        a change to how a citation is built cannot reach only one of the two paths.
        """
        binding = self._binding
        if not isinstance(binding, ManagedRetrieverBinding):
            raise AssertionError("_retrieve_managed called for a local binding")
        client = self._knowledge_base_client
        if client is None:
            raise AssertionError("_retrieve_managed called without a client")

        result = await client.retrieve(
            binding.knowledge_base,
            query,
            top_k=wanted,
            filters=binding.filters,
        )
        if result.cost_usd is not None and self._ledger is not None:
            self._ledger.charge(
                self._budget,
                LedgerEntry(
                    alias=binding.retriever_id,
                    model=binding.knowledge_base.engine.value,
                    provider=binding.knowledge_base.engine.value,
                    usage=TokenUsage(input_tokens=0, output_tokens=0),
                    cost_usd=result.cost_usd,
                ),
            )

        ranked = tuple(
            ScoredChunk(
                chunk=Chunk(
                    chunk_id=chunk.chunk_id,
                    doc_id=chunk.source_uri or binding.retriever_id,
                    uri=chunk.source_uri,
                    index=chunk.position,
                    start=0,
                    end=len(chunk.text),
                    text=chunk.text,
                    metadata=dict(chunk.metadata),
                ),
                score=chunk.score,
            )
            for chunk in result.chunks
        )
        items = _to_items(ranked)
        if self._reranker is not None:
            top_n = binding.rerank.top_n if binding.rerank is not None else wanted
            items = await self._reranker.rerank(query, items, top_n=top_n)
        guarded, records = self._guard_retrieval(items[:wanted])
        return RetrievalResult(
            retriever=binding.retriever_id,
            query=query,
            items=guarded,
            guardrails=records,
        )

    @property
    def _local(self) -> RetrieverBinding:
        """The binding, narrowed to the local shape.

        Reached only from the local code paths. Raising rather than asserting keeps a
        runtime failure explained even under ``python -O``, which strips assertions.
        """
        binding = self._binding
        if not isinstance(binding, RetrieverBinding):
            raise ConfigurationError(
                f"retriever {binding.retriever_id!r} reads a managed knowledge base, so it "
                "has no local source, chunker, embedder, or store"
            )
        return binding

    async def _read_source(self) -> tuple[SourceDocument, ...]:
        if self._connector is None:
            self._connector = open_connector(self._local.source, base_dir=self._base_dir)
        return await self._connector.documents()

    async def _embed(self, texts: Sequence[str]) -> tuple[EmbeddingBatch, float]:
        """Embed a batch, charge it to the ledger, and report what it cost.

        The cost is returned as well as charged so a caller can report what one
        operation spent: the ledger's total is cumulative across every call the
        process made, and reporting that as this ingest's cost would double-count.
        """
        embedder = self._embedder
        if embedder is None:
            raise AssertionError("_embed called without an embedder")
        local = self._local
        embedded = await embedder.embed(texts, model=local.embedding)
        return embedded, self._charge_embedding(embedded.usage)

    def _charge_embedding(self, usage: TokenUsage) -> float:
        """Price one embedding pass through the pinned profile and charge the ledger."""
        local = self._local
        # Priced through CostProfile rather than a ModelSpec: a ModelSpec requires a
        # context window and an output ceiling, and fabricating those to reuse a
        # pricing helper would put invented numbers in a generated artifact.
        cost = local.embedding.cost.cost_usd(usage)
        if self._ledger is not None:
            self._ledger.charge(
                self._budget,
                LedgerEntry(
                    alias=local.embed_model,
                    model=local.embedding.model_id,
                    provider=local.embedding.provider,
                    usage=usage,
                    cost_usd=cost,
                ),
            )
        return cost

    async def _search_vector(
        self,
        vector: Sequence[float],
        wanted: int,
        local: RetrieverBinding,
        filters: Sequence[Filter],
    ) -> tuple[SearchHit, ...]:
        """Vector search, widened until ``wanted`` passages survive the filters.

        A store can only apply ``top_k``, so a selective filter has to be satisfied by
        looking deeper. The limit doubles until enough passages match or the store
        returns fewer rows than were asked for -- the latter is the only signal that
        the corpus is exhausted. With no filters this is one search at the historical
        candidate width, so the unfiltered path is byte-for-byte unchanged.
        """
        limit = max(wanted * self._candidate_factor, 1)
        while True:
            hits = await self.store.search(vector, top_k=limit, metric=local.index.metric)
            kept = tuple(hit for hit in hits if matches_all(hit.record.chunk, filters))
            if len(kept) >= wanted or len(hits) < limit:
                return kept
            limit *= 2

    async def _rank(
        self,
        query: str,
        hits: Sequence[SearchHit],
        candidates: int,
        filters: Sequence[Filter] = (),
    ) -> tuple[ScoredChunk, ...]:
        """The candidate ranking: vector only, or fused with a lexical ranking.

        Fusion is skipped when ``index.hybrid`` is false, and that is the whole
        meaning of the flag -- not "use a different metric", but "do not consult the
        lexical ranking at all".

        The lexical half reads the stored corpus rather than the vector hits, so it is
        filtered too. Ranking the whole corpus and filtering afterwards would let a
        passage outside the selector re-enter through BM25, which is the one way a
        filter could silently match more than it says.
        """
        if not self._local.index.hybrid:
            return tuple(ScoredChunk(chunk=hit.record.chunk, score=hit.score) for hit in hits)

        corpus = await self.store.corpus()
        if filters:
            corpus = tuple(record for record in corpus if matches_all(record.chunk, filters))
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
