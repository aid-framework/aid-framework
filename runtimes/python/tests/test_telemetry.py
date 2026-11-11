"""Installing the exporter a document declared.

``configure_export`` writes process-global OpenTelemetry state that cannot be undone once
set, so almost every case here captures the provider it *would* install rather than
installing one: a second call in the same interpreter would report ``already-configured``
and the assertion would stop meaning anything. The one case that needs a real install runs
in a fresh interpreter, because a status reading ``configured`` is only worth trusting if a
provider that can actually export came out the other side.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from typing import Any, cast

import pytest
from opentelemetry import metrics as _otel_metrics
from opentelemetry.metrics._internal import _ProxyMeterProvider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import ProxyTracerProvider

from aid_runtime import (
    DEFAULT_ENDPOINT_ENV,
    EXPORT_KINDS,
    OTLP_EXTRA,
    ExportStatus,
    configure_export,
    configure_metrics,
)
from aid_runtime.telemetry import ExportReason

ENDPOINT = "http://localhost:4318/v1/traces"
METRIC_ENDPOINT = "http://localhost:4318/v1/metrics"
EXPORTER_MODULE = "opentelemetry.exporter.otlp.proto.http.trace_exporter"
METRIC_EXPORTER_MODULE = "opentelemetry.exporter.otlp.proto.http.metric_exporter"

EXPORTER_INSTALLED = importlib.util.find_spec(EXPORTER_MODULE) is not None
METRIC_EXPORTER_INSTALLED = importlib.util.find_spec(METRIC_EXPORTER_MODULE) is not None


class Captured:
    """The provider ``configure_export`` handed to the API, if it handed one over."""

    provider: TracerProvider | None = None


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> Captured:
    """Intercept the global provider install so the process stays unchanged.

    The unset state is simulated with the proxy the API itself returns before any
    provider is set, so the "is one already installed" check is exercised for real.
    """
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)
    monkeypatch.setattr("opentelemetry.trace.get_tracer_provider", ProxyTracerProvider)
    held = Captured()
    monkeypatch.setattr(
        "opentelemetry.trace.set_tracer_provider",
        lambda provider: setattr(held, "provider", provider),
    )
    return held


def _only_processor(provider: TracerProvider) -> Any:
    processors = provider._active_span_processor._span_processors
    assert len(processors) == 1, "a provider with no processor exports nothing"
    return processors[0]


def test_the_default_endpoint_variable_is_the_otel_standard() -> None:
    assert DEFAULT_ENDPOINT_ENV == "OTEL_EXPORTER_OTLP_ENDPOINT"


def test_the_only_transport_installed_is_otlp() -> None:
    assert EXPORT_KINDS == ("otlp",)


def test_a_document_that_declared_no_export_installs_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)

    status = configure_export(service_name="copilot", declared="none")

    assert status.configured is False
    assert status.reason == "not-declared"
    assert "observability.export" in status.detail


def test_an_unset_endpoint_is_not_treated_as_a_configured_export(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(DEFAULT_ENDPOINT_ENV, raising=False)

    status = configure_export(service_name="copilot")

    assert status.configured is False
    assert status.reason == "endpoint-env-unset"
    assert DEFAULT_ENDPOINT_ENV in status.detail


def test_a_blank_endpoint_is_not_an_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, "   ")

    assert configure_export(service_name="copilot").reason == "endpoint-env-unset"


def test_the_variable_named_by_the_document_is_the_one_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("COLLECTOR_ADDR", raising=False)

    status = configure_export(service_name="copilot", endpoint_env="COLLECTOR_ADDR")

    assert status.reason == "endpoint-env-unset"
    assert status.endpoint_env == "COLLECTOR_ADDR"
    assert "COLLECTOR_ADDR" in status.detail


def test_a_missing_exporter_names_the_extra_that_supplies_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)
    # `None` in `sys.modules` makes the import raise `ImportError`, which is what an
    # install without the `otlp` extra does at this exact line.
    monkeypatch.setitem(sys.modules, EXPORTER_MODULE, None)

    status = configure_export(service_name="copilot")

    assert status.configured is False
    assert status.reason == "exporter-not-installed"
    assert OTLP_EXTRA in status.detail


def test_installing_the_exporter_reports_what_it_installed(captured: Captured) -> None:
    status = configure_export(service_name="support-copilot")

    assert status.configured is True
    assert status.reason == "configured"
    assert captured.provider is not None
    assert captured.provider.resource.attributes["service.name"] == "support-copilot"

    processor = _only_processor(captured.provider)
    assert isinstance(processor, BatchSpanProcessor)
    assert type(processor.span_exporter).__name__ == "OTLPSpanExporter"
    assert processor.span_exporter._endpoint == ENDPOINT


def test_an_existing_provider_is_never_replaced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)
    installed = TracerProvider()
    monkeypatch.setattr("opentelemetry.trace.get_tracer_provider", lambda: installed)

    def refuse(provider: object) -> None:
        raise AssertionError(f"configure_export replaced a live provider: {provider!r}")

    monkeypatch.setattr("opentelemetry.trace.set_tracer_provider", refuse)

    status = configure_export(service_name="copilot")

    assert status.configured is True
    assert status.reason == "already-configured"
    assert installed._active_span_processor._span_processors == ()


@pytest.mark.parametrize(
    "reason",
    [
        "configured",
        "already-configured",
        "not-declared",
        "endpoint-env-unset",
        "exporter-not-installed",
    ],
)
def test_every_reason_is_one_of_the_declared_literals(reason: ExportReason) -> None:
    status = ExportStatus(
        configured=reason in {"configured", "already-configured"},
        reason=reason,
        endpoint_env=DEFAULT_ENDPOINT_ENV,
        detail="detail",
    )

    assert json.loads(json.dumps(status.as_dict())) == {
        "configured": status.configured,
        "reason": reason,
        "endpointEnv": DEFAULT_ENDPOINT_ENV,
        "detail": "detail",
    }


def test_the_status_is_frozen() -> None:
    status = configure_export(service_name="copilot", declared="none")

    with pytest.raises(AttributeError):
        status.reason = "configured"  # type: ignore[misc]


@pytest.mark.skipif(not EXPORTER_INSTALLED, reason=f"{EXPORTER_MODULE} is not installed")
def test_a_real_interpreter_ends_up_with_an_exporting_provider() -> None:
    script = (
        "import json;"
        "from opentelemetry import trace;"
        "from opentelemetry.sdk.trace import TracerProvider;"
        "from aid_runtime import configure_export;"
        "status = configure_export(service_name='e2e');"
        "print(json.dumps({"
        "'status': status.as_dict(),"
        "'installed': isinstance(trace.get_tracer_provider(), TracerProvider)"
        "}))"
    )
    env = {**os.environ, DEFAULT_ENDPOINT_ENV: ENDPOINT}

    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env=env,
        check=False,
        timeout=120,
    )

    assert completed.returncode == 0, completed.stderr
    reported = json.loads(completed.stdout)
    assert reported["status"]["configured"] is True
    assert reported["status"]["reason"] == "configured"
    assert reported["installed"] is True


class CapturedMetrics:
    """The meter provider ``configure_metrics`` handed to the API, if any."""

    provider: MeterProvider | None = None


@pytest.fixture
def captured_metrics(monkeypatch: pytest.MonkeyPatch) -> CapturedMetrics:
    """Intercept the global meter provider install so the process stays unchanged.

    The seam is ``opentelemetry.metrics`` itself rather than ``_internal``: that module
    re-exports both functions, and a caller reaching for ``metrics.set_meter_provider``
    looks the alias up at call time, so patching the definition in ``_internal`` would let
    the real setter run. Meter installation is set-once per process, so a single real
    install here would starve every later reader in the run.

    The unset state is the API's own proxy, so the "is one already installed" branch is
    exercised for real rather than by patching a boolean.
    """
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)
    monkeypatch.setattr(_otel_metrics, "get_meter_provider", _ProxyMeterProvider)
    held = CapturedMetrics()
    monkeypatch.setattr(
        _otel_metrics,
        "set_meter_provider",
        lambda provider: setattr(held, "provider", provider),
    )
    return held


def test_metrics_are_not_installed_when_the_document_declared_no_export(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)

    status = configure_metrics(service_name="copilot", declared="none")

    assert status.configured is False
    assert status.reason == "not-declared"
    assert "observability.export" in status.detail


def test_an_unset_endpoint_leaves_the_alert_series_unpublished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(DEFAULT_ENDPOINT_ENV, raising=False)

    status = configure_metrics(service_name="copilot")

    assert status.configured is False
    assert status.reason == "endpoint-env-unset"
    assert "the alert series are never published" in status.detail


def test_a_missing_metric_exporter_names_the_extra_that_supplies_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)
    monkeypatch.setitem(sys.modules, METRIC_EXPORTER_MODULE, None)

    status = configure_metrics(service_name="copilot")

    assert status.configured is False
    assert status.reason == "exporter-not-installed"
    assert OTLP_EXTRA in status.detail
    assert "observability.alerts" in status.detail


def test_installing_the_metric_exporter_reports_what_it_installed(
    captured_metrics: CapturedMetrics,
) -> None:
    status = configure_metrics(service_name="support-copilot", interval_ms=2000)

    assert status.configured is True
    assert status.reason == "configured"
    provider = captured_metrics.provider
    assert provider is not None
    assert provider._sdk_config.resource.attributes["service.name"] == "support-copilot"

    readers = provider._metric_readers
    assert len(readers) == 1, "a provider with no reader exports nothing"
    reader = readers[0]
    assert type(reader).__name__ == "PeriodicExportingMetricReader"
    # The reader is typed as the base MetricReader; the interval and exporter are set by
    # the concrete subclass the assertion above pinned.
    periodic = cast(Any, reader)
    assert periodic._export_interval_millis == 2000
    assert type(periodic._exporter).__name__ == "OTLPMetricExporter"
    assert periodic._exporter._endpoint == METRIC_ENDPOINT
    provider.shutdown()


def test_an_existing_meter_provider_is_never_replaced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, ENDPOINT)
    installed = MeterProvider()
    monkeypatch.setattr(_otel_metrics, "get_meter_provider", lambda: installed)

    def refuse(provider: object) -> None:
        raise AssertionError(f"configure_metrics replaced a live provider: {provider!r}")

    monkeypatch.setattr(_otel_metrics, "set_meter_provider", refuse)

    status = configure_metrics(service_name="copilot")

    assert status.configured is True
    assert status.reason == "already-configured"
    assert installed._metric_readers == ()


def test_a_bare_collector_address_gains_the_signal_path(
    captured: Captured, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A document's `endpointEnv` is a collector address, not a signal URL.

    Every walkthrough sets the generic variable, so a base address has to be completed
    rather than posted to the collector root.
    """
    monkeypatch.setenv(DEFAULT_ENDPOINT_ENV, "http://collector:4318/")

    status = configure_export(service_name="copilot")

    assert status.detail.endswith(
        "http://collector:4318/v1/traces over OTLP/HTTP as service copilot"
    )
    assert captured.provider is not None
    assert _only_processor(captured.provider).span_exporter._endpoint == (
        "http://collector:4318/v1/traces"
    )


def test_the_metric_endpoint_is_the_same_variables_metric_path(
    captured_metrics: CapturedMetrics,
) -> None:
    """One variable, two signals: the value in use today is a trace URL and must still work."""
    status = configure_metrics(service_name="copilot")

    assert status.detail.endswith(
        f"{METRIC_ENDPOINT} over OTLP/HTTP as service copilot every 60000ms"
    )
    provider = captured_metrics.provider
    assert provider is not None
    assert cast(Any, provider._metric_readers[0])._exporter._endpoint == METRIC_ENDPOINT
    provider.shutdown()


@pytest.mark.skipif(
    not METRIC_EXPORTER_INSTALLED, reason=f"{METRIC_EXPORTER_MODULE} is not installed"
)
def test_a_real_interpreter_ends_up_with_a_meter_provider() -> None:
    script = (
        "import json;"
        "from opentelemetry import metrics;"
        "from opentelemetry.sdk.metrics import MeterProvider;"
        "from aid_runtime import configure_metrics;"
        "status = configure_metrics(service_name='e2e', interval_ms=100);"
        "print(json.dumps({"
        "'status': status.as_dict(),"
        "'installed': isinstance(metrics.get_meter_provider(), MeterProvider)"
        "}))"
    )
    env = {**os.environ, DEFAULT_ENDPOINT_ENV: ENDPOINT}

    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env=env,
        check=False,
        timeout=120,
    )

    assert completed.returncode == 0, completed.stderr
    reported = json.loads(completed.stdout)
    assert reported["status"]["configured"] is True
    assert reported["status"]["reason"] == "configured"
    assert reported["status"]["detail"].endswith("every 100ms")
    assert reported["installed"] is True
