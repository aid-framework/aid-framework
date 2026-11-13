"""Checkpoint integrity: signing, expiry and replay refusal for a paused run.

A paused run is continued by handing the checkpoint back to ``POST /agents/resume``, so
the checkpoint *is* the capability. Before this module it was a bearer capability with no
integrity: the body was parsed into :class:`AgentCheckpoint` and replayed, so anyone
holding one could edit an approval decision or swap the pending tool-call arguments and
the loop would execute the edited call. A signature is what turns "a body shaped like a
checkpoint" into "a checkpoint this app issued".

Three properties are enforced here, and each has its own refusal reason:

* ``"tampered"`` -- the HMAC does not match the payload the signer covered. The signature
  covers the *whole* checkpoint minus the signature itself, so a flipped approval
  decision, a swapped argument and an extended expiry all fail the same check rather than
  needing a field-by-field audit.
* ``"expired"`` -- ``expires_at`` (inside the signed payload, so it cannot be extended
  without breaking the signature) is in the past.
* ``"replayed"`` -- the nonce was already claimed. Claiming is a store operation rather
  than an in-memory check because a replay across two processes is the interesting case.

The secret is a *value read from the environment*, never a value in the spec: the
generated app names the variable and this module fails loudly when it is unset, because a
missing secret must not degrade into "unsigned".

Replay durability is limited by the nonce store, and that limit is real rather than
theoretical: :class:`InProcessNonceStore` forgets on restart and does not span replicas.
:class:`SqliteNonceStore` is durable and is what a ``state.kind: sqlite`` declaration
gets. A ``state.kind: postgres`` declaration is served in-process for now, which the
``ir/resume-replay-weak`` gate states on the document rather than leaving to be
discovered.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from aid_runtime.agents.state import AgentCheckpoint, CheckpointIntegrity
from aid_runtime.errors import AidRuntimeError, ConfigurationError

__all__ = [
    "DEFAULT_CHECKPOINT_TTL_MINUTES",
    "CheckpointRefusalError",
    "CheckpointSigner",
    "InProcessNonceStore",
    "NonceStore",
    "PostgresNonceStore",
    "SqliteNonceStore",
    "checkpoint_payload",
    "nonce_store_for",
    "signer_from_env",
]

#: How long a checkpoint stays usable. Short on purpose: a pause is a question asked of
#: a person in the same change window, not a durable queue.
DEFAULT_CHECKPOINT_TTL_MINUTES = 15


class CheckpointRefusalError(AidRuntimeError):
    """A resume body this app will not honour, with a stable machine-readable reason.

    ``reason`` is one of ``tampered``, ``expired``, ``replayed``, ``unsigned``. The
    generated route maps it to a 403 and returns it as ``detail.reason``, so a caller can
    tell "your checkpoint expired" from "your checkpoint was edited" without parsing
    prose.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@runtime_checkable
class NonceStore(Protocol):
    """Remembers which checkpoints have been spent.

    ``claim`` must be atomic: two concurrent requests presenting the same checkpoint may
    both reach it, and exactly one must be told ``True``. A store that reads then writes
    would let both through.
    """

    async def claim(self, *, nonce: str, expires_at: int, now: int) -> bool:
        """``True`` the first time ``nonce`` is seen, ``False`` every time after.

        ``now`` is the caller's clock, not this store's, so the pruning horizon and the
        expiry the signer checked cannot disagree. A store that read the wall clock while
        the signer took an injected one would prune a row before the replay check and
        accept the replay.
        """
        ...


class InProcessNonceStore:
    """A dict, and therefore a limit worth stating.

    It is the honest default: a library must not decide where a host keeps its data. It
    survives neither a restart nor a second replica, so a checkpoint replayed against
    another worker is accepted there. ``profile: enterprise`` with no declared ``state``
    is refused by ``ir/resume-replay-weak`` for exactly this reason.
    """

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def claim(self, *, nonce: str, expires_at: int, now: int) -> bool:
        async with self._lock:
            self._seen = {seen: expiry for seen, expiry in self._seen.items() if expiry > now}
            if nonce in self._seen:
                return False
            self._seen[nonce] = expires_at
            return True


class SqliteNonceStore:
    """A file, and therefore durable across a restart.

    ``INSERT OR IGNORE`` is the atomic claim: SQLite reports whether it inserted, so two
    workers sharing the file cannot both see ``True``. This is what a ``state.kind:
    sqlite`` declaration is served by, because that declaration already means "a file on
    a volume this process can reach".
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()

    async def claim(self, *, nonce: str, expires_at: int, now: int) -> bool:
        async with self._lock:
            return await asyncio.to_thread(self._claim, nonce, expires_at, now)

    def _claim(self, nonce: str, expires_at: int, now: int) -> bool:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self._path) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS checkpoint_nonce ("
                "nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)"
            )
            connection.execute("DELETE FROM checkpoint_nonce WHERE expires_at <= ?", (now,))
            cursor = connection.execute(
                "INSERT OR IGNORE INTO checkpoint_nonce (nonce, expires_at) VALUES (?, ?)",
                (nonce, expires_at),
            )
            return cursor.rowcount == 1


class PostgresNonceStore:
    """The same claim in the database the document already names.

    ``state.kind: postgres`` is the enterprise answer, so replay protection has to live
    there rather than in a process: the whole point of a shared store is that the next
    request may land anywhere. ``ON CONFLICT DO NOTHING`` plus ``RETURNING`` makes the
    claim atomic in the database, which is the only place a claim can be atomic across
    replicas.

    The driver is optional, following the pgvector store: a deployment that never
    declares `postgres` pays nothing for it, and one that does is told which extra to
    install rather than discovering it at the first paused run.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._lock = asyncio.Lock()
        self._ready = False

    async def claim(self, *, nonce: str, expires_at: int, now: int) -> bool:
        async with self._lock:
            return await asyncio.to_thread(self._claim, nonce, expires_at, now)

    def _claim(self, nonce: str, expires_at: int, now: int) -> bool:
        psycopg = _load_psycopg()
        with psycopg.connect(self._dsn) as connection:
            if not self._ready:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS checkpoint_nonce ("
                    "nonce TEXT PRIMARY KEY, expires_at BIGINT NOT NULL)"
                )
                self._ready = True
            connection.execute("DELETE FROM checkpoint_nonce WHERE expires_at <= %s", (now,))
            row = connection.execute(
                "INSERT INTO checkpoint_nonce (nonce, expires_at) VALUES (%s, %s) "
                "ON CONFLICT (nonce) DO NOTHING RETURNING nonce",
                (nonce, expires_at),
            ).fetchone()
            return row is not None


def _load_psycopg() -> Any:
    """Import the optional driver, or explain how to install it."""
    try:
        import psycopg
    except ImportError as error:
        raise ConfigurationError(
            "a `state: postgres` declaration needs its driver for replay protection; "
            "install it with `pip install aid-runtime-python[pgvector]` (the default "
            "install omits psycopg)"
        ) from error
    return psycopg


def checkpoint_payload(checkpoint: AgentCheckpoint) -> bytes:
    """The canonical bytes a signature covers.

    Everything except the signature itself. That includes the integrity block's own
    ``issued_at``, ``expires_at`` and ``nonce``: leaving those out would let a holder
    move their deadline forward, and would let them swap the nonce of an already-spent
    checkpoint to walk past replay protection. The pending calls, the approval channel
    and the nested ``caller`` frames are inside too, so one signature binds all of them.
    Sorted keys and no separator padding make the encoding reproducible in a second
    process, which a signature requires.
    """
    document = checkpoint.model_dump(mode="json", exclude={"integrity": {"signature"}})
    return json.dumps(
        document,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")


@dataclass(frozen=True, slots=True)
class CheckpointSigner:
    """HMAC-SHA256 over :func:`checkpoint_payload`, plus the expiry it records.

    ``secret`` is read from the environment by the caller; it is never a spec value. The
    dataclass is frozen and holds no mutable state, so one instance can be shared across
    requests and a test can construct its own without touching the process environment.
    """

    secret: str = field(repr=False)
    ttl_seconds: int = DEFAULT_CHECKPOINT_TTL_MINUTES * 60

    def __post_init__(self) -> None:
        if not self.secret:
            raise ValueError(
                "CheckpointSigner needs a non-empty secret; an empty key would sign "
                "every checkpoint identically"
            )
        if self.ttl_seconds <= 0:
            raise ValueError("CheckpointSigner needs a positive ttl_seconds")

    def _mac(self, payload: bytes) -> str:
        return hmac.new(self.secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()

    def _digest(self, checkpoint: AgentCheckpoint) -> str:
        """The MAC of ``checkpoint`` excluding only the signature field.

        Signing and verifying both go through here, so the two sides cannot drift into
        covering different bytes: a signature that verifies against a payload it was not
        computed over would accept an edited checkpoint.
        """
        return self._mac(checkpoint_payload(checkpoint))

    def sign(
        self,
        checkpoint: AgentCheckpoint,
        *,
        now: int | None = None,
        nonce: str | None = None,
    ) -> AgentCheckpoint:
        """Return a copy of ``checkpoint`` carrying a fresh integrity block.

        ``now`` and ``nonce`` exist for tests; production passes neither. The return is a
        new frozen model, so a caller that kept the unsigned value still has it.
        """
        issued_at = int(time.time()) if now is None else int(now)
        integrity = CheckpointIntegrity(
            issued_at=issued_at,
            expires_at=issued_at + self.ttl_seconds,
            nonce=secrets.token_urlsafe(24) if nonce is None else nonce,
            signature="",
        )
        unsigned = checkpoint.model_copy(update={"integrity": integrity})
        signature = self._digest(unsigned)
        return checkpoint.model_copy(
            update={"integrity": integrity.model_copy(update={"signature": signature})}
        )

    def verify(self, checkpoint: AgentCheckpoint, *, now: int | None = None) -> CheckpointIntegrity:
        """Check signature and expiry. Returns the integrity block, or raises.

        Replay is *not* checked here: it needs the store, and therefore an ``await``.
        :meth:`accept` is the full check a request handler wants.
        """
        integrity = checkpoint.integrity
        if integrity is None:
            raise CheckpointRefusalError(
                "unsigned",
                "this checkpoint carries no signature, so it was not issued by an app "
                "built with checkpoint signing",
            )
        expected = self._digest(checkpoint)
        if not hmac.compare_digest(expected, integrity.signature):
            raise CheckpointRefusalError(
                "tampered",
                "this checkpoint's signature does not match its contents; it was edited "
                "after it was issued",
            )
        moment = int(time.time()) if now is None else int(now)
        if integrity.expires_at <= moment:
            raise CheckpointRefusalError(
                "expired",
                f"this checkpoint expired at {integrity.expires_at}; a pause is valid for "
                f"{self.ttl_seconds} seconds, so resume it sooner or start the run again",
            )
        return integrity

    async def accept(
        self,
        checkpoint: AgentCheckpoint,
        nonces: NonceStore,
        *,
        now: int | None = None,
    ) -> CheckpointIntegrity:
        """Signature, then expiry, then a one-time claim. Raises on any failure."""
        moment = int(time.time()) if now is None else int(now)
        integrity = self.verify(checkpoint, now=moment)
        claimed = await nonces.claim(
            nonce=integrity.nonce, expires_at=integrity.expires_at, now=moment
        )
        if not claimed:
            raise CheckpointRefusalError(
                "replayed",
                "this checkpoint has already been spent; a resume is accepted once, so a "
                "second presentation of the same checkpoint is refused",
            )
        return integrity


def signer_from_env(
    variable: str, *, ttl_seconds: int = DEFAULT_CHECKPOINT_TTL_MINUTES * 60
) -> CheckpointSigner:
    """Build a signer from ``os.environ[variable]``, naming the variable when it is unset."""
    secret = os.environ.get(variable, "")
    if not secret:
        raise ConfigurationError(
            f"{variable} is not set, but this app signs its checkpoints; set it to a "
            "high-entropy secret before serving the resume route"
        )
    return CheckpointSigner(secret=secret, ttl_seconds=ttl_seconds)


def nonce_store_for(kind: str | None, location: str | None) -> NonceStore:
    """The most durable nonce store this build can offer for a declared ``state``.

    Each declared kind claims the nonce where that declaration already points: ``sqlite``
    names a file, ``postgres`` names a database. Both are durable across a restart and
    across replicas. No declaration -- or a location that was not resolved from the
    environment -- falls back to the in-process store, which ``ir/resume-replay-weak``
    reports rather than this function hiding.
    """
    if location:
        if kind == "sqlite":
            return SqliteNonceStore(location)
        if kind == "postgres":
            return PostgresNonceStore(location)
    return InProcessNonceStore()


def nonce_store_from_env(kind: str | None, variable: str | None) -> NonceStore:
    """The store a generated app builds from the variable its ``state`` declaration names.

    ``nonce_store_for`` falls back to the in-process store when it is handed no location,
    which is right for a library and wrong here: the document declared a durable store, and
    silently claiming the nonce in one worker would withdraw the replay protection the
    build gate promised. So an unresolvable variable is refused by name, the same way
    :func:`signer_from_env` refuses an unset signing key.

    ``kind`` of ``None`` means the document declared no store at all -- ``standard`` with a
    warning from ``ir/resume-replay-weak`` -- and then the in-process store is exactly what
    was declared, so it is returned rather than refused.
    """
    if kind is None:
        return InProcessNonceStore()
    if variable is None:
        raise ConfigurationError(
            f"this app's state kind is {kind!r} but no urlEnv names where it lives; "
            "declare state.urlEnv so a spent checkpoint can be claimed durably"
        )
    location = os.environ.get(variable, "")
    if not location:
        raise ConfigurationError(
            f"{variable} is not set, but this app declares a {kind} state store; set it to "
            "the connection string or file path, so a spent checkpoint is refused there "
            "rather than only in the process that issued it"
        )
    return nonce_store_for(kind, location)
