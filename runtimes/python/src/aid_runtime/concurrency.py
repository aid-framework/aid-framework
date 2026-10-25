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

from aid_runtime.errors import ConfigurationError

__all__ = ["ConcurrencyLimiter"]


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
        """
        async with self._semaphore:
            yield
