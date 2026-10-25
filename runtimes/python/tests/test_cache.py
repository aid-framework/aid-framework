"""Prompt and semantic caching: keys, opt-in reuse, TTL, no charge on hit.

The cache key is ``(model, prompt hash, tool schema hash, temperature)``. Semantic
reuse is opt-in (explicit threshold and TTL, no silent default) and is gated by the
*same* structural key, so a prompt change can never resurrect a response computed
with different tools or a different model. Hits are trace-visible and free: they
never touch the ledger.
"""

from __future__ import annotations

import asyncio

from aid_runtime import (
    Capability,
    CompletionCache,
    CompletionRequest,
    CompletionResponse,
    CostLedger,
    CostProfile,
    FakeProvider,
    ModelCacheConfig,
    ModelGateway,
    ModelSpec,
    SemanticCacheConfig,
    cache_key_for,
)
from aid_runtime.types import TokenUsage, ToolDefinition


def _spec(*, cache: ModelCacheConfig | None = None) -> ModelSpec:
    return ModelSpec(
        name="fake-cache-1",
        provider="fake",
        cost=CostProfile(input_per_1k_usd=1.0, output_per_1k_usd=1.0),
        context_window=8_000,
        max_output_tokens=1_000,
        capabilities=frozenset({Capability.TOOL_CALLING}),
        cache=cache,
    )


def _gateway(
    spec: ModelSpec,
    *,
    provider: FakeProvider | None = None,
    ledger: CostLedger | None = None,
) -> ModelGateway:
    return ModelGateway(
        {"fake": provider if provider is not None else FakeProvider(name="fake")},
        {"m": spec},
        ledger=ledger,
    )


async def test_prompt_cache_hit_is_trace_visible_and_free() -> None:
    ledger = CostLedger()
    provider = FakeProvider(name="fake")
    gateway = _gateway(_spec(cache=ModelCacheConfig(prompt=True)), provider=provider, ledger=ledger)
    request = CompletionRequest.prompt("what is the capital of France?")

    first = await gateway.generate("m", request)
    second = await gateway.generate("m", request)

    assert first.cache_hit is False
    assert second.cache_hit is True
    assert second.cost_usd == 0.0
    assert len(provider.calls) == 1, "a cache hit must not reach the provider"
    assert ledger.summary().calls == 1, "a cache hit must not charge the ledger"


async def test_cache_is_keyed_by_prompt_tools_and_temperature() -> None:
    provider = FakeProvider(name="fake")
    gateway = _gateway(_spec(cache=ModelCacheConfig(prompt=True)), provider=provider)

    await gateway.generate("m", CompletionRequest.prompt("hello"))
    # The exact same request hits.
    assert (await gateway.generate("m", CompletionRequest.prompt("hello"))).cache_hit
    # Same prompt but a different temperature is a different key.
    hot = CompletionRequest.prompt("hello").model_copy(update={"temperature": 0.5})
    assert not (await gateway.generate("m", hot)).cache_hit
    # Different tools is a different key.
    tooled = CompletionRequest.prompt("hello").model_copy(
        update={"tools": (ToolDefinition(name="lookup", parameters={"type": "object"}),)}
    )
    assert not (await gateway.generate("m", tooled)).cache_hit


def test_cache_key_for_distinguishes_tools_and_temperature() -> None:
    base = CompletionRequest.prompt("hello")
    tooled = base.model_copy(
        update={"tools": (ToolDefinition(name="lookup", parameters={"type": "object"}),)}
    )
    hot = base.model_copy(update={"temperature": 0.5})

    a = cache_key_for("m", base)
    b = cache_key_for("m", tooled)
    c = cache_key_for("m", hot)
    d = cache_key_for("other", base)

    assert len({a, b, c, d}) == 4
    assert a.tools_hash != b.tools_hash
    assert a.temperature != c.temperature
    assert a.model != d.model


async def test_semantic_cache_is_opt_in_with_explicit_threshold_and_ttl() -> None:
    provider = FakeProvider(name="fake")
    gateway = _gateway(
        _spec(cache=ModelCacheConfig(semantic=SemanticCacheConfig(threshold=0.5, ttl_seconds=60))),
        provider=provider,
    )

    first = await gateway.generate("m", CompletionRequest.prompt("capital of France"))
    assert not first.cache_hit
    # A near-identical prompt reuses the entry through the semantic path.
    second = await gateway.generate("m", CompletionRequest.prompt("capital of France?"))
    assert second.cache_hit
    assert len(provider.calls) == 1


async def test_semantic_cache_does_not_reuse_dissimilar_prompts() -> None:
    provider = FakeProvider(name="fake")
    gateway = _gateway(
        _spec(cache=ModelCacheConfig(semantic=SemanticCacheConfig(threshold=0.9, ttl_seconds=60))),
        provider=provider,
    )

    await gateway.generate("m", CompletionRequest.prompt("capital of France"))
    # Same structure, but below the Jaccard threshold: a real miss.
    second = await gateway.generate("m", CompletionRequest.prompt("unrelated topic about weather"))
    assert not second.cache_hit
    assert len(provider.calls) == 2


def test_semantic_cache_honours_ttl() -> None:
    """An entry older than the TTL is not reusable, even for an identical prompt."""
    spec = _spec(cache=ModelCacheConfig(semantic=SemanticCacheConfig(threshold=0.5, ttl_seconds=1)))
    cache = CompletionCache()
    request = CompletionRequest.prompt("capital of France")
    response = CompletionResponse(
        text="paris",
        model=spec.name,
        provider="fake",
        usage=TokenUsage(input_tokens=1, output_tokens=1),
    )

    cache.put(cache_key_for(spec.name, request), response, request)

    # Age the stored entry past its TTL by rewriting its stored_at timestamp.
    key = cache_key_for(spec.name, request)
    entry = cache._entries[(key.model, key.prompt_hash, key.tools_hash, key.temperature)]
    entry.stored_at -= 2.0

    assert cache.semantic_get(spec, request, threshold=0.5, ttl_seconds=1) is None


async def test_use_cache_false_bypasses_the_cache() -> None:
    provider = FakeProvider(name="fake")
    gateway = _gateway(_spec(cache=ModelCacheConfig(prompt=True)), provider=provider)
    request = CompletionRequest.prompt("hello")

    await gateway.generate("m", request)
    second = await gateway.generate("m", request, use_cache=False)

    assert not second.cache_hit
    assert len(provider.calls) == 2


async def test_empty_cache_declaration_does_not_cache() -> None:
    """``cache: {}`` (no prompt, no semantic) is a no-op, not an always-cache."""
    provider = FakeProvider(name="fake")
    gateway = _gateway(_spec(cache=ModelCacheConfig()), provider=provider)
    request = CompletionRequest.prompt("hello")

    await gateway.generate("m", request)
    second = await gateway.generate("m", request)

    assert not second.cache_hit
    assert len(provider.calls) == 2


async def test_completion_cache_does_not_coalesce_inflight_requests() -> None:
    """The explicit no-coalescing choice: concurrent misses each call the provider.

    Two identical requests issued together must both reach the provider, never
    silently share a half-populated entry. We prove it with a gateway whose
    provider blocks both calls before either result is cached, then observe that
    both calls ran.
    """
    release = asyncio.Event()
    entered = asyncio.Event()

    class _GatingProvider(FakeProvider):
        async def complete(
            self, request: CompletionRequest, *, model: ModelSpec
        ) -> CompletionResponse:
            self.calls.append(request)
            entered.set()
            await release.wait()
            return CompletionResponse(
                text="gated",
                model=model.name,
                provider=self.name,
                usage=TokenUsage(input_tokens=1, output_tokens=1),
            )

    provider = _GatingProvider(name="fake")
    gateway = _gateway(_spec(cache=ModelCacheConfig(prompt=True)), provider=provider)
    request = CompletionRequest.prompt("hi")

    task_one = asyncio.create_task(gateway.generate("m", request))
    task_two = asyncio.create_task(gateway.generate("m", request))

    await entered.wait()
    release.set()
    results = await asyncio.gather(task_one, task_two)

    # Both tasks ran the provider: the second did not wait on the first's entry.
    assert len(provider.calls) == 2
    # Both observed the cold cache before either result was stored, so neither
    # silently shares the other's half-populated entry.
    assert all(not result.cache_hit for result in results)
