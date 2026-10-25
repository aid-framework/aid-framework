"""Data shapes shared across the runtime.

These are deliberately plain validated records: everything that crosses a process
boundary (a provider response, a tool call, an eval baseline) is a Pydantic model
so it round-trips through JSON without a bespoke encoder.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "Capability",
    "CompletionRequest",
    "CompletionResponse",
    "CostProfile",
    "FinishReason",
    "GenerationResult",
    "Message",
    "ModelCacheConfig",
    "ModelSpec",
    "PinnedModel",
    "Role",
    "SemanticCacheConfig",
    "StreamChunk",
    "TokenUsage",
    "ToolCall",
    "ToolDefinition",
    "ToolResult",
]

Role = Literal["system", "user", "assistant", "tool"]
FinishReason = Literal["stop", "length", "tool-calls", "content-filter", "error"]


class Capability(StrEnum):
    """Capabilities a *model* can be negotiated against.

    These are the model-side vocabulary. The IR's capability set
    (``http-trigger``, ``json-schema``, ``otel``, ``streaming``, ``tool-calling``,
    ``cursor-memory``) is a target-side vocabulary; the generator maps one to the
    other. ``STREAMING`` is served: an adapter that advertises it also implements
    :meth:`~aid_runtime.providers.Provider.stream`. ``EMBEDDINGS`` and
    ``RERANK`` are likewise model-side: the IR's ``MODEL_CAPABILITIES`` already
    admits both for embedding and rerank models, so declaring them here is what
    lets a model be negotiated against a retrieval binding at all.
    """

    TOOL_CALLING = "tool-calling"
    STRUCTURED_OUTPUT = "structured-output"
    STREAMING = "streaming"
    LONG_CONTEXT = "long-context"
    EMBEDDINGS = "embeddings"
    RERANK = "rerank"


class ToolCall(BaseModel):
    """A model's request to invoke a tool."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


class Message(BaseModel):
    """One turn of a chat transcript.

    ``tool_calls`` on an assistant turn and ``tool_call_id`` on a tool turn are what
    make a multi-step tool loop replayable: without them the next request would carry
    an observation the provider cannot attribute to the call that produced it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    role: Role
    content: str
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None
    name: str | None = None

    @classmethod
    def system(cls, content: str) -> Message:
        return cls(role="system", content=content)

    @classmethod
    def user(cls, content: str) -> Message:
        return cls(role="user", content=content)

    @classmethod
    def assistant(cls, content: str) -> Message:
        return cls(role="assistant", content=content)

    @classmethod
    def assistant_tool_calls(cls, content: str, tool_calls: Sequence[ToolCall]) -> Message:
        return cls(role="assistant", content=content, tool_calls=tuple(tool_calls))

    @classmethod
    def tool(cls, call_id: str, content: str, *, name: str | None = None) -> Message:
        return cls(role="tool", content=content, tool_call_id=call_id, name=name)


class CostProfile(BaseModel):
    """Published price for a pinned model, in USD per 1,000 tokens."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    input_per_1k_usd: float = Field(ge=0.0)
    output_per_1k_usd: float = Field(ge=0.0)

    def cost_usd(self, usage: TokenUsage) -> float:
        raw = (
            usage.input_tokens * self.input_per_1k_usd
            + usage.output_tokens * self.output_per_1k_usd
        ) / 1000.0
        return round(raw, 6)


class SemanticCacheConfig(BaseModel):
    """Opt-in semantic reuse: an explicit threshold and TTL, with no defaults."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    threshold: float = Field(ge=0.0, le=1.0)
    ttl_seconds: int = Field(gt=0)


class ModelCacheConfig(BaseModel):
    """Per-model cache policy carried by ``models[].cache`` (spec v0.3)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    prompt: bool = False
    semantic: SemanticCacheConfig | None = None


class ModelSpec(BaseModel):
    """A *pinned* model: an exact provider model id, never a floating alias.

    Pinning is the whole point of the alias table. ``name`` must be the
    provider's immutable snapshot id (``gpt-4o-mini-2024-07-18``), because a
    floating ``gpt-4o-mini`` silently changes behaviour under a stored eval
    baseline and turns a real regression into a mystery.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    cost: CostProfile
    context_window: int = Field(gt=0)
    max_output_tokens: int = Field(gt=0)
    capabilities: frozenset[Capability] = frozenset()
    cache: ModelCacheConfig | None = None

    @field_validator("capabilities", mode="before")
    @classmethod
    def _coerce_capabilities(cls, value: Any) -> Any:
        if isinstance(value, (set, frozenset)):
            return frozenset(Capability(v) for v in value)
        return value


class PinnedModel(BaseModel):
    """An alias resolved against the pinned table, with its adapter attached."""

    model_config = ConfigDict(frozen=True, extra="forbid", arbitrary_types_allowed=True)

    alias: str = Field(min_length=1)
    spec: ModelSpec

    @property
    def provider(self) -> str:
        return self.spec.provider

    @property
    def capabilities(self) -> frozenset[Capability]:
        return self.spec.capabilities

    def supports(self, capabilities: frozenset[Capability]) -> bool:
        return capabilities <= self.spec.capabilities


class TokenUsage(BaseModel):
    """Token accounting for a single model call."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def __add__(self, other: TokenUsage) -> TokenUsage:
        return TokenUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
        )


class ToolDefinition(BaseModel):
    """A tool as the model sees it: name, description, JSON Schema parameters."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(min_length=1)
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)

    def as_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters or {"type": "object", "properties": {}},
            },
        }


class ToolResult(BaseModel):
    """The outcome of executing a :class:`ToolCall`."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    call_id: str
    name: str
    content: str
    is_error: bool = False

    @classmethod
    def from_value(cls, call: ToolCall, value: Any) -> ToolResult:
        content = (
            value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
        )
        return cls(call_id=call.id, name=call.name, content=content)

    @classmethod
    def from_error(cls, call: ToolCall, message: str) -> ToolResult:
        return cls(call_id=call.id, name=call.name, content=message, is_error=True)


class CompletionRequest(BaseModel):
    """A single model call.

    It may be served request/response (:meth:`ModelGateway.generate`) or as an SSE
    byte stream (:meth:`ModelGateway.stream`). The same request shape feeds both.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    messages: tuple[Message, ...] = Field(min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, gt=0)
    tools: tuple[ToolDefinition, ...] = ()
    stop: tuple[str, ...] = ()
    metadata: dict[str, str] = Field(default_factory=dict)

    @classmethod
    def prompt(cls, text: str, *, system: str | None = None) -> CompletionRequest:
        messages = []
        if system is not None:
            messages.append(Message.system(system))
        messages.append(Message.user(text))
        return cls(messages=tuple(messages))

    def fingerprint(self) -> str:
        """Stable hash of everything that can change the model's output."""
        payload = self.model_dump(mode="json", exclude_none=True)
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class CompletionResponse(BaseModel):
    """A provider response plus the accounting needed to charge for it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    text: str
    model: str
    provider: str
    usage: TokenUsage
    tool_calls: tuple[ToolCall, ...] = ()
    finish_reason: FinishReason = "stop"


class StreamChunk(BaseModel):
    """One increment of a streamed completion.

    ``delta`` is the new text since the previous chunk. The terminal chunk carries
    ``finish_reason`` and ``usage`` so the gateway can account for the call exactly
    as :meth:`ModelGateway.generate` does.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    delta: str = ""
    finish_reason: FinishReason | None = None
    usage: TokenUsage | None = None


class GenerationResult(BaseModel):
    """What the gateway returns: the response, what it cost, and how it got there."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    response: CompletionResponse
    alias: str
    cost_usd: float = Field(ge=0.0)
    attempts: tuple[str, ...] = ()
    cache_hit: bool = False

    @property
    def text(self) -> str:
        return self.response.text

    @property
    def usage(self) -> TokenUsage:
        return self.response.usage

    @property
    def fell_back(self) -> bool:
        return len(self.attempts) > 1
