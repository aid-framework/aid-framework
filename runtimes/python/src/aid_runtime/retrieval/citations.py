"""Retrieved passages, their provenance, and the context they assemble into.

A retrieved set is only useful to a model if the passages arrive with provenance
the model can repeat back, so ranking and citation are one type here rather than
a search result plus a separate lookup table. :class:`RetrievalResult` is the
runtime's answer type: it is what a ``retrieve`` step produces and what every
retrieval metric scores.

The assembled context is numbered by **rank**, not by position in the tuple. The
two are the same in practice because ranks are assigned contiguously from 1, but
naming the rank is what makes a model's ``[2]`` resolvable by the caller without
re-running the search.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.retrieval.types import Chunk

__all__ = [
    "Citation",
    "RetrievalResult",
    "RetrievedItem",
    "assemble_context",
    "cite",
]

_RECORD = ConfigDict(frozen=True, extra="forbid")


class Citation(BaseModel):
    """Where one retrieved passage came from.

    ``doc_id`` is the document identity the IR's retrieval metric already uses
    (``expectDocs: [getting-started.md]``), so a citation and a gate expectation
    are the same vocabulary rather than two spellings of the same thing.
    """

    model_config = _RECORD

    doc_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    uri: str = ""
    index: int = Field(ge=0)

    def __str__(self) -> str:
        return f"{self.doc_id}#{self.index}"


class RetrievedItem(BaseModel):
    """One ranked passage: the chunk, its score, and its provenance."""

    model_config = _RECORD

    chunk: Chunk
    score: float
    rank: int = Field(ge=1)
    citation: Citation


class RetrievalResult(BaseModel):
    """What a ``retrieve`` step returns.

    ``items`` is rank-ordered and may be empty -- "the corpus has nothing for this
    query" is a result, not an error, and a caller that needs a non-empty answer
    says so with a metric rather than by crashing.
    """

    model_config = _RECORD

    retriever: str = Field(min_length=1)
    query: str
    items: tuple[RetrievedItem, ...] = ()

    def __len__(self) -> int:
        return len(self.items)

    def top(self, k: int) -> tuple[RetrievedItem, ...]:
        """The first ``k`` items, or all of them when the result is shorter."""
        return self.items[:k]

    @property
    def context(self) -> str:
        """The numbered excerpts a prompt binds."""
        return assemble_context(self.items)

    @property
    def citations(self) -> tuple[Citation, ...]:
        """One citation per item, in rank order."""
        return tuple(item.citation for item in self.items)

    @property
    def doc_ids(self) -> tuple[str, ...]:
        """Rank-ordered, de-duplicated document ids.

        De-duplicated because recall is about *documents found*, and a document
        that contributed three passages was found once. First occurrence wins, so
        the order still reflects relevance.
        """
        return tuple(dict.fromkeys(item.citation.doc_id for item in self.items))


def cite(chunk: Chunk) -> Citation:
    """The citation for a chunk.

    Derived from the chunk rather than passed alongside it, so a citation cannot
    drift from the passage it names.
    """
    return Citation(
        doc_id=chunk.doc_id,
        chunk_id=chunk.chunk_id,
        uri=chunk.uri,
        index=chunk.index,
    )


def assemble_context(items: Sequence[RetrievedItem], *, separator: str = "\n\n") -> str:
    """Render ranked items as numbered excerpts, each tagged with its citation.

    An empty retrieval renders as the empty string rather than as a header with
    nothing under it: a header alone reads to a model as "sources were found", and
    a prompt that invites a model to invent a source is worse than an empty prompt.
    """
    return separator.join(f"[{item.rank}] {item.citation} :: {item.chunk.text}" for item in items)
