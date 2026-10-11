"""Reading a ``file`` source, and refusing the kinds Phase 1 does not ship.

Document identity is the component most worth pinning down here: the IR's
retrieval metric writes ``expectDocs: [getting-started.md]``, so a connector that
reported ``./docs/getting-started.md`` or a Windows path would make every citation
and every gate expectation miss.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aid_runtime import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval import (
    Connector,
    FileConnector,
    SourceKind,
    SourceSpec,
    open_connector,
)
from retrieval_support import write_docs

CORPUS = {
    "getting-started.md": "# Getting started\n\nInstall the CLI.\n",
    "reference/api.md": "# API\n\nThe API is stable.\n",
}


async def test_documents_are_read_in_sorted_document_id_order(tmp_path: Path) -> None:
    root = write_docs(tmp_path, CORPUS)

    documents = await FileConnector(root).documents()

    assert [item.doc_id for item in documents] == ["getting-started.md", "reference/api.md"]


async def test_the_document_id_is_the_posix_path_relative_to_the_root(tmp_path: Path) -> None:
    root = write_docs(tmp_path, CORPUS)

    documents = await FileConnector(root).documents()

    # Not the absolute path and not a platform path: the id has to read the same on
    # Windows and on Linux, or a stored baseline stops comparing across machines.
    assert documents[1].doc_id == "reference/api.md"
    assert "\\" not in documents[1].doc_id
    assert Path(documents[1].uri).is_absolute()
    assert documents[1].uri != documents[1].doc_id


async def test_a_document_carries_its_text_and_some_provenance(tmp_path: Path) -> None:
    root = write_docs(tmp_path, {"a.md": "hello\n"})

    (paper,) = await FileConnector(root).documents()

    assert paper.text == "hello\n"
    assert paper.metadata == {"path": "a.md", "suffix": ".md"}


async def test_a_glob_selects_the_corpus(tmp_path: Path) -> None:
    root = write_docs(tmp_path, {**CORPUS, "notes.txt": "scratch\n"})

    documents = await FileConnector(root, glob="**/*.md").documents()

    assert [item.doc_id for item in documents] == ["getting-started.md", "reference/api.md"]


async def test_the_default_glob_reads_everything(tmp_path: Path) -> None:
    root = write_docs(tmp_path, {"a.md": "a\n", "b.txt": "b\n"})

    documents = await FileConnector(root).documents()

    assert [item.doc_id for item in documents] == ["a.md", "b.txt"]


async def test_a_dotfile_is_left_alone(tmp_path: Path) -> None:
    root = write_docs(tmp_path, {"a.md": "a\n", ".hidden.md": "secret\n"})

    documents = await FileConnector(root).documents()

    # Files are filtered by name, which is what the implementation promises; a file
    # inside a dot *directory* is not claimed to be excluded, so none is asserted on.
    assert [item.doc_id for item in documents] == ["a.md"]


def test_a_missing_source_path_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="does not exist"):
        FileConnector(tmp_path / "absent")


def test_a_source_path_that_is_a_file_is_refused(tmp_path: Path) -> None:
    root = write_docs(tmp_path, {"a.md": "a\n"})

    with pytest.raises(ConfigurationError, match="not a directory"):
        FileConnector(root / "a.md")


async def test_a_source_with_no_matching_files_yields_nothing(tmp_path: Path) -> None:
    root = write_docs(tmp_path, {"a.txt": "a\n"})

    assert await FileConnector(root, glob="**/*.md").documents() == ()


async def test_closing_a_file_connector_is_harmless() -> None:
    connector = FileConnector(Path())

    await connector.aclose()
    await connector.aclose()


def test_a_file_connector_satisfies_the_protocol(tmp_path: Path) -> None:
    connector = FileConnector(write_docs(tmp_path, {"a.md": "a\n"}))

    assert isinstance(connector, Connector)
    assert connector.kind is SourceKind.FILE


async def test_open_connector_resolves_a_relative_uri_against_the_base_directory(
    tmp_path: Path,
) -> None:
    write_docs(tmp_path / "docs", {"a.md": "a\n"})

    connector = open_connector(SourceSpec(kind=SourceKind.FILE, uri="./docs"), base_dir=tmp_path)

    assert [item.doc_id for item in await connector.documents()] == ["a.md"]


async def test_open_connector_ignores_the_base_directory_for_an_absolute_uri(
    tmp_path: Path,
) -> None:
    root = write_docs(tmp_path / "docs", {"a.md": "a\n"})

    connector = open_connector(
        SourceSpec(kind=SourceKind.FILE, uri=str(root)), base_dir=tmp_path / "elsewhere"
    )

    assert [item.doc_id for item in await connector.documents()] == ["a.md"]


async def test_open_connector_passes_the_glob_through(tmp_path: Path) -> None:
    write_docs(tmp_path, {"a.md": "a\n", "b.txt": "b\n"})

    connector = open_connector(
        SourceSpec(kind=SourceKind.FILE, uri=".", glob="**/*.md"), base_dir=tmp_path
    )

    assert [item.doc_id for item in await connector.documents()] == ["a.md"]


@pytest.mark.parametrize("kind", ["s3", "http", "db", "mcp"])
def test_the_unshipped_source_kinds_are_deferred_not_empty(kind: str) -> None:
    # Refused rather than answered with an empty corpus: a retriever that indexes
    # nothing and reports success looks exactly like one that found nothing.
    with pytest.raises(FeatureDeferredError, match="not implemented"):
        open_connector(SourceSpec(kind=SourceKind(kind), uri="./docs"))
