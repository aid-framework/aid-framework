"""Lexical scoring and rank fusion.

BM25 is asserted against a hand-computed value rather than a snapshot, because the
number is the contract: the same scoring has to apply to both store adapters, and a
snapshot would happily record a change that made one store rank differently from the
other. With two documents of equal length and a term in one of them, the IDF is
``log(2)`` and the saturation and normalisation factors both cancel to 1.
"""

from __future__ import annotations

import math

import pytest

from aid_runtime.retrieval import (
    RankedId,
    bm25_scores,
    fuse,
    lexical_ranking,
    rrf_score,
    tokenize,
)


def test_tokenising_lowercases_and_keeps_alphanumeric_runs() -> None:
    assert tokenize("Hello, World-2 (HTTP_500)!") == ("hello", "world", "2", "http", "500")


def test_tokenising_drops_punctuation_only_input() -> None:
    assert tokenize("-- ... ??") == ()


def test_a_term_in_one_of_two_equal_documents_scores_the_idf() -> None:
    scores = bm25_scores(["alpha", "beta"], "alpha")

    assert scores[0] == pytest.approx(math.log(2.0))
    assert scores[1] == 0.0


def test_document_order_is_preserved() -> None:
    scores = bm25_scores(["beta", "alpha"], "alpha")

    assert scores[1] == pytest.approx(math.log(2.0))
    assert scores[0] == 0.0


def test_a_rarer_term_is_worth_more_than_a_common_one() -> None:
    documents = ["alpha beta", "alpha gamma", "alpha delta", "alpha epsilon"]

    common = bm25_scores(documents, "alpha")[0]
    rare = bm25_scores(documents, "beta")[0]

    assert rare > common


def test_repeating_a_term_is_saturated_rather_than_proportional() -> None:
    once = bm25_scores(["alpha"], "alpha")[0]
    thrice = bm25_scores(["alpha alpha alpha"], "alpha")[0]

    assert once < thrice < 3 * once


def test_a_longer_document_scores_lower_for_the_same_term_frequency() -> None:
    short = bm25_scores(["alpha", "alpha beta gamma delta epsilon zeta"], "alpha")

    assert short[0] > short[1]


def test_a_query_with_no_terms_scores_everything_at_zero() -> None:
    assert bm25_scores(["alpha beta", "gamma"], "!!") == (0.0, 0.0)


def test_an_empty_corpus_scores_nothing() -> None:
    assert bm25_scores([], "alpha") == ()


def test_the_ranking_drops_documents_the_query_does_not_touch() -> None:
    ranked = lexical_ranking(["alpha here", "unrelated"], ["a", "b"], "alpha", top_k=10)

    assert [entry.chunk_id for entry in ranked] == ["a"]


def test_the_ranking_respects_top_k() -> None:
    documents = [f"alpha {index}" for index in range(5)]
    ids = [f"c{index}" for index in range(5)]

    ranked = lexical_ranking(documents, ids, "alpha", top_k=2)

    assert len(ranked) == 2


def test_equal_scores_rank_by_chunk_id() -> None:
    # Equal-scoring matches have to rank identically on every run and in both store
    # adapters, so the tie-break cannot be dict or database order.
    ranked = lexical_ranking(["alpha", "alpha"], ["b", "a"], "alpha", top_k=10)

    assert [entry.chunk_id for entry in ranked] == ["a", "b"]


def test_the_ranking_returns_ranked_ids_with_positive_scores() -> None:
    (first, *rest) = lexical_ranking(["alpha"], ["a"], "alpha", top_k=10)

    assert not rest
    assert isinstance(first, RankedId)
    assert first.score > 0.0


def test_the_ranking_refuses_non_parallel_sequences() -> None:
    with pytest.raises(ValueError, match="parallel"):
        lexical_ranking(["alpha", "beta"], ["only-one"], "alpha", top_k=10)


def test_a_reciprocal_rank_contribution_is_one_over_k_plus_rank() -> None:
    assert rrf_score(1) == pytest.approx(1.0 / 61.0)
    assert rrf_score(2) == pytest.approx(1.0 / 62.0)
    assert rrf_score(1, k=1) == pytest.approx(0.5)


def test_a_rank_is_one_based() -> None:
    with pytest.raises(ValueError, match="1-based"):
        rrf_score(0)


def test_a_rank_high_in_one_listing_beats_a_rank_low_in_it() -> None:
    (top, second) = fuse([["a", "b"]])

    assert top.chunk_id == "a"
    assert second.chunk_id == "b"
    assert top.score > second.score


def test_agreement_between_two_rankings_outweighs_a_single_first_place() -> None:
    # "b" is second and first; "a" is first in only one listing. Agreement is
    # evidence, and this is the property that makes fusion worth doing at all.
    fused = fuse([["a", "b"], ["b"]])

    assert [entry.chunk_id for entry in fused] == ["b", "a"]
    assert fused[0].score == pytest.approx(1.0 / 62.0 + 1.0 / 61.0)
    assert fused[1].score == pytest.approx(1.0 / 61.0)


def test_an_id_absent_from_a_ranking_gains_nothing_from_it() -> None:
    fused = fuse([["a"], ["b"]])

    scores = {entry.chunk_id: entry.score for entry in fused}

    assert scores["a"] == pytest.approx(1.0 / 61.0)
    assert scores["b"] == pytest.approx(1.0 / 61.0)


def test_fusing_nothing_yields_nothing() -> None:
    assert fuse([]) == ()


def test_fusing_equal_rankings_of_nothing_yields_nothing() -> None:
    assert fuse([[], []]) == ()


def test_fusion_weighs_the_rank_contributions_rather_than_the_placement() -> None:
    # A second place in both listings (2/62) is narrowly beaten by a first place in
    # one and a third in the other (1/61 + 1/63). That is RRF behaving as designed
    # rather than a tie-break quirk, so the exact order is worth pinning.
    fused = fuse([["a", "b", "c"], ["c", "b"]])

    assert [entry.chunk_id for entry in fused] == ["c", "b", "a"]
    assert fused[0].score == pytest.approx(1.0 / 63.0 + 1.0 / 61.0)
    assert fused[1].score == pytest.approx(2.0 / 62.0)
    assert fused[2].score == pytest.approx(1.0 / 61.0)
