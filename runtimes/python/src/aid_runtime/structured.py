"""Structured-output enforcement with a parse-repair loop.

This is the only place Pydantic AI is used, and it is used for what it is good at:
getting a typed object out of an untrusted model response. Pipeline control flow
is plain async; Pydantic AI is not an orchestration dependency here.

Two entry points:

* :func:`parse_structured` coerces already-received text into a typed model.
* :func:`run_structured` drives a call-repair-retry loop, feeding the validation
  failure back to the model. This is the difference between "the model must be
  right the first time" and "the model must eventually be right" -- the second is
  the only achievable contract.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from aid_runtime.errors import StructuredOutputError

__all__ = [
    "ModelT",
    "build_agent",
    "format_problems",
    "parse_structured",
    "repair_prompt",
    "run_structured",
]

ModelT = TypeVar("ModelT", bound=BaseModel)

#: The correction turn appended after a failed parse.
REPAIR_INSTRUCTION = (
    "Your previous response could not be parsed. Reply with corrected JSON only, "
    "matching the required schema exactly. Errors: {problems}"
)


def format_problems(exc: ValidationError) -> list[str]:
    """Flatten a Pydantic error into ``location: message`` strings."""
    problems: list[str] = []
    for error in exc.errors():
        location = ".".join(str(part) for part in error["loc"]) or "<root>"
        problems.append(f"{location}: {error['msg']}")
    return problems


def parse_structured(text: str, output_type: type[ModelT]) -> ModelT:
    """Validate ``text`` as ``output_type``.

    Raises :class:`~aid_runtime.errors.StructuredOutputError` with every problem,
    not just the first: feeding one error back at a time turns a two-round repair
    into a five-round one.
    """
    stripped = _strip_code_fence(text).strip()
    if not stripped:
        raise StructuredOutputError(
            f"model returned empty output for {output_type.__name__}", attempts=1
        )
    try:
        return output_type.model_validate_json(stripped)
    except ValidationError as exc:
        problems = format_problems(exc)
        raise StructuredOutputError(
            f"output did not validate as {output_type.__name__}", attempts=1, problems=problems
        ) from exc


async def run_structured(
    call: Callable[[str], Awaitable[str]],
    output_type: type[ModelT],
    prompt: str,
    *,
    retries: int = 2,
) -> ModelT:
    """Call, parse, and on failure re-ask with the validation errors attached.

    ``retries`` counts *repair* attempts beyond the first call, so
    ``retries=2`` means at most three calls. Raising after the final attempt is
    correct: a generated endpoint that returns a half-valid object is worse than
    one that fails loudly.
    """
    if retries < 0:
        raise ValueError("retries must not be negative")

    current = prompt
    problems: list[str] = []
    for attempt in range(1, retries + 2):
        text = await call(current)
        try:
            return parse_structured(text, output_type)
        except StructuredOutputError as exc:
            problems = list(exc.problems)
            if attempt <= retries:
                current = f"{prompt}\n\n{repair_prompt(exc)}"

    raise StructuredOutputError(
        f"{output_type.__name__} not produced from {retries + 1} attempt(s)",
        attempts=retries + 1,
        problems=problems,
    )


def repair_prompt(error: StructuredOutputError) -> str:
    """The corrective turn for a failed parse."""
    problems = "; ".join(error.problems) if error.problems else str(error)
    return REPAIR_INSTRUCTION.format(problems=problems)


def build_agent(
    model: Any,
    output_type: type[ModelT],
    *,
    system_prompt: str | None = None,
    retries: int = 2,
) -> Any:
    """Build a Pydantic AI agent bound to ``output_type``.

    Kept to a one-liner over the library's own constructor so the typed-output
    behaviour -- including its internal retry/repair -- is available to generated
    endpoints without this runtime growing its own orchestration layer.
    """
    from pydantic_ai import Agent

    kwargs: dict[str, Any] = {}
    if system_prompt is not None:
        kwargs["system_prompt"] = system_prompt
    return Agent(model, output_type=output_type, retries=retries, **kwargs)


def _strip_code_fence(text: str) -> str:
    """Remove a ```json fence if the model wrapped its answer in one.

    Models do this constantly when asked for JSON. Treating a valid payload as
    invalid because of presentation is a self-inflicted repair loop.
    """
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) < 2:
        return stripped
    lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines)
