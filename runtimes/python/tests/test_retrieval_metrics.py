"""The retrieval metrics, and the contract they share with the shipped gate.

The shipped `Metric` scores `(case, prediction: str)`. These score a ranked set of
passages with provenance, so they get their own protocol -- see the module docstring
of `aid_runtime.retrieval.metrics` for why widening the shipped one was the larger
change. What makes the split safe is that both protocols expose the two properties
the gate actually reads, `name` and `deterministic`, which the last test here checks
against the real gate rather than against a stub.
"""

from __future__ import annotations

from typing import cast

import pytest
from pydantic import ValidationError

from aid_runtime import GateConfigurationError
from aid_runtime.evals import Metric, Threshold
from aid_runtime.evals.gate import BaselineGate
from aid_runtime.retrieval import (
    Citation,
    CitationGrounding,
    MeanReciprocalRank,
    RecallAtK,
    RetrievalCase,
    RetrievalMetric,
    RetrievalMetricSpec,
    retrieval_metrics,
)
from retrieval_support import chunk, result, retrieval_case

THRESHOLD = Threshold(metric="recall@k", min_mean=0.9)


def test_a_case_is_built_from_the_ir_node_field_for_field() -> None:
    case = RetrievalCase.from_spec(
        case_id="docs-basics",
        query="how do I start?",
        spec=RetrievalMetricSpec(kind="retrieval", expectDocs=("getting-started.md",), k=3),
    )

    assert case == RetrievalCase(
        id="docs-basics", query="how do I start?", expect_docs=("getting-started.md",), k=3
    )


def test_a_case_needs_at_least_one_expected_document() -> None:
    # A case that expects nothing would pass for any retriever, including one that
    # returns nothing, which is worse than no case at all.
    with pytest.raises(ValidationError):
        RetrievalCase(id="c", query="q", expect_docs=(), k=1)


def test_a_case_needs_a_positive_k() -> None:
    with pytest.raises(ValidationError):
        RetrievalCase(id="c", query="q", expect_docs=("a.md",), k=0)


def test_a_case_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        RetrievalCase.model_validate(
            {"id": "c", "query": "q", "expect_docs": ["a.md"], "k": 1, "unexpected": 1}
        )


def test_the_default_metrics_are_the_three_this_runtime_ships() -> None:
    metrics = retrieval_metrics()

    assert [metric.name for metric in metrics] == ["recall@k", "mrr", "citation-grounding"]
    assert all(metric.deterministic for metric in metrics)
    assert all(isinstance(metric, RetrievalMetric) for metric in metrics)


@pytest.mark.parametrize("metric", retrieval_metrics())
def test_every_metric_satisfies_its_own_protocol(metric: RetrievalMetric) -> None:
    assert isinstance(metric, RetrievalMetric)
    assert metric.name != ""


async def test_recall_scores_one_when_every_expected_document_is_found() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)
    retrieved = result("q", [chunk("a.md", "alpha")])

    scored = await RecallAtK().score(case, retrieved)

    assert scored.metric == "recall@k"
    assert scored.score == 1.0
    assert scored.passed
    assert scored.detail == ""


async def test_recall_scores_the_fraction_found_and_names_what_is_missing() -> None:
    case = retrieval_case("c", "q", ["a.md", "b.md"], k=3)
    retrieved = result("q", [chunk("a.md", "alpha"), chunk("c.md", "gamma")])

    scored = await RecallAtK().score(case, retrieved)

    assert scored.score == pytest.approx(0.5)
    assert not scored.passed
    assert scored.detail == "missing: b.md"


async def test_recall_scores_zero_when_nothing_expected_was_found() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)
    retrieved = result("q", [chunk("z.md", "zeta")])

    scored = await RecallAtK().score(case, retrieved)

    assert scored.score == 0.0
    assert scored.detail == "missing: a.md"


async def test_recall_scores_zero_for_an_empty_retrieval() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)

    scored = await RecallAtK().score(case, result("q", []))

    assert scored.score == 0.0
    assert not scored.passed


async def test_recall_does_not_let_a_repeated_document_inflate_the_ranking() -> None:
    # Three passages of one document occupy three slots. Counting passages rather
    # than documents would push the expected document out of the top-k window and
    # score a worse retriever higher.
    case = retrieval_case("c", "q", ["b.md"], k=2)
    retrieved = result(
        "q",
        [
            chunk("a.md", "alpha one", index=0),
            chunk("a.md", "alpha two", index=1),
            chunk("b.md", "beta", index=0),
        ],
    )

    scored = await RecallAtK().score(case, retrieved)

    assert retrieved.doc_ids == ("a.md", "b.md")
    assert scored.score == 1.0


async def test_recall_only_counts_documents_inside_the_k_window() -> None:
    case = retrieval_case("c", "q", ["a.md", "b.md"], k=1)
    retrieved = result("q", [chunk("a.md", "alpha"), chunk("b.md", "beta")])

    scored = await RecallAtK().score(case, retrieved)

    assert scored.score == pytest.approx(0.5)
    assert scored.detail == "missing: b.md"


async def test_recall_can_be_renamed_and_retuned() -> None:
    metric = RecallAtK(name="docs/recall", min_score=0.5)
    case = retrieval_case("c", "q", ["a.md", "b.md"], k=3)

    scored = await metric.score(case, result("q", [chunk("a.md", "alpha")]))

    assert metric.name == "docs/recall"
    assert scored.metric == "docs/recall"
    assert scored.passed


async def test_mrr_scores_the_reciprocal_rank_of_the_first_expected_document() -> None:
    case = retrieval_case("c", "q", ["b.md"], k=3)
    retrieved = result("q", [chunk("a.md", "alpha"), chunk("b.md", "beta")])

    scored = await MeanReciprocalRank().score(case, retrieved)

    assert scored.score == pytest.approx(0.5)
    assert scored.passed
    assert "rank 2" in scored.detail


async def test_mrr_scores_one_when_the_first_hit_is_expected() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)

    scored = await MeanReciprocalRank().score(case, result("q", [chunk("a.md", "alpha")]))

    assert scored.score == 1.0


async def test_mrr_scores_zero_when_the_expected_document_is_outside_the_window() -> None:
    case = retrieval_case("c", "q", ["b.md"], k=1)
    retrieved = result("q", [chunk("a.md", "alpha"), chunk("b.md", "beta")])

    scored = await MeanReciprocalRank().score(case, retrieved)

    assert scored.score == 0.0
    assert not scored.passed
    assert scored.detail == "none of b.md were retrieved within k=1"


async def test_mrr_scores_zero_for_an_empty_retrieval() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)

    scored = await MeanReciprocalRank().score(case, result("q", []))

    assert scored.score == 0.0


async def test_citation_grounding_scores_full_marks_when_every_document_is_cited() -> None:
    case = retrieval_case("c", "q", ["a.md", "b.md"], k=3)
    retrieved = result("q", [chunk("a.md", "alpha"), chunk("b.md", "beta")])

    scored = await CitationGrounding().score(case, retrieved)

    assert scored.score == 1.0
    assert scored.passed
    assert scored.detail == ""


async def test_citation_grounding_names_the_documents_left_uncited() -> None:
    case = retrieval_case("c", "q", ["a.md", "b.md"], k=3)
    retrieved = result("q", [chunk("a.md", "alpha")])

    scored = await CitationGrounding().score(case, retrieved)

    assert scored.score == pytest.approx(0.5)
    assert scored.detail == "uncited: b.md"


async def test_a_citation_that_disagrees_with_its_passage_scores_zero() -> None:
    # Integrity is checked before coverage: a citation that names the wrong passage
    # is worse than a missing one, because it reads as authoritative while pointing
    # a reader somewhere else. Full coverage must not rescue it.
    case = retrieval_case("c", "q", ["a.md"], k=3)
    retrieved = result(
        "q",
        [chunk("a.md", "alpha")],
        citations=[Citation(doc_id="a.md", chunk_id="sha256:somewhere-else", index=0)],
    )

    scored = await CitationGrounding().score(case, retrieved)

    assert scored.score == 0.0
    assert not scored.passed
    assert "disagree" in scored.detail


async def test_a_citation_naming_the_wrong_document_scores_zero() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)
    item = chunk("a.md", "alpha")
    retrieved = result(
        "q",
        [item],
        citations=[Citation(doc_id="b.md", chunk_id=item.chunk_id, index=0)],
    )

    scored = await CitationGrounding().score(case, retrieved)

    assert scored.score == 0.0
    assert "disagree" in scored.detail


async def test_citation_grounding_scores_zero_for_an_empty_retrieval() -> None:
    case = retrieval_case("c", "q", ["a.md"], k=3)

    scored = await CitationGrounding().score(case, result("q", []))

    assert scored.score == 0.0
    assert scored.detail == "uncited: a.md"


async def test_the_retrieval_metrics_are_deterministic_across_calls() -> None:
    # `deterministic = True` is what lets these gate CI, so it is asserted rather
    # than assumed.
    case = retrieval_case("c", "q", ["a.md"], k=1)
    retrieved = result("q", [chunk("a.md", "alpha"), chunk("a.md", "alpha again", index=1)])

    for metric in retrieval_metrics():
        first = await metric.score(case, retrieved)
        second = await metric.score(case, retrieved)
        assert first == second


class _WobblingMetric:
    """A retrieval metric that admits it is not reproducible."""

    @property
    def name(self) -> str:
        return "recall@k"

    @property
    def deterministic(self) -> bool:
        return False

    async def score(self, case: RetrievalCase, retrieved: object) -> object:
        raise AssertionError("the gate must refuse this metric before it is ever scored")


def test_the_real_gate_refuses_a_non_deterministic_retrieval_metric() -> None:
    # This is what the cast in `retrieval.gate` must not be allowed to hide: the
    # gate reads `name` and `deterministic` off whatever it is handed, so a
    # metric that is not reproducible is rejected at construction, exactly as a
    # native `Metric` would be.
    gate_input = cast(list[Metric], [_WobblingMetric()])

    with pytest.raises(GateConfigurationError, match="non-deterministic"):
        BaselineGate([THRESHOLD], metrics=gate_input)
