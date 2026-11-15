"""Where a paused run waits: the store that outlives the process that paused it.

Before this module the checkpoint *was* the only record of a paused run, so the run
outlived the request and not the process. That is a real failure rather than a
theoretical one: an approval that takes an hour lands on whichever replica is awake, and
a pod that restarts between the pause and the answer loses the run entirely -- the
approver answers a question nobody is listening for, and the work is redone from the
first prompt.

:class:`RunStore` closes that gap. On a pause the loop writes the checkpoint and returns a
``run_id``; a later request names the id instead of carrying a signed blob. The stored path
is *strictly stronger* than the hand-back path it sits beside:

* The body is authored by the app, never by the caller. A stored checkpoint cannot be
  edited before it is resumed, because the caller never supplies one -- which is why this
  path is safe even for a document that declares no ``signingKeyEnv``.
* :meth:`RunStore.load` claims the row atomically, so a ``run_id`` resumes once. The row is
  marked spent in the same transaction that reads it, which is a stronger guarantee than
  the nonce claim it repeats: a nonce is remembered per store, and the claim here and the
  checkpoint's own deadline are settled by the same write.
* The deadline is the checkpoint's own ``expires_at`` for a signed document, so the store
  cannot extend a pause past what the signature allows. An unsigned document has no
  deadline inside its checkpoint, and the store records ``NULL`` rather than inventing
  one -- a run that never expires is a fact about the document, not something to guess.

``retain_seconds`` is the operator's retention, from ``agentState.ttlHours``. It is a
different number from the resume window on purpose: a run may be *kept* for a week as
audit material while only being *resumable* for fifteen minutes, and the build refuses the
one ordering that cannot work -- a retention shorter than the window it has to outlive
(``ir/state-retention``).

Two limits are stated rather than hidden. This module writes no deletion job: expired
rows are pruned opportunistically on the next save, which is enough to keep a table from
growing without deciding an operator's retention policy for them. And a store is not a
queue: it survives a restart and spans replicas, which is what a resumed request needs,
but nothing here retries a run or advances one on a timer.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sqlite3
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from aid_runtime.agents.resume import CheckpointRefusalError
from aid_runtime.agents.state import AgentCheckpoint
from aid_runtime.errors import ConfigurationError

__all__ = [
    "InProcessRunStore",
    "PostgresRunStore",
    "RunStore",
    "SqliteRunStore",
    "new_run_id",
    "run_store_for",
    "run_store_from_env",
]

#: Bytes of entropy behind a run id. 16 bytes is 128 bits: a run id is unguessable even
#: though it is not the thing that authorizes a resume -- the owner binding and the
#: single-use claim are -- because an id that could be enumerated would still tell a
#: caller that a run exists.
_RUN_ID_BYTES = 16


def new_run_id() -> str:
    """A fresh, unguessable run id. ``run_`` prefix so a log line names what it is."""
    return f"run_{secrets.token_urlsafe(_RUN_ID_BYTES)}"


@runtime_checkable
class RunStore(Protocol):
    """Where a paused run is written, and how a resuming request finds it again.

    ``load`` must be atomic in the same sense :meth:`aid_runtime.agents.resume.NonceStore.claim`
    is: two requests naming the same ``run_id`` may arrive together, and exactly one may
    be told the run is theirs. A store that read the row and then updated it would let both
    resume the same pause, which is the precise bug this store exists to prevent.
    """

    async def save(
        self,
        *,
        run_id: str,
        checkpoint: AgentCheckpoint,
        expires_at: int | None,
        now: int,
    ) -> None:
        """Write a paused run. ``expires_at`` is the pause deadline, or ``None`` for none."""

    async def load(self, *, run_id: str, now: int) -> AgentCheckpoint:
        """Claim ``run_id`` and return its checkpoint, or raise why it cannot be resumed.

        Raises :class:`~aid_runtime.errors.CheckpointRefusalError` with ``unknown-run``,
        ``replayed`` or ``expired``. The reason is for the operator log; the generated
        route answers all three with the same opaque 403, so a caller learns only that
        the id did not work.
        """


def _encode(checkpoint: AgentCheckpoint) -> str:
    return json.dumps(checkpoint.model_dump(mode="json"), separators=(",", ":"), ensure_ascii=False)


def _decode(text: str) -> AgentCheckpoint:
    return AgentCheckpoint.model_validate(json.loads(text))


class InProcessRunStore:
    """A dict, and therefore the same limit the in-process nonce store has.

    It is what a document that declares no ``agentState`` gets, so a paused run survives
    the request and not the process -- the behaviour every document had before this store
    existed. Nothing is worse than before: the checkpoint still returns to the caller.
    """

    def __init__(self) -> None:
        self._rows: dict[str, tuple[str, int | None, int | None]] = {}
        self._lock = asyncio.Lock()

    async def save(
        self,
        *,
        run_id: str,
        checkpoint: AgentCheckpoint,
        expires_at: int | None,
        now: int,
    ) -> None:
        async with self._lock:
            self._rows[run_id] = (_encode(checkpoint), expires_at, None)

    async def load(self, *, run_id: str, now: int) -> AgentCheckpoint:
        async with self._lock:
            row = self._rows.get(run_id)
            if row is None:
                raise CheckpointRefusalError(
                    "unknown-run", f"no paused run is stored under {run_id!r}"
                )
            payload, expires_at, resumed_at = row
            if resumed_at is not None:
                raise CheckpointRefusalError(
                    "replayed", f"the run stored under {run_id!r} was already resumed"
                )
            if expires_at is not None and expires_at <= now:
                raise CheckpointRefusalError(
                    "expired", f"the run stored under {run_id!r} is past its resume window"
                )
            self._rows[run_id] = (payload, expires_at, now)
            return _decode(payload)


class SqliteRunStore:
    """A file, so a paused run survives the process that paused it.

    ``UPDATE ... WHERE resumed_at IS NULL`` plus ``rowcount`` is the atomic claim: SQLite
    reports whether this writer was the one that cleared the flag, so two workers sharing
    the file cannot both resume the same pause. The row is read first so the refusal can
    say *why* -- an operator reading the log wants to know whether an approval arrived an
    hour late or arrived twice -- and the update that follows is the decision, not the
    read.
    """

    def __init__(self, path: str | Path, *, retain_seconds: int | None = None) -> None:
        self._path = Path(path)
        self._retain_seconds = retain_seconds
        self._lock = asyncio.Lock()

    async def save(
        self,
        *,
        run_id: str,
        checkpoint: AgentCheckpoint,
        expires_at: int | None,
        now: int,
    ) -> None:
        async with self._lock:
            await asyncio.to_thread(self._save, run_id, checkpoint, expires_at, now)

    async def load(self, *, run_id: str, now: int) -> AgentCheckpoint:
        async with self._lock:
            return _decode(await asyncio.to_thread(self._load, run_id, now))

    def _retain_until(self, now: int) -> int | None:
        if self._retain_seconds is None:
            return None
        return now + self._retain_seconds

    def _connect(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self._path)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS agent_run ("
            "run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, checkpoint TEXT NOT NULL, "
            "expires_at INTEGER, retain_until INTEGER, created_at INTEGER NOT NULL, "
            "resumed_at INTEGER)"
        )
        return connection

    def _save(
        self,
        run_id: str,
        checkpoint: AgentCheckpoint,
        expires_at: int | None,
        now: int,
    ) -> None:
        with self._connect() as connection:
            if self._retain_seconds is not None:
                connection.execute(
                    "DELETE FROM agent_run WHERE retain_until IS NOT NULL AND retain_until <= ?",
                    (now,),
                )
            connection.execute(
                "INSERT OR REPLACE INTO agent_run "
                "(run_id, agent_id, checkpoint, expires_at, retain_until, created_at, "
                "resumed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
                (
                    run_id,
                    checkpoint.agent_id,
                    _encode(checkpoint),
                    expires_at,
                    self._retain_until(now),
                    now,
                ),
            )

    def _load(self, run_id: str, now: int) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT checkpoint, expires_at, resumed_at FROM agent_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise CheckpointRefusalError(
                    "unknown-run", f"no paused run is stored under {run_id!r}"
                )
            payload, expires_at, resumed_at = row
            if resumed_at is not None:
                raise CheckpointRefusalError(
                    "replayed", f"the run stored under {run_id!r} was already resumed"
                )
            if expires_at is not None and expires_at <= now:
                raise CheckpointRefusalError(
                    "expired", f"the run stored under {run_id!r} is past its resume window"
                )
            claimed = connection.execute(
                "UPDATE agent_run SET resumed_at = ? WHERE run_id = ? AND resumed_at IS NULL",
                (now, run_id),
            ).rowcount
            if claimed != 1:
                # Another writer claimed the row between the read and this update.
                raise CheckpointRefusalError(
                    "replayed", f"the run stored under {run_id!r} was already resumed"
                )
            return str(payload)


class PostgresRunStore:
    """The same claim in the database a ``state.kind: postgres`` document already names.

    ``ON CONFLICT (run_id) DO UPDATE`` makes a save idempotent, so a retried write cannot
    fail on a duplicate key, and ``UPDATE ... WHERE resumed_at IS NULL RETURNING`` makes
    the claim atomic across replicas -- which is the only place it can be atomic, since the
    next request may land anywhere. The driver is optional, following the nonce store: a
    deployment that never declares ``postgres`` pays nothing for it.
    """

    def __init__(self, dsn: str, *, retain_seconds: int | None = None) -> None:
        self._dsn = dsn
        self._retain_seconds = retain_seconds
        self._lock = asyncio.Lock()
        self._ready = False

    async def save(
        self,
        *,
        run_id: str,
        checkpoint: AgentCheckpoint,
        expires_at: int | None,
        now: int,
    ) -> None:
        async with self._lock:
            await asyncio.to_thread(self._save, run_id, checkpoint, expires_at, now)

    async def load(self, *, run_id: str, now: int) -> AgentCheckpoint:
        async with self._lock:
            return _decode(await asyncio.to_thread(self._load, run_id, now))

    def _retain_until(self, now: int) -> int | None:
        if self._retain_seconds is None:
            return None
        return now + self._retain_seconds

    def _connect(self) -> Any:
        psycopg = _load_psycopg()
        connection = psycopg.connect(self._dsn)
        if not self._ready:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS agent_run ("
                "run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, checkpoint TEXT NOT NULL, "
                "expires_at BIGINT, retain_until BIGINT, created_at BIGINT NOT NULL, "
                "resumed_at BIGINT)"
            )
            self._ready = True
        return connection

    def _save(
        self,
        run_id: str,
        checkpoint: AgentCheckpoint,
        expires_at: int | None,
        now: int,
    ) -> None:
        with self._connect() as connection:
            if self._retain_seconds is not None:
                connection.execute(
                    "DELETE FROM agent_run WHERE retain_until IS NOT NULL AND retain_until <= %s",
                    (now,),
                )
            connection.execute(
                "INSERT INTO agent_run "
                "(run_id, agent_id, checkpoint, expires_at, retain_until, created_at, "
                "resumed_at) VALUES (%s, %s, %s, %s, %s, %s, NULL) "
                "ON CONFLICT (run_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint, "
                "expires_at = EXCLUDED.expires_at, retain_until = EXCLUDED.retain_until",
                (
                    run_id,
                    checkpoint.agent_id,
                    _encode(checkpoint),
                    expires_at,
                    self._retain_until(now),
                    now,
                ),
            )

    def _load(self, run_id: str, now: int) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT checkpoint, expires_at, resumed_at FROM agent_run WHERE run_id = %s",
                (run_id,),
            ).fetchone()
            if row is None:
                raise CheckpointRefusalError(
                    "unknown-run", f"no paused run is stored under {run_id!r}"
                )
            _payload, expires_at, resumed_at = row
            if resumed_at is not None:
                raise CheckpointRefusalError(
                    "replayed", f"the run stored under {run_id!r} was already resumed"
                )
            if expires_at is not None and expires_at <= now:
                raise CheckpointRefusalError(
                    "expired", f"the run stored under {run_id!r} is past its resume window"
                )
            claimed = connection.execute(
                "UPDATE agent_run SET resumed_at = %s WHERE run_id = %s AND resumed_at IS NULL "
                "RETURNING checkpoint",
                (now, run_id),
            ).fetchone()
            if claimed is None:
                raise CheckpointRefusalError(
                    "replayed", f"the run stored under {run_id!r} was already resumed"
                )
            return str(claimed[0])


def _load_psycopg() -> Any:
    """Import the optional driver, or explain how to install it."""
    try:
        import psycopg
    except ImportError as error:
        raise ConfigurationError(
            "a `state: postgres` declaration needs its driver to store a paused run; "
            "install it with `pip install aid-runtime-python[pgvector]` (the default "
            "install omits psycopg)"
        ) from error
    return psycopg


def run_store_for(
    kind: str | None,
    location: str | None,
    *,
    retain_seconds: int | None = None,
) -> RunStore:
    """The most durable run store this build can offer for a declared ``state``.

    No declaration -- or a location that was not resolved from the environment -- falls
    back to the in-process store, which is exactly what such a document declared: a run
    that outlives the request and not the process. ``ir/resume-replay-weak`` reports it
    rather than this function raising, because a library embedding the loop must not be
    forced to own a database it never asked for.
    """
    if location:
        if kind == "sqlite":
            return SqliteRunStore(location, retain_seconds=retain_seconds)
        if kind == "postgres":
            return PostgresRunStore(location, retain_seconds=retain_seconds)
    return InProcessRunStore()


def run_store_from_env(
    kind: str | None,
    variable: str | None,
    *,
    retain_seconds: int | None = None,
) -> RunStore:
    """The store a generated app builds from the variable its ``agentState`` names.

    Resolved at request time rather than import, like every other credential this app
    reads: a supervisor that sets the variable before the first request is the normal
    deployment shape, and a module that opened a database at import could not be imported
    by a test that only wants ``DOCUMENT``.

    An unresolvable variable is refused by name, the same way
    :func:`aid_runtime.agents.resume.signer_from_env` refuses an unset signing key. The
    alternative -- quietly storing the run in one worker's memory -- would withdraw the
    durability the build gate promised while looking like it worked.
    """
    if kind is None:
        return InProcessRunStore()
    if variable is None:
        raise ConfigurationError(
            f"this app's state kind is {kind!r} but no urlEnv names where it lives; "
            "declare agentState.urlEnv so a paused run can be stored durably"
        )
    location = os.environ.get(variable, "")
    if not location:
        raise ConfigurationError(
            f"{variable} is not set, but this app declares a {kind} state store; set it to "
            "the connection string or file path, so a paused run is written where the next "
            "request can read it"
        )
    return run_store_for(kind, location, retain_seconds=retain_seconds)
