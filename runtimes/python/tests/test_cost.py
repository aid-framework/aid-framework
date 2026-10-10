"""Cost accounting: the budget this runtime enforces, and when it refuses."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from aid_runtime import (
    Budget,
    BudgetExceededError,
    CostLedger,
    LedgerEntry,
    SpendSummary,
    TokenUsage,
    estimate_cost_usd,
    estimate_prompt_cost_usd,
)
from aid_runtime.types import CostProfile, ModelSpec

SPEC = ModelSpec(
    name="fake-small-1",
    provider="fake",
    cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
    context_window=128_000,
    max_output_tokens=4_096,
)


def _entry(cost: float, *, tokens: int = 10, model: str = "fake-small-1") -> LedgerEntry:
    return LedgerEntry(
        alias="small",
        model=model,
        provider="fake",
        usage=TokenUsage(input_tokens=tokens, output_tokens=0),
        cost_usd=cost,
    )


def test_budget_requires_at_least_one_ceiling() -> None:
    with pytest.raises(ValidationError):
        Budget()
    assert Budget(max_usd=1.0).max_total_tokens is None
    assert Budget(max_total_tokens=100).max_usd is None


def test_budget_rejects_nonsense_ceilings() -> None:
    with pytest.raises(ValidationError):
        Budget(max_usd=-1.0)
    with pytest.raises(ValidationError):
        Budget(max_total_tokens=0)


def test_budget_is_frozen_and_closed() -> None:
    budget = Budget(max_usd=1.0, scope="nightly")
    assert budget.scope == "nightly"
    with pytest.raises(ValidationError):
        budget.max_usd = 2.0
    with pytest.raises(ValidationError):
        # The stray keyword is the point: extra="forbid" must reject it.
        Budget(max_usd=1.0, scope="run", extra="no")  # type: ignore[call-arg]


def test_estimate_cost_matches_the_pinned_price() -> None:
    usage = TokenUsage(input_tokens=1_000, output_tokens=500)
    assert estimate_cost_usd(SPEC, usage) == 0.45


def test_estimate_prompt_cost_deliberately_over_estimates() -> None:
    """Refusing a call that would have fit is recoverable; overshooting is not."""
    prompt = "x" * 401
    naive = SPEC.cost.cost_usd(TokenUsage(input_tokens=100, output_tokens=0))
    assert estimate_prompt_cost_usd(SPEC, prompt) > naive
    assert estimate_prompt_cost_usd(SPEC, prompt) == SPEC.cost.cost_usd(
        TokenUsage(input_tokens=101, output_tokens=0)
    )


def test_estimate_prompt_cost_of_nothing_is_zero() -> None:
    assert estimate_prompt_cost_usd(SPEC, "") == 0.0


def test_empty_ledger_reports_nothing_spent() -> None:
    ledger = CostLedger()
    assert ledger.entries == ()
    assert ledger.cost_usd == 0.0
    assert ledger.total_tokens == 0
    summary = ledger.summary()
    assert summary.calls == 0
    assert summary.cost_usd == 0.0
    assert summary.by_model == {}
    assert summary.total_tokens == 0


def test_charge_without_a_budget_never_raises() -> None:
    ledger = CostLedger()
    ledger.charge(None, _entry(1_000.0))
    assert ledger.cost_usd == 1_000.0


def test_charge_records_before_it_raises() -> None:
    """A caller that catches the error must still see truthful accounting."""
    ledger = CostLedger()
    budget = Budget(max_usd=0.10, scope="run")

    with pytest.raises(BudgetExceededError) as caught:
        ledger.charge(budget, _entry(0.50))

    assert caught.value.scope == "run"
    assert caught.value.limit == 0.10
    assert caught.value.spent == 0.50
    assert caught.value.unit == "usd"
    assert len(ledger.entries) == 1
    assert ledger.cost_usd == 0.50


def test_charge_at_the_ceiling_is_allowed() -> None:
    ledger = CostLedger()
    ledger.charge(Budget(max_usd=0.50), _entry(0.50))
    assert ledger.cost_usd == 0.50


def test_token_budget_reports_its_unit() -> None:
    ledger = CostLedger()
    budget = Budget(max_total_tokens=10, scope="run")

    with pytest.raises(BudgetExceededError) as caught:
        ledger.charge(budget, _entry(0.0, tokens=40))

    assert caught.value.unit == "tokens"
    assert "40 tokens" in str(caught.value)
    assert "$" not in str(caught.value)


def test_check_refuses_a_run_that_already_overspent() -> None:
    ledger = CostLedger()
    ledger.charge(None, _entry(2.0))
    with pytest.raises(BudgetExceededError) as caught:
        ledger.check(Budget(max_usd=1.0))
    assert caught.value.spent == 2.0


def test_both_ceilings_are_enforced_independently() -> None:
    """A token ceiling must bind even when the cost ceiling would not."""
    ledger = CostLedger()
    ledger.charge(None, _entry(0.0, tokens=2))
    alongside = Budget(max_total_tokens=1, max_usd=10.0)
    with pytest.raises(BudgetExceededError) as caught:
        ledger.check(alongside)
    assert caught.value.unit == "tokens"


def test_summary_aggregates_by_model() -> None:
    ledger = CostLedger()
    ledger.charge(None, _entry(0.10, tokens=5, model="fake-small-1"))
    ledger.charge(None, _entry(0.20, tokens=7, model="fake-small-1"))
    ledger.charge(None, _entry(0.05, tokens=1, model="fake-large-1"))

    summary = ledger.summary()
    assert isinstance(summary, SpendSummary)
    assert summary.calls == 3
    assert summary.input_tokens == 13
    assert summary.total_tokens == 13
    assert summary.cost_usd == 0.35
    assert summary.by_model == {"fake-small-1": 0.30, "fake-large-1": 0.05}


def test_ledger_cost_is_rounded() -> None:
    ledger = CostLedger()
    ledger.charge(None, _entry(0.1234567))
    assert ledger.cost_usd == 0.123457


def test_budget_exceeded_message_is_readable() -> None:
    error = BudgetExceededError("run", 1.0, 2.5)
    assert "$1.000000" in str(error)
    assert "over by $1.500000" in str(error)
