"""Provider adapters.

Five wire dialects ship: OpenAI-compatible (which covers vLLM, Ollama, LiteLLM
and Azure's compatible endpoint), Anthropic's Messages API, Amazon Bedrock's
Converse API, and Gemini's ``generateContent`` -- which the Vertex AI adapter
serves over an OAuth2 bearer token and the Gemini API adapter serves with one API
key. Bedrock is signed with SigV4 and Vertex is OAuth2-bearer, which is why
neither can be an OpenAI-compatible base URL. A sixth, deterministic fake serves
tests and builds the scripted side of an eval case. A seventh, ``recorded``,
replays a committed transcript so an agent eval can be gated without calling a
vendor; it has no fall-through to a live model, by design.
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
from aid_runtime.providers.gemini import (
    DEFAULT_GEMINI_BASE_URL,
    GEMINI_API_KEY_ENV,
    GeminiProvider,
)
from aid_runtime.providers.http import DEFAULT_BASE_URL, OpenAICompatibleProvider
from aid_runtime.providers.recorded import (
    RecordedProvider,
    RecordingProvider,
    ReplayDivergenceError,
    Transcript,
    TranscriptEntry,
)
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
    "DEFAULT_GEMINI_BASE_URL",
    "DEFAULT_VERTEX_LOCATION",
    "GEMINI_API_KEY_ENV",
    "METADATA_TOKEN_URL",
    "VERTEX_TOKEN_ENV",
    "AnthropicProvider",
    "BedrockProvider",
    "FakeProvider",
    "GeminiProvider",
    "OpenAICompatibleProvider",
    "Provider",
    "RecordedProvider",
    "RecordingProvider",
    "ReplayDivergenceError",
    "ScriptedTurn",
    "Transcript",
    "TranscriptEntry",
    "VertexProvider",
    "default_bedrock_base_url",
    "default_vertex_base_url",
    "rfc3986",
]
