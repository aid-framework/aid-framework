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

from collections.abc import Callable, Iterable, Mapping, Sequence

from aid_runtime.cost import Budget, CostLedger, LedgerEntry, estimate_prompt_cost_usd
from aid_runtime.errors import (
    BudgetExceededError,
    CapabilityMismatchError,
    ConfigurationError,
    FeatureDeferredError,
    ProviderError,
    UnknownModelAliasError,
)
from aid_runtime.providers.base import Provider
from aid_runtime.tracing import ATTRIBUTES, get_tracer, llm_span, record_cost, record_usage
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    GenerationResult,
    ModelSpec,
    PinnedModel,
    TokenUsage,
)

__all__ = ["ModelGateway", "estimate_usage"]

#: Called after every successfully charged call. Lets a generated app log or
#: forward spend without the gateway knowing anything about logging.
CallHook = Callable[[LedgerEntry], None]


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
    ) -> GenerationResult:
        """Run one call, falling back through ``fallbacks`` in order.

        A fallback is only tried for a failure another model could plausibly
        survive: a provider error or a missing capability. A
        :class:`~aid_runtime.errors.BudgetExceededError` propagates immediately --
        retrying a different model cannot make an exhausted budget affordable.
        """
        chain = [alias, *fallbacks]
        errors: list[str] = []
        active_budget = budget if budget is not None else self._budget

        for index, candidate in enumerate(chain):
            pinned = self.resolve(candidate)
            try:
                return await self._attempt(pinned, request, active_budget, chain[: index + 1])
            except (ProviderError, CapabilityMismatchError) as exc:
                errors.append(f"{candidate}: {exc}")
                if index == len(chain) - 1:
                    raise ProviderError(
                        f"every candidate failed ({len(chain)} tried): {'; '.join(errors)}"
                    ) from exc

        raise ProviderError(f"no candidate produced a response: {'; '.join(errors)}")

    async def stream(self, alias: str, request: CompletionRequest) -> None:
        """Declared but not implemented; see the module docstring."""
        raise FeatureDeferredError(
            "streaming is a declared capability, not an implemented one; "
            "Phase 0 serves request/response only"
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
    ) -> GenerationResult:
        if budget is not None:
            self._ledger.check(budget)
            self._preflight(pinned, request, budget)

        spec = pinned.spec
        provider = self._providers[spec.provider]

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

        return GenerationResult(
            response=response,
            alias=pinned.alias,
            cost_usd=cost,
            attempts=tuple(attempted),
        )

    def _preflight(self, pinned: PinnedModel, request: CompletionRequest, budget: Budget) -> None:
        """Refuse a call whose *prompt* alone already breaches the budget.

        Only the prompt is priced, and deliberately over-estimated, because the
        response is unknowable before the call. This catches gross overruns early;
        the post-call charge is what enforces the ceiling exactly.
        """
        if budget.max_usd is None:
            return
        projected = self._ledger.cost_usd + sum(
            estimate_prompt_cost_usd(pinned.spec, message.content) for message in request.messages
        )
        if projected > budget.max_usd:
            raise BudgetExceededError(budget.scope, budget.max_usd, projected)


def estimate_usage(texts: Sequence[str]) -> TokenUsage:
    """Token estimate for a set of strings, at the usual four characters per token."""
    return TokenUsage(input_tokens=sum((len(text) + 3) // 4 for text in texts), output_tokens=0)
