"""A false assertion fails the gate, and no regression allowance can excuse it.

The gate is a statistical comparison: it tolerates a mean drop smaller than
``max_regression``, and larger drops when the run's own spread explains them. An
``assert`` metric scores 0 or 1, which is exactly the degenerate distribution that
machinery is weakest against -- a small sample of a 0/1 metric has a standard error
large enough to hide a real drop. That is why an assert threshold carries an
absolute floor and why the floor is checked *before* the delta: a tolerance may
excuse a regression, but it may never excuse a false assertion.
"""

from __future__ import annotations

import pytest

from aid_runtime import (
    BaselineGate,
    EvalBaseline,
    EvalCase,
    EvalRun,
    MetricBaseline,
    MetricRun,
    Threshold,
)
from aid_runtime.evals import AssertMetric, Dataset, run_evaluation

DATASET = "answers"
VERSION = "1"


def _run(*values: float) -> EvalRun:
    return EvalRun(
        dataset=DATASET,
        dataset_version=VERSION,
        runs=len(values),
        metrics=(MetricRun(metric="assert", values=values),),
    )


def _baseline(*values: float) -> EvalBaseline:
    return EvalBaseline(
        dataset=DATASET,
        dataset_version=VERSION,
        model="fake-small-1",
        metrics=(MetricBaseline.from_values("assert", values),),
    )


def _gate(**kwargs) -> BaselineGate:
    return BaselineGate([Threshold(metric="assert", **kwargs)], metrics=())


class TestTheFloorBeatsTheAllowance:
    def test_a_false_assertion_fails_even_when_the_delta_is_within_max_regression(self):
        # One case of four fails: the mean drops by 0.25, which a 0.5 allowance would
        # wave through. The floor is what makes the assertion mean anything.
        result = _gate(max_regression=0.5, min_mean=1.0).evaluate(
            _run(1.0, 1.0, 1.0, 0.0), _baseline(1.0, 1.0, 1.0, 1.0)
        )
        assert result.passed is False
        assert result.results[0].metric == "assert"

    def test_the_failure_says_floor_and_not_regression(self):
        result = _gate(max_regression=0.5, min_mean=1.0).evaluate(
            _run(1.0, 1.0, 1.0, 0.0), _baseline(1.0, 1.0, 1.0, 1.0)
        )
        rationale = result.results[0].rationale
        assert "absolute floor" in rationale
        assert "max_regression" not in rationale

    def test_a_false_assertion_fails_even_when_noise_would_explain_the_drop(self):
        # A 0/1 metric on a small sample has a standard error wide enough that the
        # z-test alone cannot call this a regression. The floor does not care.
        result = _gate(max_regression=1.0, min_mean=1.0, alpha=0.05).evaluate(
            _run(1.0, 0.0, 1.0), _baseline(1.0, 1.0, 1.0)
        )
        assert result.passed is False
        assert "absolute floor" in result.results[0].rationale

    def test_every_case_passing_passes(self):
        result = _gate(max_regression=0.05, min_mean=1.0).evaluate(
            _run(1.0, 1.0, 1.0, 1.0), _baseline(1.0, 1.0, 1.0, 1.0)
        )
        assert result.passed is True
        assert result.results[0].current_mean == 1.0

    def test_the_floor_is_the_whole_verdict_when_no_baseline_improves_on_it(self):
        # A baseline that was itself below the floor is refused too: the floor is
        # absolute, not relative to what was accepted last time.
        result = _gate(max_regression=0.05, min_mean=1.0).evaluate(
            _run(1.0, 1.0, 0.0), _baseline(0.0, 1.0, 1.0)
        )
        assert result.passed is False

    def test_without_a_floor_the_same_run_passes(self):
        # The distinguishing row: identical distributions, floor removed. If this
        # passed too the floor would be inert, and the first test would be passing
        # for some other reason.
        result = _gate(max_regression=0.5).evaluate(
            _run(1.0, 1.0, 1.0, 0.0), _baseline(1.0, 1.0, 1.0, 1.0)
        )
        assert result.passed is True

    def test_the_floor_is_validated_to_the_unit_interval(self):
        with pytest.raises(Exception):
            Threshold(metric="assert", min_mean=1.5)


PREDICATE = {
    "kind": "call",
    "name": "contains",
    "args": [
        {"kind": "path", "path": "prediction"},
        {"kind": "string", "value": "refund"},
    ],
}
MESSAGE = "must mention the refund"


def _dataset() -> Dataset:
    return Dataset(
        name="answers",
        version="1",
        cases=(
            EvalCase(id="a", input="one", expected="a refund is on the way"),
            EvalCase(id="b", input="two", expected="we cannot help"),
        ),
    )


async def _score(replies: dict[str, str]):
    """One evaluation run over the real metric, with scripted predictions."""

    async def runner(case: EvalCase) -> str:
        return replies[case.id]

    return await run_evaluation(
        _dataset(),
        runner,
        [AssertMetric(expr=PREDICATE, message=MESSAGE)],
        runs=1,
    )


def _exit_code(result) -> int:
    """What the generated module's ``main()`` returns for this verdict.

    The generated entrypoint is ``return 1 if result.failures() else 0``; spelling it
    here is what turns a gate verdict into the non-zero exit the phase exit criterion
    is actually about.
    """

    return 1 if result.failures() else 0


class TestAFalseAssertionReachesTheExitCode:
    """From the real metric to the process exit, not just to a verdict field.

    ``MetricResult.passed is False`` is necessary and not sufficient: the phase exit
    criterion is a non-zero exit from the generated eval module. These rows run the real
    ``AssertMetric`` over a real dataset through ``run_evaluation`` and then through the
    gate, and read the same ``failures()`` the generated ``main()`` reads.
    """

    async def test_a_false_assertion_on_passing_baseline_exits_non_zero(self):
        measured = await _score({"a": "a refund is on the way", "b": "we cannot help"})
        baseline = EvalBaseline(
            dataset="answers",
            dataset_version="1",
            model="fake-small-1",
            metrics=(MetricBaseline.from_values("assert", (1.0, 1.0)),),
        )
        gate = BaselineGate(
            [Threshold(metric="assert", max_regression=0.05, min_mean=1.0)], metrics=()
        )

        result = gate.evaluate(measured, baseline)

        assert result.passed is False
        assert _exit_code(result) == 1

    async def test_every_case_passing_exits_zero(self):
        measured = await _score(
            {"a": "a refund is on the way", "b": "we cannot help, no refund possible"}
        )
        baseline = EvalBaseline(
            dataset="answers",
            dataset_version="1",
            model="fake-small-1",
            metrics=(MetricBaseline.from_values("assert", (1.0, 1.0)),),
        )
        gate = BaselineGate(
            [Threshold(metric="assert", max_regression=0.05, min_mean=1.0)], metrics=()
        )

        result = gate.evaluate(measured, baseline)

        # The distinguishing row: the same wiring with a predicate that holds. Without
        # it the non-zero exit above could be produced by something other than the
        # assertion.
        assert result.passed is True
        assert _exit_code(result) == 0

    async def test_the_failure_detail_is_the_declared_message(self):
        measured = await _score({"a": "a refund is on the way", "b": "we cannot help"})

        # The run records the metric's mean; the per-case detail is what a reader sees,
        # and it is the spec's own words rather than a paraphrase.
        case = _dataset().case("b")
        missed = await AssertMetric(expr=PREDICATE, message=MESSAGE).score(case, "we cannot help")

        assert measured.metrics[0].values == (0.5,)
        assert missed.score == 0.0
        assert missed.detail == MESSAGE
