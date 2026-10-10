"""Provider adapters.

Exactly two ship in Phase 0: one real HTTP adapter and one deterministic fake for
tests and the eval-gate fixture. Provider breadth (Anthropic, Azure, Bedrock) is
deliberately out of scope.
"""

from __future__ import annotations

from aid_runtime.providers.base import Provider
from aid_runtime.providers.fake import FakeProvider
from aid_runtime.providers.http import DEFAULT_BASE_URL, OpenAICompatibleProvider

__all__ = [
    "DEFAULT_BASE_URL",
    "FakeProvider",
    "OpenAICompatibleProvider",
    "Provider",
]
