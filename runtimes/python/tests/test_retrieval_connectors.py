"""Reading a ``file``, ``s3`` or ``http`` source, and refusing the reserved kinds.

Document identity is the component most worth pinning down here: the IR's
retrieval metric writes ``expectDocs: [getting-started.md]``, so a connector that
reported ``./docs/getting-started.md`` or a Windows path would make every citation
and every gate expectation miss. The remote kinds keep the same rule, which is why
the s3 tests below check a key with a prefix stripped and an ``&`` in it rather than
asserting only that a body came back.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote

import httpx
import pytest

from aid_runtime import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval import (
    Connector,
    FileConnector,
    HttpConnector,
    S3Connector,
    SourceKind,
    SourceSpec,
    open_connector,
)
from aid_runtime.retrieval import connectors as connectors_module
from retrieval_support import write_docs


class _ChunkedBody(httpx.AsyncByteStream):
    """A body with no content-length, so a cap has to be enforced while reading it."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


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


@pytest.mark.parametrize("kind", ["db", "mcp"])
def test_the_reserved_source_kinds_are_deferred_not_empty(kind: str) -> None:
    # Refused rather than answered with an empty corpus: a retriever that indexes
    # nothing and reports success looks exactly like one that found nothing.
    with pytest.raises(FeatureDeferredError, match=r"shipped in spec 0\.21"):
        open_connector(SourceSpec(kind=SourceKind(kind), uri="./docs"))


@pytest.mark.parametrize(
    ("kind", "uri", "expected"),
    [
        ("s3", "s3://corpus/docs", S3Connector),
        ("http", "https://example.test/guides/install.md", HttpConnector),
    ],
)
async def test_open_connector_dispatches_the_remote_kinds(
    kind: str,
    uri: str,
    expected: type,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The spec's 0.21 gate is what decides whether a remote kind may appear; once it
    # has, opening one must produce a loader rather than a deferral.
    _s3_environment(monkeypatch)
    connector = open_connector(SourceSpec(kind=SourceKind(kind), uri=uri))
    try:
        assert isinstance(connector, expected)
        assert connector.kind is SourceKind(kind)
    finally:
        await connector.aclose()


_PAGE_ONE = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>corpus</Name>
  <Prefix>docs/</Prefix>
  <IsTruncated>true</IsTruncated>
  <Contents>
    <Key>docs/zz-last.md</Key>
    <LastModified>2024-01-02T03:04:05.000Z</LastModified>
    <ETag>&quot;etag-zz&quot;</ETag>
  </Contents>
  <NextContinuationToken>page-2</NextContinuationToken>
</ListBucketResult>
"""

_PAGE_TWO = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>corpus</Name>
  <Prefix>docs/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>docs/a&amp;b.md</Key>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
    <ETag>&quot;etag-ab&quot;</ETag>
  </Contents>
  <Contents>
    <Key>docs/aa-first.md</Key>
    <LastModified>2024-01-03T00:00:00.000Z</LastModified>
    <ETag>&quot;etag-aa&quot;</ETag>
  </Contents>
</ListBucketResult>
"""

_BODIES = {
    "docs/zz-last.md": "# Last\n",
    "docs/a&b.md": "# Ampersand\n",
    "docs/aa-first.md": "# First\n",
}


class _S3Endpoint:
    """A stand-in S3 endpoint: paginated listings and object bodies, no network."""

    def __init__(self, pages: list[str], bodies: dict[str, str]) -> None:
        self.pages = pages
        self.bodies = bodies
        self.list_requests: list[httpx.URL] = []
        self.object_requests: list[httpx.URL] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.params.get("list-type") == "2":
            self.list_requests.append(request.url)
            index = 0 if "continuation-token" not in request.url.params else 1
            return httpx.Response(200, text=self.pages[index])
        self.object_requests.append(request.url)
        key = unquote(request.url.path).removeprefix("/corpus/")
        return httpx.Response(200, text=self.bodies[key])


def _s3_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ENDPOINT_URL_S3", "http://s3.test")
    monkeypatch.delenv("AWS_ENDPOINT_URL", raising=False)


async def test_an_s3_source_paginates_and_sorts_by_document_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _s3_environment(monkeypatch)
    endpoint = _S3Endpoint([_PAGE_ONE, _PAGE_TWO], _BODIES)
    connector = S3Connector(
        "s3://corpus/docs",
        transport=httpx.MockTransport(endpoint.handler),
        now=lambda: datetime(2024, 5, 6, 7, 8, 9, tzinfo=UTC),
    )
    try:
        documents = await connector.documents()
    finally:
        await connector.aclose()

    # The id is the key with the prefix stripped, so it reads the same as it would
    # out of a directory, and the escaped key arrives as the character it names.
    assert [document.doc_id for document in documents] == [
        "a&b.md",
        "aa-first.md",
        "zz-last.md",
    ]
    assert documents[0].uri == "s3://corpus/docs/a&b.md"
    assert documents[0].text == "# Ampersand\n"
    assert documents[0].metadata == {
        "path": "a&b.md",
        "suffix": ".md",
        "etag": "etag-ab",
        "lastModified": "2024-01-01T00:00:00.000Z",
    }
    # IsTruncated drove a second call, which carried the token the first page named.
    assert len(endpoint.list_requests) == 2
    assert endpoint.list_requests[0].params["prefix"] == "docs/"
    assert endpoint.list_requests[1].params["continuation-token"] == "page-2"


async def test_an_s3_glob_selects_keys_relative_to_the_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _s3_environment(monkeypatch)
    page = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents><Key>docs/a.md</Key></Contents>
  <Contents><Key>docs/b.txt</Key></Contents>
  <Contents><Key>docs/nested/c.md</Key></Contents>
  <Contents><Key>docs/sub/</Key></Contents>
</ListBucketResult>
"""
    endpoint = _S3Endpoint(
        [page], {"docs/a.md": "a\n", "docs/b.txt": "b\n", "docs/nested/c.md": "c\n"}
    )
    connector = S3Connector(
        "s3://corpus/docs",
        glob="**/*.md",
        transport=httpx.MockTransport(endpoint.handler),
        now=lambda: datetime(2024, 5, 6, 7, 8, 9, tzinfo=UTC),
    )
    try:
        documents = await connector.documents()
    finally:
        await connector.aclose()

    # `**/` spans zero segments, so the key at the prefix root matches too, and a
    # nested key keeps its full relative path as its id.
    assert [document.doc_id for document in documents] == ["a.md", "nested/c.md"]
    # The directory marker and the non-matching object were never fetched.
    assert sorted(unquote(url.path) for url in endpoint.object_requests) == [
        "/corpus/docs/a.md",
        "/corpus/docs/nested/c.md",
    ]


async def test_an_s3_source_without_a_region_says_which_variable_to_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _s3_environment(monkeypatch)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)

    with pytest.raises(ConfigurationError, match="AWS_REGION or AWS_DEFAULT_REGION"):
        S3Connector("s3://corpus/docs")


async def test_an_s3_source_without_credentials_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _s3_environment(monkeypatch)
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)

    with pytest.raises(ConfigurationError, match="AWS_ACCESS_KEY_ID"):
        S3Connector("s3://corpus/docs")


async def test_an_http_source_is_exactly_one_document() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://example.test/guides/install.md"
        return httpx.Response(200, text="# Install\n")

    connector = HttpConnector(
        "https://example.test/guides/install.md",
        transport=httpx.MockTransport(handler),
    )
    try:
        (document,) = await connector.documents()
    finally:
        await connector.aclose()

    assert document.doc_id == "install.md"
    assert document.text == "# Install\n"
    assert document.uri == "https://example.test/guides/install.md"
    assert document.metadata == {"path": "install.md", "suffix": ".md"}


async def test_an_http_url_with_no_path_segment_is_indexed_as_index() -> None:
    connector = HttpConnector(
        "https://example.test/",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, text="home\n")),
    )
    try:
        (document,) = await connector.documents()
    finally:
        await connector.aclose()

    assert document.doc_id == "index"
    assert document.metadata == {"path": "index", "suffix": ""}


async def test_an_http_source_refuses_a_glob() -> None:
    # A glob describes a set and an http source is one document; accepting the
    # pattern would silently ignore it.
    with pytest.raises(ConfigurationError, match="takes no 'glob'"):
        HttpConnector("https://example.test/install.md", glob="**/*.md")


async def test_an_oversize_body_is_refused_rather_than_truncated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(connectors_module, "_MAX_DOCUMENT_BYTES", 8)
    # An iterator body carries no content-length, so the cap is enforced while the
    # body streams rather than from a header the server happened to send.
    connector = HttpConnector(
        "https://example.test/big.md",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, stream=_ChunkedBody([b"0123", b"4567", b"89"]))
        ),
    )
    try:
        with pytest.raises(ConfigurationError, match="8-byte document limit"):
            await connector.documents()
    finally:
        await connector.aclose()


async def test_a_non_2xx_remote_response_is_refused() -> None:
    connector = HttpConnector(
        "https://example.test/missing.md",
        transport=httpx.MockTransport(lambda _request: httpx.Response(404, text="no")),
    )
    try:
        with pytest.raises(ConfigurationError, match="returned HTTP 404"):
            await connector.documents()
    finally:
        await connector.aclose()
