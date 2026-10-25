"""The model gateway: alias resolution, capability negotiation, cost accounting.

Three responsibilities, in this order:

1. **Pinning.** An alias resolves to an exact provider model id. Unknown aliases
   are an error; there is no fall-through to a provider default, because a
   provider default is precisely the floating version a stored eval baseline
   cannot survive.
2. **Ordered fallback.** A caller may name fallback aliases. They are tried in the
   order given, and the aliases actually attempted are reported on the result.
   Escalation routing -- "use the strong model if the cheap one is unsure" -- is
   *not* implemented: "unsure" needs an agent loop to define, which is Phase 2.
3. **Budgets and tracing.** Every charged call opens a GenAI span and updates the
   ledger.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any

from aid_runtime.cache import CompletionCache, cache_key_for
from aid_runtime.concurrency import ConcurrencyLimiter
from aid_runtime.cost import Budget, CostLedger, LedgerEntry, estimate_prompt_cost_usd
from aid_runtime.errors import (
    BudgetExceededError,
    CapabilityMismatchError,
    ConfigurationError,
    ProviderError,
    UnknownModelAliasError,
)
from aid_runtime.providers.base import Provider
from aid_runtime.tracing import ATTRIBUTES, get_tracer, llm_span, record_cost, record_usage
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    FinishReason,
    GenerationResult,
    ModelSpec,
    PinnedModel,
    TokenUsage,
)

__all__ = ["ModelGateway", "estimate_usage"]

#: The fixed chunk size a cached stream is re-chunked into, so a cache hit still
#: streams as several deltas rather than one blob.
_CACHE_CHUNK = 16

#: Callback after every successfully charged call. Lets a generated app log or
#: forward spend without the gateway knowing anything about logging.
CallHook = Callable[[LedgerEntry], None]


def _sse(payload: dict[str, Any]) -> bytes:
    """Encode one Server-Sent Event ``data`` frame as UTF-8 bytes."""
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n".encode()


class ModelGateway:
    """Resolves aliases to pinned models and executes calls within a budget."""

    def __init__(
        self,
        providers: Mapping[str, Provider],
        aliases: Mapping[str, ModelSpec | PinnedModel],
        *,
        ledger: CostLedger | None = None,
        budget: Budget | None = None,
        on_call: Iterable[CallHook] = (),
        tracer_name: str = "aid_runtime",
        limiter: ConcurrencyLimiter | None = None,
    ) -> None:
        if not providers:
            raise ConfigurationError("the gateway needs at least one provider")
        if not aliases:
            raise ConfigurationError("the gateway needs at least one pinned alias")

        self._providers = dict(providers)
        self._aliases: dict[str, ModelSpec] = {}
        for alias, value in aliases.items():
            spec = value.spec if isinstance(value, PinnedModel) else value
            if spec.provider not in self._providers:
                raise ConfigurationError(
                    f"alias {alias!r} names provider {spec.provider!r}, "
                    f"which is not among {sorted(self._providers)}"
                )
            self._aliases[alias] = spec

        self._ledger = ledger if ledger is not None else CostLedger()
        self._budget = budget
        self._hooks = tuple(on_call)
        self._tracer_name = tracer_name
        self._cache = CompletionCache()
        self._limiter = limiter

    @property
    def aliases(self) -> tuple[str, ...]:
        return tuple(sorted(self._aliases))

    @property
    def ledger(self) -> CostLedger:
        return self._ledger

    @property
    def budget(self) -> Budget | None:
        return self._budget

    def resolve(self, alias: str) -> PinnedModel:
        """Resolve an alias to its pinned model, or fail loudly."""
        try:
            spec = self._aliases[alias]
        except KeyError:
            raise UnknownModelAliasError(alias, self.aliases) from None
        return PinnedModel(alias=alias, spec=spec)

    def provider_for(self, alias: str) -> Provider:
        """The adapter that serves ``alias``. Raises for an unknown alias."""
        return self._providers[self.resolve(alias).spec.provider]

    def require(self, alias: str, capabilities: Iterable[Capability]) -> PinnedModel:
        """Assert a pinned model *and* its adapter advertise every capability.

        Both sides are checked: a model that supports tool calling behind an
        adapter that does not serialise tool definitions cannot tool-call.
        """
        pinned = self.resolve(alias)
        required = frozenset(capabilities)
        missing = required - pinned.spec.capabilities
        missing |= required - self._providers[pinned.spec.provider].capabilities
        if missing:
            raise CapabilityMismatchError(alias, sorted(c.value for c in missing))
        return pinned

    async def generate(
        self,
        alias: str,
        request: CompletionRequest,
        *,
        fallbacks: Sequence[str] = (),
        budget: Budget | None = None,
        use_cache: bool = True,
    ) -> GenerationResult:
        """Run one call, falling back through ``fallbacks`` in order.

        A fallback is only tried for a failure another model could plausibly
        survive: a provider error or a missing capability. A
        :class:`~aid_runtime.errors.BudgetExceededError` propagates immediately --
        retrying a different model cannot make an exhausted budget affordable.

        ``use_cache`` opts out of the cache (default: on). It exists for callers
        whose result must reflect a live call -- evals in particular, where a
        cached answer would be a false pass.
        """
        chain = [alias, *fallbacks]
        errors: list[str] = []
        active_budget = budget if budget is not None else self._budget

        for index, candidate in enumerate(chain):
            pinned = self.resolve(candidate)
            try:
                return await self._attempt(
                    pinned, request, active_budget, chain[: index + 1], use_cache
                )
            except (ProviderError, CapabilityMismatchError) as exc:
                errors.append(f"{candidate}: {exc}")
                if index == len(chain) - 1:
                    raise ProviderError(
                        f"every candidate failed ({len(chain)} tried): {'; '.join(errors)}"
                    ) from exc

        raise ProviderError(f"no candidate produced a response: {'; '.join(errors)}")

    def projected_cost_usd(self, alias: str, request: CompletionRequest) -> float:
        """Spend so far plus the prompt price of ``request`` on ``alias``.

        This is the *same* estimate :meth:`_preflight` refuses on, exposed so an
        agent loop can decide to route to a cheaper alias before the gateway would
        refuse the call. One estimate, one accounting path.
        """
        spec = self.resolve(alias).spec
        return self._ledger.cost_usd + sum(
            estimate_prompt_cost_usd(spec, message.content) for message in request.messages
        )

    def fits(self, alias: str, request: CompletionRequest, budget: Budget | None) -> bool:
        """Whether ``request`` on ``alias`` still fits ``budget``'s dollar ceiling.

        Only dollars are projected: switching *alias* changes price, never token
        count, so token ceilings cannot be improved by a cheaper model. A budget
        with only a token ceiling therefore always "fits" here and is enforced by
        :meth:`CostLedger.charge`, exactly as the gateway does it.
        """
        if budget is None or budget.max_usd is None:
            return True
        if self._ledger.cost_usd > budget.max_usd:
            return False
        return self.projected_cost_usd(alias, request) <= budget.max_usd

    async def stream(
        self,
        alias: str,
        request: CompletionRequest,
        *,
        budget: Budget | None = None,
        use_cache: bool = True,
    ) -> AsyncIterator[bytes]:
        """Stream one call as Server-Sent Event ``data`` frames, accounting exactly
        like :meth:`generate`.

        Each frame is ``data: <json>\\n\\n``: one frame per text delta (payload
        ``{"delta": "..."}``) so the first frame reaches the wire before the call
        completes, then a terminal frame carrying ``done``, the finish reason, the
        served model/provider and the usage. A cache hit re-chunks the cached text
        and charges nothing. Cancellation propagates from the consumer and closes
        the stream, releasing the shared concurrency slot.

        Only models *and* adapters advertising ``streaming`` are served; anything
        else raises :class:`CapabilityMismatchError` rather than silently falling
        back to a non-streaming response.
        """
        pinned = self.require(alias, (Capability.STREAMING,))
        spec = pinned.spec
        provider = self._providers[spec.provider]
        active_budget = budget if budget is not None else self._budget

        if active_budget is not None:
            self._ledger.check(active_budget)
            self._preflight(pinned, request, active_budget)

        cached = self._cache_get(spec, request) if use_cache else None
        if cached is not None:
            async for frame in self._stream_cached(pinned, cached):
                yield frame
            return

        text_parts: list[str] = []
        usage = TokenUsage(input_tokens=0, output_tokens=0)
        finish_reason: FinishReason = "stop"

        async with self._limit():
            with llm_span(
                model=spec.name,
                provider=spec.provider,
                alias=pinned.alias,
                temperature=request.temperature,
                max_tokens=request.max_output_tokens,
                tracer=get_tracer(self._tracer_name),
            ) as span:
                async for chunk in provider.stream(request, model=spec):
                    if chunk.delta:
                        text_parts.append(chunk.delta)
                        yield _sse({"delta": chunk.delta})
                    if chunk.usage is not None:
                        usage = chunk.usage
                    if chunk.finish_reason is not None:
                        finish_reason = chunk.finish_reason

                text = "".join(text_parts)
                if usage.total_tokens == 0:
                    usage = TokenUsage(
                        input_tokens=sum(
                            (len(message.content) + 3) // 4 for message in request.messages
                        ),
                        output_tokens=(len(text) + 3) // 4,
                    )
                cost = spec.cost.cost_usd(usage)
                record_usage(span, usage)
                record_cost(span, cost, alias=pinned.alias)

                entry = LedgerEntry(
                    alias=pinned.alias,
                    model=spec.name,
                    provider=spec.provider,
                    usage=usage,
                    cost_usd=cost,
                )
                self._ledger.charge(active_budget, entry)
                for hook in self._hooks:
                    hook(entry)

                if use_cache:
                    self._cache_put(
                        spec,
                        request,
                        CompletionResponse(
                            text=text,
                            model=spec.name,
                            provider=spec.provider,
                            usage=usage,
                            finish_reason=finish_reason,
                        ),
                    )

        yield _sse(
            {
                "done": True,
                "finish_reason": finish_reason,
                "model": spec.name,
                "provider": spec.provider,
            }
        )

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()

    async def _attempt(
        self,
        pinned: PinnedModel,
        request: CompletionRequest,
        budget: Budget | None,
        attempted: Sequence[str],
        use_cache: bool,
    ) -> GenerationResult:
        if budget is not None:
            self._ledger.check(budget)
            self._preflight(pinned, request, budget)

        spec = pinned.spec
        provider = self._providers[spec.provider]

        if use_cache:
            cached = self._cache_get(spec, request)
            if cached is not None:
                return self._cache_result(pinned, cached, attempted)

        async with self._limit():
            with llm_span(
                model=spec.name,
                provider=spec.provider,
                alias=pinned.alias,
                temperature=request.temperature,
                max_tokens=request.max_output_tokens,
                tracer=get_tracer(self._tracer_name),
            ) as span:
                response = await provider.complete(request, model=spec)
                cost = spec.cost.cost_usd(response.usage)
                record_usage(span, response.usage)
                record_cost(span, cost, alias=pinned.alias)
                if len(attempted) > 1:
                    span.set_attribute(ATTRIBUTES["attempts"], list(attempted))

        entry = LedgerEntry(
            alias=pinned.alias,
            model=response.model,
            provider=response.provider,
            usage=response.usage,
            cost_usd=cost,
        )
        self._ledger.charge(budget, entry)
        for hook in self._hooks:
            hook(entry)

        if use_cache:
            self._cache_put(spec, request, response)

        return GenerationResult(
            response=response,
            alias=pinned.alias,
            cost_usd=cost,
            attempts=tuple(attempted),
        )

    @asynccontextmanager
    async def _limit(self) -> AsyncIterator[None]:
        """Acquire the shared concurrency slot, releasing it on cancel or error.

        A gateway constructed without a limiter is unbounded (no-op), which keeps
        plain request/response usage free of concurrency surprises.
        """
        if self._limiter is None:
            yield
            return
        async with self._limiter.run():
            yield

    def _cache_get(self, spec: ModelSpec, request: CompletionRequest) -> CompletionResponse | None:
        cfg = spec.cache
        if cfg is None:
            return None
        if cfg.prompt:
            exact = self._cache.get(cache_key_for(spec.name, request))
            if exact is not None:
                return exact
        if cfg.semantic is not None:
            return self._cache.semantic_get(
                spec,
                request,
                threshold=cfg.semantic.threshold,
                ttl_seconds=cfg.semantic.ttl_seconds,
            )
        return None

    def _cache_put(
        self, spec: ModelSpec, request: CompletionRequest, response: CompletionResponse
    ) -> None:
        cfg = spec.cache
        if cfg is None or (not cfg.prompt and cfg.semantic is None):
            return
        self._cache.put(cache_key_for(spec.name, request), response, request)

    def _cache_result(
        self, pinned: PinnedModel, response: CompletionResponse, attempted: Sequence[str]
    ) -> GenerationResult:
        """Build a cache-hit result: trace-visible, zero cost, no budget charge."""
        with llm_span(
            model=response.model,
            provider=response.provider,
            alias=pinned.alias,
            tracer=get_tracer(self._tracer_name),
        ) as span:
            span.set_attribute("aid.cache.hit", True)
            if len(attempted) > 1:
                span.set_attribute(ATTRIBUTES["attempts"], list(attempted))
        return GenerationResult(
            response=response,
            alias=pinned.alias,
            cost_usd=0.0,
            attempts=tuple(attempted),
            cache_hit=True,
        )

    async def _stream_cached(
        self, pinned: PinnedModel, response: CompletionResponse
    ) -> AsyncIterator[bytes]:
        with llm_span(
            model=response.model,
            provider=response.provider,
            alias=pinned.alias,
            tracer=get_tracer(self._tracer_name),
        ) as span:
            span.set_attribute("aid.cache.hit", True)
        text = response.text
        for start in range(0, len(text), _CACHE_CHUNK):
            yield _sse({"delta": text[start : start + _CACHE_CHUNK]})
        yield _sse(
            {
                "done": True,
                "finish_reason": response.finish_reason,
                "model": response.model,
                "provider": response.provider,
            }
        )

    def clear_cache(self) -> None:
        """Empty the prompt and semantic caches.

        Exposed for callers -- tests and evals in particular -- that need a known
        cold cache rather than an accidental hit from an earlier call.
        """
        self._cache.clear()

    def _preflight(self, pinned: PinnedModel, request: CompletionRequest, budget: Budget) -> None:
        """Refuse a call whose *prompt* alone already breaches the budget.

        Only the prompt is priced, and deliberately over-estimated, because the
        response is unknowable before the call. This catches gross overruns early;
        the post-call charge is what enforces the ceiling exactly.
        """
        if budget.max_usd is None:
            return
        projected = self.projected_cost_usd(pinned.alias, request)
        if projected > budget.max_usd:
            raise BudgetExceededError(budget.scope, budget.max_usd, projected)


def estimate_usage(texts: Sequence[str]) -> TokenUsage:
    """Token estimate for a set of strings, at the usual four characters per token."""
    return TokenUsage(input_tokens=sum((len(text) + 3) // 4 for text in texts), output_tokens=0)
