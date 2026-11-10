"""Reading a ``file``, ``s3`` or ``http`` source.

``file`` indexes a local directory and is implemented at every spec version. ``s3``
loads an object-store corpus and ``http`` loads exactly one document; both shipped in
spec 0.21. ``db`` and ``mcp`` are still reserved by the design, so they raise
:class:`~aid_runtime.errors.FeatureDeferredError` here rather than indexing an empty
corpus and looking healthy.

**Document identity is the POSIX path relative to the source root.** That is the
vocabulary the IR's retrieval metric already uses -- its ``expectDocs`` hold
``getting-started.md``, not ``./docs/getting-started.md`` -- and it is
machine-independent, so the same corpus indexed on Windows and on Linux yields the
same ids and the same eval outcome. Absolute paths would make a baseline
non-portable. The remote connectors keep the same rule: an ``s3`` object's ``doc_id``
is its key with the source prefix stripped, and an ``http`` document's is the last
non-empty segment of its path.

The protocol is ``async`` because the remote kinds are genuinely concurrent. The file
connector reads synchronously behind that seam so its behaviour is unchanged.

**The s3 signer is the Bedrock adapter's.** ``sigv4_headers`` already computes the
canonical request, scope and signing key for every other AWS call this runtime makes;
signing a ``GET`` with it -- ``service="s3"``, ``method="GET"`` and the canonical query
string -- avoids a second implementation that could disagree about encoding. There is
deliberately no boto3 dependency: ListObjectsV2 is one signed ``GET`` parsed with the
standard library's XML reader, and GetObject is another.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, runtime_checkable
from urllib.parse import quote, urlparse
from xml.etree import ElementTree

import httpx
from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.providers.bedrock import rfc3986, sigv4_headers
from aid_runtime.retrieval.types import SourceKind, SourceSpec

__all__ = [
    "Connector",
    "FileConnector",
    "HttpConnector",
    "S3Connector",
    "SourceDocument",
    "open_connector",
]

_RECORD = ConfigDict(frozen=True, extra="forbid")

#: The largest body either remote connector will read into one document.
_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

#: How many GetObject requests an s3 source keeps in flight.
_S3_CONCURRENCY = 8


@dataclass(frozen=True)
class _ListedObject:
    """One ``ListObjectsV2`` entry, before its body is fetched."""

    key: str
    etag: str
    last_modified: str


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


def _tokenize_glob(pattern: str) -> tuple[tuple[str, str], ...]:
    """Split a glob into the same tokens the TypeScript runtime's `compileGlob` uses."""
    tokens: list[tuple[str, str]] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if pattern[index + 1 : index + 2] == "*":
                index += 1
                if pattern[index + 1 : index + 2] == "/":
                    index += 1
                    tokens.append(("globstar_segment", ""))
                else:
                    tokens.append(("globstar", ""))
            else:
                tokens.append(("star", ""))
        elif char == "?":
            tokens.append(("any_one", ""))
        else:
            tokens.append(("literal", char))
        index += 1
    return tuple(tokens)


def _glob_matcher(pattern: str | None) -> Callable[[str], bool]:
    """Compile a ``*``/``**``/``?`` glob into a matcher over POSIX relative keys.

    Deliberately the same token walk as the file connector's documented grammar and the
    TypeScript runtime's ``compileGlob``: ``*`` and ``?`` stop at ``/``, ``**`` crosses
    them, and anything else matches literally. Walking tokens is linear in the key
    length whatever the pattern; a translated regular expression would let a pattern
    with repeated double-stars cost a pathological number of steps to fail.
    """
    if pattern is None:
        return lambda _key: True
    tokens = _tokenize_glob(pattern)

    def matches(key: str) -> bool:
        reachable = [False] * (len(key) + 1)
        reachable[0] = True
        for kind, char in tokens:
            nxt = [False] * (len(key) + 1)
            if kind == "literal":
                for end in range(1, len(key) + 1):
                    nxt[end] = reachable[end - 1] and key[end - 1] == char
            elif kind == "any_one":
                for end in range(1, len(key) + 1):
                    nxt[end] = reachable[end - 1] and key[end - 1] != "/"
            elif kind == "star":
                for end in range(len(key) + 1):
                    extends = end > 0 and nxt[end - 1] and key[end - 1] != "/"
                    nxt[end] = reachable[end] or extends
            elif kind == "globstar":
                for end in range(len(key) + 1):
                    extends = end > 0 and nxt[end - 1]
                    nxt[end] = reachable[end] or extends
            else:  # globstar_segment
                any_before = False
                for end in range(len(key) + 1):
                    lands = any_before and end > 0 and key[end - 1] == "/"
                    nxt[end] = reachable[end] or lands
                    if reachable[end]:
                        any_before = True
            reachable = nxt
        return reachable[len(key)]

    return matches


def _suffix(doc_id: str) -> str:
    """The extension of a document's final path segment, or ``''``."""
    name = doc_id.rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return "" if dot <= 0 else name[dot:]


def _local_name(tag: str) -> str:
    """An element's tag without its XML namespace, so parsing ignores the prefix."""
    return tag.rsplit("}", 1)[-1]


def _s3_environment() -> tuple[dict[str, str], str, str | None]:
    """The credentials, region and optional endpoint an ``s3`` source reads."""
    access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
    if not access_key or not secret_key:
        raise ConfigurationError(
            "an s3 source needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment"
        )
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        raise ConfigurationError(
            "an s3 source needs a region: set AWS_REGION or AWS_DEFAULT_REGION"
        )
    credentials = {"access_key_id": access_key, "secret_access_key": secret_key}
    token = os.environ.get("AWS_SESSION_TOKEN")
    if token:
        credentials["session_token"] = token
    endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL")
    return credentials, region, endpoint.rstrip("/") if endpoint else None


def _parse_listing(body: bytes) -> tuple[list[_ListedObject], str | None]:
    """Read one ListObjectsV2 page: its objects and the next continuation token."""
    try:
        # The body is the response to a signed request this process made to its own
        # configured endpoint, not a document supplied by a third party.
        root = ElementTree.fromstring(body)  # noqa: S314
    except ElementTree.ParseError as error:
        raise ConfigurationError(
            f"the s3 ListObjectsV2 response is not valid XML: {error}"
        ) from error
    listed: list[_ListedObject] = []
    is_truncated = False
    next_token: str | None = None
    for element in root.iter():
        name = _local_name(element.tag)
        if name == "Contents":
            key = etag = last_modified = ""
            for child in element:
                child_name = _local_name(child.tag)
                if child_name == "Key":
                    key = child.text or ""
                elif child_name == "ETag":
                    etag = (child.text or "").strip('"')
                elif child_name == "LastModified":
                    last_modified = child.text or ""
            if key:
                listed.append(_ListedObject(key=key, etag=etag, last_modified=last_modified))
        elif name == "IsTruncated":
            is_truncated = (element.text or "").strip().lower() == "true"
        elif name == "NextContinuationToken":
            text = (element.text or "").strip()
            next_token = text or None
    return listed, next_token if is_truncated else None


async def _get_bytes(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    *,
    label: str,
) -> bytes:
    """One ``GET``, requiring a 2xx and refusing a body over the document limit."""
    async with client.stream("GET", url, headers=headers) as response:
        if not 200 <= response.status_code < 300:
            detail = (await response.aread())[:200].decode("utf-8", "replace").strip()
            suffix = f": {detail}" if detail else ""
            raise ConfigurationError(f"{label} returned HTTP {response.status_code}{suffix}")
        declared = response.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > _MAX_DOCUMENT_BYTES:
            raise ConfigurationError(
                f"{label} is {declared} bytes, over the {_MAX_DOCUMENT_BYTES}-byte limit"
            )
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > _MAX_DOCUMENT_BYTES:
                raise ConfigurationError(
                    f"{label} exceeds the {_MAX_DOCUMENT_BYTES}-byte document limit"
                )
            chunks.append(chunk)
        return b"".join(chunks)


class S3Connector:
    """Reads an ``s3://bucket[/prefix]`` corpus, one document per object.

    An object's ``doc_id`` is its key with the source prefix stripped, so the same
    corpus indexed out of a bucket and out of a directory yields the same ids. Objects
    are fetched concurrently -- bounded, so a bucket with a thousand keys does not open
    a thousand sockets -- and emitted in sorted ``doc_id`` order regardless.
    """

    def __init__(
        self,
        uri: str,
        *,
        glob: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        parsed = urlparse(uri)
        if parsed.scheme != "s3" or not parsed.netloc:
            raise ConfigurationError(
                f"s3 source uri {uri!r} must be an absolute 's3://<bucket>[/<prefix>]' uri"
            )
        self._bucket = parsed.netloc
        raw_prefix = parsed.path.lstrip("/")
        # A prefix names a directory: without the trailing slash, ``docs`` would also
        # list ``docs-archive/`` objects that are not under the source at all.
        self._prefix = (
            f"{raw_prefix}/" if raw_prefix and not raw_prefix.endswith("/") else raw_prefix
        )
        self._glob = glob
        self._credentials, self._region, self._endpoint = _s3_environment()
        self._now = now or (lambda: datetime.now(UTC))
        self._client = httpx.AsyncClient(transport=transport, timeout=timeout)

    @property
    def kind(self) -> SourceKind:
        return SourceKind.S3

    async def documents(self) -> tuple[SourceDocument, ...]:
        matcher = _glob_matcher(self._glob)
        candidates = [
            (item, self._relative_key(item.key))
            for item in await self._list_objects()
            if not item.key.endswith("/")
        ]
        selected = [(item, doc_id) for item, doc_id in candidates if matcher(doc_id)]
        semaphore = asyncio.Semaphore(_S3_CONCURRENCY)
        documents = await asyncio.gather(
            *(self._fetch_object(item, doc_id, semaphore) for item, doc_id in selected)
        )
        return tuple(sorted(documents, key=lambda document: document.doc_id))

    async def aclose(self) -> None:
        await self._client.aclose()

    def _relative_key(self, key: str) -> str:
        if self._prefix and key.startswith(self._prefix):
            return key[len(self._prefix) :].lstrip("/")
        return key.lstrip("/")

    def _list_request(self, token: str | None) -> tuple[str, str]:
        params = {"list-type": "2"}
        if self._prefix:
            params["prefix"] = self._prefix
        if token is not None:
            params["continuation-token"] = token
        query = "&".join(
            f"{quote(name, safe='-_.~')}={quote(value, safe='-_.~')}"
            for name, value in sorted(params.items())
        )
        if self._endpoint is not None:
            return f"{self._endpoint}/{self._bucket}?{query}", query
        return f"https://{self._bucket}.s3.{self._region}.amazonaws.com/?{query}", query

    def _object_url(self, key: str) -> str:
        encoded = "/".join(rfc3986(segment) for segment in key.split("/"))
        if self._endpoint is not None:
            return f"{self._endpoint}/{self._bucket}/{encoded}"
        return f"https://{self._bucket}.s3.{self._region}.amazonaws.com/{encoded}"

    async def _list_objects(self) -> list[_ListedObject]:
        listed: list[_ListedObject] = []
        token: str | None = None
        while True:
            url, query = self._list_request(token)
            headers = sigv4_headers(
                url=url,
                body="",
                region=self._region,
                credentials=self._credentials,
                moment=self._now(),
                service="s3",
                method="GET",
                query=query,
            )
            body = await _get_bytes(self._client, url, headers, label="the s3 listing")
            page, token = _parse_listing(body)
            listed.extend(page)
            if token is None:
                return listed

    async def _fetch_object(
        self,
        item: _ListedObject,
        doc_id: str,
        semaphore: asyncio.Semaphore,
    ) -> SourceDocument:
        url = self._object_url(item.key)
        async with semaphore:
            headers = sigv4_headers(
                url=url,
                body="",
                region=self._region,
                credentials=self._credentials,
                moment=self._now(),
                service="s3",
                method="GET",
            )
            body = await _get_bytes(self._client, url, headers, label=f"the s3 object {item.key!r}")
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ConfigurationError(
                f"the s3 object {item.key!r} is not valid UTF-8: {error}"
            ) from error
        return SourceDocument(
            doc_id=doc_id,
            uri=f"s3://{self._bucket}/{item.key}",
            text=text,
            metadata={
                "path": doc_id,
                "suffix": _suffix(doc_id),
                "etag": item.etag,
                "lastModified": item.last_modified,
            },
        )


class HttpConnector:
    """Reads exactly one document from an absolute ``http://`` or ``https://`` url.

    An http source names a document, not a set, which is why it takes no ``glob``: a
    pattern there would describe documents the connector deliberately does not fetch.
    """

    def __init__(
        self,
        uri: str,
        *,
        glob: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        if glob is not None:
            raise ConfigurationError(
                f"http source {uri!r} takes no 'glob': an http source is exactly one "
                "document, and a pattern describes a set"
            )
        parsed = urlparse(uri)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ConfigurationError(
                f"http source uri {uri!r} must be an absolute 'http://' or 'https://' url"
            )
        self._uri = uri
        self._segments = [segment for segment in parsed.path.split("/") if segment]
        self._client = httpx.AsyncClient(transport=transport, timeout=timeout)

    @property
    def kind(self) -> SourceKind:
        return SourceKind.HTTP

    async def documents(self) -> tuple[SourceDocument, ...]:
        body = await _get_bytes(self._client, self._uri, {}, label=f"the http source {self._uri!r}")
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ConfigurationError(
                f"the http source {self._uri!r} is not valid UTF-8: {error}"
            ) from error
        doc_id = self._segments[-1] if self._segments else "index"
        return (
            SourceDocument(
                doc_id=doc_id,
                uri=self._uri,
                text=text,
                metadata={"path": doc_id, "suffix": _suffix(doc_id)},
            ),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def open_connector(spec: SourceSpec, *, base_dir: str | Path | None = None) -> Connector:
    """Open the connector for a source entry.

    ``base_dir`` resolves a relative ``file`` source ``uri``; it is explicit because the
    runtime has no opinion about a working directory, and a corpus must not depend on
    where a process happened to be started.
    """
    if spec.kind is SourceKind.S3:
        return S3Connector(spec.uri, glob=spec.glob)
    if spec.kind is SourceKind.HTTP:
        return HttpConnector(spec.uri, glob=spec.glob)
    if spec.kind is not SourceKind.FILE:
        raise FeatureDeferredError(
            f"source kind {spec.kind.value!r} is still reserved: the s3 and http loaders "
            "shipped in spec 0.21, and db and mcp remain part of the design but unimplemented"
        )
    root = Path(spec.uri)
    if not root.is_absolute() and base_dir is not None:
        root = Path(base_dir) / root
    return FileConnector(root, glob=spec.glob)
