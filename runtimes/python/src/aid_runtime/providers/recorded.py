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

Recording is the other half, and it is never automatic: a suite that recorded itself would
gate the build on whatever the model did on the day it ran, so capture happens only when a
run is asked to capture. :class:`RecordingProvider` wraps one live provider;
:class:`RecordingProviders` wraps the whole provider mapping, because the gateway picks a
provider per model and a run that fell back between vendors would otherwise leave the
fallback out of the file. Either way what is written is a :class:`Transcript` -- the same
shape replay reads, so there is one format and one digest, not two.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator, Mapping, Sequence
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
    "RecordingProviders",
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
    #: One vendor, or several comma-joined when the capture spanned a fallback. `model`
    #: follows the same rule, because one run can answer under more than one model.
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


class _Recorder:
    """The calls the wrapped providers answered, kept as one transcript.

    Shared by every provider a :class:`RecordingProviders` wraps. The two names it collects
    are comma-joined rather than last-wins, because a capture that spanned a fallback would
    otherwise describe itself as the one vendor it happened to call last.
    """

    def __init__(self, spec_version: str) -> None:
        self.spec_version = spec_version
        self.entries: list[TranscriptEntry] = []
        self._providers: list[str] = []
        self._models: list[str] = []

    def note(self, *, provider: str, model: str) -> None:
        if provider and provider not in self._providers:
            self._providers.append(provider)
        if model and model not in self._models:
            self._models.append(model)

    def append(self, entry: TranscriptEntry, *, provider: str, model: str) -> None:
        self.note(provider=provider, model=model)
        self.entries.append(entry)

    def transcript(self) -> Transcript:
        return Transcript(
            provider=",".join(self._providers),
            model=",".join(self._models),
            spec_version=self.spec_version,
            entries=tuple(self.entries),
        )


class RecordingProvider:
    """Wraps a live provider and keeps every exchange, so a run can be replayed offline.

    Recording is opt-in and explicit. Nothing here is enabled by an eval run that merely
    happens to have a network connection: a suite that recorded itself would gate the
    build on whatever the model did on the day it ran.

    `recorder` shares the capture with the other providers of the same run, which is what
    :class:`RecordingProviders` uses; given one, `spec_version` is the recorder's.
    """

    def __init__(
        self,
        inner: Provider,
        *,
        spec_version: str = "",
        recorder: _Recorder | None = None,
    ) -> None:
        self._inner = inner
        if recorder is None:
            self._recorder = _Recorder(spec_version)
            # Named here rather than only on the first call, so an empty recorder still
            # says what it was going to record.
            self._recorder.note(provider=str(inner.name), model="")
        else:
            self._recorder = recorder

    @property
    def name(self) -> str:
        return str(self._inner.name)

    @property
    def capabilities(self) -> frozenset[Capability]:
        return frozenset(self._inner.capabilities)

    @property
    def entries(self) -> tuple[TranscriptEntry, ...]:
        return tuple(self._recorder.entries)

    def transcript(self) -> Transcript:
        return self._recorder.transcript()

    def _record(
        self, request: CompletionRequest, response: CompletionResponse, *, model: ModelSpec
    ) -> None:
        user = next((message.content for message in request.messages if message.role == "user"), "")
        self._recorder.append(
            TranscriptEntry(
                request_digest=_digest(request.messages),
                response=response,
                prompt_preview=user[:200],
            ),
            provider=self.name,
            model=model.name,
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        response = await self._inner.complete(request, model=model)
        self._record(request, response, model=model)
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
        self._record(
            request,
            CompletionResponse(
                text=text,
                model=model.name,
                provider=self.name,
                usage=usage if usage is not None else TokenUsage(input_tokens=0, output_tokens=0),
                finish_reason=finish,
            ),
            model=model,
        )
        for chunk in chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


class RecordingProviders:
    """Wraps every provider a run could call, so one capture covers the whole run.

    `default_providers()` is keyed by provider name because the gateway selects a provider
    per model, so wrapping a single entry would leave a fallback -- or a second agent on a
    different vendor -- uncaptured, and the recording would silently replay as a shorter
    run. This wraps the mapping instead and keys each wrapper the way the gateway expects.
    """

    def __init__(self, providers: Mapping[str, Provider], *, spec_version: str = "") -> None:
        if not providers:
            raise EvalError(
                "there is no model provider to record: a capture of nothing would produce a "
                "transcript that replays no call, so point the agent at a model before "
                "recording one"
            )
        self._recorder = _Recorder(spec_version)
        self._wrapped = {
            name: RecordingProvider(provider, recorder=self._recorder)
            for name, provider in providers.items()
        }

    @property
    def providers(self) -> dict[str, Provider]:
        return dict(self._wrapped)

    def transcript(self) -> Transcript:
        return self._recorder.transcript()
