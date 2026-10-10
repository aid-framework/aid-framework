"""A plain-async pipeline engine.

This is the Phase 0 answer to "the loop". It is a sequential reducer over an
immutable context: each step receives the context and returns the context,
optionally enriched. No graph, no scheduler, no orchestration dependency.

That is a deliberate ceiling. When Phase 2 needs branching, retries and
human-in-the-loop interrupts an orchestration library is the right tool -- but
adopting one before those requirements exist would place an unobservable graph
between the user and their own trace.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

from aid_runtime.errors import PipelineError
from aid_runtime.tracing import get_tracer, record_exception

__all__ = ["STEPS_KEY", "Pipeline", "PipelineContext", "Step", "StopPipeline"]

#: Context key under which :meth:`Pipeline.run` records the steps that ran, in order.
STEPS_KEY = "steps"


class StopPipeline(Exception):  # noqa: N818 - control-flow signal, not an error condition
    """Raise from a step to end the pipeline successfully and early."""

    def __init__(self, reason: str = "") -> None:
        super().__init__(reason or "pipeline stopped")
        self.reason = reason


@dataclass(frozen=True, slots=True)
class PipelineContext:
    """The value threaded through a pipeline.

    Frozen, so a step cannot mutate what an earlier step observed; it returns a
    new context instead. That keeps a failed run's state inspectable and makes
    replaying a pipeline reproducible.
    """

    values: Mapping[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.values.get(key, default)

    def require(self, key: str) -> Any:
        try:
            return self.values[key]
        except KeyError:
            raise PipelineError(f"pipeline context has no {key!r}") from None

    def with_values(self, **values: Any) -> PipelineContext:
        return replace(self, values={**self.values, **values})

    def without(self, *keys: str) -> PipelineContext:
        return replace(self, values={k: v for k, v in self.values.items() if k not in keys})


#: What a step may produce: a new context, a mapping to merge in, or nothing.
StepResult = PipelineContext | Mapping[str, Any] | None

#: A step: an async (or plain) callable from context to a step result.
Step = Callable[[PipelineContext], StepResult | Awaitable[StepResult]]


class Pipeline:
    """Runs named steps in order, tracing each one."""

    def __init__(
        self,
        steps: Sequence[tuple[str, Step]],
        *,
        tracer_name: str = "aid_runtime",
        record_steps: bool = True,
    ) -> None:
        if not steps:
            raise PipelineError("a pipeline needs at least one step")
        seen: set[str] = set()
        for name, _ in steps:
            if name in seen:
                raise PipelineError(f"duplicate step name {name!r}")
            seen.add(name)
        self._steps = tuple(steps)
        self._tracer_name = tracer_name
        self._record_steps = record_steps

    @property
    def step_names(self) -> tuple[str, ...]:
        return tuple(name for name, _ in self._steps)

    @classmethod
    def of(cls, *steps: Step, tracer_name: str = "aid_runtime") -> Pipeline:
        """Build a pipeline from bare callables, naming each by its function."""
        return cls([(_step_name(step), step) for step in steps], tracer_name=tracer_name)

    def then(self, name: str, step: Step) -> Pipeline:
        """A new pipeline with ``step`` appended. This instance is unchanged."""
        return Pipeline(
            [*self._steps, (name, step)],
            tracer_name=self._tracer_name,
            record_steps=self._record_steps,
        )

    async def run(
        self, initial: PipelineContext | Mapping[str, Any] | None = None
    ) -> PipelineContext:
        """Execute every step, stopping early if one raises :class:`StopPipeline`.

        A step that raises anything else aborts the run and the original exception
        is chained, so the traceback shows both the pipeline coordinate and the
        real cause.
        """
        context = _as_context(initial)
        ran: list[str] = []
        tracer = get_tracer(self._tracer_name)

        for name, step in self._steps:
            with tracer.start_as_current_span(
                f"pipeline.{name}",
                # The failing step's own exception is recorded below; the automatic
                # recording would add a second event for the PipelineError wrapper
                # and would hide the original exception type.
                record_exception=False,
                set_status_on_exception=False,
            ) as span:
                span.set_attribute("aid.pipeline.step", name)
                try:
                    context = _as_context(await _resolve(step(context)))
                except StopPipeline as stop:
                    ran.append(name)
                    if stop.reason:
                        span.set_attribute("aid.pipeline.stop_reason", stop.reason)
                    return self._finish(context, ran)
                except Exception as exc:
                    record_exception(span, exc)
                    raise PipelineError(f"step {name!r} failed: {exc}") from exc
            ran.append(name)

        return self._finish(context, ran)

    def _finish(self, context: PipelineContext, ran: Sequence[str]) -> PipelineContext:
        return context.with_values(**{STEPS_KEY: tuple(ran)}) if self._record_steps else context


async def _resolve(value: StepResult | Awaitable[StepResult]) -> StepResult:
    return await value if inspect.isawaitable(value) else value


def _as_context(value: Any) -> PipelineContext:
    if isinstance(value, PipelineContext):
        return value
    if value is None:
        return PipelineContext()
    if isinstance(value, Mapping):
        return PipelineContext(values=dict(value))
    raise PipelineError(
        f"a pipeline step must return a PipelineContext, a mapping or None, "
        f"got {type(value).__name__}"
    )


def _step_name(step: Step) -> str:
    return getattr(step, "__name__", None) or type(step).__name__
