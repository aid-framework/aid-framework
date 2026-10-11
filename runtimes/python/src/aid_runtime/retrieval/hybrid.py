"""Lexical scoring and rank fusion.

Vector similarity cannot carry retrieval on its own, and the reason is not
aesthetic: cosine similarity is dominated by embedding geometry while exact terms --
an identifier, an error code, a flag name -- are what a developer actually greps for.
So a retriever fuses a vector ranking with a lexical one.

The lexical half is BM25, implemented here rather than delegated to a search engine
so that the same scoring applies to both store adapters and to a store that has no
database behind it.

The fusion is Reciprocal Rank Fusion, and it fuses *ranks* rather than scores. That
is the whole reason to pick it: BM25 scores and cosine similarities are unbounded and
on incomparable scales, so any weighted score sum would need a per-corpus
normalisation constant that nobody can justify. Ranks are already comparable, and
RRF's ``1 / (k + rank)`` says something defensible -- being ranked highly by either
retriever is evidence, being ranked highly by both is stronger evidence.

Everything here is a pure function of its inputs, so retrieval order is reproducible
and a re-ingested corpus ranks identically.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "RankedId",
    "bm25_scores",
    "fuse",
    "lexical_ranking",
    "rrf_score",
    "tokenize",
]

#: The RRF constant from the original formulation: it damps the influence of the
#: very top ranks so one retriever's confident first hit cannot alone decide the
#: fused order.
_RRF_K = 60

#: BM25 saturation and length-normalisation. The usual defaults, and defaults are
#: the right call here: they are tuned against judged-relevance corpora, and this
#: runtime has no such corpus to tune against.
_BM25_K1 = 1.5
_BM25_B = 0.75

_TOKEN = re.compile(r"[a-z0-9]+")


class RankedId(BaseModel):
    """A ranked chunk id and the score that ranked it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    chunk_id: str = Field(min_length=1)
    score: float


def tokenize(text: str) -> tuple[str, ...]:
    """Lowercase alphanumeric runs.

    No stemming and no stop-word list: both are language-specific, and a retrieval
    runtime that silently mangles identifiers by stemming them is worse at its
    actual job than one that keeps the tokens it was given.
    """
    return tuple(_TOKEN.findall(text.lower()))


def bm25_scores(
    documents: Sequence[str],
    query: str,
    *,
    k1: float = _BM25_K1,
    b: float = _BM25_B,
) -> tuple[float, ...]:
    """BM25 score of every document for ``query``, in the order given.

    Saturated term frequency (a term repeated ten times is not ten times as
    informative) and length normalisation (a long chunk should not win merely by
    containing more words) -- those two properties are the reason to use BM25 rather
    than a raw term count.
    """
    tokenised = [tokenize(document) for document in documents]
    terms = tokenize(query)
    if not tokenised or not terms:
        return tuple(0.0 for _ in documents)

    total = len(tokenised)
    lengths = [len(tokens) for tokens in tokenised]
    average_length = sum(lengths) / total
    counts = [Counter(tokens) for tokens in tokenised]

    scores: list[float] = []
    for index, frequencies in enumerate(counts):
        length = lengths[index]
        score = 0.0
        for term in terms:
            frequency = frequencies.get(term, 0)
            if frequency == 0:
                continue
            document_frequency = sum(1 for other in counts if term in other)
            inverse_frequency = math.log(
                1.0 + (total - document_frequency + 0.5) / (document_frequency + 0.5)
            )
            norm = 1.0 - b + b * (length / average_length) if average_length else 1.0
            score += inverse_frequency * (frequency * (k1 + 1.0)) / (frequency + k1 * norm)
        scores.append(score)
    return tuple(scores)


def lexical_ranking(
    documents: Sequence[str],
    ids: Sequence[str],
    query: str,
    *,
    top_k: int,
) -> tuple[RankedId, ...]:
    """The ``top_k`` documents with a non-zero lexical score, best first.

    Ties break on chunk id so that equal-scoring matches rank identically on every
    run and in both store adapters.
    """
    if len(documents) != len(ids):
        raise ValueError("documents and ids must be parallel sequences")
    scored = [
        RankedId(chunk_id=chunk_id, score=score)
        for chunk_id, score in zip(ids, bm25_scores(documents, query), strict=True)
        if score > 0.0
    ]
    scored.sort(key=lambda entry: (-entry.score, entry.chunk_id))
    return tuple(scored[:top_k])


def rrf_score(rank: int, *, k: int = _RRF_K) -> float:
    """The reciprocal-rank contribution of a 1-based ``rank``."""
    if rank < 1:
        raise ValueError("rank is 1-based")
    return 1.0 / (k + rank)


def fuse(
    rankings: Sequence[Sequence[str]],
    *,
    k: int = _RRF_K,
) -> tuple[RankedId, ...]:
    """Reciprocal Rank Fusion of rank-ordered id lists.

    Each ranking contributes ``1 / (k + rank)`` per id; an id absent from a ranking
    contributes nothing from it. An id that appears in several rankings therefore
    outranks one that is top of a single ranking, which is the behaviour that makes
    fusion worth doing.
    """
    totals: dict[str, float] = {}
    for ranking in rankings:
        for rank, chunk_id in enumerate(ranking, start=1):
            totals[chunk_id] = totals.get(chunk_id, 0.0) + rrf_score(rank, k=k)
    fused = [RankedId(chunk_id=chunk_id, score=score) for chunk_id, score in totals.items()]
    fused.sort(key=lambda entry: (-entry.score, entry.chunk_id))
    return tuple(fused)
