"""Provider adapter contract.

A provider translates the runtime's shapes into one wire protocol. It knows
nothing about aliases, budgets, or tracing -- those live in the gateway, so an
adapter stays a thin, independently testable translation layer.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from aid_runtime.types import Capability, CompletionRequest, CompletionResponse, ModelSpec

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

    async def aclose(self) -> None:
        """Release transport resources. Must be idempotent."""
        ...
