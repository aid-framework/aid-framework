"""Trajectory scoring: what a run *did*, not only what it said.

Three things can go wrong here, and each has its own test: the order semantics of
`ordered`, an expectation that silently passes over a runner that reports no tool calls, and
a harness that drops the trajectory between the runner and the metric.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from aid_runtime import (
    Dataset,
    EvalCase,
    EvalError,
    ExactMatch,
    Metric,
    RunContext,
    RunOutput,
    RunStatus,
    StepKind,
    StepRecord,
    ToolTrace,
    Trajectory,
    evaluate_once,
)
from aid_runtime.agents.state import RunResult
from aid_runtime.errors import ConfigurationError

CASE = EvalCase(id="refund", input="Refund order 4471", expected="refunded")


def _step(index: int, *tools: str) -> StepRecord:
    return StepRecord(
        index=index,
        agent_id="support",
        kind=StepKind.TOOLS,
        alias="primary",
        model="gpt-4o-mini",
        cost_usd=0.0,
        total_tokens=0,
        tool_names=tools,
    )


def _run(*steps: StepRecord) -> RunResult:
    return RunResult(status=RunStatus.COMPLETED, agent_id="support", answer="refunded", steps=steps)


def _context(*calls: str) -> RunContext:
    return RunContext(trajectory=Trajectory(calls=calls))


async def _score(metric: Metric, calls: Sequence[str] | None) -> bool:
    context = None if calls is None else _context(*calls)
    return (await metric.score(CASE, "refunded", context=context)).passed


def _dataset() -> Dataset:
    return Dataset(name="refunds", version="1.0.0", cases=(CASE,))


def test_a_trajectory_flattens_every_step_in_order() -> None:
    # Multi-tool steps are the reason this is a flatten rather than a per-step read: one
    # model turn can call two tools, and both belong in the sequence.
    trajectory = Trajectory.from_run(
        _run(_step(1, "lookup_order"), _step(2, "check_policy", "issue_refund"))
    )

    assert trajectory.calls == ("lookup_order", "check_policy", "issue_refund")


def test_a_trajectory_of_a_run_that_called_nothing_is_empty_not_absent() -> None:
    # An agent that answered without a tool has a trajectory; a *runner* that never reported
    # one does not. `tool-trace` refuses the second and scores the first.
    trajectory = Trajectory.from_run(_run(_step(1)))

    assert trajectory.calls == ()
    assert not trajectory


async def test_an_ordered_expectation_requires_a_subsequence() -> None:
    metric = ToolTrace(expect=("lookup_order", "issue_refund"), ordered=True)

    assert await _score(metric, ("lookup_order", "issue_refund")) is True
    # Reversed is not a subsequence, which is the whole point of `ordered`.
    assert await _score(metric, ("issue_refund", "lookup_order")) is False


async def test_an_ordered_expectation_tolerates_calls_between_the_expected_ones() -> None:
    # Extra work is more than the minimum, so failing it would benchmark one transcript
    # rather than a capability.
    metric = ToolTrace(expect=("lookup_order", "issue_refund"), ordered=True)

    assert await _score(metric, ("lookup_order", "check_policy", "issue_refund")) is True


async def test_an_unordered_expectation_is_set_inclusion() -> None:
    metric = ToolTrace(expect=("lookup_order", "issue_refund"))

    assert await _score(metric, ("issue_refund", "lookup_order")) is True
    assert await _score(metric, ("lookup_order",)) is False


async def test_a_tool_called_twice_still_satisfies_a_single_expectation() -> None:
    # "How often" is a budget question the cost metric answers; this one asks whether the
    # tool was called at all.
    metric = ToolTrace(expect=("lookup_order", "issue_refund"), ordered=True)

    assert await _score(metric, ("lookup_order", "lookup_order", "issue_refund")) is True


async def test_a_failing_trace_reports_what_it_expected_and_what_it_saw() -> None:
    result = await ToolTrace(expect=("lookup_order", "issue_refund"), ordered=True).score(
        CASE, "refunded", context=_context("issue_refund")
    )

    assert result.detail == "expected lookup_order, issue_refund in order, called issue_refund"
    assert result.score == 0.0


async def test_a_passing_trace_reports_the_calls_it_saw() -> None:
    result = await ToolTrace(expect=("issue_refund",)).score(
        CASE, "refunded", context=_context("issue_refund")
    )

    assert result.detail == "called issue_refund"


async def test_a_trace_refuses_a_runner_that_reported_no_tool_calls() -> None:
    # The failure this metric exists to prevent: passing on every case by having nothing to
    # compare, which is eval coverage that does not exist.
    with pytest.raises(EvalError, match="reported no tool calls"):
        await ToolTrace(expect=("issue_refund",)).score(
            CASE, "refunded", context=RunContext(cost_usd=0.0, metered=True)
        )


async def test_a_trace_refuses_a_prediction_scored_outside_a_run() -> None:
    with pytest.raises(EvalError, match="reported no tool calls"):
        await ToolTrace(expect=("issue_refund",)).score(CASE, "refunded")


def test_a_trace_must_expect_at_least_one_tool() -> None:
    # An empty expectation is satisfied by every run, including one that called nothing, so
    # it would be a metric that measures nothing while reporting a pass rate.
    with pytest.raises(ConfigurationError, match="must expect at least one tool"):
        ToolTrace(expect=())


async def test_the_harness_carries_a_run_output_trajectory_to_the_metric() -> None:
    async def agent_runner(case: EvalCase) -> RunOutput:
        return RunOutput(
            text="refunded",
            trajectory=Trajectory.from_run(_run(_step(1, "lookup_order", "issue_refund"))),
        )

    metrics: Sequence[Metric] = (ToolTrace(expect=("lookup_order", "issue_refund"), ordered=True),)

    run = await evaluate_once(_dataset(), agent_runner, metrics)

    outcome = run.outcomes[0]
    assert outcome.scores[0].passed is True
    assert outcome.prediction == "refunded"
    assert outcome.trajectory is not None
    assert outcome.trajectory.calls == ("lookup_order", "issue_refund")


async def test_a_string_returning_runner_refuses_a_trace_rather_than_passing_it() -> None:
    # Absent, not empty: the harness must not invent an empty trajectory for a runner that
    # never reported one, or `tool-trace` would score it instead of refusing it.
    async def plain(case: EvalCase) -> str:
        return "refunded"

    metrics: Sequence[Metric] = (ToolTrace(expect=("issue_refund",)),)

    with pytest.raises(EvalError, match="reported no tool calls"):
        await evaluate_once(_dataset(), plain, metrics)


async def test_a_run_with_no_trajectory_metrics_records_no_trajectory() -> None:
    async def plain(case: EvalCase) -> str:
        return "refunded"

    metrics: Sequence[Metric] = (ExactMatch(),)

    run = await evaluate_once(_dataset(), plain, metrics)

    assert run.outcomes[0].scores[0].passed is True
    assert run.outcomes[0].trajectory is None
