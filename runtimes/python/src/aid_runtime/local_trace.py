"""A local JSONL trace sink, enabled by ``AID_TRACE_DIR``.

The OpenTelemetry path is unchanged: with no provider installed, spans are no-ops and
tracing costs nothing. This module exists for the other case -- the CLI needs trace
data on disk, without the application installing an exporter, an SDK or a collector.
Setting ``AID_TRACE_DIR`` is that explicit request, and nothing here runs otherwise.

It is deliberately *not* an OpenTelemetry ``SpanExporter``: exporting one would mean
depending on the SDK, and the runtime deliberately depends only on the API so it never
decides a host application's telemetry. Instead it mirrors the span surface the
runtime itself uses (attributes, events, status) and writes one JSON line per span.

Writing must never fail a request, so every failure to record is swallowed.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import secrets
import threading
import time
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from collections.abc import Mapping

    from opentelemetry.trace import Span, Status

__all__ = ["TRACE_DIR_ENV", "finish_span", "local_trace_enabled", "wrap_span"]

TRACE_DIR_ENV = "AID_TRACE_DIR"

#: ``(span_id, trace_id)`` for the spans currently open in this context. A tuple, so
#: a context cannot see a sibling's stack, and a span that ends out of order removes
#: only its own entry.
_OPEN: ContextVar[tuple[tuple[str, str], ...]] = ContextVar("aid_local_trace_open", default=())

_lock = threading.Lock()
_sink: tuple[str, Path] | None = None


def local_trace_enabled() -> bool:
    """Whether ``AID_TRACE_DIR`` names a directory to write to."""
    return bool(_configured_dir())


def wrap_span(
    span: Span,
    *,
    name: str,
    kind: str,
    attributes: Mapping[str, Any] | None = None,
) -> Span:
    """Return ``span`` itself unless a local trace is requested, else a recording proxy."""
    if not local_trace_enabled():
        return span
    return cast("Span", _LocalSpan(span, name=name, kind=kind, attributes=attributes or {}))


def finish_span(span: Span) -> None:
    """End a wrapped span. A no-op for an ordinary OpenTelemetry span."""
    if isinstance(span, _LocalSpan):
        span.end()


def _configured_dir() -> str:
    return os.environ.get(TRACE_DIR_ENV, "").strip()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _jsonable(value: Any) -> Any:
    """Coerce an attribute value to something ``json`` can always serialise.

    OpenTelemetry accepts attribute types that JSON does not (tuples, arbitrary
    objects), and a value that failed to serialise would cost the whole record.
    """
    if value is None or isinstance(value, str | bool | int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    return str(value)


def _sink_path() -> Path | None:
    """The file for this process, creating its directory on first use.

    Cached per configured directory so one process writes one file, while a test
    that points ``AID_TRACE_DIR`` somewhere else still gets a fresh file.
    """
    global _sink
    configured = _configured_dir()
    if not configured:
        return None
    with _lock:
        if _sink is not None and _sink[0] == configured:
            return _sink[1]
        directory = Path(configured)
        with contextlib.suppress(OSError):
            directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        path = directory / f"trace-{stamp}-{os.getpid()}.jsonl"
        _sink = (configured, path)
        return path


def _write(record: dict[str, Any]) -> None:
    path = _sink_path()
    if path is None:
        return
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    # A trace that could not be written is a lost trace, not a failed request.
    with (
        contextlib.suppress(OSError, TypeError, ValueError),
        _lock,
        path.open("a", encoding="utf-8") as handle,
    ):
        handle.write(f"{line}\n")


class _LocalSpan:
    """Mirrors the span methods this runtime calls, then writes one JSON line."""

    def __init__(
        self,
        span: Span,
        *,
        name: str,
        kind: str,
        attributes: Mapping[str, Any],
    ) -> None:
        self._span = span
        self._name = name
        self._kind = kind
        self._attributes: dict[str, Any] = {
            key: _jsonable(value) for key, value in attributes.items()
        }
        self._events: list[dict[str, Any]] = []
        self._status: dict[str, Any] | None = None
        self._monotonic = time.monotonic()
        self._started_at = _now()
        self._ended = False

        open_spans = _OPEN.get()
        parent = open_spans[-1] if open_spans else None
        self._trace_id = parent[1] if parent is not None else secrets.token_hex(16)
        self._span_id = secrets.token_hex(8)
        self._parent_span_id = parent[0] if parent is not None else None
        _OPEN.set((*open_spans, (self._span_id, self._trace_id)))

    def set_attribute(self, key: str, value: Any) -> None:
        self._attributes[key] = _jsonable(value)
        self._span.set_attribute(key, value)

    def set_attributes(self, attributes: Mapping[str, Any]) -> None:
        for key, value in attributes.items():
            self.set_attribute(key, value)

    def add_event(
        self,
        name: str,
        attributes: Mapping[str, Any] | None = None,
        timestamp: int | None = None,
    ) -> None:
        self._events.append(
            {
                "name": name,
                "at": _now(),
                "attributes": {key: _jsonable(value) for key, value in (attributes or {}).items()},
            }
        )
        self._span.add_event(name, attributes, timestamp)

    def record_exception(
        self,
        exception: BaseException,
        attributes: Mapping[str, Any] | None = None,
        *,
        escaped: bool = True,
        timestamp: int | None = None,
    ) -> None:
        recorded = {
            "exception.type": f"{type(exception).__module__}.{type(exception).__qualname__}",
            "exception.message": str(exception),
            **{key: _jsonable(value) for key, value in (attributes or {}).items()},
        }
        self._events.append({"name": "exception", "at": _now(), "attributes": recorded})
        self._span.record_exception(exception, attributes, escaped=escaped, timestamp=timestamp)

    def set_status(self, status: Status) -> None:
        self._status = {"code": status.status_code.name, "message": status.description}
        self._span.set_status(status)

    def update_name(self, name: str) -> None:
        self._name = name
        self._span.update_name(name)

    def end(self, end_time: int | None = None) -> None:
        if self._ended:
            return
        self._ended = True
        _OPEN.set(tuple(entry for entry in _OPEN.get() if entry[0] != self._span_id))
        self._span.end(end_time)
        _write(
            {
                "trace_id": self._trace_id,
                "span_id": self._span_id,
                "parent_span_id": self._parent_span_id,
                "name": self._name,
                "kind": self._kind,
                "started_at": self._started_at,
                "ended_at": _now(),
                "duration_ms": round((time.monotonic() - self._monotonic) * 1000, 3),
                "attributes": self._attributes,
                "events": self._events,
                "status": self._status,
            }
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._span, name)
