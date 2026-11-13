"""The recorded provider: replay a transcript, or refuse.

The property under test is the one that makes a replay trustworthy: it must answer exactly
the questions that were recorded and refuse every other one. A provider that quietly served
the nearest match would let a reworded prompt pass on an old recording, which is worse than
a red build because it looks green.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aid_runtime import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    EvalError,
    Message,
    ModelSpec,
    RecordedProvider,
    RecordingProvider,
    RecordingProviders,
    ReplayDivergenceError,
    TokenUsage,
    ToolCall,
    Transcript,
    TranscriptEntry,
)
from aid_runtime.providers.recorded import _digest
from aid_runtime.types import CostProfile

MODEL = ModelSpec(
    name="gpt-4o-mini-2024-07-18",
    provider="openai",
    cost=CostProfile(input_per_1k_usd=0.00015, output_per_1k_usd=0.0006),
    context_window=128_000,
    max_output_tokens=16_384,
    capabilities=frozenset({Capability.TOOL_CALLING}),
)

ASK = CompletionRequest.prompt("Refund order 4471")


def _response(text: str = "refunded", *, calls: tuple[ToolCall, ...] = ()) -> CompletionResponse:
    return CompletionResponse(
        text=text,
        model=MODEL.name,
        provider="openai",
        usage=TokenUsage(input_tokens=12, output_tokens=4),
        tool_calls=calls,
    )


def _entry(request: CompletionRequest = ASK, *, text: str = "refunded") -> TranscriptEntry:
    return TranscriptEntry(
        request_digest=_digest(request.messages),
        response=_response(text),
        prompt_preview="Refund order 4471",
    )


def _transcript(*entries: TranscriptEntry) -> Transcript:
    return Transcript(provider="openai", model=MODEL.name, entries=entries)


class TestReplay:
    async def test_serves_the_recorded_turns_in_order(self) -> None:
        second = CompletionRequest(messages=(Message.user("and the second one"),))
        provider = RecordedProvider(
            _transcript(_entry(text="first"), _entry(second, text="second"))
        )

        first = await provider.complete(ASK, model=MODEL)
        following = await provider.complete(second, model=MODEL)

        assert first.text == "first"
        assert following.text == "second"
        assert provider.served == 2
        assert provider.remaining == 0

    async def test_keeps_the_tool_calls_the_model_made(self) -> None:
        call = ToolCall(id="call_1_1", name="refund_order", arguments={"order": "4471"})
        request = CompletionRequest.prompt("Refund order 4471")
        entry = TranscriptEntry(
            request_digest=_digest(request.messages),
            response=_response("refunding", calls=(call,)),
        )

        replay = await RecordedProvider(_transcript(entry)).complete(request, model=MODEL)

        assert replay.tool_calls == (call,)
        assert replay.tool_calls[0].name == "refund_order"

    async def test_streams_the_recorded_answer_in_one_chunk(self) -> None:
        provider = RecordedProvider(_transcript(_entry(text="refunded")))

        chunks = [chunk async for chunk in provider.stream(ASK, model=MODEL)]

        # Token boundaries were never recorded, so inventing several chunks would make a
        # replayed run differ from the recorded one where streaming is observable.
        assert len(chunks) == 1
        assert chunks[0].delta == "refunded"
        assert chunks[0].usage is not None
        assert chunks[0].usage.total_tokens == 16

    async def test_reports_its_own_name_and_only_carriable_capabilities(self) -> None:
        provider = RecordedProvider(_transcript(_entry()))
        other = RecordedProvider(_transcript(_entry()), name="replay")

        assert provider.name == "openai"
        assert other.name == "replay"
        assert provider.capabilities == frozenset(
            {Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT}
        )


class TestRefusal:
    async def test_refuses_a_run_that_outlasts_the_recording(self) -> None:
        provider = RecordedProvider(_transcript(_entry()))

        await provider.complete(ASK, model=MODEL)

        with pytest.raises(ReplayDivergenceError) as raised:
            await provider.complete(ASK, model=MODEL)

        assert "ends after 1 call" in str(raised.value)
        assert "number 2" in str(raised.value)
        assert "RecordingProvider" in str(raised.value)

    async def test_refuses_a_prompt_that_changed_after_recording(self) -> None:
        provider = RecordedProvider(_transcript(_entry()))

        with pytest.raises(ReplayDivergenceError) as raised:
            await provider.complete(CompletionRequest.prompt("Refund order 9999"), model=MODEL)

        message = str(raised.value)
        assert "replayed call 1 does not match" in message
        assert "Refund order 9999" in message
        # The recorded preview is what makes the difference locatable in one line.
        assert "Refund order 4471" in message

    async def test_refuses_when_a_tool_result_moved(self) -> None:
        """A tool whose answer changed changes the question, so the transcript is stale."""
        recorded = CompletionRequest(
            messages=(
                Message.user("Refund order 4471"),
                Message.assistant_tool_calls(
                    "",
                    (ToolCall(id="call_1_1", name="lookup", arguments={"id": "4471"}),),
                ),
                Message.tool("call_1_1", '{"status": "shipped"}', name="lookup"),
            )
        )
        provider = RecordedProvider(_transcript(_entry(recorded)))

        changed = CompletionRequest(
            messages=(
                Message.user("Refund order 4471"),
                Message.assistant_tool_calls(
                    "",
                    (ToolCall(id="call_1_1", name="lookup", arguments={"id": "4471"}),),
                ),
                Message.tool("call_1_1", '{"status": "refunded"}', name="lookup"),
            )
        )
        with pytest.raises(ReplayDivergenceError) as raised:
            await provider.complete(changed, model=MODEL)

        assert "message digest changed" in str(raised.value)

    async def test_divergence_is_not_a_provider_error_so_the_gateway_will_not_retry(self) -> None:
        """A retry cannot help, and the gateway would hide the call index behind a fallback."""
        from aid_runtime.errors import EvalError, ProviderError

        assert issubclass(ReplayDivergenceError, EvalError)
        assert not issubclass(ReplayDivergenceError, ProviderError)


class TestTranscriptFile:
    def test_round_trips_through_disk_byte_identically(self, tmp_path: Path) -> None:
        transcript = _transcript(_entry(), _entry(text="second"))

        first = tmp_path / "a.json"
        second = tmp_path / "b.json"
        transcript.save(first)
        Transcript.from_path(first).save(second)

        assert first.read_bytes() == second.read_bytes()

    def test_writes_a_trailing_newline_and_sorted_keys(self, tmp_path: Path) -> None:
        path = tmp_path / "replay.json"
        _transcript(_entry()).save(path)

        raw = path.read_text(encoding="utf-8")

        assert raw.endswith("}\n")
        assert list(json.loads(raw)) == sorted(json.loads(raw))

    def test_missing_file_names_how_to_record_one(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError) as raised:
            Transcript.from_path(tmp_path / "absent.json")

        assert "RecordingProvider" in str(raised.value)

    def test_provider_loads_from_a_path(self, tmp_path: Path) -> None:
        path = tmp_path / "replay.json"
        _transcript(_entry()).save(path)

        assert RecordedProvider.from_path(path).remaining == 1

    def test_records_the_spec_version_it_was_made_under(self, tmp_path: Path) -> None:
        path = tmp_path / "replay.json"
        Transcript(provider="openai", model=MODEL.name, spec_version="0.30").save(path)

        assert Transcript.from_path(path).spec_version == "0.30"


class TestRecording:
    async def test_records_what_the_inner_provider_answered(self) -> None:
        from aid_runtime.providers.fake import FakeProvider, ScriptedTurn

        inner = FakeProvider(script=[ScriptedTurn.answer("refunded")])
        recorder = RecordingProvider(inner, spec_version="0.30")

        await recorder.complete(ASK, model=MODEL)

        assert recorder.name == inner.name
        assert len(recorder.entries) == 1
        assert recorder.entries[0].response.text == "refunded"
        assert recorder.entries[0].prompt_preview == "Refund order 4471"
        assert recorder.transcript().spec_version == "0.30"

    async def test_a_recording_replays_without_the_inner_provider(self) -> None:
        """The round trip is the point: record once, then gate on it forever."""
        from aid_runtime.providers.fake import FakeProvider, ScriptedTurn

        inner = FakeProvider(script=[ScriptedTurn.answer("refunded")])
        recorder = RecordingProvider(inner)
        recorded = await recorder.complete(ASK, model=MODEL)

        replay = RecordedProvider(recorder.transcript())
        replayed = await replay.complete(ASK, model=MODEL)

        assert replayed.text == recorded.text == "refunded"
        assert replayed.usage == recorded.usage


class TestRecordingEverythingARunCalls:
    """The capture half: one run, every provider it reached, one file to commit.

    A generated eval holds a *mapping* of providers, because the gateway chooses one per
    model. Capturing only the entry that answered would drop a fallback from the file and
    turn a replayed run into a shorter one -- which is why the mapping is wrapped whole.
    """

    async def test_two_vendors_land_in_one_capture(self) -> None:
        from aid_runtime.providers.fake import FakeProvider, ScriptedTurn

        recorder = RecordingProviders(
            {
                "primary": FakeProvider(script=[ScriptedTurn.answer("first")], name="openai"),
                "fallback": FakeProvider(script=[ScriptedTurn.answer("second")], name="anthropic"),
            },
            spec_version="0.33",
        )
        wrapped = recorder.providers
        first = await wrapped["primary"].complete(ASK, model=MODEL)
        second = await wrapped["fallback"].complete(
            CompletionRequest.prompt("and the second one"), model=MODEL
        )

        transcript = recorder.transcript()

        assert [first.text, second.text] == ["first", "second"]
        assert len(transcript) == 2
        assert transcript.spec_version == "0.33"
        # Both vendors answered, so both are named -- a capture that spans a fallback must
        # not describe itself as the one provider it called last.
        assert transcript.provider == "openai,anthropic"
        assert transcript.model == MODEL.name

    async def test_a_capture_of_the_whole_mapping_replays_as_one_run(self) -> None:
        from aid_runtime.providers.fake import FakeProvider, ScriptedTurn

        recorder = RecordingProviders(
            {
                "primary": FakeProvider(script=[ScriptedTurn.answer("first")]),
                "fallback": FakeProvider(script=[ScriptedTurn.answer("second")]),
            }
        )
        wrapped = recorder.providers
        await wrapped["primary"].complete(ASK, model=MODEL)
        await wrapped["fallback"].complete(
            CompletionRequest.prompt("and the second one"), model=MODEL
        )

        replay = RecordedProvider(recorder.transcript())

        assert (await replay.complete(ASK, model=MODEL)).text == "first"
        assert (
            await replay.complete(CompletionRequest.prompt("and the second one"), model=MODEL)
        ).text == "second"
        assert replay.remaining == 0

    def test_a_capture_with_no_provider_is_refused(self) -> None:
        """An empty mapping would write a transcript that replays no call, which is not a
        recording of anything; refusing here means the file is never created."""
        raised = pytest.raises(EvalError)
        with raised as caught:
            RecordingProviders({})

        assert "no model provider to record" in str(caught.value)
