"""The ASGI entry point for `guarded-reply`.

This file is hand-written, not generated: the generator owns the routes, and an
application decides what to mount and how to run it. Every route it mounts comes
from the generated tree, so `uvicorn app.main:app` serves the spec.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.generated.routes.answer_message import answer_message_router

app = FastAPI(title="guarded-reply", version="0.1.0")
"""The application the spec describes, wired to the router the generator emitted."""

app.include_router(answer_message_router)
