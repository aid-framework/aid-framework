"""A pgvector-backed store, provisioned locally and never touched by CI.

The driver is an optional extra, so this module must be importable without it.
Nothing at module scope imports ``psycopg``; the import happens inside
:func:`_load_driver` on first use, and a missing driver becomes a
:class:`~aid_runtime.errors.ConfigurationError` that names the extra to install.
Importing :mod:`aid_runtime.retrieval` therefore cannot fail because a database
extra is absent, which is what lets the default dependency set stay unchanged.

Two consequences of that choice are deliberate and visible:

* The driver is loaded as an untyped module, so ``Any`` reaches this file. It is
  confined to this one adapter rather than spreading a suppressed import across the
  retrieval package.
* Every statement is a fixed string. The embedding column is declared
  dimension-less rather than ``vector(1536)``, so no computed identifier is ever
  interpolated into SQL, and the pinned width is enforced where the pin actually
  lives: the caller's :class:`~aid_runtime.retrieval.types.PinnedEmbedding`.

Correctness here is expected to match the in-memory adapter, but nothing checks
that: this adapter is not gate-covered, and its SQL path runs only on a machine where
someone brought the database up themselves. See ``compose.pgvector.yml``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from typing import Any

from aid_runtime.errors import ConfigurationError, ProviderError
from aid_runtime.retrieval.types import (
    Chunk,
    DistanceMetric,
    SearchHit,
    StoreKind,
    StoreRecord,
)

__all__ = ["PgVectorStore", "resolve_uri"]

_ENV_PREFIX = "env:"

_CREATE_EXTENSION = "CREATE EXTENSION IF NOT EXISTS vector"
_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS aid_chunks (
    chunk_id text PRIMARY KEY,
    doc_id text NOT NULL,
    uri text NOT NULL,
    chunk_index integer NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    body text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    embedding vector NOT NULL
)
"""
_UPSERT = """
INSERT INTO aid_chunks (
    chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, embedding
) VALUES (
    %(chunk_id)s, %(doc_id)s, %(uri)s, %(chunk_index)s, %(start_offset)s, %(end_offset)s,
    %(body)s, %(metadata)s::jsonb, %(embedding)s::vector
)
ON CONFLICT (chunk_id) DO UPDATE SET
    doc_id = EXCLUDED.doc_id,
    uri = EXCLUDED.uri,
    chunk_index = EXCLUDED.chunk_index,
    start_offset = EXCLUDED.start_offset,
    end_offset = EXCLUDED.end_offset,
    body = EXCLUDED.body,
    metadata = EXCLUDED.metadata,
    embedding = EXCLUDED.embedding
"""
_CORPUS = (
    "SELECT chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, "
    "embedding FROM aid_chunks ORDER BY chunk_id"
)
# `<=>` is cosine distance, `<#>` is negative inner product and `<->` is L2 distance.
# Each is rewritten into "higher is better" so callers see one orientation, matching
# `stores.similarity`. The tie-break on `chunk_id` matches the in-memory adapter too:
# equal scores must rank identically on both.
#
# Every statement is spelled out in full rather than assembled from a column list, so
# that no statement is ever *constructed*: the only values that reach SQL are bound
# parameters.
_SEARCH: dict[DistanceMetric, str] = {
    DistanceMetric.COSINE: (
        "SELECT chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, "
        "embedding, 1 - (embedding <=> %(vector)s::vector) AS score FROM aid_chunks "
        "ORDER BY embedding <=> %(vector)s::vector, chunk_id LIMIT %(top_k)s"
    ),
    DistanceMetric.DOT: (
        "SELECT chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, "
        "embedding, -(embedding <#> %(vector)s::vector) AS score FROM aid_chunks "
        "ORDER BY embedding <#> %(vector)s::vector, chunk_id LIMIT %(top_k)s"
    ),
    DistanceMetric.L2: (
        "SELECT chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, "
        "embedding, -(embedding <-> %(vector)s::vector) AS score FROM aid_chunks "
        "ORDER BY embedding <-> %(vector)s::vector, chunk_id LIMIT %(top_k)s"
    ),
}


def _load_driver() -> Any:
    """Import the optional driver, or explain how to install it."""
    try:
        import psycopg
    except ImportError as error:
        raise ConfigurationError(
            "the pgvector store needs its driver; install it with "
            "`pip install aid-runtime-python[pgvector]` (the default install omits it)"
        ) from error
    return psycopg


def resolve_uri(uri: str | None) -> str:
    """Resolve an ``env:NAME`` reference to the variable's value.

    An ``env:`` reference names a variable, not an alias: nothing here reaches the
    model catalog, so resolving it at run time cannot silently change which store a
    run wrote to.
    """
    if uri is None:
        raise ConfigurationError("the pgvector store requires a uri")
    if not uri.startswith(_ENV_PREFIX):
        return uri
    name = uri[len(_ENV_PREFIX) :]
    if not name:
        raise ConfigurationError(f"store uri {uri!r} names an empty environment variable")
    value = os.environ.get(name)
    if value is None:
        raise ConfigurationError(
            f"store uri {uri!r} refers to environment variable {name!r}, which is unset"
        )
    return value


def _literal(vector: Sequence[float]) -> str:
    """pgvector's text input format, so its Python package is not a dependency."""
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


class PgVectorStore:
    """A single-table store: one row per chunk, keyed by content hash."""

    def __init__(self, *, uri: str | None, dimensions: int | None = None) -> None:
        self._uri = resolve_uri(uri)
        self._dimensions = dimensions
        self._connection: Any = None
        self._closed = False

    @property
    def kind(self) -> StoreKind:
        return StoreKind.PGVECTOR

    async def _connect(self) -> Any:
        if self._closed:
            raise ConfigurationError("this store has been closed")
        if self._connection is None:
            psycopg = _load_driver()
            try:
                self._connection = await psycopg.AsyncConnection.connect(self._uri)
            except Exception as error:
                raise ProviderError(f"cannot connect to the pgvector store: {error}") from error
            await self._ensure_schema()
        return self._connection

    async def _ensure_schema(self) -> None:
        async with self._connection.cursor() as cursor:
            await cursor.execute(_CREATE_EXTENSION)
            await cursor.execute(_CREATE_TABLE)
        await self._connection.commit()

    async def upsert(self, records: Sequence[StoreRecord]) -> int:
        if self._dimensions is not None:
            for record in records:
                if len(record.vector) != self._dimensions:
                    raise ConfigurationError(
                        f"store is pinned to {self._dimensions} dimensions but a record carries "
                        f"{len(record.vector)}"
                    )
        if not records:
            return 0
        connection = await self._connect()
        async with connection.cursor() as cursor:
            for record in records:
                await cursor.execute(_UPSERT, self._params(record))
        await connection.commit()
        return len(records)

    async def search(
        self, vector: Sequence[float], *, top_k: int, metric: DistanceMetric
    ) -> tuple[SearchHit, ...]:
        if top_k < 1:
            raise ConfigurationError("top_k must be at least 1")
        statement = _SEARCH.get(metric)
        if statement is None:
            raise ConfigurationError(f"pgvector cannot rank by {metric.value!r}")
        connection = await self._connect()
        async with connection.cursor() as cursor:
            await cursor.execute(statement, {"vector": _literal(vector), "top_k": top_k})
            rows = await cursor.fetchall()
        return tuple(SearchHit(record=self._record(row), score=float(row[9])) for row in rows)

    async def corpus(self) -> tuple[StoreRecord, ...]:
        connection = await self._connect()
        async with connection.cursor() as cursor:
            await cursor.execute(_CORPUS)
            rows = await cursor.fetchall()
        return tuple(self._record(row) for row in rows)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._connection is not None:
            await self._connection.close()
            self._connection = None

    def _params(self, record: StoreRecord) -> dict[str, Any]:
        chunk = record.chunk
        return {
            "chunk_id": chunk.chunk_id,
            "doc_id": chunk.doc_id,
            "uri": chunk.uri,
            "chunk_index": chunk.index,
            "start_offset": chunk.start,
            "end_offset": chunk.end,
            "body": chunk.text,
            "metadata": json.dumps(chunk.metadata, sort_keys=True),
            "embedding": _literal(record.vector),
        }

    def _record(self, row: Sequence[Any]) -> StoreRecord:
        return StoreRecord(
            chunk=Chunk(
                chunk_id=row[0],
                doc_id=row[1],
                uri=row[2],
                index=row[3],
                start=row[4],
                end=row[5],
                text=row[6],
                metadata=row[7] or {},
            ),
            vector=tuple(float(value) for value in _parse_vector(row[8])),
        )


def _parse_vector(value: Any) -> list[float]:
    """Accept either a driver-returned sequence or pgvector's text form."""
    if isinstance(value, str):
        stripped = value.strip().strip("[]")
        return [float(part) for part in stripped.split(",")] if stripped else []
    return [float(item) for item in value]
