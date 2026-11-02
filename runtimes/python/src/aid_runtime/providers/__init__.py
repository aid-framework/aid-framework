"""Provider adapters.

Four wire dialects ship: OpenAI-compatible (which covers vLLM, Ollama, LiteLLM
and Azure's compatible endpoint), Anthropic's Messages API, Amazon Bedrock's
Converse API, and Vertex AI's ``generateContent``. Bedrock is signed with SigV4
and Vertex is OAuth2-bearer, which is why neither can be an OpenAI-compatible
base URL. A fifth, deterministic fake serves tests and the eval-gate fixture.
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
from aid_runtime.providers.vertex import (
    DEFAULT_VERTEX_LOCATION,
    METADATA_TOKEN_URL,
    VERTEX_TOKEN_ENV,
    VertexProvider,
    default_vertex_base_url,
)

__all__ = [
    "ANTHROPIC_VERSION",
    "BEDROCK_SERVICE",
    "DEFAULT_ANTHROPIC_BASE_URL",
    "DEFAULT_BASE_URL",
    "DEFAULT_VERTEX_LOCATION",
    "METADATA_TOKEN_URL",
    "VERTEX_TOKEN_ENV",
    "AnthropicProvider",
    "BedrockProvider",
    "FakeProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "ScriptedTurn",
    "VertexProvider",
    "default_bedrock_base_url",
    "default_vertex_base_url",
    "rfc3986",
]
