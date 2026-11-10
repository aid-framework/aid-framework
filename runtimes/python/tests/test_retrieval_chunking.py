"""The implemented chunking strategies.

The load-bearing assertions are the coverage ones: a chunker that drops a sentence
produces a corpus that retrieves nothing for a query that should have matched, and
the loss stays invisible until someone asks exactly the right question. So these
check the spans against the source text rather than only counting chunks.

The boundary-preference tests use deliberately contrived strings. That is the point:
each one isolates a single step of a marker preference list, which no realistic prose
sample would distinguish on its own.

`semantic` is tested against a fake embedder whose vectors the test chooses, so the
similarity valleys are deliberate rather than a property of a hash.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from itertools import pairwise

import pytest

from aid_runtime import ConfigurationError
from aid_runtime.retrieval import (
    Chunk,
    Chunker,
    ChunkingSpec,
    ChunkingStrategy,
    CodeChunker,
    EmbeddingBatch,
    FixedChunker,
    PinnedEmbedding,
    RecursiveChunker,
    chunk_document,
    chunk_id_for,
    chunker_for,
    estimate_tokens,
)
from aid_runtime.retrieval.chunking import _split_units
from aid_runtime.types import TokenUsage
from retrieval_support import document, pinned

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


async def chunks_of(text: str, spec: ChunkingSpec) -> tuple[Chunk, ...]:
    return await chunk_document(document("a.md", text), spec)


def spec_for(strategy: ChunkingStrategy, *, size: int = 80, overlap: int = 0) -> ChunkingSpec:
    return ChunkingSpec(strategy=strategy, size=size, overlap=overlap, keepMetadata=())


@pytest.mark.parametrize("strategy", STRATEGIES)
async def test_every_strategy_covers_the_whole_document(strategy: ChunkingStrategy) -> None:
    produced = await chunks_of(DENSE, spec_for(strategy, size=80))

    assert produced[0].start == 0
    assert produced[-1].end == len(DENSE)
    assert all(earlier.end == later.start for earlier, later in pairwise(produced))


@pytest.mark.parametrize("strategy", STRATEGIES)
async def test_every_strategy_numbers_its_chunks_from_zero(strategy: ChunkingStrategy) -> None:
    produced = await chunks_of(PROSE, spec_for(strategy, size=80))

    assert [item.index for item in produced] == list(range(len(produced)))


@pytest.mark.parametrize("strategy", STRATEGIES)
async def test_every_strategy_derives_the_id_from_the_content(strategy: ChunkingStrategy) -> None:
    produced = await chunks_of(PROSE, spec_for(strategy, size=80))

    for item in produced:
        assert item.chunk_id == chunk_id_for("a.md", item.index, item.text)


@pytest.mark.parametrize("strategy", STRATEGIES)
async def test_every_strategy_bounds_the_chunk_by_the_size(strategy: ChunkingStrategy) -> None:
    produced = await chunks_of(DENSE, spec_for(strategy, size=40))

    assert all(len(item.text) <= 40 for item in produced)


@pytest.mark.parametrize("strategy", STRATEGIES)
async def test_no_chunk_is_only_whitespace(strategy: ChunkingStrategy) -> None:
    produced = await chunks_of(PROSE, spec_for(strategy, size=40))

    assert all(item.text.strip() for item in produced)


@pytest.mark.parametrize("strategy", STRATEGIES)
async def test_a_chunk_carries_the_document_identity_and_its_span(
    strategy: ChunkingStrategy,
) -> None:
    produced = await chunks_of(DENSE, spec_for(strategy, size=80))

    for item in produced:
        assert item.doc_id == "a.md"
        assert item.text == DENSE[item.start : item.end]


async def test_fixed_chunking_fills_the_window_and_so_cuts_mid_token() -> None:
    # Documented as the honest baseline the other two improve on: with a fixed
    # window the budget, not the language, decides where a chunk ends. A size of 42
    # is not a multiple of the token stride, so the cut lands inside a token.
    produced = await chunks_of(DENSE, spec_for(ChunkingStrategy.FIXED, size=42))

    assert len(produced[0].text) == 42
    assert produced[0].text == DENSE[:42]
    assert not produced[0].text.endswith(" ")


async def test_fixed_chunking_with_overlap_backs_the_next_window_up() -> None:
    produced = await chunks_of(DENSE, spec_for(ChunkingStrategy.FIXED, size=40, overlap=10))

    assert produced[1].start == produced[0].end - 10


async def test_no_overlap_makes_the_spans_disjoint() -> None:
    produced = await chunks_of(DENSE, spec_for(ChunkingStrategy.FIXED, size=40))

    assert all(earlier.end == later.start for earlier, later in pairwise(produced))


async def test_recursive_chunking_prefers_a_paragraph_break_to_the_budget() -> None:
    # The blank line sits at offset 50, inside a 80-character window whose second
    # half starts at 40, so it is usable and takes precedence over the budget.
    text = "a" * 50 + "\n\n" + "b" * 200

    produced = await chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert produced[0].end == 52
    assert produced[0].text == "a" * 50 + "\n\n"


async def test_code_chunking_honours_the_same_paragraph_break() -> None:
    text = "a" * 50 + "\n\n" + "b" * 200

    produced = await chunks_of(text, spec_for(ChunkingStrategy.CODE, size=80))

    assert produced[0].end == 52


async def test_recursive_chunking_falls_back_to_a_sentence_end() -> None:
    # No blank line and no line break in the window, so the sentence marker is the
    # first usable boundary; without it the window would cut at the budget of 80.
    text = "a" * 50 + ". " + "b" * 200

    produced = await chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert produced[0].end == 52


async def test_code_chunking_prefers_a_statement_end_over_a_word_break() -> None:
    # Two spaces are usable in the window: the one inside "; " at offset 41, and
    # another at offset 52. Prose would take the later one; code takes the
    # statement end, which is the difference between the two strategies.
    text = "a" * 40 + "; " + "b" * 10 + " " + "c" * 30

    code = await chunks_of(text, spec_for(ChunkingStrategy.CODE, size=80))
    prose = await chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert code[0].end == 42
    assert prose[0].end == 53


async def test_a_boundary_in_the_first_half_is_rejected_for_the_budget() -> None:
    # A blank line at offset 10 is too early to be worth taking: honouring it would
    # emit a stream of very short chunks instead of one full window.
    text = "a" * 10 + "\n\n" + "b" * 200

    produced = await chunks_of(text, spec_for(ChunkingStrategy.RECURSIVE, size=80))

    assert produced[0].end == 80


async def test_a_smaller_size_yields_at_least_as_many_chunks() -> None:
    coarse = await chunks_of(PROSE, spec_for(ChunkingStrategy.RECURSIVE, size=200))
    fine = await chunks_of(PROSE, spec_for(ChunkingStrategy.RECURSIVE, size=60))

    assert len(fine) >= len(coarse)


async def test_an_empty_document_yields_no_chunks() -> None:
    assert await chunks_of("", spec_for(ChunkingStrategy.FIXED, size=40)) == ()


async def test_a_document_shorter_than_the_size_is_one_chunk() -> None:
    produced = await chunks_of("short text", spec_for(ChunkingStrategy.FIXED, size=800))

    assert len(produced) == 1
    assert produced[0].text == "short text"


@pytest.mark.parametrize("keep", [("path",), ("suffix",), ("path", "suffix")])
async def test_keep_metadata_copies_the_named_document_fields(keep: tuple[str, ...]) -> None:
    spec = ChunkingSpec(strategy=ChunkingStrategy.FIXED, size=800, overlap=0, keepMetadata=keep)
    source = document("a.md", "hello", metadata={"path": "a.md", "suffix": ".md"})

    produced = await chunk_document(source, spec)

    assert produced[0].metadata == {name: source.metadata[name] for name in keep}


async def test_without_keep_metadata_a_chunk_carries_none() -> None:
    source = document("a.md", "hello", metadata={"path": "a.md"})

    produced = await chunk_document(source, spec_for(ChunkingStrategy.FIXED, size=800))

    assert produced[0].metadata == {}


async def test_keep_metadata_naming_an_absent_field_does_not_invent_a_value() -> None:
    spec = ChunkingSpec(
        strategy=ChunkingStrategy.FIXED, size=800, overlap=0, keepMetadata=("absent",)
    )

    produced = await chunk_document(document("a.md", "hello", metadata={"path": "a.md"}), spec)

    assert produced[0].metadata == {}


def test_chunker_for_builds_the_strategy_that_was_declared() -> None:
    assert isinstance(chunker_for(spec_for(ChunkingStrategy.FIXED)), FixedChunker)
    assert isinstance(chunker_for(spec_for(ChunkingStrategy.RECURSIVE)), RecursiveChunker)
    assert isinstance(chunker_for(spec_for(ChunkingStrategy.CODE)), CodeChunker)


def test_a_built_chunker_satisfies_the_protocol_and_reports_its_strategy() -> None:
    chunker = chunker_for(spec_for(ChunkingStrategy.RECURSIVE))

    assert isinstance(chunker, Chunker)
    assert chunker.strategy is ChunkingStrategy.RECURSIVE


def test_semantic_chunking_is_refused_without_the_retrievers_embedder() -> None:
    with pytest.raises(ConfigurationError, match="embedder"):
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


# --------------------------------------------------------------------------------------
# Semantic chunking
# --------------------------------------------------------------------------------------

MODEL = pinned()

FOUR_SENTENCES = "alpha one. beta two. gamma three. delta four."


class VectorEmbedder:
    """An embedder whose vectors the test chooses, so similarity valleys are deliberate."""

    name = "vector-embedder"

    def __init__(self, vector: Callable[[str], Sequence[float]]) -> None:
        self._vector = vector
        self.calls = 0
        self.input_tokens = 0

    async def embed(self, texts: Sequence[str], *, model: PinnedEmbedding) -> EmbeddingBatch:
        del model
        self.calls += 1
        input_tokens = sum(estimate_tokens(text) for text in texts)
        self.input_tokens += input_tokens
        return EmbeddingBatch(
            vectors=tuple(tuple(self._vector(text)) for text in texts),
            usage=TokenUsage(input_tokens=input_tokens, output_tokens=0),
        )

    async def aclose(self) -> None:
        return None


def two_topics(text: str) -> tuple[float, ...]:
    """Alpha/beta land on one axis, gamma/delta on the other."""
    return (1.0, 0.0) if text.startswith(("alpha", "beta")) else (0.0, 1.0)


def one_topic(text: str) -> tuple[float, ...]:
    del text
    return (1.0, 0.0)


async def semantic_chunks(
    text: str,
    embedder: VectorEmbedder,
    *,
    size: int = 40,
    overlap: int = 0,
) -> tuple[Chunk, ...]:
    chunker = chunker_for(
        spec_for(ChunkingStrategy.SEMANTIC, size=size, overlap=overlap),
        embedder=embedder,
        model=MODEL,
    )
    return await chunker.chunk(document("a.md", text))


async def test_semantic_cuts_where_the_similarity_dips() -> None:
    produced = await semantic_chunks(FOUR_SENTENCES, VectorEmbedder(two_topics))

    assert [item.text for item in produced] == [
        "alpha one. beta two. ",
        "gamma three. delta four.",
    ]


async def test_semantic_keeps_a_document_with_no_dip_in_one_chunk() -> None:
    produced = await semantic_chunks(FOUR_SENTENCES, VectorEmbedder(one_topic), size=800)

    assert len(produced) == 1
    assert produced[0].text == FOUR_SENTENCES


async def test_semantic_bounds_every_chunk_by_the_size() -> None:
    produced = await semantic_chunks(DENSE, VectorEmbedder(one_topic), size=40)

    assert produced
    assert all(len(item.text) <= 40 for item in produced)


async def test_semantic_carries_the_previous_units_for_the_overlap() -> None:
    produced = await semantic_chunks(FOUR_SENTENCES, VectorEmbedder(two_topics), overlap=10)

    assert produced[1].start < produced[0].end
    assert produced[1].text.startswith("beta two. ")


@pytest.mark.parametrize("text", ["", "   \n\n\t "])
async def test_semantic_makes_an_empty_document_zero_chunks_and_zero_embeds(text: str) -> None:
    embedder = VectorEmbedder(two_topics)

    assert await semantic_chunks(text, embedder) == ()
    assert embedder.calls == 0


async def test_semantic_single_unit_is_one_chunk_and_embeds_nothing() -> None:
    embedder = VectorEmbedder(two_topics)

    produced = await semantic_chunks("one short sentence", embedder, size=800)

    assert len(produced) == 1
    assert produced[0].text == "one short sentence"
    assert embedder.calls == 0


async def test_semantic_ids_are_deterministic_across_runs() -> None:
    first = await semantic_chunks(FOUR_SENTENCES, VectorEmbedder(two_topics))
    second = await semantic_chunks(FOUR_SENTENCES, VectorEmbedder(two_topics))

    assert [item.chunk_id for item in second] == [item.chunk_id for item in first]
    assert [item.text for item in second] == [item.text for item in first]
    assert all(item.chunk_id == chunk_id_for("a.md", item.index, item.text) for item in first)


async def test_semantic_reports_the_boundary_pass_usage() -> None:
    embedder = VectorEmbedder(two_topics)
    chunker = chunker_for(
        spec_for(ChunkingStrategy.SEMANTIC, size=40), embedder=embedder, model=MODEL
    )

    await chunker.chunk(document("a.md", FOUR_SENTENCES))

    assert chunker.usage.input_tokens > 0
    assert chunker.usage.input_tokens == embedder.input_tokens


def test_semantic_units_of_a_paragraph_split_on_newlines_not_mid_word() -> None:
    # The span has no blank lines, so the paragraph level yields one piece; falling
    # through to the hard cut there would slice words, even though the line breaks
    # are an available boundary.
    text = "".join(f"line {index} of prose\n" for index in range(20))

    units = _split_units(text, 64)

    assert len(units) > 1
    for start, end in units:
        assert len(text[start:end]) <= 64
        assert text[start:end].endswith("\n")
