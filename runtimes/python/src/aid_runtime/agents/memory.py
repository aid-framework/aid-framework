"""Agent memory: thread scope, and one durable adapter.

Ratified decision D5 draws the line this module implements: in-process memory is
the default, exactly one store-backed adapter ships, and there is no plugin zoo.
A ``backend`` naming a declared store is served by whatever store the caller
registered under that id; with none registered, the in-process store answers.

``thread`` scope is the checkpointer unit -- the conversation the loop is already
carrying -- so it needs no store and no key. ``user`` and ``global`` scope are the
cross-run facts, keyed by a caller-supplied key and stored behind
:class:`MemoryStore`. The IR vocabulary is ``thread``/``user``/``global``; the
``session`` spelling L1 removed is not reintroduced here.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol, runtime_checkable

from aid_runtime.cost import estimate_tokens
from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.types import Message

__all__ = [
    "IMPLEMENTED_MEMORY_KINDS",
    "MEMORY_SCOPES",
    "FileMemoryStore",
    "InProcessMemoryStore",
    "MemoryStore",
    "ThreadMemory",
    "check_memory_supported",
    "render_context",
]

#: The IR's scope vocabulary. ``session`` is deliberately absent.
MEMORY_SCOPES = ("thread", "user", "global")

#: The kinds served without a summarizer or an embedding model. The rest are
#: declared in the IR and refused by name, never silently downgraded.
IMPLEMENTED_MEMORY_KINDS = ("buffer", "window")


@runtime_checkable
class MemoryStore(Protocol):
    """Append-only, scoped storage behind the memory scopes that outlive a run."""

    async def read(self, *, scope: str, key: str) -> tuple[str, ...]:
        """Every value recorded for ``(scope, key)``, oldest first."""
        ...

    async def append(self, *, scope: str, key: str, value: str) -> None:
        """Record one value. Append-only is what makes replay deterministic."""
        ...


class InProcessMemoryStore:
    """The default: a dict, lost when the process ends.

    That is the honest default for a library that must not decide where a host
    application keeps its data. A durable adapter is opt-in, and there is one.
    """

    def __init__(self) -> None:
        self._values: dict[tuple[str, str], list[str]] = {}

    async def read(self, *, scope: str, key: str) -> tuple[str, ...]:
        return tuple(self._values.get((scope, key), ()))

    async def append(self, *, scope: str, key: str, value: str) -> None:
        self._values.setdefault((scope, key), []).append(value)

    def clear(self) -> None:
        self._values.clear()


class FileMemoryStore:
    """One JSON file, one lock-free writer.

    The file is rewritten through a temporary file and an atomic replace so a crash
    mid-write cannot leave a half-file that a later read would parse as truth.
    Writes are serialized by an ``asyncio.Lock``; the file I/O itself runs in a
    worker thread so the loop is not blocked by disk.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()

    @property
    def path(self) -> Path:
        return self._path

    async def read(self, *, scope: str, key: str) -> tuple[str, ...]:
        data = await asyncio.to_thread(self._load)
        return tuple(data.get(scope, {}).get(key, ()))

    async def append(self, *, scope: str, key: str, value: str) -> None:
        async with self._lock:
            data = await asyncio.to_thread(self._load)
            data.setdefault(scope, {}).setdefault(key, []).append(value)
            await asyncio.to_thread(self._save, data)

    def _load(self) -> dict[str, dict[str, list[str]]]:
        if not self._path.exists():
            return {}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigurationError(f"memory store {self._path} is unreadable: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigurationError(f"memory store {self._path} is not a JSON object")
        return {
            str(scope): {str(key): [str(value) for value in values] for key, values in keys.items()}
            for scope, keys in raw.items()
            if isinstance(keys, dict)
        }

    def _save(self, data: dict[str, dict[str, list[str]]]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(
            dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(data, stream, sort_keys=True, separators=(",", ":"))
            Path(temporary).replace(self._path)
        except OSError:
            Path(temporary).unlink(missing_ok=True)
            raise


def check_memory_supported(
    *,
    memory_id: str,
    kind: str,
    summarize_model: str | None,
    ttl: str | None,
    redact: Sequence[str],
) -> None:
    """Refuse a declared memory the runtime cannot honour exactly.

    ``summary``, ``semantic``, ``episodic`` and ``vector`` would each need a model
    or an index that L2 does not have, and so would ``summarizeModel``; ``ttl``
    needs a clock and ``redact`` needs redaction on the tracing path. Serving them
    approximately would make the declaration lie, so they are refused by name.
    """
    if kind not in IMPLEMENTED_MEMORY_KINDS:
        raise FeatureDeferredError(
            f"memory {memory_id!r} asks for kind {kind!r}; L2 implements "
            f"{', '.join(IMPLEMENTED_MEMORY_KINDS)} and refuses the rest by name"
        )
    if summarize_model is not None:
        raise FeatureDeferredError(
            f"memory {memory_id!r} names summarizeModel {summarize_model!r}; "
            "no summarizer is implemented, so an unbounded buffer is served instead"
        )
    if ttl is not None:
        raise FeatureDeferredError(
            f"memory {memory_id!r} declares ttl {ttl!r}; expiry enforcement is not implemented"
        )
    if redact:
        raise FeatureDeferredError(
            f"memory {memory_id!r} declares redaction rules; memory redaction is not implemented"
        )


class ThreadMemory:
    """Bounds the transcript a single agent turn may replay.

    ``thread`` scope is the conversation the loop is already carrying, so this is
    a trimmer rather than a store: when the transcript exceeds ``token_budget``,
    whole tool-call groups are dropped oldest-first. A group is an assistant turn
    with its tool observations, because dropping one without the other would
    replay a tool result whose call is gone.

    A message larger than the whole budget is kept rather than truncated: half a
    tool observation is worse than an over-budget one, and the budget is a target
    for what to *replay*, not a hard accounting ceiling.
    """

    def __init__(self, token_budget: int | None = None) -> None:
        if token_budget is not None and token_budget < 1:
            raise ConfigurationError("thread memory tokenBudget must be positive")
        self._token_budget = token_budget

    @property
    def token_budget(self) -> int | None:
        return self._token_budget

    def tokens(self, messages: Sequence[Message]) -> int:
        return sum(estimate_tokens(message.content) for message in messages)

    def trim(self, messages: Sequence[Message]) -> tuple[Message, ...]:
        if self._token_budget is None:
            return tuple(messages)
        kept = list(messages)
        total = self.tokens(kept)
        start = next(
            (index for index, message in enumerate(kept) if message.tool_calls),
            len(kept),
        )
        while total > self._token_budget and start < len(kept):
            end = start + 1
            while end < len(kept) and kept[end].role == "tool":
                end += 1
            total -= self.tokens(kept[start:end])
            del kept[start:end]
        while total > self._token_budget:
            victim = next(
                (
                    index
                    for index, message in enumerate(kept)
                    if message.role != "system" and index < len(kept) - 1
                ),
                None,
            )
            if victim is None:
                break
            total -= estimate_tokens(kept[victim].content)
            del kept[victim]
        return tuple(kept)


def render_context(entries: Sequence[str], token_budget: int) -> tuple[str, int]:
    """Fit stored entries into ``token_budget``, newest first. Returns text, tokens."""
    chosen: list[str] = []
    tokens = 0
    for entry in reversed(entries):
        cost = estimate_tokens(entry) + 1
        if chosen and tokens + cost > token_budget:
            break
        chosen.append(entry)
        tokens += cost
        if tokens >= token_budget:
            break
    return "\n".join(reversed(chosen)), tokens
