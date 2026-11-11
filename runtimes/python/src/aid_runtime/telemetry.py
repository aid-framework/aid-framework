"""Installing the exporters a document declared.

``observability.export`` states where telemetry should go, and ``observability.endpointEnv``
names -- never holds -- the variable carrying the collector address. Those two facts were
declarable from spec 0.27 and unenforced until this module: :mod:`aid_runtime.tracing`
writes every span through the OpenTelemetry *API*, so with no provider installed the spans
were recorded and dropped.

Two exporters are installed from that one switch, because a document that asked for a
collector asked for the telemetry stream, not for one of its halves:

- :func:`configure_export` installs the span exporter behind ``observability.trace``.
- :func:`configure_metrics` installs the metric exporter that publishes the four series
  ``observability.alerts`` watches (:mod:`aid_runtime.metrics`), which is what makes a
  declared alarm watch a series something actually writes.

One variable feeds both, so the value is read as a collector address and completed with the
signal's own path -- a document never has to name two variables to get two signals.

This is the one place the runtime installs a provider, and it is deliberately a function
the application calls rather than an import side effect. A library that configured global
telemetry on import would decide its host's export destination, and the entrypoint that
runs it belongs to the application, not to this package.

Nothing here raises. A missing endpoint or a missing exporter is reported as a status the
caller can log, because telemetry that cannot start must not stop a service from serving --
the honest alternative to a silent drop is a status that names what was missing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final, Literal

__all__ = [
    "DEFAULT_ENDPOINT_ENV",
    "EXPORT_KINDS",
    "OTLP_EXTRA",
    "ExportReason",
    "ExportStatus",
    "configure_export",
    "configure_metrics",
]

#: The variable an OTLP/HTTP collector address conventionally lives in, and the value a
#: document's ``endpointEnv`` names on every walkthrough.
DEFAULT_ENDPOINT_ENV: Final = "OTEL_EXPORTER_OTLP_ENDPOINT"

#: The transport this module installs. OTLP over HTTP with protobuf bodies: it needs no
#: gRPC runtime, and every collector that speaks OTLP speaks this half of it.
EXPORT_KINDS: Final[tuple[str, ...]] = ("otlp",)

#: The extra that carries the exporter, quoted back when the import fails. The SDK itself
#: is not enough -- the OTLP exporter is a separate distribution, which is exactly the
#: mistake this message exists to stop.
OTLP_EXTRA: Final = "aid-runtime-python[otlp]"

#: The two signals this module can send. Named once so the status details and the
#: endpoint paths cannot drift from the exporter each one installs.
Signal = Literal["traces", "metrics"]

#: The OTLP/HTTP path each signal is posted to, in the order a collector address is
#: stripped of one before another is appended.
SIGNAL_PATHS: Final[tuple[str, ...]] = ("/v1/traces", "/v1/metrics")

ExportReason = Literal[
    "configured",
    "already-configured",
    "not-declared",
    "endpoint-env-unset",
    "exporter-not-installed",
]


@dataclass(frozen=True, slots=True)
class ExportStatus:
    """What :func:`configure_export` or :func:`configure_metrics` did, in terms a caller
    can log or assert on.

    ``configured`` is the answer to "will this signal leave this process", and it is never
    inferred from the document alone: an endpoint variable that is unset means the same
    dropped telemetry as no declaration, so it reports ``False`` with a reason rather than
    echoing the declaration back as if it had been honoured.
    """

    configured: bool
    reason: ExportReason
    endpoint_env: str
    detail: str

    def as_dict(self) -> dict[str, object]:
        """A JSON-safe view, for a health endpoint or a startup log line."""
        return {
            "configured": self.configured,
            "reason": self.reason,
            "endpointEnv": self.endpoint_env,
            "detail": self.detail,
        }


def _status(
    *,
    configured: bool,
    reason: ExportReason,
    endpoint_env: str,
    detail: str,
) -> ExportStatus:
    return ExportStatus(
        configured=configured,
        reason=reason,
        endpoint_env=endpoint_env,
        detail=detail,
    )


def _preamble(
    *,
    declared: Literal["otlp", "none"],
    endpoint_env: str,
    inactive: str,
) -> tuple[ExportStatus | None, str]:
    """The two gates both signals share, and the endpoint when they pass.

    ``inactive`` finishes the sentence "…so nothing is exported and <inactive>", which is
    the only part that differs between spans and series: the gates themselves are the same
    two facts -- what the document asked for, and whether the environment supplied it.
    """
    if declared != "otlp":
        return (
            _status(
                configured=False,
                reason="not-declared",
                endpoint_env=endpoint_env,
                detail=(
                    f"observability.export is not otlp, so no exporter is installed and {inactive}"
                ),
            ),
            "",
        )

    endpoint = os.environ.get(endpoint_env, "").strip()
    if not endpoint:
        return (
            _status(
                configured=False,
                reason="endpoint-env-unset",
                endpoint_env=endpoint_env,
                detail=(
                    f"{endpoint_env} is unset or empty, so the OTLP exporter has no "
                    f"collector to send to and {inactive}"
                ),
            ),
            "",
        )
    return None, endpoint


def _signal_endpoint(endpoint: str, signal: Signal) -> str:
    """The URL a request carrying ``signal`` is posted to.

    One document declares one ``endpointEnv``, and that variable now feeds two signals. The
    OTLP spec answers this with a base address per signal, so the value is read as a
    collector address: this signal's own path is used when the value already ends with it,
    the other signal's path is replaced, and a bare address gets the path appended.

    Without this, the values in use today would all break -- a variable holding
    ``http://collector:4318/v1/traces`` would post metric protobuf to the trace endpoint, a
    collector would reject it, and the alarms watching those series would report no data
    while every startup status claimed the exporter was running.
    """
    trimmed = endpoint.rstrip("/")
    for path in SIGNAL_PATHS:
        if trimmed.endswith(path):
            trimmed = trimmed[: -len(path)]
            break
    return f"{trimmed}/v1/{signal}"


def configure_export(
    *,
    service_name: str,
    declared: Literal["otlp", "none"] = "otlp",
    endpoint_env: str = DEFAULT_ENDPOINT_ENV,
) -> ExportStatus:
    """Install an OTLP span exporter when the document declared one and the endpoint is set.

    Call it once, at startup, before serving:

    .. code-block:: python

        from aid_runtime.telemetry import configure_export

        status = configure_export(service_name="support-copilot")
        if not status.configured:
            logger.warning("tracing export inactive: %s", status.detail)

    ``declared`` is the document's ``observability.export`` as generated, so a document
    that never asked for export reports ``not-declared`` instead of guessing from the
    environment. ``endpoint_env`` is the *name* of the variable to read at call time,
    which is what lets one image run in several environments. Its value may be the
    collector's base address or this signal's own URL; see :func:`_signal_endpoint`.

    Re-calling after a successful install returns ``already-configured`` and installs
    nothing: the OpenTelemetry API forbids replacing a global provider, and quietly trying
    would produce the warning every second call currently produces.
    """
    refused, endpoint = _preamble(
        declared=declared, endpoint_env=endpoint_env, inactive="spans stay in-process"
    )
    if refused is not None:
        return refused

    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        return _status(
            configured=False,
            reason="exporter-not-installed",
            endpoint_env=endpoint_env,
            detail=(
                "the OpenTelemetry SDK and OTLP exporter are not installed; install "
                f"{OTLP_EXTRA} to honour observability.export"
            ),
        )

    from opentelemetry import trace

    existing = trace.get_tracer_provider()
    if isinstance(existing, TracerProvider):
        return _status(
            configured=True,
            reason="already-configured",
            endpoint_env=endpoint_env,
            detail="a tracer provider is already installed; this call installed nothing",
        )

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    target = _signal_endpoint(endpoint, "traces")
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=target)))
    trace.set_tracer_provider(provider)
    return _status(
        configured=True,
        reason="configured",
        endpoint_env=endpoint_env,
        detail=f"spans export to {target} over OTLP/HTTP as service {service_name}",
    )


def configure_metrics(
    *,
    service_name: str,
    declared: Literal["otlp", "none"] = "otlp",
    endpoint_env: str = DEFAULT_ENDPOINT_ENV,
    interval_ms: int = 60000,
) -> ExportStatus:
    """Install the OTLP metric exporter that carries the series alarms watch.

    This is the other half of the same switch. A document may declare four alarms over
    ``agent.cost``, ``agent.tokens``, ``eval.cost`` and ``eval.latency.p95``; the recording
    points live in :mod:`aid_runtime.metrics` and write nothing anywhere until a meter
    provider exists. An alarm over a series nobody publishes does not fail -- it reports no
    data, forever, which is the failure mode that looks like health.

    The gates are :func:`configure_export`'s gates, because they are the same questions: did
    the document ask for a collector, and did the environment name one. ``interval_ms`` is
    the export period; the default matches the periodic reader's own, so a caller passes it
    only to shorten the window in a test.

    Call it beside :func:`configure_export`, at startup:

    .. code-block:: python

        from aid_runtime.telemetry import configure_export, configure_metrics

        configure_export(service_name="support-copilot")
        configure_metrics(service_name="support-copilot")
    """
    refused, endpoint = _preamble(
        declared=declared,
        endpoint_env=endpoint_env,
        inactive="the alert series are never published",
    )
    if refused is not None:
        return refused

    try:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
    except ImportError:
        return _status(
            configured=False,
            reason="exporter-not-installed",
            endpoint_env=endpoint_env,
            detail=(
                "the OpenTelemetry SDK and OTLP exporter are not installed; install "
                f"{OTLP_EXTRA} to publish the series observability.alerts watches"
            ),
        )

    from opentelemetry import metrics

    existing = metrics.get_meter_provider()
    if isinstance(existing, MeterProvider):
        return _status(
            configured=True,
            reason="already-configured",
            endpoint_env=endpoint_env,
            detail="a meter provider is already installed; this call installed nothing",
        )

    target = _signal_endpoint(endpoint, "metrics")
    reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=target), export_interval_millis=interval_ms
    )
    provider = MeterProvider(
        resource=Resource.create({"service.name": service_name}),
        metric_readers=[reader],
    )
    metrics.set_meter_provider(provider)
    return _status(
        configured=True,
        reason="configured",
        endpoint_env=endpoint_env,
        detail=(
            f"metrics export to {target} over OTLP/HTTP as service {service_name} "
            f"every {interval_ms}ms"
        ),
    )
