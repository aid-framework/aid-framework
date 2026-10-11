"""Ingest, retrieve, and the retrieval gate.

Two things here are not ordinary unit tests.

**Regime (B).** ``docs/design.md`` §12 keeps two testing regimes, and this layer owes
the second one: a deliberately *worse* retriever must **fail** the gate. So the gate
test below drives the real ``RetrievalGate.sample`` into a real ``EvalRun``, stores a
real ``EvalBaseline`` from the good run, and calls the shipped
``BaselineGate.evaluate``. It asserts a pass on the good run and a failure on the worse
one, from the same thresholds. A comparator written for the occasion, or a metric that
merely returned a lower number, would prove nothing about the shipped gate; this test
can fail, which is the point.

The thresholds deliberately carry **no** ``min_mean``. With a floor present the failure
could come from the floor comparison and the statistical half of the gate would never
be exercised; with the floor absent, the only path that can reject the worse run is
``delta > max_regression`` **and** ``z > z_critical``. The assertions pin the verdict
path, not merely the verdict.

**Idempotence (A6).** Ingest sits outside the byte-identical codegen guarantee and is
held to a weaker one instead: chunk ids are content hashes, so re-ingesting identical
input yields identical ids and a no-op diff.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from aid_runtime import (
    Budget,
    BudgetExceededError,
    ConfigurationError,
    EvalError,
    FeatureDeferredError,
)
from aid_runtime.cost import CostLedger
from aid_runtime.evals.gate import EvalBaseline, EvalRun, MetricRun, Threshold
from aid_runtime.retrieval import (
    DistanceMetric,
    FakeDeterministicEmbedder,
    InMemoryVectorStore,
    RefreshMode,
    RetrievalGate,
    Retriever,
    retrieval_metrics,
)
from retrieval_support import (
    EMBED_ID,
    MODEL_ID,
    binding,
    document,
    pinned,
    retrieval_case,
    write_docs,
)

DATASET = "docs-retrieval"
DATASET_VERSION = "1"

#: Three runs, matching the golden fixture's own gate (``samples: 3``). One run would
#: make the run-to-run spread zero by construction and leave the statistical half of
#: the gate with nothing to measure.
RUNS = 3

#: Long enough that its embedding charge survives the shipped pricing helper, which
#: rounds USD to six decimals: `CostProfile.cost_usd` on a three-token document rounds
#: to exactly zero, so a test that wants to observe a charge has to feed it tokens.
EXPECTED_TEXT = "Install the CLI with the package manager, then run the doctor command. " * 8
OTHER_TEXT = "Furniture assembly instructions for the flat pack shelving unit."


def make_retriever(
    *,
    top_k: int = 3,
    hybrid: bool = False,
    rerank_model: str | None = None,
    size: int = 120,
) -> Retriever:
    """A bound retriever over the fake embedder, as every gated run uses."""
    return Retriever(
        binding(top_k=top_k, hybrid=hybrid, rerank_model=rerank_model, size=size),
        embedder=FakeDeterministicEmbedder(),
        store=InMemoryVectorStore(),
    )


def make_gate() -> RetrievalGate:
    thresholds = [
        Threshold(metric=name, max_regression=0.05)
        for name in ("recall@k", "mrr", "citation-grounding")
    ]
    return RetrievalGate(thresholds, metrics=retrieval_metrics())


async def test_ingest_reports_what_it_read_chunked_and_wrote() -> None:
    # One chunk per document, so the counts below are the document counts and the token
    # total is dominated by the long one.
    retriever = make_retriever(size=2000)

    report = await retriever.ingest([document("a.md", EXPECTED_TEXT), document("b.md", "beta")])

    assert report.retriever == "docs"
    assert report.documents == 2
    assert report.chunks == 2
    assert report.written == 2
    assert report.tokens > 0
    assert report.cost_usd > 0.0
    assert not report.is_empty


async def test_the_reported_chunk_ids_are_sorted() -> None:
    # Sorted, so two ingests of the same corpus compare equal without depending on the
    # order the filesystem happened to yield.
    report = await make_retriever().ingest([document("b.md", "beta"), document("a.md", "alpha")])

    assert report.chunk_ids == tuple(sorted(report.chunk_ids))


async def test_an_ingest_of_nothing_is_empty() -> None:
    report = await make_retriever().ingest([])

    assert report.is_empty
    assert report.chunks == 0
    assert report.written == 0
    assert report.chunk_ids == ()


async def test_ingest_reads_the_source_through_the_connector(tmp_path: Path) -> None:
    # The path generated code takes: no documents passed in, the source read from disk.
    write_docs(tmp_path / "docs", {"guide.md": "alpha", "nested/deep.md": "beta"})
    retriever = Retriever(
        binding(),
        embedder=FakeDeterministicEmbedder(),
        store=InMemoryVectorStore(),
        base_dir=str(tmp_path),
    )

    report = await retriever.ingest()

    assert report.documents == 2
    assert report.written == 2


async def test_the_source_glob_decides_what_is_read(tmp_path: Path) -> None:
    write_docs(
        tmp_path / "docs",
        {"guide.md": "alpha", "notes.rst": "beta", "skip/ignored.md": "gamma"},
    )
    retriever = Retriever(
        binding(glob="*.md"),
        embedder=FakeDeterministicEmbedder(),
        store=InMemoryVectorStore(),
        base_dir=str(tmp_path),
    )

    report = await retriever.ingest()

    # `*.md` does not match at depth, so only the top-level markdown file is read.
    assert report.documents == 1
    assert report.written == 1


async def test_re_ingesting_identical_input_is_a_no_op() -> None:
    # A6: chunk ids are content hashes, so a second ingest recomputes exactly the same
    # ids and the store replaces in place. The resulting diff is empty -- the property
    # ingest is held to, in place of the byte-identical codegen guarantee.
    retriever = make_retriever()
    documents = [document("a.md", "alpha"), document("b.md", "beta")]

    first = await retriever.ingest(documents)
    corpus_after_first = await retriever.store.corpus()
    second = await retriever.ingest(documents)

    assert first.chunk_ids == second.chunk_ids
    assert first.written == second.written
    assert await retriever.store.corpus() == corpus_after_first


async def test_changing_the_text_changes_the_chunk_id() -> None:
    # The complement of idempotence: a real change must not be swallowed as a no-op.
    retriever = make_retriever()

    first = await retriever.ingest([document("a.md", "alpha")])
    second = await retriever.ingest([document("a.md", "alpha, revised")])

    assert first.chunk_ids != second.chunk_ids
    assert len(await retriever.store.corpus()) == 2


async def test_ingest_charges_the_existing_ledger() -> None:
    ledger = CostLedger()
    retriever = Retriever(
        binding(),
        embedder=FakeDeterministicEmbedder(),
        store=InMemoryVectorStore(),
        ledger=ledger,
    )

    report = await retriever.ingest([document("a.md", EXPECTED_TEXT)])

    assert ledger.cost_usd == pytest.approx(report.cost_usd)
    entry = ledger.entries[0]
    # The pinned alias is the IR entry's `embedModel` id, not a provider model name.
    assert entry.alias == EMBED_ID
    assert entry.model == MODEL_ID
    assert entry.provider == "fake"
    assert entry.usage.output_tokens == 0


async def test_a_reported_cost_is_the_calls_spend_and_not_the_ledger_total() -> None:
    # `charge` accumulates, so reporting the ledger's running total as one ingest's cost
    # would double-count the first ingest. The embedding profile prices output at zero,
    # so every token charged here is an input token.
    ledger = CostLedger()
    retriever = Retriever(
        binding(),
        embedder=FakeDeterministicEmbedder(),
        store=InMemoryVectorStore(),
        ledger=ledger,
    )
    documents = [document("a.md", EXPECTED_TEXT)]

    first = await retriever.ingest(documents)
    second = await retriever.ingest(documents)

    assert first.cost_usd == pytest.approx(second.cost_usd)
    assert ledger.cost_usd == pytest.approx(2 * first.cost_usd)
    assert ledger.total_tokens == 2 * first.tokens


async def test_a_budget_ceiling_stops_an_ingest() -> None:
    # Reuses the shipped budget hook: the embedding profile is cheap but not free, and a
    # zero ceiling leaves no room for it. The corpus has to be long enough for the
    # six-decimal rounding in `CostProfile.cost_usd` to leave a non-zero charge behind.
    retriever = Retriever(
        binding(),
        embedder=FakeDeterministicEmbedder(),
        store=InMemoryVectorStore(),
        ledger=CostLedger(),
        budget=Budget(max_usd=0.0),
    )

    with pytest.raises(BudgetExceededError):
        await retriever.ingest([document("a.md", EXPECTED_TEXT)])


async def test_retrieve_returns_ranked_cited_items() -> None:
    retriever = make_retriever()
    await retriever.ingest([document("a.md", "alpha"), document("b.md", "beta")])

    result = await retriever.retrieve("anything")

    assert result.retriever == "docs"
    assert result.query == "anything"
    assert result.items
    assert [item.rank for item in result.items] == list(range(1, len(result.items) + 1))
    for item in result.items:
        assert item.citation.chunk_id == item.chunk.chunk_id
        assert item.citation.doc_id == item.chunk.doc_id
    assert len(result) == len(result.items)
    assert result.doc_ids == tuple(dict.fromkeys(citation.doc_id for citation in result.citations))
    # Each excerpt is tagged with its rank and citation, so a model reading the context
    # can cite what it used.
    assert result.context == "\n\n".join(
        f"[{item.rank}] {item.citation} :: {item.chunk.text}" for item in result.items
    )


async def test_retrieve_honours_the_top_k_the_binding_declares() -> None:
    retriever = make_retriever(top_k=1)
    await retriever.ingest([document("a.md", "alpha"), document("b.md", "beta")])

    result = await retriever.retrieve("anything")

    assert len(result.items) == 1


async def test_retrieve_honours_a_top_k_override() -> None:
    retriever = make_retriever(top_k=1)
    await retriever.ingest([document("a.md", "alpha"), document("b.md", "beta")])

    result = await retriever.retrieve("anything", top_k=2)

    assert len(result.items) == 2


async def test_retrieve_needs_a_positive_top_k() -> None:
    retriever = make_retriever()
    await retriever.ingest([document("a.md", "alpha")])

    with pytest.raises(ConfigurationError, match="top_k"):
        await retriever.retrieve("anything", top_k=0)


async def test_retrieve_from_an_empty_store_finds_nothing() -> None:
    # "The corpus has nothing for this query" is a result, not an error.
    result = await make_retriever().retrieve("anything")

    assert result.items == ()
    assert len(result) == 0
    assert result.context == ""
    assert result.doc_ids == ()


async def test_a_retriever_without_a_reranker_returns_the_stores_own_order() -> None:
    # Ranking is the store's ranking unless the index is hybrid or a rerank model is
    # declared, so comparing against the store's own hits pins that the vector order is
    # what reaches the caller rather than something re-sorted on the way out.
    retriever = make_retriever(top_k=2)
    await retriever.ingest([document("a.md", "alpha beta"), document("b.md", "gamma delta")])
    query = "alpha"

    batch = await FakeDeterministicEmbedder().embed((query,), model=pinned())
    hits = await retriever.store.search(batch.vectors[0], top_k=2, metric=DistanceMetric.COSINE)

    result = await retriever.retrieve(query)

    assert [item.chunk.chunk_id for item in result.items] == [
        hit.record.chunk.chunk_id for hit in hits
    ]
    assert [item.score for item in result.items] == [hit.score for hit in hits]


async def test_a_hybrid_retriever_still_returns_a_ranking() -> None:
    retriever = make_retriever(hybrid=True)
    await retriever.ingest([document("a.md", "alpha beta"), document("b.md", "gamma delta")])

    result = await retriever.retrieve("alpha")

    assert result.items
    assert [item.rank for item in result.items] == list(range(1, len(result.items) + 1))


async def test_a_declared_lexical_rerank_model_reorders_the_vector_ranking() -> None:
    # One document shares the query's terms, one shares none. The reranker scores the
    # first above zero and the second at exactly zero, and the caller sees those scores
    # -- so the ranking that arrives is the reranker's, not the store's. Which document
    # the *vector* ranking put first is a property of the hash embedding and is
    # deliberately not asserted here.
    retriever = make_retriever(top_k=2, rerank_model="fake-lexical-rerank")
    await retriever.ingest(
        [
            document("matching.md", "install the cli, then install the cli again"),
            document("unrelated.md", "flat pack shelving unit"),
        ]
    )

    result = await retriever.retrieve("install the cli")

    assert [item.chunk.doc_id for item in result.items] == ["matching.md", "unrelated.md"]
    assert result.items[0].score > 0.0
    assert result.items[1].score == 0.0
    assert [item.rank for item in result.items] == [1, 2]


async def test_aclose_is_idempotent() -> None:
    retriever = make_retriever()

    await retriever.aclose()
    await retriever.aclose()


def test_a_candidate_factor_below_one_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="candidate_factor"):
        Retriever(binding(), candidate_factor=0)


def test_incremental_refresh_is_deferred_rather_than_ignored() -> None:
    # Quietly treating an incremental refresh as a full one would be a correctness hole:
    # the caller asked for something this layer does not implement.
    with pytest.raises(FeatureDeferredError, match="incremental"):
        Retriever(binding(refresh_mode=RefreshMode.INCREMENTAL))


def test_the_gate_exposes_its_thresholds_and_metrics() -> None:
    configured = make_gate()

    assert [threshold.metric for threshold in configured.thresholds] == [
        "recall@k",
        "mrr",
        "citation-grounding",
    ]
    assert [metric.name for metric in configured.metrics] == [
        "recall@k",
        "mrr",
        "citation-grounding",
    ]
    assert all(metric.deterministic for metric in configured.metrics)


async def test_sampling_produces_one_value_per_metric_per_run() -> None:
    retriever = make_retriever(top_k=1)
    await retriever.ingest([document("expected.md", EXPECTED_TEXT)])
    cases = [retrieval_case("basics", "how do I install?", ["expected.md"], k=1)]

    run = await make_gate().sample(
        cases, retriever, runs=RUNS, dataset=DATASET, dataset_version=DATASET_VERSION
    )

    assert run.dataset == DATASET
    assert run.dataset_version == DATASET_VERSION
    assert run.runs == RUNS
    assert [entry.metric for entry in run.metrics] == ["recall@k", "mrr", "citation-grounding"]
    assert all(len(entry.values) == RUNS for entry in run.metrics)
    assert run.means()["recall@k"] == 1.0
    assert not run.is_varying()


async def test_sampling_needs_cases_runs_and_metrics() -> None:
    retriever = make_retriever()
    cases = [retrieval_case("basics", "q", ["a.md"], k=1)]

    with pytest.raises(EvalError, match="at least one case"):
        await make_gate().sample(
            [], retriever, runs=RUNS, dataset=DATASET, dataset_version=DATASET_VERSION
        )
    with pytest.raises(EvalError, match="at least one run"):
        await make_gate().sample(
            cases, retriever, runs=0, dataset=DATASET, dataset_version=DATASET_VERSION
        )
    with pytest.raises(EvalError, match="at least one metric"):
        await RetrievalGate([Threshold(metric="recall@k")]).sample(
            cases, retriever, runs=RUNS, dataset=DATASET, dataset_version=DATASET_VERSION
        )


async def test_a_run_against_a_baseline_from_another_dataset_is_refused() -> None:
    # The shipped gate's own dataset guard, reached through the retrieval wrapper:
    # comparing against a baseline recorded elsewhere would compare unlike things.
    retriever = make_retriever()
    cases = [retrieval_case("basics", "q", ["a.md"], k=1)]
    configured = make_gate()
    run = await configured.sample(
        cases, retriever, runs=RUNS, dataset=DATASET, dataset_version=DATASET_VERSION
    )
    baseline = EvalBaseline.from_run(run, model="fake")
    foreign = EvalRun(
        dataset="somewhere-else",
        dataset_version=DATASET_VERSION,
        runs=RUNS,
        metrics=tuple(MetricRun(metric=entry.metric, values=entry.values) for entry in run.metrics),
    )

    with pytest.raises(EvalError, match="compare like with like"):
        configured.evaluate(foreign, baseline)


async def test_a_worse_retriever_fails_the_shipped_gate_while_the_good_one_passes() -> None:
    """Regime (B): the gate must be able to reject a deliberately worse retriever.

    Both retrievers are real, both share one binding, the same fake embedder and the
    same in-memory adapter; the only difference is *which* corpus was ingested -- one
    that contains the expected document, and one that contains a different one. That is
    a regression the gate exists to catch: a source glob that stopped matching, or a
    store that was never re-indexed.

    The worse run is rejected because its mean has dropped materially *and* by more than
    the runs' own variation can explain. Both retrievers are deterministic, so both
    spreads are zero and any drop is real; that is asserted too, so the test cannot pass
    for the wrong reason.
    """
    good = Retriever(
        binding(top_k=1), embedder=FakeDeterministicEmbedder(), store=InMemoryVectorStore()
    )
    await good.ingest([document("expected.md", EXPECTED_TEXT)])

    worse = Retriever(
        binding(top_k=1), embedder=FakeDeterministicEmbedder(), store=InMemoryVectorStore()
    )
    await worse.ingest([document("unrelated.md", OTHER_TEXT)])

    cases = [retrieval_case("basics", "how do I install the cli?", ["expected.md"], k=1)]
    configured = make_gate()

    good_run = await configured.sample(
        cases, good, runs=RUNS, dataset=DATASET, dataset_version=DATASET_VERSION
    )
    baseline = EvalBaseline.from_run(good_run, model="fake")
    worse_run = await configured.sample(
        cases, worse, runs=RUNS, dataset=DATASET, dataset_version=DATASET_VERSION
    )

    accepted = configured.evaluate(good_run, baseline)
    rejected = configured.evaluate(worse_run, baseline)

    # No floor is configured, so the failure below cannot be a floor breach: the only
    # path left is the regression test, which needs the drop to exceed the run-to-run
    # spread as well as the allowed delta.
    assert all(threshold.min_mean is None for threshold in configured.thresholds)

    assert accepted.passed
    assert accepted.failures() == ()
    assert not rejected.passed

    failures = {result.metric: result for result in rejected.failures()}
    assert set(failures) == {"recall@k", "mrr", "citation-grounding"}
    for result in failures.values():
        assert result.current_mean == 0.0
        assert result.baseline_mean == 1.0
        assert result.delta == pytest.approx(1.0)
        assert "exceeds max_regression" in result.rationale

    recall = failures["recall@k"]
    assert recall.alpha == 0.05
    assert recall.max_regression == 0.05
    assert math.isinf(recall.z)
    assert recall.z > 1.6449

    assert not good_run.is_varying()
    assert not worse_run.is_varying()
    assert baseline.metric("recall@k").mean == 1.0
    assert baseline.metric("recall@k").stdev == 0.0
