"""Checkpoint integrity: signing, expiry and replay refusal for a paused run.

A paused run is continued by handing the checkpoint back to ``POST /agents/resume``, so
the checkpoint *is* the capability. Before this module it was a bearer capability with no
integrity: the body was parsed into :class:`AgentCheckpoint` and replayed, so anyone
holding one could edit an approval decision or swap the pending tool-call arguments and
the loop would execute the edited call. A signature is what turns "a body shaped like a
checkpoint" into "a checkpoint this app issued".

Four properties are enforced here, and each has its own refusal reason:

* ``"tampered"`` -- the HMAC does not match the payload the signer covered. The signature
  covers the *whole* checkpoint minus the signature itself, so a flipped approval
  decision, a swapped argument and an extended expiry all fail the same check rather than
  needing a field-by-field audit.
* ``"expired"`` -- ``expires_at`` (inside the signed payload, so it cannot be extended
  without breaking the signature) is in the past, allowing ``leeway_seconds`` of clock
  skew between the host that paused and the host that resumes.
* ``"unbound"`` -- the checkpoint was issued to a named principal and this caller is not
  that principal, or the caller presents no subject at all. The owner is a keyed hash of
  the principal's ``subject`` inside the signed payload, so it cannot be stripped or
  rewritten, only presented correctly.
* ``"replayed"`` -- the nonce was already claimed. Claiming is a store operation rather
  than an in-memory check because a replay across two processes is the interesting case.

Signing and owner binding are domain-separated: the same secret derives the checkpoint
MAC and the owner hash through different prefixes, so a value from one use can never be
presented as the other. The prefix is versioned (``aid.checkpoint.v2``) because changing
it is how a payload-format change invalidates in-flight checkpoints instead of silently
reinterpreting them.

The secret is a *value read from the environment*, never a value in the spec: the
generated app names the variable and this module fails loudly when it is unset, because a
missing secret must not degrade into "unsigned". A secret shorter than
:data:`MIN_SECRET_BYTES` is refused for the same reason a missing one is -- it looks set
and is not.

Refusal reasons are for the log, not the wire. The generated route answers every refusal
with one opaque 403, because the difference between "expired" and "tampered" is useful to
an operator and an oracle to an unauthenticated caller holding a guessed checkpoint.

Replay durability is limited by the nonce store, and that limit is real rather than
theoretical: :class:`InProcessNonceStore` forgets on restart and does not span replicas.
:class:`SqliteNonceStore` and :class:`PostgresNonceStore` are durable and are what a
``state.kind: sqlite`` or ``state.kind: postgres`` declaration gets; only a document that
declares no store at all falls back to the in-process one, which ``ir/resume-replay-weak``
states on the document rather than leaving to be discovered.

This module stores the *nonce*, not the run. The checkpoint for a paused run still returns
to the caller, so resuming after a restart is the application's to arrange -- see
:mod:`aid_runtime.agents.state`.
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
    "DEFAULT_CLOCK_LEEWAY_SECONDS",
    "MIN_SECRET_BYTES",
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

#: Tolerance for a clock difference between the host that paused and the host that
#: resumes. A pause is verified on whichever replica serves the resume request, so the two
#: clocks are not guaranteed equal; without this, a checkpoint could be refused as expired
#: by a replica that is seconds ahead. It widens the expiry by this much and no more.
DEFAULT_CLOCK_LEEWAY_SECONDS = 30

#: The shortest secret this module will sign with, in UTF-8 bytes. A 32-byte key is the
#: output size of SHA-256, so a shorter one caps the strength of the MAC below its own
#: hash. A secret that is set but weak is worse than one that is missing, because a
#: missing one is loud and a weak one looks configured.
MIN_SECRET_BYTES = 32

#: Domain separators. Prepended to the bytes each use signs, so the checkpoint MAC and the
#: owner hash can never be confused for one another even under one shared secret. The
#: ``v2`` suffix is the payload format version: bumping it is how a format change
#: invalidates in-flight checkpoints rather than reinterpreting them under new rules.
_CHECKPOINT_DOMAIN = b"aid.checkpoint.v2\x00"
_OWNER_DOMAIN = b"aid.checkpoint.owner.v2\x00"


def _same(expected: str, presented: str) -> bool:
    """Constant-time comparison of a computed hex digest against an untrusted string.

    Both sides are encoded before comparison. ``hmac.compare_digest`` refuses two ``str``
    arguments that contain non-ASCII characters, so comparing the decoded strings would
    turn a malicious checkpoint carrying a non-ASCII ``signature`` into a ``TypeError`` --
    a 500 for what is simply a bad signature. Comparing bytes makes any presented value
    comparable and therefore simply unequal.
    """
    return hmac.compare_digest(expected.encode("ascii"), presented.encode("utf-8"))


class CheckpointRefusalError(AidRuntimeError):
    """A resume body this app will not honour, with a stable machine-readable reason.

    ``reason`` is one of ``tampered``, ``expired``, ``unbound``, ``replayed`` or
    ``unsigned``. It is for the log: the generated route answers every one of them with
    the same opaque 403, so a caller cannot use the distinction as an oracle. Library
    embedders that want the distinction can read it here.
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
    ``issued_at``, ``expires_at``, ``owner`` and ``nonce``: leaving those out would let a
    holder move their deadline forward or rebind the checkpoint to themselves, and would
    let them swap the nonce of an already-spent checkpoint to walk past replay protection.
    The pending calls, the approval channel and the nested ``caller`` frames are inside
    too, so one signature binds all of them. Sorted keys and no separator padding make the
    encoding reproducible in a second process, which a signature requires.

    There is deliberately no ``default=`` fallback for a value JSON cannot represent. A
    fallback stringifies it, and two different values that stringify alike would produce
    the same payload for different checkpoints -- a collision in the thing being signed.
    A checkpoint that cannot be encoded is refused instead, and the model's own strictness
    is what should have stopped it reaching here.

    The dump runs in JSON mode before this function, so a value pydantic can *normalise*
    is normalised rather than refused: a ``NaN`` in ``when`` reaches the encoder as
    ``null``. That is not the same as the fallback above, because the loop never
    interprets such a value -- the two forms are the same checkpoint to every reader,
    rather than two checkpoints the signature cannot tell apart.
    """
    try:
        document = checkpoint.model_dump(mode="json", exclude={"integrity": {"signature"}})
        encoded = json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ConfigurationError(
            f"a checkpoint for agent {checkpoint.agent_id!r} cannot be signed because its "
            f"payload is not canonical JSON ({error}); a value the encoder has to guess at "
            "is a value a signature cannot bind"
        ) from error
    return encoded.encode("utf-8")


@dataclass(frozen=True, slots=True)
class CheckpointSigner:
    """HMAC-SHA256 over :func:`checkpoint_payload`, plus the expiry it records.

    ``secret`` is read from the environment by the caller; it is never a spec value. The
    dataclass is frozen and holds no mutable state, so one instance can be shared across
    requests and a test can construct its own without touching the process environment.

    ``previous`` is the secret being rotated out. It is accepted for verification only, so
    a checkpoint issued before a rotation still resumes; it never signs. Rotation is
    bounded by the checkpoint TTL rather than by this field: a checkpoint lives for
    ``ttl_seconds``, so a retired secret is worth keeping for exactly that long and no
    longer, and dropping it after that is what makes the rotation a rotation rather than a
    permanent second key.
    """

    secret: str = field(repr=False)
    ttl_seconds: int = DEFAULT_CHECKPOINT_TTL_MINUTES * 60
    previous: str | None = field(default=None, repr=False)
    leeway_seconds: int = DEFAULT_CLOCK_LEEWAY_SECONDS

    def __post_init__(self) -> None:
        for name, value in (("secret", self.secret), ("previous", self.previous)):
            if value is None:
                continue
            if not value:
                raise ValueError(
                    f"CheckpointSigner needs a non-empty {name}; an empty key would sign "
                    "every checkpoint identically"
                )
            size = len(value.encode("utf-8"))
            if size < MIN_SECRET_BYTES:
                raise ValueError(
                    f"CheckpointSigner needs a {name} of at least {MIN_SECRET_BYTES} "
                    f"bytes; this one is {size}. A key shorter than the hash it feeds "
                    "lowers the strength of every signature it makes"
                )
        if self.previous is not None and self.previous == self.secret:
            raise ValueError(
                "CheckpointSigner was given the same value for secret and previous; a "
                "rotation has to name two different keys, or it has rotated nothing"
            )
        if self.ttl_seconds <= 0:
            raise ValueError("CheckpointSigner needs a positive ttl_seconds")
        if self.leeway_seconds < 0:
            raise ValueError("CheckpointSigner needs a non-negative leeway_seconds")

    @staticmethod
    def _mac(key: bytes, domain: bytes, payload: bytes) -> str:
        return hmac.new(key, domain + payload, hashlib.sha256).hexdigest()

    def _digest(self, checkpoint: AgentCheckpoint, key: bytes | None = None) -> str:
        """The MAC of ``checkpoint`` excluding only the signature field.

        Signing and verifying both go through here, so the two sides cannot drift into
        covering different bytes: a signature that verifies against a payload it was not
        computed over would accept an edited checkpoint.
        """
        material = self.secret.encode("utf-8") if key is None else key
        return self._mac(material, _CHECKPOINT_DOMAIN, checkpoint_payload(checkpoint))

    @staticmethod
    def owner_of(subject: str | None, *, key: bytes) -> str:
        """The keyed hash a checkpoint carries for ``subject``, or ``""`` for none.

        A keyed hash rather than the subject itself: the checkpoint body travels through
        the caller, so writing a user id into it would hand every holder an identifier
        they did not already have. The key is what makes the hash unguessable, and the
        domain is what keeps it from ever equalling a signature.
        """
        if not subject:
            return ""
        return CheckpointSigner._mac(key, _OWNER_DOMAIN, subject.encode("utf-8"))

    def sign(
        self,
        checkpoint: AgentCheckpoint,
        *,
        subject: str | None = None,
        now: int | None = None,
        nonce: str | None = None,
    ) -> AgentCheckpoint:
        """Return a copy of ``checkpoint`` carrying a fresh integrity block.

        ``subject`` is the verified identity of the principal pausing the run. When it is
        absent the checkpoint is signed but unbound, which is the honest result for a
        principal that carries no subject: there is nothing to bind to.

        ``now`` and ``nonce`` exist for tests; production passes neither. The return is a
        new frozen model, so a caller that kept the unsigned value still has it.
        """
        issued_at = int(time.time()) if now is None else int(now)
        integrity = CheckpointIntegrity(
            issued_at=issued_at,
            expires_at=issued_at + self.ttl_seconds,
            nonce=secrets.token_urlsafe(24) if nonce is None else nonce,
            owner=self.owner_of(subject, key=self.secret.encode("utf-8")),
            signature="",
        )
        unsigned = checkpoint.model_copy(update={"integrity": integrity})
        signature = self._digest(unsigned)
        return checkpoint.model_copy(
            update={"integrity": integrity.model_copy(update={"signature": signature})}
        )

    def verify(
        self,
        checkpoint: AgentCheckpoint,
        *,
        subject: str | None = None,
        now: int | None = None,
    ) -> CheckpointIntegrity:
        """Check signature, expiry and owner binding. Returns the block, or raises.

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
        key = self._verifying_key(checkpoint, integrity)
        moment = int(time.time()) if now is None else int(now)
        if integrity.expires_at + self.leeway_seconds <= moment:
            raise CheckpointRefusalError(
                "expired",
                f"this checkpoint expired at {integrity.expires_at}; a pause is valid for "
                f"{self.ttl_seconds} seconds, so resume it sooner or start the run again",
            )
        if integrity.owner:
            # The owner hash was derived from whichever key signed this checkpoint, so it
            # is recomputed with that same key: after a rotation the current secret would
            # produce a hash that never matches a checkpoint the previous one issued.
            if not subject:
                raise CheckpointRefusalError(
                    "unbound",
                    "this checkpoint was issued to a named principal, and the caller "
                    "presented no subject, so there is no identity to check it against",
                )
            expected_owner = self.owner_of(subject, key=key)
            if not _same(expected_owner, integrity.owner):
                raise CheckpointRefusalError(
                    "unbound",
                    "this checkpoint was issued to a different principal; a resume is "
                    "accepted only from the caller who paused the run",
                )
        return integrity

    def _verifying_key(self, checkpoint: AgentCheckpoint, integrity: CheckpointIntegrity) -> bytes:
        """The key this checkpoint's signature verifies under, or a refusal.

        The current secret is tried first and the retired one second, so a rotation takes
        effect immediately for new checkpoints and stays compatible for the TTL of the old
        ones. Both attempts go through the same comparison, so which key matched is not
        something a caller can observe.
        """
        current = self.secret.encode("utf-8")
        if _same(self._digest(checkpoint, current), integrity.signature):
            return current
        if self.previous is not None:
            retired = self.previous.encode("utf-8")
            if _same(self._digest(checkpoint, retired), integrity.signature):
                return retired
        raise CheckpointRefusalError(
            "tampered",
            "this checkpoint's signature does not match its contents; it was edited "
            "after it was issued",
        )

    async def accept(
        self,
        checkpoint: AgentCheckpoint,
        nonces: NonceStore,
        *,
        subject: str | None = None,
        now: int | None = None,
    ) -> CheckpointIntegrity:
        """Signature, then expiry, then owner, then a one-time claim. Raises on failure."""
        moment = int(time.time()) if now is None else int(now)
        integrity = self.verify(checkpoint, subject=subject, now=moment)
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
    """Build a signer from ``os.environ[variable]``, naming the variable when it is unset.

    ``{variable}_PREVIOUS`` is read as the secret being rotated out, when it is set. A
    rotation is therefore a deployment in two steps -- set ``_PREVIOUS`` to the old value
    and the variable to the new one, then unset ``_PREVIOUS`` once the checkpoint TTL has
    passed -- and neither step requires downtime.
    """
    secret = os.environ.get(variable, "")
    if not secret:
        raise ConfigurationError(
            f"{variable} is not set, but this app signs its checkpoints; set it to a "
            "high-entropy secret before serving the resume route"
        )
    previous = os.environ.get(f"{variable}_PREVIOUS", "") or None
    try:
        return CheckpointSigner(secret=secret, ttl_seconds=ttl_seconds, previous=previous)
    except ValueError as error:
        raise ConfigurationError(f"{variable}: {error}") from error


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
