"""The `classify_quality` eval gate, driven by the fake provider.

The gate compares a sampled run against a stored baseline *statistically* rather
than by equality, because model output is not deterministic and a gate that
demanded identical numbers would fail on every honest run. Two properties have
to hold at once, and they pull in opposite directions:

* a run whose numbers move is not a failure -- the sampled mean is compared
  against a tolerance; and
* a real drop is still a failure -- the tolerance must not swallow a regression.

`test_a_measured_drop_fails_the_gate` is the falsifying half of that pair. If the
gate ever degrades into a check that passes everything, or into an equality check
with no tolerance, one of the two halves breaks.
"""

from __future__ import annotations

from aid_runtime import EvalBaseline
from aid_runtime.evals import BaselineGate, Threshold

from app.generated.evals import classify_quality
from tests.fake_gateway import fake_deps

METRIC = "json-valid"


async def test_the_gate_passes_at_the_recorded_accuracy() -> None:
    """A run at the accuracy the baseline was recorded from passes, and samples SAMPLES times."""

    measured = await classify_quality.run(deps=fake_deps(accuracy=1.0))
    result = classify_quality.gate(measured, classify_quality.load_baseline())

    assert result.passed, result.summary()
    assert result.runs == classify_quality.SAMPLES
    assert result.results[0].current_mean == 1.0


async def test_a_measured_drop_fails_the_gate() -> None:
    """A model that gets worse fails the stored baseline, so the gate has teeth."""

    measured = await classify_quality.run(deps=fake_deps(accuracy=0.25))
    result = classify_quality.gate(measured, classify_quality.load_baseline())

    assert not result.passed, result.summary()
    failure = result.failures()[0]
    assert failure.metric == METRIC
    assert failure.current_mean < failure.baseline_mean
    assert "max_regression" in failure.rationale


async def test_the_same_drop_passes_under_a_looser_tolerance() -> None:
    """The verdict is decided by the tolerance, not by the numbers being equal.

    Same measurement as the failing case above; only `max_regression` changes.
    This is what makes the gate a statistical test rather than a strict-equality
    assertion, and it is why non-determinism is not a bug to be fixed.
    """

    measured = await classify_quality.run(deps=fake_deps(accuracy=0.25))
    tolerant = BaselineGate(
        (Threshold(metric=METRIC, max_regression=0.9),),
        metrics=classify_quality.metrics(),
    )
    result = tolerant.evaluate(measured, classify_quality.load_baseline())

    assert result.passed, result.summary()
    assert result.results[0].delta > 0.0, "a drop really happened; only the tolerance allowed it"


async def test_sampling_varies_and_variation_is_reported_not_failed() -> None:
    """Run-to-run variation is a fact about the system, and the gate records it."""

    measured = await classify_quality.run(deps=fake_deps(accuracy=0.5))
    result = classify_quality.gate(measured, classify_quality.load_baseline())

    assert measured.is_varying(), "an inaccurate provider must not score identically every time"
    assert 0.0 < measured.means()[METRIC] < 1.0
    assert result.varying is True


async def test_the_stored_baseline_is_a_recorded_run() -> None:
    """The committed baseline is a measurement, not a hand-written number."""

    measured = await classify_quality.run(deps=fake_deps(accuracy=1.0))
    recorded = EvalBaseline.from_run(measured, model=classify_quality.MODEL)
    stored = classify_quality.load_baseline()

    assert stored.model == classify_quality.MODEL
    assert (stored.dataset, stored.dataset_version) == (
        measured.dataset,
        measured.dataset_version,
    )
    for entry in stored.metrics:
        fresh = recorded.metric(entry.metric)
        assert entry.runs == fresh.runs == classify_quality.SAMPLES
        assert entry.mean == fresh.mean
        assert entry.stdev == fresh.stdev


def test_the_dataset_and_the_thresholds_come_from_the_spec() -> None:
    """The generated eval measures the declared dataset against the declared tolerance."""

    dataset = classify_quality.load_dataset()

    assert dataset.name == classify_quality.EVAL_ID
    assert len(dataset.cases) >= 1
    assert classify_quality.thresholds() == (
        Threshold(metric=METRIC, max_regression=classify_quality.MAX_REGRESSION),
    )
