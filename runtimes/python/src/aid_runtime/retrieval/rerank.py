"""Reordering a retrieved set before it is returned.

Exactly one reranker exists in Phase 1, and it is lexical. That is a deliberate
limitation rather than an unfinished one: the seam is what this layer owes, and the
deterministic implementation is what lets a gate assert on ranking behaviour without
an API key or a floating cross-encoder.

Why rerank at all when hybrid search already blends two rankings? Because fusion
answers "which candidates are worth considering" and reranking answers "which of
these best answers the question", and the second question can look at the query and
one passage together instead of at ranks alone. The lexical reranker does that with
query-term coverage, which is cheap, explainable, and stable.

The reranker **replaces** each item's score instead of adding a second number. After
reranking, the number that ranks the list is the reranker's, and keeping a fused RRF
value in the same field would put two incomparable scales in one place. Ranks are
renumbered from 1 so ``RetrievalResult.context`` stays resolvable.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval.citations import RetrievedItem, cite
from aid_runtime.retrieval.hybrid import tokenize
from aid_runtime.retrieval.types import RerankSpec

__all__ = [
    "LexicalReranker",
    "Reranker",
    "lexical_score",
    "reranker_for",
]

_LEXICAL_MARKER = "lexical"


def lexical_score(query: str, text: str) -> float:
    """How much of ``query`` the passage actually covers, in ``[0, 1]``.

    Query-term coverage, not term frequency: for "which passages answer this", a
    passage containing each distinct query term once is as good a candidate as one
    repeating a term, and rewarding repetition is how a keyword-stuffed chunk wins.
    An exact phrase match breaks ties toward the passage quoting the query.
    """
    terms = set(tokenize(query))
    if not terms:
        return 0.0
    present = set(tokenize(text))
    coverage = len(terms & present) / len(terms)
    if query.strip() and query.strip().lower() in text.lower():
        # Small and bounded, so it can only order passages that already cover the
        # query equally well; it can never promote an unrelated passage.
        return min(1.0, coverage + 0.1)
    return coverage


@runtime_checkable
class Reranker(Protocol):
    """Reorder candidates for a query, deterministically."""

    @property
    def name(self) -> str: ...

    async def rerank(
        self,
        query: str,
        items: Sequence[RetrievedItem],
        *,
        top_n: int,
    ) -> tuple[RetrievedItem, ...]: ...


class LexicalReranker:
    """Coverage-based reranking, with ties broken on chunk id."""

    def __init__(self, *, name: str = "lexical") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    async def rerank(
        self,
        query: str,
        items: Sequence[RetrievedItem],
        *,
        top_n: int,
    ) -> tuple[RetrievedItem, ...]:
        if top_n < 1:
            raise ConfigurationError("rerank top_n must be at least 1")
        scored = [
            (lexical_score(query, item.chunk.text), item.chunk.chunk_id, item) for item in items
        ]
        # A reranker that cannot read the query leaves the incoming order alone
        # rather than shuffling it: every score is 0.0, so the tie-break would be
        # chunk-id order, which is an arbitrary order dressed up as a decision.
        if all(score == 0.0 for score, _, _ in scored):
            return tuple(items[:top_n])
        scored.sort(key=lambda entry: (-entry[0], entry[1]))
        return tuple(
            RetrievedItem(
                chunk=item.chunk,
                score=score,
                rank=rank,
                citation=cite(item.chunk),
            )
            for rank, (score, _, item) in enumerate(scored[:top_n], start=1)
        )


def reranker_for(spec: RerankSpec | None) -> Reranker | None:
    """The reranker a retriever's ``rerank`` block asks for, if any.

    ``rerank.model`` is free-form in the IR, and Phase 1 ships exactly one
    implementation. A declared model outside the lexical family is refused rather
    than quietly served by :class:`LexicalReranker`, for the same reason an
    unimplemented source kind or store kind is refused: a retriever that appears to
    rerank with a cross-encoder it never called is worse than one that says it
    cannot. The guard matches on the name because the name is the only signal the
    IR gives; the lexical family is what this runtime can honestly claim.
    """
    if spec is None:
        return None
    if _LEXICAL_MARKER not in spec.model.casefold():
        raise FeatureDeferredError(
            f"rerank model {spec.model!r} is declared but not implemented: Phase 1 ships one "
            "deterministic lexical reranker, and a hosted cross-encoder is a later layer"
        )
    return LexicalReranker()
