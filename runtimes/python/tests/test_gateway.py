"""The gateway: pinning, capability negotiation, ordered fallback, budgets."""

from __future__ import annotations

from typing import Any

import pytest

from aid_runtime import (
    Budget,
    BudgetExceededError,
    Capability,
    CapabilityMismatchError,
    CompletionRequest,
    CompletionResponse,
    ConfigurationError,
    CostLedger,
    CostProfile,
    FakeProvider,
    FeatureDeferredError,
    ModelGateway,
    ModelSpec,
    ProviderError,
    UnknownModelAliasError,
    estimate_usage,
)
from aid_runtime.types import TokenUsage

PROMPT = CompletionRequest.prompt("hello")


class _CappedProvider(FakeProvider):
    """A provider whose *adapter* is narrower than the models it serves."""

    def __init__(self, *, capabilities: frozenset[Capability], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._capabilities = capabilities

    @property
    def capabilities(self) -> frozenset[Capability]:
        return self._capabilities


class _RecordingCloser(FakeProvider):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.closes = 0

    async def aclose(self) -> None:
        self.closes += 1


class _BrokenProvider(FakeProvider):
    """Raises a capability mismatch from ``complete`` rather than from resolution."""

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        raise CapabilityMismatchError(model.name, ["tool-calling"])


def _spec(name: str, provider: str = "fake", **overrides: Any) -> ModelSpec:
    base: dict[str, Any] = {
        "name": name,
        "provider": provider,
        "cost": CostProfile(input_per_1k_usd=1.0, output_per_1k_usd=1.0),
        "context_window": 8_000,
        "max_output_tokens": 1_000,
        "capabilities": frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT}),
    }
    base.update(overrides)
    return ModelSpec.model_validate(base)


def test_gateway_needs_a_provider() -> None:
    with pytest.raises(ConfigurationError):
        ModelGateway({}, {"small": _spec("m")})


def test_gateway_needs_an_alias() -> None:
    with pytest.raises(ConfigurationError):
        ModelGateway({"fake": FakeProvider()}, {})


def test_alias_naming_an_absent_provider_is_refused() -> None:
    """The failure must name the offender, not surface later as an opaque KeyError."""
    with pytest.raises(ConfigurationError) as caught:
        ModelGateway({"fake": FakeProvider()}, {"small": _spec("m", provider="anthropic")})
    assert "anthropic" in str(caught.value)
    assert "['fake']" in str(caught.value)


def test_aliases_are_reported_sorted() -> None:
    gateway = ModelGateway({"fake": FakeProvider()}, {"zeta": _spec("m1"), "alpha": _spec("m2")})
    assert gateway.aliases == ("alpha", "zeta")


def test_resolve_returns_a_pinned_model(gateway: ModelGateway, spec: ModelSpec) -> None:
    pinned = gateway.resolve("small")
    assert pinned.alias == "small"
    assert pinned.spec == spec
    assert pinned.provider == "fake"
    assert pinned.capabilities == spec.capabilities


def test_unknown_alias_is_a_configuration_error(gateway: ModelGateway) -> None:
    """Pinning means the alias table is closed; there is no provider default."""
    assert isinstance(UnknownModelAliasError("nope", ()), ConfigurationError)
    with pytest.raises(UnknownModelAliasError) as caught:
        gateway.resolve("nope")
    assert caught.value.alias == "nope"
    assert caught.value.known == ("large", "small")
    assert "pinned aliases: large, small" in str(caught.value)


def test_provider_for_returns_the_adapter(gateway: ModelGateway, provider: FakeProvider) -> None:
    assert gateway.provider_for("small") is provider
    with pytest.raises(UnknownModelAliasError):
        gateway.provider_for("nope")


def test_require_checks_the_model_and_the_adapter() -> None:
    wide = _CappedProvider(name="fake", capabilities=frozenset(Capability))
    narrow = _CappedProvider(name="narrow", capabilities=frozenset({Capability.STRUCTURED_OUTPUT}))
    gateway = ModelGateway(
        {"fake": wide, "narrow": narrow},
        {
            "full": _spec("full", capabilities=frozenset(Capability)),
            "text-only": _spec("text-only", capabilities=frozenset({Capability.STRUCTURED_OUTPUT})),
            "on-narrow": _spec("on-narrow", provider="narrow", capabilities=frozenset(Capability)),
        },
    )

    assert gateway.require("full", [Capability.TOOL_CALLING]).alias == "full"
    assert gateway.require("full", []).alias == "full"

    with pytest.raises(CapabilityMismatchError) as model_side:
        gateway.require("text-only", [Capability.TOOL_CALLING])
    assert model_side.value.alias == "text-only"
    assert model_side.value.missing == ("tool-calling",)

    # The model claims the capability; the adapter cannot serialise it. Still a mismatch.
    with pytest.raises(CapabilityMismatchError) as adapter_side:
        gateway.require("on-narrow", [Capability.TOOL_CALLING, Capability.LONG_CONTEXT])
    assert adapter_side.value.missing == ("long-context", "tool-calling")


async def test_generate_records_the_call(gateway: ModelGateway, provider: FakeProvider) -> None:
    result = await gateway.generate("small", PROMPT)

    assert result.alias == "small"
    assert result.attempts == ("small",)
    assert result.fell_back is False
    assert result.response.model == "fake-small-1"
    assert result.response.provider == "fake"
    assert result.text.startswith("echo:")
    assert len(provider.calls) == 1
    assert len(gateway.ledger.entries) == 1
    assert gateway.ledger.entries[0].alias == "small"


async def test_generate_falls_back_in_the_order_given() -> None:
    primary = FakeProvider(name="primary", fail_with=("upstream 503",))
    backup = FakeProvider(name="backup")
    gateway = ModelGateway(
        {"primary": primary, "backup": backup},
        {
            "p": _spec("primary-model", provider="primary"),
            "b": _spec("backup-model", provider="backup"),
        },
    )

    result = await gateway.generate("p", PROMPT, fallbacks=("b",))

    assert result.alias == "b"
    assert result.attempts == ("p", "b")
    assert result.fell_back is True
    assert result.response.model == "backup-model"
    assert len(primary.calls) == 1
    assert len(backup.calls) == 1
    # The failed attempt produced no billable response, so it is not charged.
    assert len(gateway.ledger.entries) == 1
    assert gateway.ledger.entries[0].alias == "b"


async def test_a_fallback_is_only_tried_when_the_preceding_one_fails(
    gateway: ModelGateway, provider: FakeProvider
) -> None:
    result = await gateway.generate("small", PROMPT, fallbacks=("large",))
    assert result.alias == "small"
    assert result.attempts == ("small",)
    assert len(provider.calls) == 1


async def test_exhausted_chain_reports_every_attempt(spec: ModelSpec) -> None:
    failing = FakeProvider(name="fake", fail_with=("boom one", "boom two"))
    gateway = ModelGateway({"fake": failing}, {"a": spec, "b": spec})

    with pytest.raises(ProviderError) as caught:
        await gateway.generate("a", PROMPT, fallbacks=("b",))

    message = str(caught.value)
    assert "every candidate failed (2 tried)" in message
    assert "a: boom one" in message
    assert "b: boom two" in message


async def test_capability_mismatch_is_fallback_eligible() -> None:
    """A missing capability is exactly the failure another model can survive."""
    gateway = ModelGateway(
        {"fake": _BrokenProvider(name="fake"), "ok": FakeProvider(name="ok")},
        {"broken": _spec("broken", provider="fake"), "healthy": _spec("healthy", provider="ok")},
    )

    result = await gateway.generate("broken", PROMPT, fallbacks=("healthy",))
    assert result.alias == "healthy"
    assert result.attempts == ("broken", "healthy")


async def test_budget_refusal_does_not_fall_back(spec: ModelSpec) -> None:
    """Trying a different model cannot make an exhausted budget affordable."""
    secondary = FakeProvider(name="fake")
    gateway = ModelGateway({"fake": secondary}, {"primary": spec, "backup": spec})
    budget = Budget(max_usd=0.000001, scope="run")

    with pytest.raises(BudgetExceededError):
        await gateway.generate("primary", PROMPT, fallbacks=("backup",), budget=budget)

    assert secondary.calls == []
    assert gateway.ledger.entries == ()


async def test_preflight_refuses_before_spending(spec: ModelSpec) -> None:
    provider = FakeProvider(name="fake")
    gateway = ModelGateway({"fake": provider}, {"small": spec})

    with pytest.raises(BudgetExceededError) as caught:
        await gateway.generate("small", PROMPT, budget=Budget(max_usd=0.000001))

    assert caught.value.spent > caught.value.limit
    assert provider.calls == []


async def test_token_budget_is_enforced_after_the_call(spec: ModelSpec) -> None:
    """Without a USD ceiling there is no pre-flight, so the charge must refuse."""
    provider = FakeProvider(name="fake")
    gateway = ModelGateway({"fake": provider}, {"small": spec})

    with pytest.raises(BudgetExceededError) as caught:
        await gateway.generate("small", PROMPT, budget=Budget(max_total_tokens=1))

    assert caught.value.unit == "tokens"
    assert len(provider.calls) == 1
    assert gateway.ledger.total_tokens > 1


async def test_unknown_alias_in_a_fallback_chain_is_not_swallowed(spec: ModelSpec) -> None:
    """An unknown alias is a configuration error, so it must not be retried."""
    gateway = ModelGateway(
        {"fake": FakeProvider(name="fake", fail_with=("boom",))}, {"small": spec}
    )
    with pytest.raises(UnknownModelAliasError):
        await gateway.generate("small", PROMPT, fallbacks=("ghost",))


async def test_gateway_budget_is_used_when_none_is_passed(spec: ModelSpec) -> None:
    gateway = ModelGateway(
        {"fake": FakeProvider()},
        {"small": spec},
        budget=Budget(max_total_tokens=1, scope="default"),
    )
    with pytest.raises(BudgetExceededError) as caught:
        await gateway.generate("small", PROMPT)
    assert caught.value.scope == "default"


async def test_ledger_and_hooks_observe_the_charge(spec: ModelSpec) -> None:
    ledger = CostLedger()
    seen: list[Any] = []
    gateway = ModelGateway(
        {"fake": FakeProvider(name="fake")},
        {"small": spec},
        ledger=ledger,
        on_call=(seen.append,),
    )

    result = await gateway.generate("small", PROMPT)

    assert gateway.ledger is ledger
    assert len(seen) == 1
    assert seen[0].alias == "small"
    assert seen[0].provider == "fake"
    assert seen[0].model == "fake-small-1"
    assert seen[0].cost_usd == result.cost_usd
    assert seen[0].usage == result.usage
    assert ledger.summary().calls == 1


async def test_generate_prices_the_response_at_the_pinned_rate(spec: ModelSpec) -> None:
    gateway = ModelGateway({"fake": FakeProvider(name="fake")}, {"small": spec})
    result = await gateway.generate("small", PROMPT)
    assert result.cost_usd == spec.cost.cost_usd(result.usage)
    assert result.cost_usd > 0.0


async def test_streaming_is_declared_not_implemented(gateway: ModelGateway) -> None:
    with pytest.raises(FeatureDeferredError) as caught:
        await gateway.stream("small", PROMPT)
    assert "request/response only" in str(caught.value)


async def test_aclose_reaches_every_provider() -> None:
    one = _RecordingCloser(name="fake")
    two = _RecordingCloser(name="other")
    gateway = ModelGateway(
        {"fake": one, "other": two},
        {"a": _spec("a", provider="fake"), "b": _spec("b", provider="other")},
    )

    await gateway.aclose()
    await gateway.aclose()

    assert one.closes == 2
    assert two.closes == 2


def test_estimate_usage_rounds_up_per_string() -> None:
    assert estimate_usage(["abcd"]).input_tokens == 1
    assert estimate_usage(["abcde"]).input_tokens == 2
    assert estimate_usage(["", ""]) == TokenUsage(input_tokens=0, output_tokens=0)
    assert estimate_usage([]) == TokenUsage(input_tokens=0, output_tokens=0)


def test_pinned_model_supports_is_a_subset_test(gateway: ModelGateway) -> None:
    pinned = gateway.resolve("small")
    assert pinned.supports(frozenset({Capability.TOOL_CALLING}))
    assert pinned.supports(frozenset())
    assert not pinned.supports(frozenset({Capability.STREAMING}))
    assert not pinned.supports(frozenset({Capability.TOOL_CALLING, Capability.STREAMING}))
