"""Retrieved passages, their provenance, and the assembled context.

The reason these matter to a gate: ``doc_ids`` is what a recall metric compares
against ``expectDocs``, and it de-duplicates. A document that contributed three
passages was found once, so the de-duplication is what makes recall a statement about
documents rather than about chunking.
"""

from __future__ import annotations

from aid_runtime.retrieval import (
    Citation,
    RetrievalResult,
    RetrievedItem,
    assemble_context,
    cite,
)
from retrieval_support import chunk, result


def test_a_citation_is_derived_from_the_chunk_it_names() -> None:
    passage = chunk("guide.md", "hello", index=2, uri="/abs/guide.md")

    citation = cite(passage)

    assert citation.doc_id == "guide.md"
    assert citation.chunk_id == passage.chunk_id
    assert citation.uri == "/abs/guide.md"
    assert citation.index == 2


def test_a_citation_renders_as_its_document_and_position() -> None:
    assert str(cite(chunk("guide.md", "hello", index=2))) == "guide.md#2"


def test_a_result_numbers_its_items_from_one() -> None:
    retrieved = result("q", [chunk("a.md", "one"), chunk("b.md", "two")])

    assert [item.rank for item in retrieved.items] == [1, 2]


def test_a_result_records_the_retriever_and_the_query() -> None:
    retrieved = result("how do I install?", [chunk("a.md", "one")], retriever="docs")

    assert retrieved.retriever == "docs"
    assert retrieved.query == "how do I install?"


def test_top_returns_the_leading_items() -> None:
    retrieved = result("q", [chunk(f"{name}.md", name) for name in ("a", "b", "c")])

    assert [item.citation.doc_id for item in retrieved.top(2)] == ["a.md", "b.md"]
    assert len(retrieved.top(99)) == 3
    assert retrieved.top(0) == ()


def test_an_empty_result_is_a_result() -> None:
    # "The corpus has nothing for this query" is an answer, not an error; a caller
    # that needs a non-empty set says so with a metric, not by crashing here.
    retrieved = result("q", [])

    assert len(retrieved) == 0
    assert retrieved.items == ()
    assert retrieved.context == ""


def test_doc_ids_are_rank_ordered_and_de_duplicated() -> None:
    retrieved = result(
        "q",
        [
            chunk("a.md", "one", index=0),
            chunk("b.md", "two", index=0),
            chunk("a.md", "three", index=1),
        ],
    )

    assert retrieved.doc_ids == ("a.md", "b.md")


def test_citations_are_one_per_item_in_rank_order() -> None:
    retrieved = result("q", [chunk("a.md", "one"), chunk("b.md", "two")])

    assert retrieved.citations == tuple(item.citation for item in retrieved.items)
    assert len(retrieved.citations) == len(retrieved.items)


def test_the_context_numbers_each_excerpt_by_its_rank() -> None:
    retrieved = result("q", [chunk("a.md", "first passage"), chunk("b.md", "second passage")])

    context = retrieved.context

    assert "[1] a.md#0 :: first passage" in context
    assert "[2] b.md#0 :: second passage" in context


def test_an_empty_context_is_empty_rather_than_a_bare_header() -> None:
    # A header with nothing under it reads to a model as "sources were found",
    # which is an invitation to cite something that was never retrieved.
    assert assemble_context(()) == ""


def test_the_context_separator_is_configurable() -> None:
    items = result("q", [chunk("a.md", "one"), chunk("b.md", "two")]).items

    assert assemble_context(items, separator=" | ").count(" | ") == 1


def test_a_hand_built_item_keeps_the_citation_it_was_given() -> None:
    passage = chunk("a.md", "text")
    citation = Citation(doc_id="a.md", chunk_id="other", uri="a.md", index=0)

    item = RetrievedItem(chunk=passage, score=1.0, rank=1, citation=citation)

    assert item.citation.chunk_id == "other"


def test_a_result_is_immutable() -> None:
    retrieved = result("q", [chunk("a.md", "one")])

    assert isinstance(retrieved, RetrievalResult)
    assert retrieved.model_config["frozen"] is True
