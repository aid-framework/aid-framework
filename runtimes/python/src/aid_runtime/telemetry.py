"""Installing the span exporter a document declared.

``observability.export`` states where spans should go, and ``observability.endpointEnv``
names -- never holds -- the variable carrying the collector address. Those two facts were
declarable from spec 0.27 and unenforced until this module: :mod:`aid_runtime.tracing`
writes every span through the OpenTelemetry *API*, so with no provider installed the spans
were recorded and dropped.

This is the one place the runtime installs a provider, and it is deliberately a function
the application calls rather than an import side effect. A library that configured global
telemetry on import would decide its host's export destination, and the entrypoint that
runs it belongs to the application, not to this package.

Nothing here raises. A missing endpoint or a missing exporter is reported as an
:class:`ExportStatus` the caller can log, because telemetry that cannot start must not stop
a service from serving -- the honest alternative to a silent drop is a status that names
what was missing.
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

ExportReason = Literal[
    "configured",
    "already-configured",
    "not-declared",
    "endpoint-env-unset",
    "exporter-not-installed",
]


@dataclass(frozen=True, slots=True)
class ExportStatus:
    """What :func:`configure_export` did, in terms a caller can log or assert on.

    ``configured`` is the answer to "will spans leave this process", and it is never
    inferred from the document alone: an endpoint variable that is unset means the same
    dropped spans as no declaration, so it reports ``False`` with a reason rather than
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
    which is what lets one image run in several environments.

    Re-calling after a successful install returns ``already-configured`` and installs
    nothing: the OpenTelemetry API forbids replacing a global provider, and quietly trying
    would produce the warning every second call currently produces.
    """
    if declared != "otlp":
        return _status(
            configured=False,
            reason="not-declared",
            endpoint_env=endpoint_env,
            detail=(
                "observability.export is not otlp, so no exporter is installed and spans "
                "stay in-process"
            ),
        )

    endpoint = os.environ.get(endpoint_env, "").strip()
    if not endpoint:
        return _status(
            configured=False,
            reason="endpoint-env-unset",
            endpoint_env=endpoint_env,
            detail=(
                f"{endpoint_env} is unset or empty, so the OTLP exporter has no collector "
                "to send to and spans stay in-process"
            ),
        )

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
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    return _status(
        configured=True,
        reason="configured",
        endpoint_env=endpoint_env,
        detail=f"spans export to {endpoint} over OTLP/HTTP as service {service_name}",
    )
