"""Turning documents into deterministic, size-bounded chunks.

The IR declares a strategy, a size and an overlap; it does not declare the split
algorithm. This module pins one per strategy. Three of them are size-bounded
splitters and differ only in **where a boundary is allowed to fall**:

``fixed``
    Anywhere. The window always fills to ``size``, cutting mid-word when that is
    where the budget ends. This is the honest baseline other strategies improve on.
``recursive``
    Prefer the last paragraph break, then the last line break, then the last
    sentence end, then the last word break inside the window.
``code``
    Prefer the last blank line, then the last line break, then the last statement
    end. Code is line-structured, so a blank line is the closest thing it has to a
    paragraph, and cutting mid-statement is the failure worth avoiding.
``semantic``
    Cut where the text changes topic, measured as a valley in the cosine similarity
    between adjacent *atomic units*. The units come from the same recursive
    hierarchy, so the strategy never invents a boundary inside a paragraph it did
    not have to split; it only chooses which of the existing boundaries to take.

``semantic`` is the one strategy that needs the embedder, so it pays for a boundary
pass: it embeds every atomic unit before it can decide where to cut, and the retriever
embeds the finished chunks afterwards. That is two embedding passes over one source,
not one. The chunker accumulates the boundary pass's :class:`~aid_runtime.types.TokenUsage`
and exposes it as :attr:`Chunker.usage`; :meth:`Retriever.ingest` adds it to the report's
``tokens`` and ``cost_usd`` and charges the same ledger entry the chunk pass uses, so an
ingest report never undercounts the work it caused. The size strategies report a zero
usage because they make no embed calls.

Chunks are pure functions of the text and the embeddings, so the same input always
produces the same chunks with the same ids in the same order -- which is what makes
re-ingesting a corpus a no-op instead of a duplicate.

The seam is ``async`` because a semantic boundary pass embeds, and the embedder is
async. The size strategies have no awaits; making them async changes nothing about
their boundaries, and their existing byte-level tests are the proof.
"""

from __future__ import annotations

import abc
from collections.abc import Sequence
from math import sqrt
from typing import Protocol, runtime_checkable

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval.connectors import SourceDocument
from aid_runtime.retrieval.embedding import Embedder
from aid_runtime.retrieval.types import (
    Chunk,
    ChunkingSpec,
    ChunkingStrategy,
    PinnedEmbedding,
    chunk_id_for,
)
from aid_runtime.types import TokenUsage

__all__ = [
    "Chunker",
    "CodeChunker",
    "FixedChunker",
    "RecursiveChunker",
    "SemanticChunker",
    "chunk_document",
    "chunker_for",
]

#: A boundary found in the first half of a window is ignored and the window is
#: filled to ``size`` instead. Without this, one early paragraph break near the end
#: of a split would produce a stream of very short chunks, and a chunker that emits
#: 5-character chunks is worse than one that cuts a sentence in half.
_MIN_FILL_NUMERATOR = 1
_MIN_FILL_DENOMINATOR = 2

#: Where the semantic strategy cuts: an adjacent-unit cosine similarity below this
#: value, at a local valley, is read as a topic change. 0.72 is a deliberately
#: conservative start. Adjacent sentences in the same paragraph sit well above it
#: (the pinned text-embedding-3-small model puts them around 0.85-0.95), a sentence
#: that starts a new subject sits well below it, and 0.72 leaves room for the drift
#: that a paraphrase introduces. It is one module constant rather than a spec field
#: because the IR does not carry it: a caller that could tune it could silently
#: change every chunk id, and the threshold is a property of the algorithm, not of
#: the application.
SEMANTIC_SIMILARITY_THRESHOLD = 0.72

#: A chunk shorter than ``size`` divided by this is a runt. It is only a *floor*: the
#: chunker merges such a chunk forward when it still can, because a 30-character chunk
#: ranks badly and cites worse. It never splits a unit to reach the floor.
SEMANTIC_MIN_CHUNK_DIVISOR = 4

#: The recursive hierarchy, most semantic first. A unit is split on the first level
#: that yields more than one piece, then each piece is offered the next level, so a
#: paragraph under ``size`` is never split at all.
_SEMANTIC_SEPARATORS: tuple[tuple[str, ...], ...] = (
    ("\n\n",),
    ("\n",),
    (". ", "! ", "? "),
)


def _check_window(size: int, overlap: int) -> None:
    """Reject a window that cannot advance. Shared so both families agree."""
    if size <= 0:
        raise ConfigurationError("chunking size must be positive")
    if overlap < 0:
        raise ConfigurationError("chunking overlap must not be negative")
    if overlap >= size:
        raise ConfigurationError(
            f"chunking overlap {overlap} must be smaller than size {size}; otherwise a "
            "window would not advance and chunking would never terminate"
        )


@runtime_checkable
class Chunker(Protocol):
    """Splits a document into chunks, deterministically."""

    @property
    def strategy(self) -> ChunkingStrategy: ...

    @property
    def usage(self) -> TokenUsage:
        """Tokens the chunker itself spent. Non-zero only for a semantic boundary pass."""
        ...

    async def chunk(self, document: SourceDocument) -> tuple[Chunk, ...]: ...


class _SizeChunker(abc.ABC):
    """Shared windowing. Subclasses only choose where a boundary may fall."""

    def __init__(self, *, size: int, overlap: int, keep_metadata: Sequence[str] = ()) -> None:
        _check_window(size, overlap)
        self._size = size
        self._overlap = overlap
        self._keep = tuple(keep_metadata)

    @property
    @abc.abstractmethod
    def strategy(self) -> ChunkingStrategy: ...

    @property
    def usage(self) -> TokenUsage:
        # A size strategy never calls the embedder, so it has nothing to report. It is
        # a real property rather than an absent one so `chunker.usage` is total.
        return TokenUsage(input_tokens=0, output_tokens=0)

    @abc.abstractmethod
    def _cut(self, text: str, start: int, limit: int) -> int:
        """Where to end the window that starts at ``start`` and may reach ``limit``."""

    async def chunk(self, document: SourceDocument) -> tuple[Chunk, ...]:
        text = document.text
        chunks: list[Chunk] = []
        start = 0
        while start < len(text):
            limit = min(start + self._size, len(text))
            end = limit if limit >= len(text) else self._cut(text, start, limit)
            # A boundary at or before `start` would stall the loop, so progress is
            # guaranteed here rather than trusted from the strategy hook.
            end = max(end, start + 1)
            window = text[start:end]
            if window.strip():
                chunks.append(self._build(document, len(chunks), start, end, window))
            if end >= len(text):
                break
            start = max(end - self._overlap, start + 1)
        return tuple(chunks)

    def _build(
        self, document: SourceDocument, index: int, start: int, end: int, text: str
    ) -> Chunk:
        return _build_chunk(document, index, start, end, text, self._keep)

    def _boundary(self, text: str, start: int, limit: int, markers: Sequence[str]) -> int | None:
        """The end offset of the last ``marker`` in ``text[start:limit]``, if usable.

        ``None`` means "no boundary worth taking", and the caller falls back to
        ``limit``. The minimum-fill rule is applied here rather than by each
        strategy so no strategy can forget it.
        """
        floor = start + (self._size * _MIN_FILL_NUMERATOR) // _MIN_FILL_DENOMINATOR
        window = text[start:limit]
        found: int | None = None
        for marker in markers:
            position = window.rfind(marker)
            if position != -1:
                end = start + position + len(marker)
                if end >= max(floor, start + 1):
                    found = end
                    break
        return found

    def _fill(
        self, text: str, start: int, limit: int, marker_groups: Sequence[Sequence[str]]
    ) -> int:
        """The first usable boundary from ``marker_groups``, in preference order."""
        for markers in marker_groups:
            found = self._boundary(text, start, limit, markers)
            if found is not None:
                return found
        return limit


class FixedChunker(_SizeChunker):
    """Cuts on size alone."""

    @property
    def strategy(self) -> ChunkingStrategy:
        return ChunkingStrategy.FIXED

    def _cut(self, text: str, start: int, limit: int) -> int:
        return limit


class RecursiveChunker(_SizeChunker):
    """Prefers prose boundaries: paragraph, then line, then sentence, then word."""

    @property
    def strategy(self) -> ChunkingStrategy:
        return ChunkingStrategy.RECURSIVE

    def _cut(self, text: str, start: int, limit: int) -> int:
        return self._fill(
            text,
            start,
            limit,
            (("\n\n",), ("\n",), (". ", "! ", "? "), (" ",)),
        )


class CodeChunker(_SizeChunker):
    """Prefers code boundaries: blank line, then line, then statement, then token."""

    @property
    def strategy(self) -> ChunkingStrategy:
        return ChunkingStrategy.CODE

    def _cut(self, text: str, start: int, limit: int) -> int:
        return self._fill(
            text,
            start,
            limit,
            (("\n\n",), ("\n",), (";\n", ";\r\n", "; "), (" ",)),
        )


def _build_chunk(
    document: SourceDocument,
    index: int,
    start: int,
    end: int,
    text: str,
    keep: Sequence[str],
) -> Chunk:
    return Chunk(
        chunk_id=chunk_id_for(document.doc_id, index, text),
        doc_id=document.doc_id,
        uri=document.uri,
        index=index,
        start=start,
        end=end,
        text=text,
        metadata={key: document.metadata[key] for key in keep if key in document.metadata},
    )


def _split_span(
    text: str, start: int, end: int, separators: Sequence[str]
) -> list[tuple[int, int]]:
    """Split ``text[start:end]`` on every ``separators`` hit, keeping the separator.

    The separator stays with the piece it ends, so a unit is always a raw slice of the
    document and joining the pieces back together reproduces the span exactly.
    """
    pieces: list[tuple[int, int]] = []
    cursor = start
    position = start
    while position < end:
        matched = next((item for item in separators if text.startswith(item, position)), None)
        if matched is None:
            position += 1
            continue
        cut = position + len(matched)
        pieces.append((cursor, cut))
        cursor = cut
        position = cut
    if cursor < end:
        pieces.append((cursor, end))
    return pieces


def _split_units(text: str, size: int) -> list[tuple[int, int]]:
    """Atomic units: the recursive hierarchy, hard-cut only when nothing else fits."""
    units: list[tuple[int, int]] = []

    def visit(start: int, end: int, depth: int) -> None:
        if end <= start:
            return
        if end - start <= size:
            if text[start:end].strip():
                units.append((start, end))
            return
        if depth < len(_SEMANTIC_SEPARATORS):
            pieces = _split_span(text, start, end, _SEMANTIC_SEPARATORS[depth])
            if len(pieces) > 1:
                for piece_start, piece_end in pieces:
                    visit(piece_start, piece_end, depth + 1)
                return
            # Nothing at this level separated the span, so try the next level with the
            # same span rather than jumping straight to a hard cut. Falling through
            # here would cut prose with no blank lines mid-word even though it has
            # plenty of line breaks.
            visit(start, end, depth + 1)
            return
        # The bottom of the hierarchy: one word or one very long line, where a hard
        # cut is the only boundary left and `size` bounds it.
        for cut in range(start, end, size):
            visit(cut, min(cut + size, end), len(_SEMANTIC_SEPARATORS))

    visit(0, len(text), 0)
    return units


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = sqrt(sum(a * a for a in left))
    right_norm = sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)


def _is_valley(similarities: Sequence[float], index: int) -> bool:
    """True when the similarity at ``index`` is a local low below the threshold."""
    score = similarities[index]
    if score >= SEMANTIC_SIMILARITY_THRESHOLD:
        return False
    if index > 0 and similarities[index - 1] < score:
        return False
    if index + 1 < len(similarities) and similarities[index + 1] < score:
        return False
    return True


class SemanticChunker:
    """Cuts where adjacent-unit similarity dips, rather than at a fixed size.

    The boundary pass and the chunk pass are separate: this class embeds the atomic
    units to find the boundaries, and :class:`~aid_runtime.retrieval.retriever.Retriever`
    embeds the finished chunks to index them. :attr:`usage` reports the boundary pass
    so the ingest report can account for it.
    """

    def __init__(
        self,
        *,
        size: int,
        overlap: int,
        keep_metadata: Sequence[str] = (),
        embedder: Embedder,
        model: PinnedEmbedding,
    ) -> None:
        _check_window(size, overlap)
        self._size = size
        self._overlap = overlap
        self._keep = tuple(keep_metadata)
        self._embedder = embedder
        self._model = model
        self._usage = TokenUsage(input_tokens=0, output_tokens=0)

    @property
    def strategy(self) -> ChunkingStrategy:
        return ChunkingStrategy.SEMANTIC

    @property
    def usage(self) -> TokenUsage:
        return self._usage

    async def chunk(self, document: SourceDocument) -> tuple[Chunk, ...]:
        text = document.text
        self._usage = TokenUsage(input_tokens=0, output_tokens=0)
        if not text.strip():
            return ()
        units = _split_units(text, self._size)
        if not units:
            return ()
        if len(units) == 1:
            # One unit needs no boundary decision, so the boundary pass is skipped
            # entirely: zero embed calls, and `usage` stays zero.
            start, end = units[0]
            return (_build_chunk(document, 0, start, end, text[start:end], self._keep),)

        batch = await self._embedder.embed(
            [text[start:end] for start, end in units], model=self._model
        )
        self._usage = batch.usage
        vectors = batch.vectors
        similarities = [
            _cosine(vectors[index], vectors[index + 1]) for index in range(len(units) - 1)
        ]
        floor = max(1, self._size // SEMANTIC_MIN_CHUNK_DIVISOR)

        spans: list[tuple[int, int]] = []
        first_unit = 0
        cursor_start = units[0][0]
        for index in range(len(units) - 1):
            next_start, next_end = units[index + 1]
            length = units[index][1] - cursor_start
            overflows = length + (next_end - next_start) > self._size
            dips = length >= floor and _is_valley(similarities, index)
            if not (overflows or dips):
                continue
            spans.append((cursor_start, units[index][1]))
            carried = self._carry(units, first_unit, index, index + 1)
            first_unit = carried[0] if carried else index + 1
            cursor_start = units[first_unit][0]
        spans.append((cursor_start, units[-1][1]))
        spans = _merge_runts(spans, floor, self._size)

        chunks: list[Chunk] = []
        for start, end in spans:
            window = text[start:end]
            if window.strip():
                chunks.append(
                    _build_chunk(document, len(chunks), start, end, window, self._keep)
                )
        return tuple(chunks)

    def _carry(
        self, units: Sequence[tuple[int, int]], first: int, last: int, next_unit: int
    ) -> list[int]:
        """Trailing units of the chunk just emitted that fit inside ``overlap``."""
        carried: list[int] = []
        carried_length = 0
        next_length = units[next_unit][1] - units[next_unit][0]
        index = last
        while index >= first:
            unit_length = units[index][1] - units[index][0]
            if carried_length + unit_length > self._overlap:
                break
            if carried_length + unit_length + next_length > self._size:
                break
            carried.insert(0, index)
            carried_length += unit_length
            index -= 1
        return carried


def _merge_runts(
    spans: list[tuple[int, int]], floor: int, size: int
) -> list[tuple[int, int]]:
    """Fold any chunk shorter than ``floor`` into a neighbour where the result fits.

    A size overflow can leave a short chunk in the middle of a document, not only at
    the end, so this repairs any runt: backward when the previous chunk has room, then
    forward when the next one does. A runt with no room on either side stays as it is,
    because growing it would break the ``size`` cap.
    """
    merged = list(spans)
    index = 0
    while index < len(merged) and len(merged) > 1:
        start, end = merged[index]
        if end - start >= floor:
            index += 1
            continue
        if index > 0 and end - merged[index - 1][0] <= size:
            merged[index - 1] = (merged[index - 1][0], end)
            del merged[index]
            index = max(index - 1, 0)
            continue
        if index + 1 < len(merged) and merged[index + 1][1] - start <= size:
            merged[index] = (start, merged[index + 1][1])
            del merged[index + 1]
            continue
        index += 1
    return merged


_STRATEGIES: dict[ChunkingStrategy, type[_SizeChunker]] = {
    ChunkingStrategy.FIXED: FixedChunker,
    ChunkingStrategy.RECURSIVE: RecursiveChunker,
    ChunkingStrategy.CODE: CodeChunker,
}


def chunker_for(
    spec: ChunkingSpec,
    *,
    embedder: Embedder | None = None,
    model: PinnedEmbedding | None = None,
) -> Chunker:
    """Resolve a chunking block to an implementation.

    ``semantic`` needs the retriever's own embedder and pinned model, because it
    embeds the units to choose a boundary. Nothing here resolves an alias or picks a
    model: the caller passes the pin the index already uses. An unknown strategy is
    still refused, because the runtime is reachable from generated code the validator
    never saw.
    """
    if spec.strategy is ChunkingStrategy.SEMANTIC:
        if embedder is None or model is None:
            raise ConfigurationError(
                "semantic chunking needs the retriever's embedder and pinned model; pass both "
                "to chunker_for rather than letting the runtime choose one"
            )
        return SemanticChunker(
            size=spec.size,
            overlap=spec.overlap,
            keep_metadata=spec.keep_metadata,
            embedder=embedder,
            model=model,
        )
    implementation = _STRATEGIES.get(spec.strategy)
    if implementation is None:
        raise FeatureDeferredError(
            f"chunking strategy {spec.strategy.value!r} is declared but not implemented: fixed, "
            "recursive, code and semantic are the strategies this runtime chunks with"
        )
    return implementation(size=spec.size, overlap=spec.overlap, keep_metadata=spec.keep_metadata)


async def chunk_document(
    document: SourceDocument,
    spec: ChunkingSpec,
    *,
    embedder: Embedder | None = None,
    model: PinnedEmbedding | None = None,
) -> tuple[Chunk, ...]:
    """Chunk one document with the strategy the spec names."""
    chunker = chunker_for(spec, embedder=embedder, model=model)
    return await chunker.chunk(document)
