"""The ASGI entry point for `support-copilot`.

This file is hand-written, not generated: the generator owns the routes, and an
application decides what to mount and how to run it. Every route it mounts comes
from the generated tree, so `uvicorn app.main:app` serves the spec.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.generated.agents import agent_router
from app.generated.observability import metrics_export_status, tracing_export_status
from app.generated.routes.answer_ticket import answer_ticket_router

# The two lines the generator cannot write: this file is the application's, so the exporters
# are installed from here. Both return a status rather than raising, so a collector address
# that is missing at startup leaves the service serving instead of crash-looping -- call them
# and log the results, do not guard them. The tracer is the half a reader remembers; the meter
# is the half an alarm reads, and a service that installs only the tracer serves normally and
# publishes no series, which is the one failure mode that looks like health.
tracing_export_status("support-copilot")
metrics_export_status("support-copilot")

app = FastAPI(title="support-copilot", version="0.1.0")
"""The application the spec describes, wired to the routers the generator emitted."""

app.include_router(answer_ticket_router)
app.include_router(agent_router)
