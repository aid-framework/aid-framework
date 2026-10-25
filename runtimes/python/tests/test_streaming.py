"""Streaming end to end: SSE bytes on the wire, accounting, cancellation, cache.

The contract under test is not "the endpoint returned HTTP 200" but that the
generator emits *Server-Sent Event bytes*: ``data: <json>\\n\\n``, one frame per
text delta (so the first byte reaches the wire before the call completes), then a
terminal ``done`` frame. That is exactly the test that would have caught the
withdrawn-streaming defect D-1: a declared capability with no bytes behind it.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, cast

import pytest

from aid_runtime import (
    Capability,
    CapabilityMismatchError,
    CompletionRequest,
    ConcurrencyLimiter,
    CostLedger,
    CostProfile,
    FakeProvider,
    ModelCacheConfig,
    ModelGateway,
    ModelSpec,
    ScriptedTurn,
    StreamChunk,
    TokenUsage,
)

TEXT = "hello streaming world"


def _streaming_spec(*, cache: ModelCacheConfig | None = None) -> ModelSpec:
    return ModelSpec(
        name="fake-stream-1",
        provider="fake",
        cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
        context_window=128_000,
        max_output_tokens=4_096,
        capabilities=frozenset({Capability.STREAMING}),
        cache=cache,
    )


def _gateway(
    spec: ModelSpec,
    *,
    provider: FakeProvider | None = None,
    ledger: CostLedger | None = None,
    limiter: ConcurrencyLimiter | None = None,
) -> ModelGateway:
    return ModelGateway(
        {"fake": provider if provider is not None else FakeProvider(name="fake")},
        {"stream": spec},
        ledger=ledger,
        limiter=limiter,
    )


def _payload(frame: bytes) -> dict[str, Any]:
    """Decode one SSE ``data`` frame into its JSON payload."""
    assert isinstance(frame, bytes), "the stream must emit bytes on the wire"
    assert frame.startswith(b"data: "), frame
    assert frame.endswith(b"\n\n"), frame
    return cast(dict[str, Any], json.loads(frame[len(b"data: ") : -2].decode("utf-8")))


async def _collect(gateway: ModelGateway, request: CompletionRequest) -> list[bytes]:
    return [frame async for frame in gateway.stream("stream", request)]


async def test_stream_emits_sse_bytes() -> None:
    """The capability test: actual ``data:`` frames, not a buffered blob."""
    gateway = _gateway(
        _streaming_spec(), provider=FakeProvider(name="fake", script=(ScriptedTurn.answer(TEXT),))
    )
    frames = await _collect(gateway, CompletionRequest.prompt("hi"))

    assert frames, "a streamed answer must produce at least one frame"
    # First frame is the first text delta, before completion.
    assert _payload(frames[0]) == {"delta": TEXT[:4]}
    # Terminal frame closes the stream.
    assert _payload(frames[-1]) == {
        "done": True,
        "finish_reason": "stop",
        "model": "fake-stream-1",
        "provider": "fake",
    }


async def test_stream_delivers_deltas_in_order() -> None:
    gateway = _gateway(
        _streaming_spec(), provider=FakeProvider(name="fake", script=(ScriptedTurn.answer(TEXT),))
    )
    frames = await _collect(gateway, CompletionRequest.prompt("hi"))

    deltas = [_payload(frame)["delta"] for frame in frames[:-1]]
    assert "".join(deltas) == TEXT
    assert all("delta" in _payload(frame) for frame in frames[:-1])


async def test_stream_records_cost_like_generate() -> None:
    """A streamed call charges the ledger exactly as ``generate`` would."""
    ledger = CostLedger()
    spec = _streaming_spec()
    gateway = _gateway(
        spec, provider=FakeProvider(name="fake", script=(ScriptedTurn.answer(TEXT),)), ledger=ledger
    )

    frames = await _collect(gateway, CompletionRequest.prompt("hi"))
    assert frames

    terminal = _payload(frames[-1])
    assert ledger.summary().calls == 1
    entry = ledger.entries[0]
    assert entry.alias == "stream"
    assert entry.model == spec.name
    assert entry.cost_usd == spec.cost.cost_usd(entry.usage)
    assert terminal["model"] == spec.name


async def test_stream_cache_hit_rechunks_and_charges_nothing() -> None:
    ledger = CostLedger()
    spec = _streaming_spec(cache=ModelCacheConfig(prompt=True))
    gateway = _gateway(
        spec, provider=FakeProvider(name="fake", script=(ScriptedTurn.answer(TEXT),)), ledger=ledger
    )
    request = CompletionRequest.prompt("hi")

    # Prime the cache via generate.
    first = await gateway.generate("stream", request)
    assert not first.cache_hit
    assert ledger.summary().calls == 1

    frames = await _collect(gateway, request)

    deltas = [_payload(frame)["delta"] for frame in frames[:-1]]
    assert "".join(deltas) == TEXT
    assert _payload(frames[-1])["done"] is True
    # The hit must not charge the budget again.
    assert ledger.summary().calls == 1


async def test_stream_requires_the_streaming_capability() -> None:
    """A model without ``streaming`` is refused, not silently buffered."""
    no_stream = ModelSpec(
        name="fake-nostream-1",
        provider="fake",
        cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
        context_window=128_000,
        max_output_tokens=4_096,
        capabilities=frozenset({Capability.TOOL_CALLING}),
    )
    gateway = _gateway(no_stream)
    with pytest.raises(CapabilityMismatchError):
        await _collect(gateway, CompletionRequest.prompt("hi"))


class _SlowProvider(FakeProvider):
    """A streaming provider whose deltas pause so a consumer can cancel mid-stream."""

    async def stream(
        self, request: CompletionRequest, *, model: ModelSpec
    ) -> AsyncIterator[StreamChunk]:
        for start in range(0, len(TEXT), 4):
            await asyncio.sleep(0.05)
            yield StreamChunk(delta=TEXT[start : start + 4])
        yield StreamChunk(finish_reason="stop", usage=TokenUsage(input_tokens=1, output_tokens=1))


async def test_stream_cancellation_closes_the_stream() -> None:
    limiter = ConcurrencyLimiter(1)
    spec = _streaming_spec()
    gateway = _gateway(spec, provider=_SlowProvider(name="fake"), limiter=limiter)

    first_delta = asyncio.Event()
    task = asyncio.create_task(_consume_until_cancelled(gateway, first_delta))
    # Wait for the first delta to reach the wire, then cancel mid-stream.
    await first_delta.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        # gather re-raises the cancelled child's error on await.
        await asyncio.gather(task)

    # Cancellation must have released the concurrency slot, not leaked it.
    async with limiter.run():
        pass  # acquiring immediately would deadlock if the slot had leaked


async def _consume_until_cancelled(gateway: ModelGateway, first_delta: asyncio.Event) -> None:
    async for frame in gateway.stream("stream", CompletionRequest.prompt("hi")):
        if "delta" in json.loads(frame[len(b"data: ") : -2]):
            first_delta.set()
