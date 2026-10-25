"""Provider adapter contract.

A provider translates the runtime's shapes into one wire protocol. It knows
nothing about aliases, budgets, or tracing -- those live in the gateway, so an
adapter stays a thin, independently testable translation layer.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    ModelSpec,
    StreamChunk,
)

__all__ = ["Provider"]


@runtime_checkable
class Provider(Protocol):
    """A single upstream model vendor endpoint."""

    @property
    def name(self) -> str:
        """Identifier referenced by :attr:`ModelSpec.provider`."""
        ...

    @property
    def capabilities(self) -> frozenset[Capability]:
        """What this endpoint can do at all, before per-model negotiation."""
        ...

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        """Perform one request/response call.

        Implementations must not retry in a way that hides which model answered:
        the gateway owns fallback and reports every attempt it made.
        """
        ...

    def stream(self, request: CompletionRequest, *, model: ModelSpec) -> AsyncIterator[StreamChunk]:
        """Stream one call as text deltas, ending with a usage-bearing chunk.

        Only adapters that advertise :attr:`Capability.STREAMING` implement this.
        The first delta must be yielded before the call completes, and the final
        chunk carries ``finish_reason`` and ``usage`` so the gateway can account
        for the stream exactly as it accounts for :meth:`complete`.
        """

    async def aclose(self) -> None:
        """Release transport resources. Must be idempotent."""
        ...
