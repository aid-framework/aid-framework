"""The `handbook_quality` eval gate, driven by an in-process index.

This is the retrieval half of the example's evidence, and it exists because
retrieval is the one part of the generated app whose correctness the build cannot
see. A generator that emitted a retriever nobody could search would still pass
every golden, drift and determinism test, because those compare bytes -- and the
bytes would be right. So the eval is run here against a real index, and beside it
against an empty one. If both passed, neither number would mean anything.

Two properties are pinned together:

* a run over a corpus that does contain the expected documents passes the stored
  baseline; and
* a run over an empty index fails it, because every expected document is missing.

The second is the falsifying half. The embedder is the deterministic fake, so the
retrieval metrics are deterministic and a real drop is a drop rather than noise.

The index is built in this process on purpose. A memory store is per-process, so a
corpus written by `python -m app.generated.retrieval.ingest.handbook` -- which is
the operator-facing entry point, and is exercised as a command in CI -- would be
gone by the time anything searched it. Building the index here is what lets the
measurement cover the real store, chunker, embedder and reranker rather than a
stand-in for them. Nothing here reaches the network or needs a key.
"""

from __future__ import annotations

from aid_runtime import CostLedger, EvalBaseline, Retriever

from app.generated.deps import Deps
from app.generated.evals import handbook_quality
from app.generated.retrieval.bindings import build_retriever
from tests.fake_gateway import fake_deps

RECALL = "recall@k"


async def indexed_retriever() -> Retriever:
    """The handbook retriever with the example's corpus written to it.

    The retriever is built from the spec's own binding, so what is indexed here is
    what the app searches: the declared source, the declared chunking, the
    declared store.
    """

    retriever = build_retriever(handbook_quality.RETRIEVER, ledger=CostLedger())
    await retriever.ingest()
    return retriever


def deps_with(retriever: Retriever) -> Deps:
    """The app's dependencies, with this process's index where the app expects it."""

    return fake_deps(retrievers={handbook_quality.RETRIEVER: retriever})


async def test_the_gate_passes_at_the_recorded_ranking() -> None:
    """A run where the expected documents are in the index passes the stored baseline."""

    measured = await handbook_quality.run(deps=deps_with(await indexed_retriever()))
    result = handbook_quality.gate(measured, handbook_quality.load_baseline())

    assert result.passed, result.summary()
    assert result.runs == handbook_quality.SAMPLES
    # Not `== 1.0`: what the ranking is worth is the measurement the baseline records, and
    # this asserts only that something was found rather than nothing.
    assert measured.means()[RECALL] > 0.0


async def test_a_query_the_index_cannot_answer_fails_the_gate() -> None:
    """With nothing indexed every expected document is missing, and the gate says so.

    This is what makes the passing test evidence. A gate that passed here as well
    would be measuring its own tolerance rather than the retrieval, and the numbers
    in the test above would be decoration.
    """

    measured = await handbook_quality.run(
        deps=deps_with(build_retriever(handbook_quality.RETRIEVER, ledger=CostLedger()))
    )
    result = handbook_quality.gate(measured, handbook_quality.load_baseline())

    assert not result.passed, result.summary()
    assert measured.means()[RECALL] == 0.0
    assert result.failures()[0].metric == RECALL
    assert result.failures()[0].baseline_mean > 0.0


async def test_the_stored_baseline_is_a_recorded_run() -> None:
    """The committed baseline is a measurement, not a hand-written number."""

    measured = await handbook_quality.run(deps=deps_with(await indexed_retriever()))
    recorded = EvalBaseline.from_run(measured, model=handbook_quality.RETRIEVER)
    stored = handbook_quality.load_baseline()

    assert stored.model == handbook_quality.RETRIEVER
    assert (stored.dataset, stored.dataset_version) == (
        measured.dataset,
        measured.dataset_version,
    )
    for entry in stored.metrics:
        fresh = recorded.metric(entry.metric)
        assert entry.runs == fresh.runs == handbook_quality.SAMPLES
        assert entry.mean == fresh.mean
        assert entry.stdev == fresh.stdev


def test_the_thresholds_are_the_runtime_s_own_metric_names() -> None:
    """The gate is built from the metric objects, so a name cannot drift from the runtime."""

    assert {threshold.metric for threshold in handbook_quality.thresholds()} == {
        metric.name for metric in handbook_quality.metrics()
    }
    assert handbook_quality.RETRIEVER == "handbook"


def test_the_expected_documents_are_the_retriever_s_own_ids() -> None:
    """`expectDocs` names documents the way the connector does: relative to the source uri."""

    assert handbook_quality.EXPECT_DOCS == ("billing.md", "exports.md")
    assert handbook_quality.TOP_K >= 1
