"""The series an ``observability.alerts`` entry watches, and the points that write them.

An alarm over a series nothing publishes does not fail -- it reports no data, which is the
one failure mode that looks like health. So the cases here are about the join rather than
about arithmetic: what a recording point emits, under which label, and whether the names
the deploy plan names are the names the runtime writes.

The reader is in-memory because the alternative is asserting on a mock, and a mock would
pass even if an instrument's unit or aggregation were wrong.

A meter provider is process-global and cannot be replaced once installed, so the module
installs exactly one and every case reads through a shared reader. Readers accumulate
across cases, which is why each case records under an id no other case reuses: a counter's
value per attribute set is that set's total, so a fresh id's point is exactly what the case
recorded.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry import metrics as otel_metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from aid_runtime.metrics import (
    AGENT_LABEL,
    EVAL_LABEL,
    METRIC_NAMES,
    record_agent_run,
    record_eval_case,
)


@pytest.fixture(scope="module")
def reader() -> InMemoryMetricReader:
    """The one in-memory reader every case in this module reads through."""
    held = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[held])
    otel_metrics.set_meter_provider(provider)
    assert otel_metrics.get_meter_provider() is provider, (
        "a meter provider was already installed, so these cases would read another process's "
        "reader; meter installation is set-once, so no other module may install one"
    )
    return held


def _points(reader: InMemoryMetricReader, name: str) -> dict[Any, Any]:
    """Every point recorded under ``name``, keyed by the id it was labelled with."""
    data = reader.get_metrics_data()
    found: dict[Any, Any] = {}
    if data is None:
        return found
    for resource_metrics in data.resource_metrics:
        for scope in resource_metrics.scope_metrics:
            for metric in scope.metrics:
                if metric.name != name:
                    continue
                for point in metric.data.data_points:
                    raw = point.attributes
                    attributes: dict[str, Any] = dict(raw) if raw is not None else {}
                    found[attributes.get(AGENT_LABEL) or attributes.get(EVAL_LABEL)] = point
    return found


def test_an_agent_run_publishes_its_spend_and_tokens(reader: InMemoryMetricReader) -> None:
    record_agent_run(agent_id="agent-run", cost_usd=0.25, tokens=120)

    assert _points(reader, "agent.cost")["agent-run"].value == 0.25
    assert _points(reader, "agent.tokens")["agent-run"].value == 120


def test_an_eval_case_publishes_its_spend_and_duration(reader: InMemoryMetricReader) -> None:
    record_eval_case(eval_id="eval-case", cost_usd=0.5, latency_ms=1200.0)

    assert _points(reader, "eval.cost")["eval-case"].value == 0.5
    histogram = _points(reader, "eval.latency.p95")["eval-case"]
    assert (histogram.sum, histogram.count) == (1200.0, 1)


def test_one_agents_points_do_not_land_on_anothers_series(reader: InMemoryMetricReader) -> None:
    """The label is what an alarm's `source` narrows by, so it has to separate series."""
    record_agent_run(agent_id="triage", cost_usd=1.0, tokens=10)
    record_agent_run(agent_id="resolver", cost_usd=2.0, tokens=20)

    cost = _points(reader, "agent.cost")
    assert cost["triage"].value == 1.0
    assert cost["resolver"].value == 2.0


def test_every_plannable_name_has_a_point_after_a_full_run(
    reader: InMemoryMetricReader,
) -> None:
    """The join the gate enforces, asserted from the producer's side.

    ``ir/alerts-unproduced`` refuses a document whose alarms name a series this build
    cannot write. That refusal is only honest while a run of the app actually writes all
    four, so this case records through both recording points and requires every name to
    come out.
    """
    record_agent_run(agent_id="full-run", cost_usd=0.01, tokens=7)
    record_eval_case(eval_id="full-run", cost_usd=0.02, latency_ms=8.0)

    assert METRIC_NAMES == ("agent.cost", "agent.tokens", "eval.cost", "eval.latency.p95")
    assert all("full-run" in _points(reader, name) for name in METRIC_NAMES)


def test_the_units_are_the_ones_a_threshold_is_read_in(reader: InMemoryMetricReader) -> None:
    """A threshold in a document is a bare number, so the unit is where its meaning lives."""
    record_agent_run(agent_id="units", cost_usd=0.01, tokens=7)
    record_eval_case(eval_id="units", cost_usd=0.02, latency_ms=8.0)

    data = reader.get_metrics_data()
    assert data is not None
    units = {
        metric.name: metric.unit
        for resource_metrics in data.resource_metrics
        for scope in resource_metrics.scope_metrics
        for metric in scope.metrics
    }
    assert units == {
        "agent.cost": "usd",
        "agent.tokens": "tokens",
        "eval.cost": "usd",
        "eval.latency.p95": "ms",
    }
