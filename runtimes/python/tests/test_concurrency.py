"""Bounded concurrency: one shared limiter, overlap up to cap, slot release.

The plan is explicit: *one* limiter, not two. The gateway (model calls), the tool
executor, and the agent engine's delegation all draw from the same
:class:`ConcurrencyLimiter`, so the cap bounds every unit of concurrent work. These
tests prove the cap is actually enforced (overlap rises to, but never exceeds, the
limit) and that cancellation and errors release slots.
"""

from __future__ import annotations

import asyncio

import pytest

from aid_runtime import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    ConcurrencyLimiter,
    CostProfile,
    FakeProvider,
    ModelGateway,
    ModelSpec,
    ProviderError,
    TokenUsage,
    Tool,
    ToolCall,
    ToolExecutor,
)


def _spec(name: str = "fake-conc-1") -> ModelSpec:
    return ModelSpec(
        name=name,
        provider="fake",
        cost=CostProfile(input_per_1k_usd=1.0, output_per_1k_usd=1.0),
        context_window=8_000,
        max_output_tokens=1_000,
        capabilities=frozenset({Capability.TOOL_CALLING}),
    )


class _SlowProvider(FakeProvider):
    """Records the peak concurrent in-flight calls and gates each call."""

    def __init__(
        self,
        *,
        gate: asyncio.Event,
        name: str = "fake",
        parked: asyncio.Event | None = None,
        threshold: int = 1,
    ) -> None:
        super().__init__(name=name)
        self._gate = gate
        self._parked = parked
        self._threshold = threshold
        self.active = 0
        self.peak = 0

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        self.calls.append(request)
        self.active += 1
        self.peak = max(self.peak, self.active)
        if self._parked is not None and self.active >= self._threshold:
            self._parked.set()
        try:
            await self._gate.wait()
        finally:
            self.active -= 1
        return CompletionResponse(
            text="ok",
            model=model.name,
            provider=self.name,
            usage=TokenUsage(input_tokens=1, output_tokens=1),
        )


async def test_concurrency_overlaps_up_to_the_cap_and_never_exceeds_it() -> None:
    limiter = ConcurrencyLimiter(2)
    gate = asyncio.Event()
    parked = asyncio.Event()
    provider = _SlowProvider(gate=gate, parked=parked, threshold=2)
    gateway = ModelGateway({"fake": provider}, {"m": _spec()}, limiter=limiter)
    request = CompletionRequest.prompt("hi")

    # Three calls, cap of two: all three are admitted as tasks, but at most two
    # are ever in flight, so the provider never sees more than two active.
    tasks = [asyncio.create_task(gateway.generate("m", request)) for _ in range(3)]

    # Wait until two calls are parked inside the provider, then prove a third is
    # still queued at the limiter rather than running.
    await parked.wait()

    assert provider.active == 2
    assert provider.peak == 2

    gate.set()
    results = await asyncio.gather(*tasks)
    assert len(results) == 3
    assert provider.peak == 2


async def test_cancellation_releases_a_slot() -> None:
    limiter = ConcurrencyLimiter(1)
    gate = asyncio.Event()
    parked = asyncio.Event()
    provider = _SlowProvider(gate=gate, parked=parked)
    gateway = ModelGateway({"fake": provider}, {"m": _spec()}, limiter=limiter)
    request = CompletionRequest.prompt("hi")

    first = asyncio.create_task(gateway.generate("m", request))
    await parked.wait()

    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        # gather re-raises the cancelled child's error on await.
        await asyncio.gather(first)

    # The slot is free again: a second call proceeds rather than deadlocking.
    gate.set()
    second = await gateway.generate("m", request)
    assert second.text == "ok"


async def test_error_releases_a_slot() -> None:
    limiter = ConcurrencyLimiter(1)
    provider = FakeProvider(name="fake", fail_with=("boom",))
    gateway = ModelGateway({"fake": provider}, {"m": _spec()}, limiter=limiter)
    request = CompletionRequest.prompt("hi")

    with pytest.raises(ProviderError):
        await gateway.generate("m", request)

    # The failed call must not leak the slot: the next call (which now succeeds
    # because the failure queue is exhausted) runs without hanging.
    result = await gateway.generate("m", request)
    assert result.text.startswith("echo:")


async def test_gateway_and_tool_executor_share_one_limiter() -> None:
    """One limiter, not two: a model call and a tool call draw from the same cap."""
    limiter = ConcurrencyLimiter(1)
    gate = asyncio.Event()
    parked = asyncio.Event()
    provider = _SlowProvider(gate=gate, parked=parked)
    gateway = ModelGateway({"fake": provider}, {"m": _spec()}, limiter=limiter)

    release = asyncio.Event()
    active = asyncio.Event()

    async def slow_tool() -> str:
        active.set()
        await release.wait()
        return "done"

    executor = ToolExecutor([Tool.of("slow", slow_tool)], limiter=limiter)
    tool_call = ToolCall(id="call_0_0", name="slow", arguments={})

    model_task = asyncio.create_task(gateway.generate("m", CompletionRequest.prompt("hi")))
    await parked.wait()

    # The tool call is queued behind the model call: same limiter, cap of one.
    tool_task = asyncio.create_task(executor.execute(tool_call))
    await asyncio.sleep(0.05)
    assert not active.is_set(), "the tool call ran while the model call held the shared slot"

    gate.set()
    await asyncio.gather(model_task)
    release.set()
    result = await tool_task
    assert result.content == "done"
