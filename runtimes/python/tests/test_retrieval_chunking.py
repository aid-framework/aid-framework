"""The three implemented chunking strategies.

The load-bearing assertions are the coverage ones: a chunker that drops a sentence
produces a corpus that retrieves nothing for a query that should have matched, and
the loss stays invisible until someone asks exactly the right question. So these
check the spans against the source text rather than only counting chunks.

The boundary-preference tests use deliberately contrived strings. That is the point:
each one isolates a single step of a marker preference list, which no realistic prose
sample would distinguish on its own.
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from aid_runtime import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval import (
    Chunk,
    Chunker,
    ChunkingSpec,
    ChunkingStrategy,
    CodeChunker,
    FixedChunker,
    RecursiveChunker,
    chunk_document,
    chunk_id_for,
    chunker_for,
)
from retrieval_support import document

#: Dense prose with no blank lines and no trailing whitespace: every fixed-size
#: window has content, so window skipping cannot make spans look non-contiguous.
DENSE = " ".join(f"w{index:03d}" for index in range(200))

PROSE = (
    "Retrieval augments a prompt with passages the model never saw during training.\n\n"
    "A retriever embeds the query and the corpus into one vector space, then ranks by "
    "similarity.\n\n"
    "Chunking decides what a passage is, and it is the choice most likely to decide "
    "whether retrieval works at all.\n\n"
    "Citations are what let a model's answer be checked against the source it names.\n"
)

STRATEGIES = [ChunkingStrategy.FIXED, ChunkingStrategy.RECURSIVE, ChunkingStrategy.CODE]


def chunks_of(text: str, spec: ChunkingSpec) -> tuple[Chunk, ...]:
    return chunk_document(document("a.md", text), spec)


def spec_for(strategy: ChunkingStrategy, *, size: int = 80, overlap: int = 0) -> ChunkingSpec:
    return ChunkingSpec(strategy=strategy, size=size, overlap=overlap, keepMetadata=())


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_strategy_covers_the_whole_document(strategy: ChunkingStrategy) -> None:
    produced = chunks_of(DENSE, spec_for(strategy, size=80))

    assert produced[0].start == 0
    assert produced[-1].end == len(DENSE)
    assert all(earlier.end == later.start for earlier, later in pairwise(produced))


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_strategy_numbers_its_chunks_from_zero(strategy: ChunkingStrategy) -> None:
    produced = chunks_of(PROSE, spec_for(strategy, size=80))

    assert [item.index for item in produced] == list(range(len(produced)))


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_strategy_derives_the_id_from_the_content(strategy: ChunkingStrategy) -> None:
    produced = chunks_of(PROSE, spec_for(strategy, size=80))

    for item in produced:
        assert item.chunk_id == chunk_id_for("a.md", item.index, item.text)


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_strategy_bounds_the_chunk_by_the_size(strategy: ChunkingStrategy) -> None:
    produced = chunks_of(DENSE, spec_for(strategy, size=40))

    assert all(len(item.text) <= 40 for item in produced)


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_no_chunk_is_only_whitespace(strategy: ChunkingStrategy) -> None:
    produced = chunks_of(PROSE, spec_for(strategy, size=40))

    assert all(item.text.strip() for item in produced)


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_a_chunk_carries_the_document_identity_and_its_span(strategy: ChunkingStrategy) -> None:
    produced = chunks_of(DENSE, spec_for(strategy, size=80))

    for item in produced:
        assert item.doc_id == "a.md"
        assert item.text == DENSE[item.start : item.end]


def test_fixed_chunking_fills_the_window_and_so_cuts_mid_token() -> None:
    # Documented as the honest baseline the other two improve on: with a fixed
    # window the budget, not the language, decides where a chunk ends. A size of 42
    # is not a multiple of the token stride, so the cut lands inside a token.
    produced = chunks_of(DENSE, spec_for(ChunkingStrategy.FIXED, size=42))

    assert len(produced[0].text) == 42
    assert produced[0].text == DENSE[:42]
    assert not produced[0].text.endswith(" ")


def test_fixed_chunking_with_overlap_backs_the_next_window_up() -> None:
    produced = chunks_of(DENSE, spec_for(ChunkingStrategy.FIXED, size=40, overlap=10))

    assert produced[1].start == produced[0].end - 10


def test_no_overlap_makes_the_spans_disjoint() -> None:
    produced = chunks_of(DENSE, spec_for(ChunkingStrategy.FIXED, size=40))

    assert all(earlier.end == later.start for earlier, later in pairwise(produced))


def test_recursive_chunking_prefers_a_paragraph_break_to_the_budget() -> None:
    # The blank line sits at offset 50, inside a 80-character window whose second
    # half starts at 40, so it is usable and takes precedence over the budget.
    text = "a" * 50 + "\n\n" + "b" * 200

    produced = chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert produced[0].end == 52
    assert produced[0].text == "a" * 50 + "\n\n"


def test_code_chunking_honours_the_same_paragraph_break() -> None:
    text = "a" * 50 + "\n\n" + "b" * 200

    produced = chunks_of(text, spec_for(ChunkingStrategy.CODE, size=80))

    assert produced[0].end == 52


def test_recursive_chunking_falls_back_to_a_sentence_end() -> None:
    # No blank line and no line break in the window, so the sentence marker is the
    # first usable boundary; without it the window would cut at the budget of 80.
    text = "a" * 50 + ". " + "b" * 200

    produced = chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert produced[0].end == 52


def test_code_chunking_prefers_a_statement_end_over_a_word_break() -> None:
    # Two spaces are usable in the window: the one inside "; " at offset 41, and
    # another at offset 52. Prose would take the later one; code takes the
    # statement end, which is the difference between the two strategies.
    text = "a" * 40 + "; " + "b" * 10 + " " + "c" * 30

    code = chunks_of(text, spec_for(ChunkingStrategy.CODE, size=80))
    prose = chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert code[0].end == 42
    assert prose[0].end == 53


def test_a_boundary_in_the_first_half_is_rejected_for_the_budget() -> None:
    # A blank line at offset 10 is too early to be worth taking: honouring it would
    # emit a stream of very short chunks instead of one full window.
    text = "a" * 10 + "\n\n" + "b" * 200

    produced = chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert produced[0].end == 80


def test_a_smaller_size_yields_at_least_as_many_chunks() -> None:
    coarse = chunks_of(PROSE, spec_for(ChunkingStrategy.RECURSIVE, size=200))
    fine = chunks_of(PROSE, spec_for(ChunkingStrategy.RECURSIVE, size=60))

    assert len(fine) >= len(coarse)


def test_an_empty_document_yields_no_chunks() -> None:
    assert chunks_of("", spec_for(ChunkingStrategy.FIXED, size=40)) == ()


def test_a_document_shorter_than_the_size_is_one_chunk() -> None:
    produced = chunks_of("short text", spec_for(ChunkingStrategy.FIXED, size=800))

    assert len(produced) == 1
    assert produced[0].text == "short text"


@pytest.mark.parametrize("keep", [("path",), ("suffix",), ("path", "suffix")])
def test_keep_metadata_copies_the_named_document_fields(keep: tuple[str, ...]) -> None:
    spec = ChunkingSpec(strategy=ChunkingStrategy.FIXED, size=800, overlap=0, keepMetadata=keep)
    source = document("a.md", "hello", metadata={"path": "a.md", "suffix": ".md"})

    produced = chunk_document(source, spec)

    assert produced[0].metadata == {name: source.metadata[name] for name in keep}


def test_without_keep_metadata_a_chunk_carries_none() -> None:
    source = document("a.md", "hello", metadata={"path": "a.md"})

    produced = chunk_document(source, spec_for(ChunkingStrategy.FIXED, size=800))

    assert produced[0].metadata == {}


def test_keep_metadata_naming_an_absent_field_does_not_invent_a_value() -> None:
    spec = ChunkingSpec(
        strategy=ChunkingStrategy.FIXED, size=800, overlap=0, keepMetadata=("absent",)
    )

    produced = chunk_document(document("a.md", "hello", metadata={"path": "a.md"}), spec)

    assert produced[0].metadata == {}


def test_chunker_for_builds_the_strategy_that_was_declared() -> None:
    assert isinstance(chunker_for(spec_for(ChunkingStrategy.FIXED)), FixedChunker)
    assert isinstance(chunker_for(spec_for(ChunkingStrategy.RECURSIVE)), RecursiveChunker)
    assert isinstance(chunker_for(spec_for(ChunkingStrategy.CODE)), CodeChunker)


def test_a_built_chunker_satisfies_the_protocol_and_reports_its_strategy() -> None:
    chunker = chunker_for(spec_for(ChunkingStrategy.RECURSIVE))

    assert isinstance(chunker, Chunker)
    assert chunker.strategy is ChunkingStrategy.RECURSIVE


def test_semantic_chunking_is_deferred_not_approximated() -> None:
    with pytest.raises(FeatureDeferredError, match="semantic"):
        chunker_for(spec_for(ChunkingStrategy.SEMANTIC))


@pytest.mark.parametrize("size", [0, -1])
def test_a_non_positive_size_is_refused(size: int) -> None:
    with pytest.raises(ConfigurationError, match="size must be positive"):
        FixedChunker(size=size, overlap=0)


def test_a_negative_overlap_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="overlap must not be negative"):
        FixedChunker(size=40, overlap=-1)


def test_an_overlap_at_the_size_would_not_advance_and_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="smaller than size"):
        FixedChunker(size=40, overlap=40)
