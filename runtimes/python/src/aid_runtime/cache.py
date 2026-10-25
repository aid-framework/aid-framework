"""A completion cache with exact (prompt-keyed) and opt-in semantic reuse.

The exact key is ``(model, prompt transcript hash, tool identity hash, temperature,
max output tokens, stop sequences)``. Semantic reuse is strictly opt-in (an explicit
threshold and TTL; there is no default) and is gated by the *same* structural key: a
stored entry may only answer a new request whose model, tool identity, temperature,
output cap and stop sequences all match, and then only when the prompt text is
similar enough and young enough.

The invalidation rule, stated: an entry is reusable if and only if (a) the model,
tool-identity hash, temperature, output cap and stop sequences are identical, (b)
the Jaccard similarity of the two prompt transcripts is at least ``threshold``, and
(c) the entry is younger than ``ttl_seconds``. Text similarity is the *match* test,
never the storage key: the key stays a structural hash so a prompt change can never
resurrect a response that was computed with different tools, a different model, a
different cap, or different stop sequences.

The similarity measure is lexical (token Jaccard), not an embedding cosine. A true
embedding similarity would need an embedder at cache-construction time; wiring that
in is deferred rather than implied.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field

from aid_runtime.types import CompletionRequest, CompletionResponse, ModelSpec

__all__ = ["CompletionCache", "cache_key_for"]


@dataclass(frozen=True, slots=True)
class CacheKey:
    """The structural key: everything in a request that can change its output.

    Model, transcript hash, full tool identity, temperature, output cap, and stop
    sequences. ``tools_hash`` covers each tool's name, description, and parameters
    in request order, since a provider preserves that order. The cap and stop
    sequences are stored verbatim rather than omitted: a cached body must never
    answer a request that asked for a different cap or stop set.
    """

    model: str
    prompt_hash: str
    tools_hash: str
    temperature: str
    max_output_tokens: str
    stop: str

    def same_structure(self, other: CacheKey) -> bool:
        """Whether two keys may share a completion, ignoring prompt similarity."""
        return (
            self.model == other.model
            and self.tools_hash == other.tools_hash
            and self.temperature == other.temperature
            and self.max_output_tokens == other.max_output_tokens
            and self.stop == other.stop
        )


def cache_key_for(model: str, request: CompletionRequest) -> CacheKey:
    """Derive the structural key for a request.

    "Prompt hash" hashes the full transcript (roles, content, and tool context),
    not concatenated text, so a system/user/tool distinction is part of the key.
    The output cap and stop sequences are part of the key too, so a cached body
    cannot answer a request that asked for a different cap or stop set.
    """
    return CacheKey(
        model=model,
        prompt_hash=_transcript_hash(request),
        tools_hash=_tools_hash(request),
        temperature=repr(request.temperature),
        max_output_tokens=repr(request.max_output_tokens),
        stop=repr(request.stop),
    )


@dataclass(slots=True)
class CacheEntry:
    response: CompletionResponse
    prompt: str
    stored_at: float = field(default_factory=time.monotonic)


class CompletionCache:
    """An in-process, async-safe cache of provider completions.

    Async-safe by construction: lookups and inserts are synchronous and complete
    before the first ``await`` in the caller, and a caller never observes a
    half-populated entry because an entry is written whole, once, after the call
    completes. In-flight identical requests are *not* coalesced: each miss calls
    the provider. That is the explicit choice here -- coalescing would add a
    per-key condition variable and change failure semantics -- and a test pins the
    duplicate-work behaviour.
    """

    def __init__(self) -> None:
        self._entries: dict[CacheKey, CacheEntry] = {}

    def get(self, key: CacheKey) -> CompletionResponse | None:
        entry = self._entries.get(key)
        return None if entry is None else entry.response

    def semantic_get(
        self,
        spec: ModelSpec,
        request: CompletionRequest,
        *,
        threshold: float,
        ttl_seconds: int,
    ) -> CompletionResponse | None:
        """The opt-in semantic lookup: same structure, similar prompt, young enough."""
        key = cache_key_for(spec.name, request)
        prompt = _transcript_text(request)
        now = time.monotonic()
        for existing_key, entry in self._entries.items():
            if not existing_key.same_structure(key):
                continue
            if now - entry.stored_at > ttl_seconds:
                continue
            if _jaccard(prompt, entry.prompt) < threshold:
                continue
            return entry.response
        return None

    def put(self, key: CacheKey, response: CompletionResponse, request: CompletionRequest) -> None:
        self._entries[key] = CacheEntry(response=response, prompt=_transcript_text(request))

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)


def _transcript_text(request: CompletionRequest) -> str:
    return "\n".join(message.content for message in request.messages)


def _transcript_hash(request: CompletionRequest) -> str:
    messages = [
        {
            "role": message.role,
            "content": message.content,
            "tool_call_id": message.tool_call_id,
            "name": message.name,
            "tool_calls": [call.model_dump(mode="json") for call in message.tool_calls],
        }
        for message in request.messages
    ]
    blob = json.dumps(messages, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _tools_hash(request: CompletionRequest) -> str:
    blob = json.dumps(
        [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
            for tool in request.tools
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _jaccard(left: str, right: str) -> float:
    """Token Jaccard similarity in [0, 1]; two empty transcripts are identical."""
    a = set(_tokens(left))
    b = set(_tokens(right))
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def _tokens(text: str) -> list[str]:
    return [word for word in text.lower().replace("?", " ").split() if word]
