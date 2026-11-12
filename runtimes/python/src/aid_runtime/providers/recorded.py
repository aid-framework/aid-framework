"""A provider transcript, replayed instead of called.

An agent eval needs the model's *tool calls*, and a live model decides those itself. That
is the right thing to measure in production and the wrong thing to gate a build on: a CI
suite that spends money and answers differently on Tuesday cannot refuse a pull request.
So the model's turns are recorded once, committed beside the dataset, and replayed.

What that buys and what it costs are stated together on purpose. A replayed suite verifies
that the machinery around the model does what the spec says -- the step ceiling stops the
run, an unreachable tool stays unreachable, a rejected approval blocks the call, the cost
is attributed. It says nothing about whether the model would choose those calls, because
the model is not consulted. A green replayed suite is evidence about plumbing, never about
model quality; measuring a model needs a pinned provider and belongs with the baselines.

Replay is **positional and verified**, not a search for a matching question. Each recorded
entry carries a digest of the request it answered, and the provider checks the digest of
the request it is handed. A prompt edit, a changed tool result or a reordered step changes
that digest, and the run stops with the call index and the first differing message instead
of quietly serving an answer to a question nobody asked. The alternative -- matching on
content -- would turn a diverged run into a permissive one.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import EvalError
from aid_runtime.providers.base import Provider
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    FinishReason,
    Message,
    ModelSpec,
    StreamChunk,
    TokenUsage,
)

__all__ = [
    "RecordedProvider",
    "RecordingProvider",
    "ReplayDivergenceError",
    "Transcript",
    "TranscriptEntry",
]


class ReplayDivergenceError(EvalError):
    """A replayed run asked something the recording does not answer.

    Deliberately *not* a :class:`~aid_runtime.errors.ProviderError`: the gateway treats a
    provider error as a reason to try the next candidate model, and a divergence is not a
    vendor outage -- every candidate would diverge identically. Inheriting the gateway's
    retry path would hide the call index behind a "no candidate produced a response"
    message and spend a fallback finding nothing.
    """


def _digest(messages: Sequence[Message]) -> str:
    """A stable digest of a request's transcript.

    Every field that reaches the provider is folded in, including tool-call ids and
    names, because a change to any of them is a change to what the model was asked. The
    encoding is fixed rather than default, so the digest does not move with a Python
    upgrade and a committed transcript keeps checking out.
    """
    payload = [
        {
            "role": message.role,
            "content": message.content,
            "tool_calls": [
                {"id": call.id, "name": call.name, "arguments": call.arguments}
                for call in message.tool_calls
            ],
            "tool_call_id": message.tool_call_id,
            "name": message.name,
        }
        for message in messages
    ]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


class TranscriptEntry(BaseModel):
    """One recorded exchange: what was asked, and what came back."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    request_digest: str = Field(min_length=1)
    response: CompletionResponse
    #: The first user message of the request, kept for a human reading the file. It is
    #: not used for matching -- the digest is -- so it may be trimmed without changing
    #: what the transcript replays.
    prompt_preview: str = ""


class Transcript(BaseModel):
    """A recorded provider session, as a file a repository can commit."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str
    model: str
    #: The spec version the recording was made under. A transcript is evidence about a
    #: particular document, so a bump that changes what an eval runs should prompt a
    #: re-record rather than silently reusing turns planned against the old shape.
    spec_version: str = ""
    entries: tuple[TranscriptEntry, ...] = ()

    @classmethod
    def from_path(cls, path: Path) -> Transcript:
        if not path.is_file():
            raise FileNotFoundError(
                f"no recorded transcript at {path}; record one by wrapping a pinned provider in "
                "RecordingProvider, then save its transcript() here and commit it beside the "
                "dataset"
            )
        return cls.model_validate_json(path.read_text(encoding="utf-8"))

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Trailing newline and a stable key order, so recording twice from the same
        # session produces the same bytes and a diff means the run really changed.
        path.write_text(
            json.dumps(self.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def __len__(self) -> int:
        return len(self.entries)

    def __bool__(self) -> bool:
        return bool(self.entries)


class RecordedProvider:
    """Replays a :class:`Transcript`, one entry per call.

    Deliberately not a cache: a cache answers a question it has seen before and falls
    through to a live call otherwise, which is exactly the behaviour that makes a gated
    suite flaky. This provider has no fall-through. Once the transcript is exhausted the
    run has taken more steps than were recorded, which is a finding rather than a reason
    to call a vendor.
    """

    def __init__(
        self,
        transcript: Transcript,
        *,
        name: str | None = None,
        verify_requests: bool = True,
    ) -> None:
        self._transcript = transcript
        self._name = transcript.provider if name is None else name
        self._verify = verify_requests
        self._served = 0

    @classmethod
    def from_path(cls, path: Path, **kwargs: Any) -> RecordedProvider:
        return cls(Transcript.from_path(path), **kwargs)

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> frozenset[Capability]:
        # The recorded provider can answer whatever was recorded. Advertising the full
        # set would let a model negotiate a capability no entry exercises, so it claims
        # only what a transcript can carry.
        return frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT})

    @property
    def served(self) -> int:
        return self._served

    @property
    def remaining(self) -> int:
        return max(len(self._transcript) - self._served, 0)

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        entry = self._next(request)
        return entry.response

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        """Stream a recorded answer as one terminal chunk.

        Recordings do not carry token boundaries, so inventing them would make a
        replayed run differ from the recorded one in the one place streaming is
        observable. A single chunk carrying the whole answer and the usage is the
        honest reconstruction.
        """
        response = await self.complete(request, model=model)
        yield StreamChunk(
            delta=response.text,
            finish_reason=response.finish_reason,
            usage=response.usage,
        )

    async def aclose(self) -> None:
        return None

    def _next(self, request: CompletionRequest) -> TranscriptEntry:
        if self._served >= len(self._transcript):
            raise ReplayDivergenceError(
                f"the recording in this transcript ends after {len(self._transcript)} call(s) "
                f"and the run asked for number {self._served + 1}: the app took a step the "
                "recording does not cover. Record a longer one by wrapping the live provider "
                "in RecordingProvider, or fix the step that now runs further than it did"
            )
        entry = self._transcript.entries[self._served]
        if self._verify:
            self._verify_digest(entry, request, self._served)
        self._served += 1
        return entry

    def _verify_digest(
        self, entry: TranscriptEntry, request: CompletionRequest, index: int
    ) -> None:
        actual = _digest(request.messages)
        if actual == entry.request_digest:
            return
        raise ReplayDivergenceError(
            f"replayed call {index + 1} does not match the recording: "
            f"{self._first_difference(entry, request)}. A recorded transcript answers the "
            "question that was asked when it was recorded; a changed prompt, tool result or "
            "step order is a different question"
        )

    def _first_difference(self, entry: TranscriptEntry, request: CompletionRequest) -> str:
        """Name the first message that moved, so the fix is locatable.

        The recording keeps only a preview, so this can say *which* message differs and
        what the run sent, not what was recorded in full. That is enough to find the
        step, and promising more detail than the file holds would be a lie.
        """
        previews = entry.prompt_preview
        for position, message in enumerate(request.messages):
            if position == 0 and previews and message.content != previews:
                return (
                    f"the opening user message is now {message.content[:80]!r} and the "
                    f"recording was made with {previews[:80]!r}"
                )
        return (
            f"the request's message digest changed ({len(request.messages)} message(s) "
            "sent); compare the prompt and the tool results at this step"
        )


class RecordingProvider:
    """Wraps a live provider and keeps every exchange, so a run can be replayed offline.

    Recording is opt-in and explicit. Nothing here is enabled by an eval run that merely
    happens to have a network connection: a suite that recorded itself would gate the
    build on whatever the model did on the day it ran.
    """

    def __init__(self, inner: Provider, *, spec_version: str = "") -> None:
        self._inner = inner
        self._spec_version = spec_version
        self._entries: list[TranscriptEntry] = []
        self._model = ""

    @property
    def name(self) -> str:
        return str(self._inner.name)

    @property
    def capabilities(self) -> frozenset[Capability]:
        return frozenset(self._inner.capabilities)

    @property
    def entries(self) -> tuple[TranscriptEntry, ...]:
        return tuple(self._entries)

    def transcript(self) -> Transcript:
        return Transcript(
            provider=self.name,
            model=self._model,
            spec_version=self._spec_version,
            entries=tuple(self._entries),
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        response = await self._inner.complete(request, model=model)
        self._model = model.name
        user = next((message.content for message in request.messages if message.role == "user"), "")
        self._entries.append(
            TranscriptEntry(
                request_digest=_digest(request.messages),
                response=response,
                prompt_preview=user[:200],
            )
        )
        return response

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        # Streaming is recorded as the assembled answer rather than as chunks: a
        # transcript is replayed for its *content*, and a chunk boundary is not
        # something an eval asserts.
        chunks: list[StreamChunk] = []
        async for chunk in self._inner.stream(request, model=model):
            chunks.append(chunk)
        text = "".join(chunk.delta for chunk in chunks)
        usage = next((chunk.usage for chunk in reversed(chunks) if chunk.usage is not None), None)
        finish: FinishReason = next(
            (chunk.finish_reason for chunk in reversed(chunks) if chunk.finish_reason is not None),
            "stop",
        )
        self._model = model.name
        user = next((message.content for message in request.messages if message.role == "user"), "")
        self._entries.append(
            TranscriptEntry(
                request_digest=_digest(request.messages),
                response=CompletionResponse(
                    text=text,
                    model=model.name,
                    provider=self.name,
                    usage=usage
                    if usage is not None
                    else TokenUsage(input_tokens=0, output_tokens=0),
                    finish_reason=finish,
                ),
                prompt_preview=user[:200],
            )
        )
        for chunk in chunks:
            yield chunk

    async def aclose(self) -> None:
        return None
