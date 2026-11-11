"""The ASGI entry point for `support-copilot`.

This file is hand-written, not generated: the generator owns the routes, and an
application decides what to mount and how to run it. Every route it mounts comes
from the generated tree, so `uvicorn app.main:app` serves the spec.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.generated.agents import agent_router
from app.generated.observability import tracing_export_status
from app.generated.routes.answer_ticket import answer_ticket_router

# The one line the generator cannot write: this file is the application's, so the exporter
# is installed from here. It returns a status rather than raising, so a collector address
# that is missing at startup leaves the service serving instead of crash-looping -- call it
# and log the result, do not guard it.
tracing_export_status("support-copilot")

app = FastAPI(title="support-copilot", version="0.1.0")
"""The application the spec describes, wired to the routers the generator emitted."""

app.include_router(answer_ticket_router)
app.include_router(agent_router)
