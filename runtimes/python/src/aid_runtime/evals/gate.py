"""N-run sampling and the statistical baseline gate.

The ratified Phase 0 decision (design §17 #2) is that gating uses **N-run sampling
with statistical thresholds compared against a stored baseline**, in the
``maxRegression`` style -- *not* strict equality. Non-determinism is expected and
must not be treated as a bug.

Concretely, for each metric we:

1. Run the dataset ``n_runs`` times, giving one mean score per run. Those means
   are the *sample*, and their spread is the honest measure of how much this
   system varies when nothing changed.
2. Compare the sample against a stored baseline (its own mean, spread and size).
3. Fail only when the drop exceeds ``max_regression`` **and** that drop is larger
   than the standard error of the difference could explain, at the configured
   significance level.

Step 3 is what makes the gate trustworthy in both directions. A gate that fires on
any decrease is a flaky gate; a gate that only compares means can be fooled by a
noisy run. Requiring both a material *and* a statistically distinguishable drop
means the gate reports a regression when the evidence says there is one, and
stays quiet otherwise.

The z critical values are a table rather than a library call because adding a
statistics dependency (scipy) to enforce one one-sided test is not a trade worth
making in a runtime that must stay small.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import EvalError, GateConfigurationError
from aid_runtime.evals.metrics import Metric

__all__ = [
    "BaselineGate",
    "EvalBaseline",
    "EvalRun",
    "GateResult",
    "MetricBaseline",
    "MetricGateResult",
    "MetricRun",
    "Threshold",
    "gate_from_config",
    "z_critical",
]

#: One-sided z critical values, keyed by significance level.
_Z_CRITICAL: dict[float, float] = {
    0.20: 0.8416,
    0.10: 1.2816,
    0.05: 1.6449,
    0.025: 1.9600,
    0.01: 2.3263,
    0.005: 2.5758,
}


def z_critical(alpha: float) -> float:
    """The one-sided z critical value at ``alpha``, rounded to a stricter level.

    ``alpha`` is rounded to the next *stricter* tabulated level -- a smaller alpha,
    hence a larger z, hence a gate that demands slightly more evidence than asked
    for. That is the safe direction for a regression gate: a gate that fires on
    borderline evidence is a gate that gets switched off. An ``alpha`` below the
    strictest tabulated level gets the strictest value, for the same reason.
    """
    if not 0.0 < alpha < 1.0:
        raise ValueError("alpha must be between 0 and 1")
    levels = sorted(_Z_CRITICAL)
    at_or_below = [level for level in levels if level <= alpha]
    return _Z_CRITICAL[max(at_or_below) if at_or_below else levels[0]]


class MetricRun(BaseModel):
    """Per-run, per-metric means: one value per run of the dataset."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: str
    values: tuple[float, ...] = Field(min_length=1)


class EvalRun(BaseModel):
    """The sampled result of running a dataset N times."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset: str
    dataset_version: str
    runs: int = Field(gt=0)
    metrics: tuple[MetricRun, ...] = Field(min_length=1)

    def means(self) -> dict[str, float]:
        return {entry.metric: statistics.fmean(entry.values) for entry in self.metrics}

    def spread(self) -> dict[str, float]:
        return {entry.metric: _stdev(entry.values) for entry in self.metrics}

    def values_for(self, metric: str) -> tuple[float, ...]:
        for entry in self.metrics:
            if entry.metric == metric:
                return entry.values
        raise EvalError(f"metric {metric!r} is not in this run")

    def is_varying(self) -> bool:
        """Whether any metric produced different scores across runs.

        Exposed because "the run varied" is a *fact about the system*, not a
        failure: a test asserts on it to prove the gate tolerates noise rather
        than assuming a deterministic system.
        """
        return any(len(set(entry.values)) > 1 for entry in self.metrics)

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)


class MetricBaseline(BaseModel):
    """A stored metric distribution, recorded from a run that was accepted."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: str
    runs: int = Field(gt=0)
    mean: float = Field(ge=0.0, le=1.0)
    stdev: float = Field(ge=0.0)

    @classmethod
    def from_values(cls, metric: str, values: Sequence[float]) -> MetricBaseline:
        return cls(
            metric=metric,
            runs=len(values),
            mean=statistics.fmean(values),
            stdev=_stdev(values),
        )


class EvalBaseline(BaseModel):
    """A committed baseline: the accepted distribution for a dataset and model."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset: str
    dataset_version: str
    model: str
    metrics: tuple[MetricBaseline, ...] = Field(min_length=1)
    note: str = ""

    @classmethod
    def from_run(cls, run: EvalRun, *, model: str, note: str = "") -> EvalBaseline:
        return cls(
            dataset=run.dataset,
            dataset_version=run.dataset_version,
            model=model,
            metrics=tuple(
                MetricBaseline.from_values(entry.metric, entry.values) for entry in run.metrics
            ),
            note=note,
        )

    def metric(self, name: str) -> MetricBaseline:
        for entry in self.metrics:
            if entry.metric == name:
                return entry
        raise EvalError(f"baseline has no metric {name!r}")

    @classmethod
    def from_json(cls, payload: str) -> EvalBaseline:
        return cls.model_validate_json(payload)

    @classmethod
    def from_path(cls, path: str | Path) -> EvalBaseline:
        return cls.from_json(Path(path).read_text(encoding="utf-8"))

    def to_json(self) -> str:
        return self.model_dump_json(indent=2) + "\n"


class Threshold(BaseModel):
    """The acceptance rule for one metric."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: str = Field(min_length=1)
    #: Absolute floor on the mean. Independent of the baseline: it says what
    #: "good enough" means, which no comparison to a past run can express.
    min_mean: float | None = Field(default=None, ge=0.0, le=1.0)
    #: Largest mean drop, versus the baseline, still considered acceptable.
    max_regression: float = Field(default=0.02, ge=0.0, le=1.0)
    #: Significance level for the one-sided regression test.
    alpha: float = Field(default=0.05, gt=0.0, lt=1.0)


class MetricGateResult(BaseModel):
    """Why one metric passed or failed. The rationale is the product."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: str
    passed: bool
    current_mean: float
    current_stdev: float
    baseline_mean: float
    baseline_stdev: float
    delta: float
    z: float
    alpha: float
    max_regression: float
    rationale: str


class GateResult(BaseModel):
    """The gate's verdict over every metric."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    passed: bool
    dataset: str
    dataset_version: str
    runs: int
    results: tuple[MetricGateResult, ...] = Field(min_length=1)
    varying: bool = False

    def failures(self) -> tuple[MetricGateResult, ...]:
        return tuple(result for result in self.results if not result.passed)

    def summary(self) -> str:
        lines = [
            f"eval gate {'PASSED' if self.passed else 'FAILED'} "
            f"({self.dataset}@{self.dataset_version}, {self.runs} runs, "
            f"run-to-run variation: {'yes' if self.varying else 'no'})"
        ]
        for result in self.results:
            mark = "ok  " if result.passed else "FAIL"
            lines.append(f"  [{mark}] {result.rationale}")
        return "\n".join(lines)


class BaselineGate:
    """Compares a sampled run against a stored baseline."""

    def __init__(
        self,
        thresholds: Sequence[Threshold],
        *,
        metrics: Sequence[Metric] = (),
        allow_nondeterministic: bool = False,
    ) -> None:
        if not thresholds:
            raise GateConfigurationError("the gate needs at least one threshold")
        names = [threshold.metric for threshold in thresholds]
        duplicates = sorted({name for name in names if names.count(name) > 1})
        if duplicates:
            raise GateConfigurationError(f"duplicate thresholds for: {', '.join(duplicates)}")
        self._thresholds = tuple(thresholds)
        by_name = {metric.name: metric for metric in metrics}
        self._metrics = by_name
        self._allow_nondeterministic = allow_nondeterministic
        self._check_metric_eligibility()

    @property
    def thresholds(self) -> tuple[Threshold, ...]:
        return self._thresholds

    def evaluate(self, run: EvalRun, baseline: EvalBaseline) -> GateResult:
        """Decide whether ``run`` regressed against ``baseline``."""
        if (run.dataset, run.dataset_version) != (baseline.dataset, baseline.dataset_version):
            raise EvalError(
                f"baseline was recorded on {baseline.dataset}@{baseline.dataset_version} but the "
                f"run is {run.dataset}@{run.dataset_version}; compare like with like"
            )

        results = tuple(
            self._evaluate_metric(threshold, run, baseline) for threshold in self._thresholds
        )
        return GateResult(
            passed=all(result.passed for result in results),
            dataset=run.dataset,
            dataset_version=run.dataset_version,
            runs=run.runs,
            results=results,
            varying=run.is_varying(),
        )

    def _evaluate_metric(
        self, threshold: Threshold, run: EvalRun, baseline: EvalBaseline
    ) -> MetricGateResult:
        values = run.values_for(threshold.metric)
        stored = baseline.metric(threshold.metric)
        current_mean = statistics.fmean(values)
        current_stdev = _stdev(values)
        delta = stored.mean - current_mean
        z = _regression_z(
            current_mean=current_mean,
            current_stdev=current_stdev,
            current_n=len(values),
            baseline_mean=stored.mean,
            baseline_stdev=stored.stdev,
            baseline_n=stored.runs,
        )

        passed, rationale = self._verdict(threshold, current_mean, stored, delta, z)
        return MetricGateResult(
            metric=threshold.metric,
            passed=passed,
            current_mean=current_mean,
            current_stdev=current_stdev,
            baseline_mean=stored.mean,
            baseline_stdev=stored.stdev,
            delta=delta,
            z=z,
            alpha=threshold.alpha,
            max_regression=threshold.max_regression,
            rationale=rationale,
        )

    def _verdict(
        self,
        threshold: Threshold,
        current_mean: float,
        stored: MetricBaseline,
        delta: float,
        z: float,
    ) -> tuple[bool, str]:
        """The pass/fail call and the sentence explaining it.

        Three ways to pass, and the distinction between them is the whole point:
        no floor breached, no material drop, or a drop that is material but within
        what the two runs' own variation can explain. Only a drop that is both
        material *and* beyond the noise threshold counts as a regression.
        """
        where = f"{threshold.metric}: mean {current_mean:.4f} vs baseline {stored.mean:.4f}"

        if threshold.min_mean is not None and current_mean < threshold.min_mean:
            return False, (
                f"{threshold.metric}: mean {current_mean:.4f} is below the absolute floor "
                f"{threshold.min_mean:.4f} (baseline {stored.mean:.4f})"
            )

        if delta <= threshold.max_regression:
            return True, (
                f"{where} -- delta {delta:+.4f} is within "
                f"max_regression {threshold.max_regression:.4f}"
            )

        if z <= z_critical(threshold.alpha):
            return True, (
                f"{where} -- delta {delta:+.4f} exceeds max_regression but z={z:.3f} is not "
                f"beyond {z_critical(threshold.alpha):.3f} at alpha={threshold.alpha}; "
                f"consistent with run-to-run noise"
            )

        return False, (
            f"{where} -- delta {delta:+.4f} exceeds max_regression "
            f"{threshold.max_regression:.4f} and z={z:.3f} > {z_critical(threshold.alpha):.3f} "
            f"at alpha={threshold.alpha}"
        )

    def _check_metric_eligibility(self) -> None:
        """Refuse thresholds that a non-deterministic metric would undermine.

        The rule is enforced here, at construction, rather than documented and
        hoped for: a gate configured on a model-backed metric is not a gate, and
        refusing at configuration time is the only moment that is cheap to fix.
        """
        if self._allow_nondeterministic:
            return
        offending = sorted(
            threshold.metric
            for threshold in self._thresholds
            if (metric := self._metrics.get(threshold.metric)) is not None
            and not metric.deterministic
        )
        if offending:
            raise GateConfigurationError(
                f"thresholds reference non-deterministic metric(s): {', '.join(offending)}. "
                "A model-backed metric varies run to run, so it cannot distinguish a regression "
                "from its own noise; keep it as a reported metric and gate on a deterministic one. "
                "Pass allow_nondeterministic=True only for local exploration, never in CI."
            )


def _stdev(values: Sequence[float]) -> float:
    return statistics.stdev(values) if len(values) > 1 else 0.0


def _regression_z(
    *,
    current_mean: float,
    current_stdev: float,
    current_n: int,
    baseline_mean: float,
    baseline_stdev: float,
    baseline_n: int,
) -> float:
    """One-sided z for "the current mean is lower than the baseline mean".

    Uses the standard error of the difference of two means, so *both* spreads
    contribute: a noisy baseline is a weak claim to regress against, and the gate
    should demand more evidence before rejecting it.
    """
    standard_error = math.sqrt(
        (current_stdev**2 / max(current_n, 1)) + (baseline_stdev**2 / max(baseline_n, 1))
    )
    if standard_error <= 0.0:
        # Both distributions are degenerate: any drop is real, so report an
        # arbitrarily large statistic rather than dividing by zero.
        return math.inf if current_mean < baseline_mean else 0.0
    return (baseline_mean - current_mean) / standard_error


def gate_from_config(
    config: Mapping[str, object], *, metrics: Sequence[Metric] = ()
) -> BaselineGate:
    """Build a gate from parsed JSON/YAML, so CI config stays declarative."""
    raw = config.get("thresholds")
    if not isinstance(raw, list):
        raise GateConfigurationError("config needs a 'thresholds' list")
    return BaselineGate(
        [Threshold.model_validate(entry) for entry in raw],
        metrics=metrics,
        allow_nondeterministic=bool(config.get("allow_nondeterministic", False)),
    )
