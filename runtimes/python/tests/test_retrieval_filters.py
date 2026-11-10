"""Filter expressions: the grammar, its evaluation, and its place in retrieval.

The grammar is pinned deliberately narrow, so the accept/reject table is the
specification. Two behaviours are worth stating where a reader will look for them:

* a field the chunk does not carry matches **nothing**, including under ``!=``, because
  absence is not a value and treating it as one widens a selector;
* filtering happens in the retriever, not in the store, and the hybrid lexical half
  reads the same filtered corpus -- otherwise a filtered-out passage could re-enter
  through BM25.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from aid_runtime import ConfigurationError
from aid_runtime.retrieval import (
    FILTER_OPERATORS,
    FakeDeterministicEmbedder,
    Filter,
    InMemoryVectorStore,
    Retriever,
    SearchHit,
    compile_filters,
    matches,
    matches_all,
    parse_filter,
)
from aid_runtime.retrieval.types import DistanceMetric
from retrieval_support import binding, chunk, document

# --------------------------------------------------------------------------- grammar


def test_every_declared_operator_round_trips() -> None:
    assert FILTER_OPERATORS == ("==", "!=", "^=", "$=", "*=")
    for operator in FILTER_OPERATORS:
        parsed = parse_filter(f"tenant {operator} acme")
        assert parsed == Filter(field="tenant", operator=operator, value="acme")


def test_a_value_may_be_double_or_single_quoted() -> None:
    assert parse_filter('path == "a/b c"').value == "a/b c"
    assert parse_filter("path == 'a/b c'").value == "a/b c"


def test_quotes_are_only_stripped_when_they_pair() -> None:
    # A value that merely starts with a quote has no closing quote, which is a typo
    # rather than a value containing one.
    with pytest.raises(ConfigurationError, match="does not close it"):
        parse_filter('path == "unterminated')


@pytest.mark.parametrize(
    "expression",
    [
        "tenant",  # no operator
        "tenant = acme",  # single '=' is not an operator
        "tenant == ",  # empty value
        "tenant ==",
        "== acme",  # no field
        "tenant ~= acme",  # unsupported operator
    ],
)
def test_malformed_expressions_are_refused_with_the_grammar(expression: str) -> None:
    with pytest.raises(ConfigurationError):
        parse_filter(expression)


def test_a_malformed_expression_lists_the_operators() -> None:
    with pytest.raises(ConfigurationError) as raised:
        parse_filter("tenant = acme")
    for operator in FILTER_OPERATORS:
        assert operator in str(raised.value)


def test_metadata_keys_may_contain_dots_and_hyphens() -> None:
    assert parse_filter("classification.level-2 == internal").field == "classification.level-2"


# ------------------------------------------------------------------------ evaluation


def test_equality_is_exact_and_case_sensitive() -> None:
    compiled = compile_filters(['tenant == "Acme"'])
    assert matches_all(chunk("a", "text", metadata={"tenant": "Acme"}), compiled)
    assert not matches_all(chunk("a", "text", metadata={"tenant": "acme"}), compiled)


def test_the_five_operators_differ_on_the_same_value() -> None:
    subject = chunk("a", "text", metadata={"path": "docs/guide.md"})
    assert matches(subject, parse_filter("path == docs/guide.md"))
    assert matches(subject, parse_filter("path != docs/other.md"))
    assert matches(subject, parse_filter("path ^= docs/"))
    assert matches(subject, parse_filter("path $= .md"))
    assert matches(subject, parse_filter("path *= guide"))
    assert not matches(subject, parse_filter("path ^= guide"))
    assert not matches(subject, parse_filter("path $= guide"))
    assert not matches(subject, parse_filter("path *= other"))


def test_a_missing_field_never_matches_even_under_not_equal() -> None:
    # This is the security-relevant rule: `tenant != other` on a chunk with no tenant
    # must not admit the chunk, because that would turn a selector into a bypass.
    subject = chunk("a", "text", metadata={})
    for operator in FILTER_OPERATORS:
        assert not matches(subject, parse_filter(f"tenant {operator} acme"))


def test_doc_id_and_uri_are_resolved_from_the_chunk_not_the_metadata() -> None:
    subject = chunk("doc-1", "text", uri="s3://bucket/key.md", metadata={"doc_id": "shadowed"})
    assert matches(subject, parse_filter("doc_id == doc-1"))
    assert matches(subject, parse_filter("uri == s3://bucket/key.md"))
    assert not matches(subject, parse_filter("doc_id == shadowed"))


def test_metadata_may_not_shadow_the_reserved_fields() -> None:
    # A document can carry any metadata, so pinning precedence keeps a corpus from
    # choosing which identity the filter sees.
    subject = chunk("doc-1", "text", uri="real.md", metadata={"uri": "forged.md"})
    assert matches(subject, parse_filter("uri == real.md"))
    assert not matches(subject, parse_filter("uri == forged.md"))


def test_entries_are_anded() -> None:
    subject = chunk("a", "text", metadata={"tenant": "acme", "tier": "gold"})
    assert matches_all(subject, compile_filters(["tenant == acme", "tier == gold"]))
    assert not matches_all(subject, compile_filters(["tenant == acme", "tier == silver"]))


def test_an_empty_filter_list_admits_everything() -> None:
    assert matches_all(chunk("a", "text"), ())
    assert compile_filters([]) == ()


# --------------------------------------------------------------------- in retrieval


def make_retriever(
    *,
    filters: Sequence[str] | None = None,
    hybrid: bool = False,
    top_k: int = 3,
    store: InMemoryVectorStore | None = None,
) -> Retriever:
    return Retriever(
        binding(filters=filters, hybrid=hybrid, top_k=top_k, size=2000),
        embedder=FakeDeterministicEmbedder(),
        store=store or InMemoryVectorStore(),
    )


class OrderedStore(InMemoryVectorStore):
    """Returns insertion order, so a test can place a filtered-out chunk first."""

    def __init__(self) -> None:
        super().__init__()
        self.limits: list[int] = []

    async def search(
        self, vector: Sequence[float], *, top_k: int, metric: DistanceMetric
    ) -> tuple[SearchHit, ...]:
        self.limits.append(top_k)
        hits = [SearchHit(record=record, score=1.0) for record in self._records.values()]
        return tuple(hits[:top_k])


async def test_a_filter_narrows_the_result() -> None:
    retriever = make_retriever(filters=['tenant == "acme"'])
    await retriever.ingest(
        [
            document("ours.md", "alpha", metadata={"tenant": "acme"}),
            document("theirs.md", "alpha alpha", metadata={"tenant": "other"}),
        ]
    )

    result = await retriever.retrieve("alpha")

    assert [item.chunk.doc_id for item in result.items] == ["ours.md"]


async def test_a_filter_matching_nothing_yields_an_empty_result() -> None:
    retriever = make_retriever(filters=['tenant == "absent"'])
    await retriever.ingest([document("a.md", "alpha", metadata={"tenant": "acme"})])

    result = await retriever.retrieve("alpha")

    assert result.items == ()


async def test_a_selective_filter_widens_the_search_until_it_can_fill_top_k() -> None:
    store = OrderedStore()
    retriever = make_retriever(filters=['tenant == "acme"'], top_k=1, store=store)
    await retriever.ingest(
        [
            document(f"other-{index}.md", f"text {index}", metadata={"tenant": "other"})
            for index in range(4)
        ]
        + [document("ours.md", "text ours", metadata={"tenant": "acme"})]
    )

    result = await retriever.retrieve("text")

    # 1 * candidate_factor (4) misses, then doubles past the five-record corpus.
    assert store.limits == [4, 8]
    assert [item.chunk.doc_id for item in result.items] == ["ours.md"]


async def test_hybrid_lexical_ranking_cannot_reintroduce_a_filtered_out_chunk() -> None:
    # The lexical half reads the whole corpus, which is exactly where a leak would
    # come from: the disallowed document matches the query far more strongly.
    retriever = make_retriever(filters=['tenant == "acme"'], hybrid=True, top_k=2)
    await retriever.ingest(
        [
            document("ours.md", "alpha", metadata={"tenant": "acme"}),
            document("theirs.md", "alpha alpha alpha alpha", metadata={"tenant": "other"}),
        ]
    )

    result = await retriever.retrieve("alpha")

    assert [item.chunk.doc_id for item in result.items] == ["ours.md"]


async def test_an_unfiltered_retriever_search_does_not_widen() -> None:
    store = OrderedStore()
    retriever = make_retriever(top_k=1, store=store)
    await retriever.ingest([document(f"{index}.md", f"text {index}") for index in range(4)])

    await retriever.retrieve("text")

    assert store.limits == [4]


def test_a_malformed_filter_fails_at_construction() -> None:
    # Configuration faults should surface where the configuration is read, not on the
    # first query after a successful deploy.
    with pytest.raises(ConfigurationError, match="operators are"):
        make_retriever(filters=["tenant = acme"])


async def test_filters_do_not_change_the_result_without_matches_among_them() -> None:
    # A filter every chunk satisfies must be invisible: same docs, same order, same
    # scores as the unfiltered run.
    texts = [("a.md", "alpha beta"), ("b.md", "gamma delta"), ("c.md", "epsilon")]
    plain = make_retriever(top_k=3)
    filtered = make_retriever(filters=['tier == "gold"'], top_k=3)
    for retriever in (plain, filtered):
        await retriever.ingest(
            [document(name, text, metadata={"tier": "gold"}) for name, text in texts]
        )

    unfiltered = await plain.retrieve("alpha")
    narrowed = await filtered.retrieve("alpha")

    assert [(item.chunk.doc_id, item.score) for item in narrowed.items] == [
        (item.chunk.doc_id, item.score) for item in unfiltered.items
    ]
