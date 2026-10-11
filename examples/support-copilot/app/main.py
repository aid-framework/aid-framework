"""The ASGI entry point for `support-copilot`.

This file is hand-written, not generated: the generator owns the routes, and an
application decides what to mount and how to run it. Every route it mounts comes
from the generated tree, so `uvicorn app.main:app` serves the spec.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.generated.routes.answer_ticket import answer_ticket_router

app = FastAPI(title="support-copilot", version="0.1.0")
"""The application the spec describes, wired to the routers the generator emitted."""

app.include_router(answer_ticket_router)
