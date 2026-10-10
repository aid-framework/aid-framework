"""The eval gate, exercised through a provider that genuinely varies.

The shape of this file is the argument for the gate. A deliberately
non-deterministic provider is sampled N times; the run is *allowed* to vary and
still passes against a like-for-like baseline; a drop five times larger than
``max_regression`` is tolerated when the two runs' own spread explains it; and
only a drop exceeding both ``max_regression`` **and** the noise threshold fails.
Gating on strict equality would fail every run in this file, and gating on means
alone would let the real regression through.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from aid_runtime import (
    BaselineGate,
    CostProfile,
    Dataset,
    EvalBaseline,
    EvalError,
    EvalRun,
    ExactMatch,
    FakeProvider,
    GateConfigurationError,
    GatewayRunner,
    LlmJudge,
    MetricBaseline,
    MetricRun,
    ModelGateway,
    ModelSpec,
    Threshold,
    default_metrics,
    evaluate_once,
    gate_from_config,
    run_evaluation,
    z_critical,
)
from aid_runtime.types import Capability

FAKE_PROVIDER = "fake"
SMALL_ALIAS = "small"
CAPABILITIES = frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT})
BASELINE_FIXTURE = Path(__file__).parent / "fixtures" / "capitals-baseline.json"

#: The table in the implementation, restated independently. These are one-sided
#: z critical values, so `alpha` is a statement about the false-positive rate.
Z_TABLE = {
    0.20: 0.8416,
    0.10: 1.2816,
    0.05: 1.6449,
    0.025: 1.9600,
    0.01: 2.3263,
    0.005: 2.5758,
}


def _spec() -> ModelSpec:
    return ModelSpec(
        name="fake-small-1",
        provider=FAKE_PROVIDER,
        cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
        context_window=128_000,
        max_output_tokens=4_096,
        capabilities=CAPABILITIES,
    )


def _runner(dataset: Dataset, *, accuracy: float, seed: int) -> GatewayRunner:
    provider = FakeProvider(
        name=FAKE_PROVIDER,
        answers={case.input: case.expected or "" for case in dataset.cases},
        accuracy=accuracy,
        seed=seed,
    )
    gateway = ModelGateway({FAKE_PROVIDER: provider}, {SMALL_ALIAS: _spec()})
    return GatewayRunner(gateway, SMALL_ALIAS)


async def _sample(dataset: Dataset, *, accuracy: float, seed: int, runs: int) -> EvalRun:
    runner = _runner(dataset, accuracy=accuracy, seed=seed)
    return await run_evaluation(dataset, runner, default_metrics(), runs=runs)


def _run_like(dataset: Dataset, values: tuple[float, ...]) -> EvalRun:
    """A run carrying exactly ``values``, for tests about the decision logic."""
    return EvalRun(
        dataset=dataset.name,
        dataset_version=dataset.version,
        runs=len(values),
        metrics=(MetricRun(metric="exact-match", values=values),),
    )


def _baseline_like(dataset: Dataset, values: tuple[float, ...]) -> EvalBaseline:
    return EvalBaseline(
        dataset=dataset.name,
        dataset_version=dataset.version,
        model="fake-small-1",
        metrics=(MetricBaseline.from_values("exact-match", values),),
    )


async def _judge_call(prompt: str) -> str:
    return '{"score": 1.0, "reason": "ok"}'


# --- the critical value table -------------------------------------------------


def test_z_critical_matches_the_table() -> None:
    for alpha, expected in Z_TABLE.items():
        assert z_critical(alpha) == pytest.approx(expected)


def test_z_critical_rounds_to_a_stricter_level() -> None:
    """An untabulated alpha takes the next *stricter* level, never a looser one."""
    assert z_critical(0.07) == pytest.approx(Z_TABLE[0.05])
    assert z_critical(0.03) == pytest.approx(Z_TABLE[0.025])
    assert z_critical(0.9) == pytest.approx(Z_TABLE[0.20])


def test_z_critical_below_the_strictest_level_stays_strictest() -> None:
    assert z_critical(0.004) == pytest.approx(Z_TABLE[0.005])
    assert z_critical(0.0001) == pytest.approx(Z_TABLE[0.005])


def test_z_critical_rises_as_alpha_shrinks() -> None:
    ordered = [z_critical(alpha) for alpha in (0.9, 0.20, 0.10, 0.05, 0.025, 0.01, 0.004)]
    assert ordered == sorted(ordered)
    assert ordered[0] < ordered[-1]


def test_z_critical_rejects_values_outside_the_unit_interval() -> None:
    for alpha in (0.0, 1.0, -0.1, 2.0):
        with pytest.raises(ValueError, match="between 0 and 1"):
            z_critical(alpha)


# --- baselines ---------------------------------------------------------------


def test_a_metric_baseline_summarizes_its_values() -> None:
    baseline = MetricBaseline.from_values("exact-match", (0.5, 1.0, 1.0, 0.5))
    assert baseline.metric == "exact-match"
    assert baseline.runs == 4
    assert baseline.mean == pytest.approx(0.75)
    assert baseline.stdev == pytest.approx(0.2887, abs=1e-4)


def test_a_metric_baseline_needs_at_least_one_run() -> None:
    with pytest.raises(ValidationError):
        MetricBaseline(metric="exact-match", runs=0, mean=1.0, stdev=0.0)


def test_a_run_needs_at_least_one_metric_and_one_run() -> None:
    with pytest.raises(ValidationError):
        EvalRun(dataset="capitals", dataset_version="1.0.0", runs=0, metrics=())
    with pytest.raises(ValidationError):
        EvalRun(dataset="capitals", dataset_version="1.0.0", runs=1, metrics=())


def test_an_eval_baseline_round_trips_through_json(dataset: Dataset) -> None:
    baseline = _baseline_like(dataset, (0.5, 1.0))
    payload = baseline.to_json()
    assert payload.endswith("\n")
    assert EvalBaseline.from_json(payload) == baseline


def test_the_committed_baseline_fixture_loads(dataset: Dataset) -> None:
    baseline = EvalBaseline.from_path(BASELINE_FIXTURE)
    assert baseline.dataset == dataset.name
    assert baseline.dataset_version == dataset.version
    assert baseline.model == "fake-small-1"
    assert baseline.note != ""
    assert baseline.metric("exact-match").runs == 10
    assert baseline.metric("exact-match").mean == pytest.approx(0.525)
    assert baseline.metric("contains").mean == pytest.approx(1.0)


async def test_the_committed_baseline_matches_a_like_for_like_run(dataset: Dataset) -> None:
    baseline = EvalBaseline.from_path(BASELINE_FIXTURE)
    run = await _sample(dataset, accuracy=0.6, seed=0, runs=10)
    result = BaselineGate([Threshold(metric="exact-match")]).evaluate(run, baseline)
    assert result.runs == 10
    assert result.passed is True
    assert result.results[0].delta == pytest.approx(0.0)


def test_asking_for_an_absent_metric_raises(dataset: Dataset) -> None:
    run = _run_like(dataset, (1.0, 1.0))
    baseline = _baseline_like(dataset, (1.0, 1.0))
    with pytest.raises(EvalError, match="not in this run"):
        run.values_for("contains")
    with pytest.raises(EvalError, match="no metric"):
        baseline.metric("contains")


# --- gate configuration ------------------------------------------------------


def test_the_gate_needs_at_least_one_threshold() -> None:
    with pytest.raises(GateConfigurationError, match="at least one threshold"):
        BaselineGate([])


def test_the_gate_rejects_duplicate_thresholds() -> None:
    with pytest.raises(GateConfigurationError, match="duplicate thresholds for: exact-match"):
        BaselineGate([Threshold(metric="exact-match"), Threshold(metric="exact-match")])


def test_the_gate_refuses_to_gate_on_a_model_backed_metric() -> None:
    judge = LlmJudge(_judge_call, rubric="Is the answer correct?")
    with pytest.raises(GateConfigurationError, match="non-deterministic"):
        BaselineGate([Threshold(metric="llm-judge")], metrics=(judge,))


def test_the_judge_can_only_be_loosened_deliberately() -> None:
    judge = LlmJudge(_judge_call, rubric="Is the answer correct?")
    gate = BaselineGate(
        [Threshold(metric="llm-judge")], metrics=(judge,), allow_nondeterministic=True
    )
    assert gate.thresholds[0].metric == "llm-judge"
    assert judge.deterministic is False


def test_gate_from_config_reads_declarative_thresholds() -> None:
    gate = gate_from_config(
        {
            "thresholds": [
                {"metric": "exact-match", "min_mean": 0.8, "max_regression": 0.05, "alpha": 0.01}
            ]
        }
    )
    assert gate.thresholds == (
        Threshold(metric="exact-match", min_mean=0.8, max_regression=0.05, alpha=0.01),
    )


def test_gate_from_config_insists_on_a_thresholds_list() -> None:
    with pytest.raises(GateConfigurationError, match="thresholds"):
        gate_from_config({})
    with pytest.raises(GateConfigurationError, match="thresholds"):
        gate_from_config({"thresholds": "exact-match"})


def test_the_gate_refuses_to_compare_different_dataset_versions(dataset: Dataset) -> None:
    run = _run_like(dataset, (1.0, 1.0))
    stale = EvalBaseline(
        dataset=dataset.name,
        dataset_version="0.9.0",
        model="fake-small-1",
        metrics=(MetricBaseline.from_values("exact-match", (1.0, 1.0)),),
    )
    with pytest.raises(EvalError, match="compare like with like"):
        BaselineGate([Threshold(metric="exact-match")]).evaluate(run, stale)


# --- the decision logic ------------------------------------------------------


def test_a_material_drop_within_the_noise_threshold_is_not_a_regression(dataset: Dataset) -> None:
    """Both samples spread by 0.1, so a 0.1 drop is explained by the sampling."""
    run = _run_like(dataset, (0.4, 0.6, 0.4, 0.6, 0.5))
    baseline = _baseline_like(dataset, (0.5, 0.7, 0.5, 0.7, 0.6))
    outcome = (
        BaselineGate([Threshold(metric="exact-match", max_regression=0.0, alpha=0.05)])
        .evaluate(run, baseline)
        .results[0]
    )

    assert outcome.delta == pytest.approx(0.1)
    assert outcome.z == pytest.approx(1.5811, abs=1e-3)
    assert outcome.passed is True
    assert "consistent with run-to-run noise" in outcome.rationale


def test_alpha_decides_how_much_evidence_is_required(dataset: Dataset) -> None:
    """A laxer alpha means a smaller critical z, so the same drop fails sooner.

    With a z of ~1.58 the verdict flips between alpha=0.05 and alpha=0.10. This is
    the assertion that a critical-value lookup can silently invert.
    """
    run = _run_like(dataset, (0.4, 0.6, 0.4, 0.6, 0.5))
    baseline = _baseline_like(dataset, (0.5, 0.7, 0.5, 0.7, 0.6))

    def verdict(alpha: float) -> bool:
        threshold = Threshold(metric="exact-match", max_regression=0.0, alpha=alpha)
        return BaselineGate([threshold]).evaluate(run, baseline).passed

    assert verdict(0.05) is True
    assert verdict(0.10) is False
    assert verdict(0.20) is False
    assert verdict(0.025) is True


def test_a_single_run_has_no_spread(dataset: Dataset) -> None:
    run = _run_like(dataset, (0.5,))
    baseline = _baseline_like(dataset, (0.5, 0.5))
    outcome = BaselineGate([Threshold(metric="exact-match")]).evaluate(run, baseline).results[0]
    assert outcome.current_stdev == 0.0
    assert outcome.delta == pytest.approx(0.0)
    assert outcome.z == 0.0


def test_a_drop_between_two_degenerate_samples_is_infinite(dataset: Dataset) -> None:
    run = _run_like(dataset, (0.5,))
    baseline = _baseline_like(dataset, (1.0, 1.0, 1.0))
    outcome = (
        BaselineGate([Threshold(metric="exact-match", max_regression=0.0)])
        .evaluate(run, baseline)
        .results[0]
    )
    assert outcome.z == math.inf
    assert outcome.passed is False


# --- sampling a provider that really varies ----------------------------------


async def test_the_fake_provider_really_varies_across_runs(dataset: Dataset) -> None:
    run = await _sample(dataset, accuracy=0.6, seed=0, runs=5)
    assert run.is_varying() is True
    assert run.values_for("exact-match") == (0.75, 0.25, 0.5, 0.75, 0.5)
    assert run.means()["exact-match"] == pytest.approx(0.55)
    assert run.spread()["exact-match"] == pytest.approx(0.2092, abs=1e-4)


async def test_a_perfect_run_does_not_vary(dataset: Dataset) -> None:
    run = await _sample(dataset, accuracy=1.0, seed=0, runs=5)
    assert run.is_varying() is False
    assert run.means()["exact-match"] == pytest.approx(1.0)
    assert run.spread()["exact-match"] == 0.0


async def test_a_like_for_like_run_passes_despite_varying(dataset: Dataset) -> None:
    run = await _sample(dataset, accuracy=0.6, seed=0, runs=5)
    baseline = EvalBaseline.from_run(run, model="fake-small-1")
    result = BaselineGate([Threshold(metric="exact-match")]).evaluate(run, baseline)

    assert run.is_varying() is True
    assert result.varying is True
    assert result.passed is True
    assert result.results[0].delta == pytest.approx(0.0)
    assert "run-to-run variation: yes" in result.summary()


async def test_a_real_regression_fails_the_gate(dataset: Dataset) -> None:
    accepted = await _sample(dataset, accuracy=1.0, seed=0, runs=5)
    baseline = EvalBaseline.from_run(accepted, model="fake-small-1")
    regressed = await _sample(dataset, accuracy=0.6, seed=0, runs=5)

    result = BaselineGate([Threshold(metric="exact-match")]).evaluate(regressed, baseline)
    outcome = result.results[0]

    assert regressed.is_varying() is True
    assert result.passed is False
    assert len(result.failures()) == 1
    assert outcome.delta == pytest.approx(0.45)
    assert outcome.z == pytest.approx(4.8107, abs=2e-3)
    assert outcome.z > z_critical(0.05)
    assert "exceeds max_regression" in outcome.rationale
    assert "at alpha=0.05" in outcome.rationale
    assert "eval gate FAILED" in result.summary()


async def test_the_gate_tolerates_a_drop_its_own_spread_explains(dataset: Dataset) -> None:
    """A 0.10 drop -- five times max_regression -- is accepted as noise.

    Both samples come from the same system with different sampling seeds, so their
    combined spread fully explains the difference. This is the case a mean-only
    gate gets wrong, and the reason the gate compares distributions instead.
    """
    baseline = EvalBaseline.from_run(
        await _sample(dataset, accuracy=0.6, seed=0, runs=5), model="fake-small-1"
    )
    current = await _sample(dataset, accuracy=0.6, seed=2, runs=5)

    result = BaselineGate([Threshold(metric="exact-match")]).evaluate(current, baseline)
    outcome = result.results[0]

    assert current.is_varying() is True
    assert result.passed is True
    assert outcome.delta == pytest.approx(0.10)
    assert outcome.delta > outcome.max_regression
    assert outcome.z == pytest.approx(0.7559, abs=1e-3)
    assert outcome.z <= z_critical(0.05)
    assert "consistent with run-to-run noise" in outcome.rationale


async def test_an_absolute_floor_fails_even_when_the_drop_is_within_noise(
    dataset: Dataset,
) -> None:
    """The floor is checked first: "good enough" is not a statement about history."""
    baseline = EvalBaseline.from_run(
        await _sample(dataset, accuracy=0.6, seed=0, runs=5), model="fake-small-1"
    )
    current = await _sample(dataset, accuracy=0.6, seed=2, runs=5)

    outcome = (
        BaselineGate([Threshold(metric="exact-match", min_mean=0.9)])
        .evaluate(current, baseline)
        .results[0]
    )

    assert outcome.passed is False
    assert "absolute floor" in outcome.rationale


async def test_a_failing_pass_names_the_cases_that_moved(dataset: Dataset) -> None:
    pass_result = await evaluate_once(
        dataset, _runner(dataset, accuracy=0.6, seed=0), (ExactMatch(),)
    )
    summary = pass_result.summary()
    failures = pass_result.failures()

    assert summary.startswith("capitals@1.0.0: 3/4 cases passed")
    assert len(failures) == 1
    assert f"FAIL {failures[0].case_id}:" in summary
    assert pass_result.outcome(failures[0].case_id).passed is False
