"""The two budget metrics: wall-clock and spend, measured around the runner call.

Both read a number the harness already has rather than deriving one from the prediction,
so what these tests pin is the two ways they can go wrong: scoring a boundary in the wrong
direction, and quietly passing over a run nobody measured.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence

import pytest

from aid_runtime import (
    CostCeiling,
    Dataset,
    EvalCase,
    EvalError,
    LatencyCeiling,
    Metric,
    RunContext,
    evaluate_once,
)
from aid_runtime.errors import ConfigurationError

CASE = EvalCase(id="only", input="Capital of France?", expected="paris")


class _Metered:
    """A runner that charges a fixed spend per case and optionally takes its time."""

    def __init__(self, *, per_case_usd: float = 0.0, delay_s: float = 0.0) -> None:
        self.cost_usd = 0.0
        self._per_case = per_case_usd
        self._delay = delay_s

    async def __call__(self, case: EvalCase) -> str:
        self.cost_usd += self._per_case
        if self._delay > 0:
            await asyncio.sleep(self._delay)
        return "paris"


async def _score(metric: Metric, case: EvalCase, context: RunContext | None) -> object:
    return await metric.score(case, "paris", context=context)


def _dataset() -> Dataset:
    return Dataset(name="capitals", version="1.0.0", cases=(CASE,))


def test_both_ceilings_are_deterministic_so_a_gate_may_threshold_on_them() -> None:
    assert CostCeiling(max_usd=0.01).deterministic is True
    assert LatencyCeiling(max_ms=100).deterministic is True


@pytest.mark.parametrize(("spent", "passed"), [(0.04, True), (0.05, True), (0.06, False)])
async def test_the_cost_ceiling_includes_its_own_boundary(spent: float, passed: bool) -> None:
    metric = CostCeiling(max_usd=0.05)
    result = await metric.score(CASE, "paris", context=RunContext(cost_usd=spent, metered=True))

    assert result.passed is passed
    assert result.score == (1.0 if passed else 0.0)


async def test_the_cost_ceiling_reports_the_amount_it_compared() -> None:
    result = await CostCeiling(max_usd=0.05).score(
        CASE, "paris", context=RunContext(cost_usd=0.0123, metered=True)
    )

    assert result.detail == "spent $0.0123, ceiling $0.0500"


async def test_the_cost_ceiling_refuses_a_run_that_does_not_meter_its_spend() -> None:
    # The distinction that matters: an unmetered runner reports a real 0.0, so a ceiling
    # that trusted the number would pass forever over a run it never measured.
    with pytest.raises(EvalError, match="does not meter"):
        await CostCeiling(max_usd=0.05).score(
            CASE, "paris", context=RunContext(cost_usd=0.0, metered=False)
        )


async def test_the_cost_ceiling_refuses_a_prediction_scored_outside_a_run() -> None:
    with pytest.raises(EvalError, match="does not meter"):
        await CostCeiling(max_usd=0.05).score(CASE, "paris")


@pytest.mark.parametrize(("taken", "passed"), [(900.0, True), (1000.0, True), (1001.0, False)])
async def test_the_latency_ceiling_includes_its_own_boundary(taken: float, passed: bool) -> None:
    metric = LatencyCeiling(max_ms=1000)
    result = await metric.score(CASE, "paris", context=RunContext(latency_ms=taken, metered=True))

    assert result.passed is passed


async def test_the_latency_ceiling_refuses_a_prediction_scored_outside_a_run() -> None:
    with pytest.raises(EvalError, match="outside a measured run"):
        await LatencyCeiling(max_ms=1000).score(CASE, "paris")


@pytest.mark.parametrize(
    "build",
    [lambda: CostCeiling(max_usd=0.0), lambda: LatencyCeiling(max_ms=0.0)],
    ids=["cost", "latency"],
)
def test_a_ceiling_must_be_above_zero(build: Callable[[], object]) -> None:
    # A zero ceiling is not a budget: every run that costs anything fails it, and every
    # run that costs nothing passes it, so the number states no intent.
    with pytest.raises(ConfigurationError, match="above zero"):
        build()


async def test_the_harness_measures_the_spend_the_ceiling_judges() -> None:
    runner = _Metered(per_case_usd=0.10)
    metrics: Sequence[Metric] = (CostCeiling(max_usd=0.05),)

    run = await evaluate_once(_dataset(), runner, metrics)

    assert run.outcomes[0].scores[0].passed is False
    assert run.outcomes[0].scores[0].detail == "spent $0.1000, ceiling $0.0500"


async def test_the_harness_measures_the_time_the_ceiling_judges() -> None:
    runner = _Metered(delay_s=0.02)
    metrics: Sequence[Metric] = (LatencyCeiling(max_ms=5),)

    run = await evaluate_once(_dataset(), runner, metrics)

    assert run.outcomes[0].scores[0].passed is False


async def test_an_unmetered_runner_cannot_be_held_to_a_cost_ceiling() -> None:
    async def plain(case: EvalCase) -> str:
        return "paris"

    with pytest.raises(EvalError, match="does not meter"):
        await evaluate_once(_dataset(), plain, [CostCeiling(max_usd=1.0)])
