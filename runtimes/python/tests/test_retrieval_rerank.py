"""The one deterministic reranker, and the refusal of the ones it is not.

Two decisions are pinned here. First, a reranker *replaces* each item's score rather
than adding a second number, because after reranking the number that orders the list
is the reranker's, and leaving a fused RRF value in the same field would put two
incomparable scales in one place. Second, when the reranker cannot read the query at
all it leaves the incoming order alone rather than shuffling it -- every score is
then 0.0, so the tie-break would impose chunk-id order and dress an arbitrary choice
up as a decision.
"""

from __future__ import annotations

import pytest

from aid_runtime import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval import (
    LexicalReranker,
    Reranker,
    RerankSpec,
    RetrievedItem,
    lexical_score,
    reranker_for,
)
from retrieval_support import chunk, result


def items_of(*texts: str) -> tuple[RetrievedItem, ...]:
    return result("q", [chunk(f"{index}.md", text) for index, text in enumerate(texts)]).items


def test_coverage_is_the_share_of_query_terms_the_passage_contains() -> None:
    assert lexical_score("alpha beta", "alpha gamma") == pytest.approx(0.5)
    assert lexical_score("alpha beta", "gamma delta") == 0.0
    assert lexical_score("alpha beta", "alpha beta gamma") == 1.0


def test_a_query_with_no_terms_scores_nothing() -> None:
    assert lexical_score("", "anything") == 0.0
    assert lexical_score("?? --", "anything") == 0.0


def test_coverage_never_exceeds_one() -> None:
    # The phrase bonus is bounded for exactly this reason: it can only order
    # passages that already cover the query equally well, so it can never promote an
    # unrelated passage above a relevant one.
    assert lexical_score("alpha", "alpha") == 1.0
    assert lexical_score("alpha", "alpha alpha alpha") == 1.0


async def test_a_covering_passage_outranks_a_partial_one() -> None:
    reranked = await LexicalReranker().rerank(
        "alpha beta", items_of("alpha gamma", "alpha beta"), top_n=2
    )

    assert [item.chunk.text for item in reranked] == ["alpha beta", "alpha gamma"]


async def test_ranks_are_renumbered_from_one() -> None:
    reranked = await LexicalReranker().rerank("alpha", items_of("nothing here", "alpha"), top_n=2)

    assert [item.rank for item in reranked] == [1, 2]


async def test_the_score_becomes_the_rerankers_own() -> None:
    (first, *_) = await LexicalReranker().rerank("alpha beta", items_of("alpha beta"), top_n=1)

    assert first.score == pytest.approx(1.0)


async def test_the_citation_still_matches_the_passage() -> None:
    (first, *_) = await LexicalReranker().rerank("alpha", items_of("alpha"), top_n=1)

    assert first.citation.doc_id == first.chunk.doc_id
    assert first.citation.chunk_id == first.chunk.chunk_id


async def test_an_unreadable_query_leaves_the_incoming_order_alone() -> None:
    incoming = items_of("one", "two", "three")

    reranked = await LexicalReranker().rerank("", incoming, top_n=3)

    assert [item.chunk.text for item in reranked] == ["one", "two", "three"]


async def test_top_n_truncates_after_reordering() -> None:
    reranked = await LexicalReranker().rerank(
        "alpha", items_of("nothing", "alpha", "also alpha"), top_n=1
    )

    assert len(reranked) == 1
    assert reranked[0].chunk.text == "alpha"


async def test_top_n_beyond_the_candidates_returns_them_all() -> None:
    reranked = await LexicalReranker().rerank("alpha", items_of("alpha"), top_n=50)

    assert len(reranked) == 1


async def test_reranking_nothing_yields_nothing() -> None:
    assert await LexicalReranker().rerank("alpha", (), top_n=3) == ()


async def test_a_top_n_below_one_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="top_n"):
        await LexicalReranker().rerank("alpha", items_of("alpha"), top_n=0)


async def test_equal_scores_rank_by_chunk_id() -> None:
    incoming = result("q", [chunk("b.md", "alpha"), chunk("a.md", "alpha")]).items

    reranked = await LexicalReranker().rerank("alpha", incoming, top_n=2)

    assert [item.chunk.chunk_id for item in reranked] == sorted(
        item.chunk.chunk_id for item in incoming
    )


def test_the_default_name_is_lexical() -> None:
    assert LexicalReranker().name == "lexical"


def test_the_name_can_be_overridden() -> None:
    assert LexicalReranker(name="lexical-v2").name == "lexical-v2"


def test_the_reranker_satisfies_the_protocol() -> None:
    assert isinstance(LexicalReranker(), Reranker)


def test_no_rerank_block_asks_for_no_reranker() -> None:
    assert reranker_for(None) is None


def test_a_lexical_rerank_block_gets_the_lexical_reranker() -> None:
    resolved = reranker_for(RerankSpec(model="fake-lexical-rerank", topN=3))

    assert isinstance(resolved, LexicalReranker)


def test_the_lexical_family_is_matched_case_insensitively() -> None:
    assert isinstance(reranker_for(RerankSpec(model="LEXICAL-2", topN=3)), LexicalReranker)


def test_a_hosted_cross_encoder_is_refused_rather_than_silently_served() -> None:
    # A retriever that appears to rerank with a cross-encoder it never called is
    # worse than one that says it cannot: the later layer is not this one.
    with pytest.raises(FeatureDeferredError, match="not implemented"):
        reranker_for(RerankSpec(model="cohere-rerank-3", topN=3))


def test_the_refusal_names_the_declared_model() -> None:
    with pytest.raises(FeatureDeferredError, match="cohere-rerank-3"):
        reranker_for(RerankSpec(model="cohere-rerank-3", topN=3))
