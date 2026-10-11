"""Metrics over a retrieved set.

The shipped :class:`~aid_runtime.evals.metrics.Metric` scores ``(case, prediction:
str)``. That signature cannot express these metrics: recall@k and MRR score a *ranked
set of passages with provenance*, and a citation-grounding score has to look at where
each passage came from. Encoding a retrieved set into one string would make every
metric re-parse it, and the parse would become the thing under test.

So the retrieval metrics get their own protocol here rather than widening the shipped
one. Widening ``Metric`` would change the meaning of an interface the eval gate
already threshold-checks, and would do so for every existing implementation. The new
protocol is additive and reuses :class:`~aid_runtime.evals.metrics.MetricResult`.

The two protocols share the part the gate actually consumes -- ``name`` and
``deterministic`` -- which is what lets retrieval metrics be handed to the shipped
gate's ``metrics=`` parameter. See :mod:`aid_runtime.retrieval.gate` for why that
hand-off needs a cast and why the cast is sound.

``deterministic`` is ``True`` for all three, and that is a claim the gate enforces:
none of these metrics calls a model, and every tie is broken by chunk id, so the same
retrieved set always scores the same.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.evals.metrics import MetricResult
from aid_runtime.retrieval.citations import RetrievalResult
from aid_runtime.retrieval.types import RetrievalMetricSpec

__all__ = [
    "CitationGrounding",
    "MeanReciprocalRank",
    "RecallAtK",
    "RetrievalCase",
    "RetrievalMetric",
    "retrieval_metrics",
]


class RetrievalCase(BaseModel):
    """One retrieval question and the documents that should answer it.

    This mirrors the IR's ``retrieval`` metric node field for field, and it exists
    because :class:`~aid_runtime.evals.dataset.EvalCase` carries ``metadata:
    dict[str, str]`` -- a string map, which cannot hold ``expectDocs`` without
    inventing an encoding. The expected documents, and ``k``, are what a retrieval
    metric needs, so they are typed here instead of smuggled through a string.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(min_length=1)
    query: str
    expect_docs: tuple[str, ...] = Field(min_length=1)
    k: int = Field(gt=0)

    @classmethod
    def from_spec(cls, *, case_id: str, query: str, spec: RetrievalMetricSpec) -> RetrievalCase:
        """Build a case from the IR's ``{kind, expectDocs, k}`` node."""
        return cls(id=case_id, query=query, expect_docs=spec.expect_docs, k=spec.k)


@runtime_checkable
class RetrievalMetric(Protocol):
    """Scores a ranked, cited retrieved set.

    ``name`` and ``deterministic`` are part of the contract because the shipped gate
    reads exactly those two properties when it checks that a thresholded metric is
    allowed to gate CI.
    """

    @property
    def name(self) -> str: ...

    @property
    def deterministic(self) -> bool: ...

    async def score(self, case: RetrievalCase, retrieved: RetrievalResult) -> MetricResult: ...


class RecallAtK:
    """Fraction of expected documents present in the top ``k``.

    Duplicated passages do not inflate the score: :attr:`RetrievalResult.doc_ids` is
    de-duplicated, so a document that contributed three passages counts once. Recall
    is about which documents were found.
    """

    def __init__(self, *, name: str = "recall@k", min_score: float = 1.0) -> None:
        self._name = name
        self._min_score = min_score

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(self, case: RetrievalCase, retrieved: RetrievalResult) -> MetricResult:
        expected = set(case.expect_docs)
        found = expected & set(retrieved.doc_ids[: case.k])
        score = len(found) / len(expected)
        missing = sorted(expected - found)
        return MetricResult(
            metric=self.name,
            score=score,
            passed=score >= self._min_score,
            detail="" if not missing else f"missing: {', '.join(missing)}",
        )


class MeanReciprocalRank:
    """Reciprocal rank of the first expected document, averaged over cases.

    Scored per case, so the "mean" is taken by the gate across cases and runs. One
    number per case keeps the metric a drop-in for the gate's per-case arithmetic.
    """

    def __init__(self, *, name: str = "mrr", min_score: float = 0.5) -> None:
        self._name = name
        self._min_score = min_score

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(self, case: RetrievalCase, retrieved: RetrievalResult) -> MetricResult:
        expected = set(case.expect_docs)
        for rank, doc_id in enumerate(retrieved.doc_ids[: case.k], start=1):
            if doc_id in expected:
                score = 1.0 / rank
                return MetricResult(
                    metric=self.name,
                    score=score,
                    passed=score >= self._min_score,
                    detail=f"first expected document {doc_id!r} at rank {rank}",
                )
        return MetricResult(
            metric=self.name,
            score=0.0,
            passed=self._min_score <= 0.0,
            detail=f"none of {', '.join(sorted(expected))} were retrieved within k={case.k}",
        )


class CitationGrounding:
    """Fraction of expected documents that a returned item cites *correctly*.

    Distinct from recall because it scores citations rather than document ids, and
    because it checks integrity first: a citation whose ``chunk_id`` or ``doc_id``
    disagrees with the passage it is attached to is worse than a missing citation,
    since it sends a reader to the wrong place while looking authoritative. Any
    such mismatch scores 0 regardless of what was retrieved.

    This definition is authored here: the IR has no citation metric kind, so there is
    no upstream semantics to match. It is stated rather than derived.
    """

    def __init__(self, *, name: str = "citation-grounding", min_score: float = 1.0) -> None:
        self._name = name
        self._min_score = min_score

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(self, case: RetrievalCase, retrieved: RetrievalResult) -> MetricResult:
        broken = [
            item
            for item in retrieved.items
            if item.citation.chunk_id != item.chunk.chunk_id
            or item.citation.doc_id != item.chunk.doc_id
        ]
        if broken:
            return MetricResult(
                metric=self.name,
                score=0.0,
                passed=False,
                detail=(
                    f"{len(broken)} citation(s) disagree with the passage they name, "
                    f"first: {broken[0].citation} vs chunk {broken[0].chunk.chunk_id}"
                ),
            )
        expected = set(case.expect_docs)
        cited = {item.citation.doc_id for item in retrieved.items}
        grounded = expected & cited
        score = len(grounded) / len(expected)
        missing = sorted(expected - grounded)
        return MetricResult(
            metric=self.name,
            score=score,
            passed=score >= self._min_score,
            detail="" if not missing else f"uncited: {', '.join(missing)}",
        )


def retrieval_metrics() -> tuple[RetrievalMetric, ...]:
    """The retrieval metrics this runtime ships, in a stable order."""
    return (RecallAtK(), MeanReciprocalRank(), CitationGrounding())
