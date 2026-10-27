"""A single shared concurrency limiter for a generated application.

``deployments.concurrency`` produces exactly one :class:`ConcurrencyLimiter`. The
model gateway, the tool executor, and the agent engine's delegation all acquire it,
so there is one limiter -- not one per component -- and a single cap bounds every
unit of work the app performs concurrently.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar

from aid_runtime.errors import ConfigurationError

__all__ = ["ConcurrencyLimiter", "holds_slot"]

#: Whether the current task is already inside :meth:`ConcurrencyLimiter.run`.
#:
#: A fan-out worker holds a slot for its whole body, and that body's model and tool
#: calls acquire the same limiter. Acquiring twice would deadlock at a cap of one,
#: so an acquisition made while a slot is already held is a no-op: the work is
#: already counted against the cap above it. The flag is a ``ContextVar`` because
#: each worker runs in its own task, and a task's copy must not leak to a sibling.
_HELD: ContextVar[bool] = ContextVar("aid_runtime_holds_slot", default=False)


def holds_slot() -> bool:
    """Whether this task already holds a slot of the limiter it would acquire."""
    return _HELD.get()


class ConcurrencyLimiter:
    """An ``asyncio.Semaphore`` with a name and an explicit, validated cap.

    Sharing the same instance between the gateway and the executor is what makes
    "one limiter, not two" true: both acquire the same counter, so tool calls and
    model calls draw from the same budget of concurrent slots.
    """

    def __init__(self, limit: int) -> None:
        if limit < 1:
            raise ConfigurationError(f"concurrency must be at least 1, got {limit}")
        self.limit = limit
        self._semaphore = asyncio.Semaphore(limit)

    @asynccontextmanager
    async def run(self) -> AsyncIterator[None]:
        """Hold one slot for the duration of a single unit of work.

        Cancellation and errors release the slot: ``asyncio.Semaphore`` is an async
        context manager whose ``__aexit__`` releases on both the normal and
        exceptional paths, so a cancelled or failed call cannot leak capacity.

        Nested acquisition inside an already-held slot yields at once rather than
        waiting: the enclosing unit of work is already counted, and waiting would
        deadlock at a cap of one, where the fan-out worker holding the only slot is
        the caller of the gateway that wants it.
        """
        if _HELD.get():
            yield
            return
        async with self._semaphore:
            token = _HELD.set(True)
            try:
                yield
            finally:
                _HELD.reset(token)
