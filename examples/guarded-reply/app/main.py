"""The ASGI entry point for `guarded-reply`.

This file is hand-written, not generated: the generator owns the routes, and an
application decides what to mount and how to run it. Every route it mounts comes
from the generated tree, so `uvicorn app.main:app` serves the spec.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.generated.observability import tracing_export_status
from app.generated.routes.answer_message import answer_message_router

# The one line the generator cannot write: this file is the application's, so the exporter
# is installed from here. It returns a status rather than raising, so a collector address
# that is missing at startup leaves the service serving instead of crash-looping.
tracing_export_status("guarded-reply")

app = FastAPI(title="guarded-reply", version="0.1.0")
"""The application the spec describes, wired to the router the generator emitted."""

app.include_router(answer_message_router)
