"""Provider adapters.

Three wire dialects ship: OpenAI-compatible (which covers vLLM, Ollama, LiteLLM and
Azure's compatible endpoint), Anthropic's Messages API, and Amazon Bedrock's
Converse API, plus one deterministic fake for tests and the eval-gate fixture.
Bedrock is signed with SigV4 rather than keyed, which is why it cannot be an
OpenAI-compatible base URL. Vertex is a transport adapter over the same seam and
is still out of scope.
"""

from __future__ import annotations

from aid_runtime.providers.anthropic import (
    ANTHROPIC_VERSION,
    DEFAULT_ANTHROPIC_BASE_URL,
    AnthropicProvider,
)
from aid_runtime.providers.base import Provider
from aid_runtime.providers.bedrock import (
    BEDROCK_SERVICE,
    BedrockProvider,
    default_bedrock_base_url,
    rfc3986,
)
from aid_runtime.providers.fake import FakeProvider, ScriptedTurn
from aid_runtime.providers.http import DEFAULT_BASE_URL, OpenAICompatibleProvider

__all__ = [
    "ANTHROPIC_VERSION",
    "BEDROCK_SERVICE",
    "DEFAULT_ANTHROPIC_BASE_URL",
    "DEFAULT_BASE_URL",
    "AnthropicProvider",
    "BedrockProvider",
    "FakeProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "ScriptedTurn",
    "default_bedrock_base_url",
    "rfc3986",
]
