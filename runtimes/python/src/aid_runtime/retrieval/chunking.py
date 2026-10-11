"""Turning documents into deterministic, size-bounded chunks.

The IR declares a strategy, a size and an overlap; it does not declare the split
algorithm. This module pins one, and the pin is the spec validator's own reading
of the intent: *"spec v0.1 chunks by size (fixed, recursive, code)"*. ``semantic``
is refused because it needs an embedding pass over the whole source at ingest --
a different shape of job, not a different boundary rule.

So all three implemented strategies are size-bounded splitters and the only thing
that distinguishes them is **where a boundary is allowed to fall**:

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

Chunks are pure functions of the text, so the same input always produces the same
chunks with the same ids in the same order -- which is what makes re-ingesting a
corpus a no-op instead of a duplicate.
"""

from __future__ import annotations

import abc
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval.connectors import SourceDocument
from aid_runtime.retrieval.types import Chunk, ChunkingSpec, ChunkingStrategy, chunk_id_for

__all__ = [
    "Chunker",
    "CodeChunker",
    "FixedChunker",
    "RecursiveChunker",
    "chunk_document",
    "chunker_for",
]

#: A boundary found in the first half of a window is ignored and the window is
#: filled to ``size`` instead. Without this, one early paragraph break near the end
#: of a split would produce a stream of very short chunks, and a chunker that emits
#: 5-character chunks is worse than one that cuts a sentence in half.
_MIN_FILL_NUMERATOR = 1
_MIN_FILL_DENOMINATOR = 2


@runtime_checkable
class Chunker(Protocol):
    """Splits a document into chunks, deterministically."""

    @property
    def strategy(self) -> ChunkingStrategy: ...

    def chunk(self, document: SourceDocument) -> tuple[Chunk, ...]: ...


class _SizeChunker(abc.ABC):
    """Shared windowing. Subclasses only choose where a boundary may fall."""

    def __init__(self, *, size: int, overlap: int, keep_metadata: Sequence[str] = ()) -> None:
        if size <= 0:
            raise ConfigurationError("chunking size must be positive")
        if overlap < 0:
            raise ConfigurationError("chunking overlap must not be negative")
        if overlap >= size:
            raise ConfigurationError(
                f"chunking overlap {overlap} must be smaller than size {size}; otherwise a "
                "window would not advance and chunking would never terminate"
            )
        self._size = size
        self._overlap = overlap
        self._keep = tuple(keep_metadata)

    @property
    @abc.abstractmethod
    def strategy(self) -> ChunkingStrategy: ...

    @abc.abstractmethod
    def _cut(self, text: str, start: int, limit: int) -> int:
        """Where to end the window that starts at ``start`` and may reach ``limit``."""

    def chunk(self, document: SourceDocument) -> tuple[Chunk, ...]:
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
        return Chunk(
            chunk_id=chunk_id_for(document.doc_id, index, text),
            doc_id=document.doc_id,
            uri=document.uri,
            index=index,
            start=start,
            end=end,
            text=text,
            metadata={
                key: document.metadata[key] for key in self._keep if key in document.metadata
            },
        )

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


_STRATEGIES: dict[ChunkingStrategy, type[_SizeChunker]] = {
    ChunkingStrategy.FIXED: FixedChunker,
    ChunkingStrategy.RECURSIVE: RecursiveChunker,
    ChunkingStrategy.CODE: CodeChunker,
}


def chunker_for(spec: ChunkingSpec) -> Chunker:
    """Resolve a chunking block to an implementation.

    ``semantic`` is refused here as well as in the spec validator, because the
    runtime is reachable from generated code the validator never saw.
    """
    implementation = _STRATEGIES.get(spec.strategy)
    if implementation is None:
        raise FeatureDeferredError(
            f"chunking strategy {spec.strategy.value!r} is declared but not implemented: spec "
            "v0.1 chunks by size (fixed, recursive, code), and semantic chunking needs an "
            "embedding pass over the whole source at ingest"
        )
    return implementation(size=spec.size, overlap=spec.overlap, keep_metadata=spec.keep_metadata)


def chunk_document(document: SourceDocument, spec: ChunkingSpec) -> tuple[Chunk, ...]:
    """Chunk one document with the strategy the spec names."""
    return chunker_for(spec).chunk(document)
