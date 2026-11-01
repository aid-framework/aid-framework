"""Provider adapters.

Two wire dialects ship: OpenAI-compatible (which covers vLLM, Ollama, LiteLLM and
Azure's compatible endpoint) and Anthropic's Messages API, plus one deterministic
fake for tests and the eval-gate fixture. Bedrock and Vertex are transport
adapters over the same seam and are still out of scope.
"""

from __future__ import annotations

from aid_runtime.providers.anthropic import (
    ANTHROPIC_VERSION,
    DEFAULT_ANTHROPIC_BASE_URL,
    AnthropicProvider,
)
from aid_runtime.providers.base import Provider
from aid_runtime.providers.fake import FakeProvider, ScriptedTurn
from aid_runtime.providers.http import DEFAULT_BASE_URL, OpenAICompatibleProvider

__all__ = [
    "ANTHROPIC_VERSION",
    "DEFAULT_ANTHROPIC_BASE_URL",
    "DEFAULT_BASE_URL",
    "AnthropicProvider",
    "FakeProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "ScriptedTurn",
]
