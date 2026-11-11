"""Publishing the four series an ``observability.alerts`` entry can watch.

An alarm is only as real as the series under it. This module is the producer side of the
four metric names the deploy plan's alarm policies name -- ``agent.cost``,
``agent.tokens``, ``eval.cost`` and ``eval.latency.p95`` -- recorded where the values are
already computed rather than recomputed from a second reading of the run: the agent loop
knows what a run cost when it assembles the result, and the eval harness knows how long a
case took when it scores it.

Recording is a no-op until :func:`aid_runtime.telemetry.configure_metrics` installs a meter
provider, for the same reason spans are dropped until a tracer provider is installed: a
library must not decide its host's export destination, and a service that never asked for a
collector should pay nothing for one. The instruments are created through the OpenTelemetry
*API*, so an instrument made before the provider exists still forwards once it does.

Names and units are not invented here. ``agent.cost`` and ``eval.cost`` are dollars,
``agent.tokens`` is a token count and ``eval.latency.p95`` is milliseconds -- the same
pairing ``alertUnit`` derives in ``@aid-framework/ir``, which is why a threshold in a
document is never ambiguous about what its number means.
"""

from __future__ import annotations

from typing import Any, Final

from opentelemetry import metrics

__all__ = [
    "AGENT_LABEL",
    "EVAL_LABEL",
    "METRIC_NAMES",
    "record_agent_run",
    "record_eval_case",
]

#: Every series a document can name in ``observability.alerts[].metric``. Kept in the
#: generator's order so this module and the schema read the same four names.
METRIC_NAMES: Final[tuple[str, ...]] = (
    "agent.cost",
    "agent.tokens",
    "eval.cost",
    "eval.latency.p95",
)

#: The label that separates one agent's series from another's. It is the span attribute
#: ``aid.agent.id`` under the same name, so a trace and a metric name the same run the same
#: way -- and a value an operator can match against an alarm's ``source`` either way.
#:
#: The generated alarm narrows by the cloud's own spelling of that idea: ``alerts.ts``
#: writes ``dimensions = { Source = "<source>" }`` for CloudWatch and
#: ``metric.label.source`` for Cloud Monitoring, whose label keys are lowercased. Nothing
#: in this package renames attributes on the way out -- an OTLP collector maps
#: ``aid.agent.id`` to those keys once, in the exporter config, because the mapping is the
#: operator's account detail and the runtime's job is only to publish a labelled series.
AGENT_LABEL: Final = "aid.agent.id"

#: The eval counterpart of :data:`AGENT_LABEL`. The value is the *declared* eval id -- the
#: ``observability.alerts[].source`` an operator writes for an eval suite, and the id the
#: deploy plan derives an alarm for -- not a per-case identifier. A per-case label would
#: spread one suite's cost across as many series as it has cases, and an alarm scoped to
#: the suite would then watch a series nothing writes.
EVAL_LABEL: Final = "aid.eval.id"

#: The meter's scope name. Distinct from the tracer's only by convention; both are the
#: runtime's own wiring rather than the application's.
_METER_NAME: Final = "aid_runtime"

_instruments: dict[str, Any] | None = None


def _recorders() -> dict[str, Any]:
    """Create the four instruments once.

    Built lazily rather than at import so a process that imports this package for
    something else does not register instruments it will never record. Safe to create
    before a provider exists: the API returns forwarding instruments that bind to the
    provider when one is installed.
    """
    global _instruments
    if _instruments is None:
        meter = metrics.get_meter(_METER_NAME)
        _instruments = {
            "agent.cost": meter.create_counter(
                name="agent.cost",
                unit="usd",
                description="Model spend of one agent run, in US dollars.",
            ),
            "agent.tokens": meter.create_counter(
                name="agent.tokens",
                unit="tokens",
                description="Total tokens one agent run consumed, input and output.",
            ),
            "eval.cost": meter.create_counter(
                name="eval.cost",
                unit="usd",
                description="Model spend of one eval case, in US dollars.",
            ),
            "eval.latency.p95": meter.create_histogram(
                name="eval.latency.p95",
                unit="ms",
                description="Wall-clock duration of one eval case, in milliseconds.",
            ),
        }
    return _instruments


def record_agent_run(*, agent_id: str, cost_usd: float, tokens: int) -> None:
    """Publish one completed agent run's spend and token count.

    Both series carry ``aid.agent.id``, so an alarm scoped to an agent watches that
    agent's runs and an alarm with no ``source`` watches the whole environment. A run that
    fails still spent money, so the caller records every run it assembles rather than only
    the successful ones -- a budget alarm that ignored failures would under-report exactly
    the runs most likely to overspend.
    """
    recorders = _recorders()
    labels = {AGENT_LABEL: agent_id}
    recorders["agent.cost"].add(cost_usd, labels)
    recorders["agent.tokens"].add(tokens, labels)


def record_eval_case(*, eval_id: str, cost_usd: float, latency_ms: float) -> None:
    """Publish one eval case's spend and duration.

    ``eval_id`` is the declared eval's id, so every case in one suite lands on the same
    series and an alarm scoped to that suite sees the suite's total. ``eval.latency.p95`` is
    a histogram rather than a gauge: a percentile is computed from a distribution, and a
    backend that cannot reduce a histogram cannot answer a p95.
    """
    recorders = _recorders()
    labels = {EVAL_LABEL: eval_id}
    recorders["eval.cost"].add(cost_usd, labels)
    recorders["eval.latency.p95"].record(latency_ms, labels)
