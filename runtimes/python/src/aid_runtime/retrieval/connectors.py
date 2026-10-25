"""Reading a ``file`` source.

The IR names five source kinds and Phase 1 implements one. That is the spec
validator's own position ("spec v0.1 indexes a local ``file`` source; the remote
loaders belong to the phase that ships them"), so the other four raise
:class:`~aid_runtime.errors.FeatureDeferredError` here rather than indexing an
empty corpus and looking healthy.

**Document identity is the POSIX path relative to the source root.** That is the
vocabulary the IR's retrieval metric already uses -- its ``expectDocs`` hold
``getting-started.md``, not ``./docs/getting-started.md`` -- and it is
machine-independent, so the same corpus indexed on Windows and on Linux yields the
same ids and the same eval outcome. Absolute paths would make a baseline
non-portable.

The protocol is ``async`` even though the only implementation reads local files
synchronously, because the kinds that follow (``s3``, ``http``, ``db``, ``mcp``) are
genuinely concurrent. Making it sync now would be a breaking change to the seam
exactly when the first real loader arrives.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval.types import SourceKind, SourceSpec

__all__ = [
    "Connector",
    "FileConnector",
    "SourceDocument",
    "open_connector",
]

_RECORD = ConfigDict(frozen=True, extra="forbid")


class SourceDocument(BaseModel):
    """One document read from a source, before chunking."""

    model_config = _RECORD

    #: POSIX path relative to the source root; the document's identity everywhere.
    doc_id: str = Field(min_length=1)
    #: The absolute resolved location, for a human reading a citation. Never matched on.
    uri: str = Field(min_length=1)
    text: str
    metadata: dict[str, str] = Field(default_factory=dict)


@runtime_checkable
class Connector(Protocol):
    """A source that yields documents in a deterministic order."""

    @property
    def kind(self) -> SourceKind: ...

    async def documents(self) -> tuple[SourceDocument, ...]: ...

    async def aclose(self) -> None: ...


class FileConnector:
    """Reads ``*.md``-style files under a local directory.

    Files are read and returned in sorted ``doc_id`` order, never in directory
    order: directory order is a filesystem accident, and a corpus whose chunk ids
    depend on it would reindex itself differently on a different machine.
    """

    def __init__(self, root: str | Path, *, glob: str | None = None) -> None:
        self._root = Path(root)
        if not self._root.exists():
            raise ConfigurationError(f"source path {str(self._root)!r} does not exist")
        if not self._root.is_dir():
            raise ConfigurationError(f"source path {str(self._root)!r} is not a directory")
        self._glob = glob

    @property
    def kind(self) -> SourceKind:
        return SourceKind.FILE

    async def documents(self) -> tuple[SourceDocument, ...]:
        return tuple(self._read(path) for path in self._paths())

    async def aclose(self) -> None:
        return None

    def _paths(self) -> tuple[Path, ...]:
        pattern = self._glob or "**/*"
        found = [
            path
            for path in self._root.glob(pattern)
            if path.is_file() and not path.name.startswith(".")
        ]
        return tuple(sorted(found, key=self._doc_id))

    def _doc_id(self, path: Path) -> str:
        return path.relative_to(self._root).as_posix()

    def _read(self, path: Path) -> SourceDocument:
        doc_id = self._doc_id(path)
        return SourceDocument(
            doc_id=doc_id,
            uri=str(path.resolve()),
            text=path.read_text(encoding="utf-8"),
            metadata={"path": doc_id, "suffix": path.suffix},
        )


def open_connector(spec: SourceSpec, *, base_dir: str | Path | None = None) -> Connector:
    """Open the connector for a source entry.

    ``base_dir`` resolves a relative source ``uri``; it is explicit because the
    runtime has no opinion about a working directory, and a corpus must not depend
    on where a process happened to be started.
    """
    if spec.kind is not SourceKind.FILE:
        raise FeatureDeferredError(
            f"source kind {spec.kind.value!r} is declared but not implemented: spec v0.1 "
            "indexes a local 'file' source, and the remote loaders (s3, http, db, mcp) "
            "belong to the phase that ships them"
        )
    root = Path(spec.uri)
    if not root.is_absolute() and base_dir is not None:
        root = Path(base_dir) / root
    return FileConnector(root, glob=spec.glob)
