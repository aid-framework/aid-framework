"""Shared fixtures for the AID Python runtime test suite.

Fixtures are deliberately concrete rather than factory-shaped. A test that needs a
differently pinned model builds one where it is used, which keeps this file
readable instead of accumulating optional arguments that only one test ever sets.
"""

from __future__ import annotations

import pytest

from aid_runtime import (
    CostProfile,
    Dataset,
    EvalCase,
    FakeProvider,
    ModelGateway,
    ModelSpec,
)
from aid_runtime.types import Capability

FAKE_PROVIDER = "fake"
SMALL_ALIAS = "small"
LARGE_ALIAS = "large"

#: Capabilities both fixtures advertise. Streaming is deliberately absent from
#: the http adapter but present here so capability negotiation can be tested in
#: both directions.
CAPABILITIES = frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT})


@pytest.fixture
def spec() -> ModelSpec:
    """A pinned, inexpensive model served by the fake provider."""
    return ModelSpec(
        name="fake-small-1",
        provider=FAKE_PROVIDER,
        cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
        context_window=128_000,
        max_output_tokens=4_096,
        capabilities=CAPABILITIES,
    )


@pytest.fixture
def large_spec() -> ModelSpec:
    """A second pinned model, used to exercise ordered fallback."""
    return ModelSpec(
        name="fake-large-1",
        provider=FAKE_PROVIDER,
        cost=CostProfile(input_per_1k_usd=2.50, output_per_1k_usd=10.00),
        context_window=200_000,
        max_output_tokens=8_192,
        capabilities=CAPABILITIES,
    )


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider(name=FAKE_PROVIDER, accuracy=1.0, seed=0)


@pytest.fixture
def gateway(provider: FakeProvider, spec: ModelSpec, large_spec: ModelSpec) -> ModelGateway:
    return ModelGateway(
        {FAKE_PROVIDER: provider},
        {SMALL_ALIAS: spec, LARGE_ALIAS: large_spec},
    )


@pytest.fixture
def cases() -> tuple[EvalCase, ...]:
    """Four cases whose expectations are single words.

    Short expectations keep ``exact-match`` the discriminating metric: the fake
    provider's wrong answers are the ideal value with a suffix, so a
    ``contains``-style metric scores them correct. Tests that must detect a
    regression therefore gate on ``exact-match``.
    """
    return (
        EvalCase(id="capital-fr", input="Capital of France?", expected="paris"),
        EvalCase(id="capital-jp", input="Capital of Japan?", expected="tokyo"),
        EvalCase(id="capital-pe", input="Capital of Peru?", expected="lima"),
        EvalCase(id="capital-ke", input="Capital of Kenya?", expected="nairobi"),
    )


@pytest.fixture
def dataset(cases: tuple[EvalCase, ...]) -> Dataset:
    return Dataset(name="capitals", version="1.0.0", cases=cases)
