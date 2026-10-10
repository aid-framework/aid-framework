"""The plain-async pipeline engine.

The interesting properties are the ones an orchestration library would hide:
steps run in a fixed order, the context cannot be mutated in place, an early stop
is a success rather than an error, and a step's exception is never swallowed.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from typing import Any

import pytest

from aid_runtime import (
    STEPS_KEY,
    Pipeline,
    PipelineContext,
    PipelineError,
    Step,
    StopPipeline,
)


class BoomError(Exception):
    """A stand-in for whatever a real step raises."""


def _add(key: str, value: Any) -> Step:
    def step(context: PipelineContext) -> PipelineContext:
        return context.with_values(**{key: value})

    return step


def _record(log: list[str], name: str) -> Step:
    def step(context: PipelineContext) -> PipelineContext:
        log.append(name)
        return context

    return step


async def _async_add(key: str, value: Any) -> Step:
    async def step(context: PipelineContext) -> PipelineContext:
        return context.with_values(**{key: value})

    return step


def test_the_context_is_frozen_and_cannot_be_mutated_in_place() -> None:
    context = PipelineContext(values={"a": 1})

    with pytest.raises(FrozenInstanceError):
        # Writing through the read-only property is what must fail at runtime.
        context.values = {"a": 2}  # type: ignore[misc]


def test_get_require_with_values_and_without() -> None:
    context = PipelineContext(values={"a": 1})

    assert context.get("a") == 1
    assert context.get("missing") is None
    assert context.get("missing", "fallback") == "fallback"
    assert context.require("a") == 1

    with pytest.raises(PipelineError, match="pipeline context has no 'missing'"):
        context.require("missing")


def test_deriving_a_context_leaves_the_original_untouched() -> None:
    original = PipelineContext(values={"a": 1})

    extended = original.with_values(b=2)
    trimmed = extended.without("a")

    assert extended.values == {"a": 1, "b": 2}
    assert trimmed.values == {"b": 2}
    assert original.values == {"a": 1}
    assert extended.with_values(a=9).get("a") == 9


async def test_steps_run_in_order_and_thread_the_context() -> None:
    pipeline = Pipeline([("first", _add("a", 1)), ("second", _add("b", 2))])
    context = await pipeline.run()

    assert context.get("a") == 1
    assert context.get("b") == 2


async def test_async_and_sync_steps_can_be_mixed() -> None:
    pipeline = Pipeline([("sync", _add("a", 1)), ("async", await _async_add("b", 2))])
    context = await pipeline.run()

    assert context.values == {"a": 1, "b": 2, STEPS_KEY: ("sync", "async")}


async def test_the_steps_that_ran_are_recorded_in_order() -> None:
    log: list[str] = []
    pipeline = Pipeline([("a", _record(log, "a")), ("b", _record(log, "b"))])
    context = await pipeline.run()

    assert log == ["a", "b"]
    assert context.get(STEPS_KEY) == ("a", "b")


async def test_recording_can_be_turned_off() -> None:
    pipeline = Pipeline([("a", _add("a", 1))], record_steps=False)

    assert (await pipeline.run()).values == {"a": 1}


async def test_an_empty_pipeline_is_rejected() -> None:
    with pytest.raises(PipelineError, match="a pipeline needs at least one step"):
        Pipeline([])


async def test_duplicate_step_names_are_rejected() -> None:
    with pytest.raises(PipelineError, match="duplicate step name 'a'"):
        Pipeline([("a", _add("x", 1)), ("a", _add("y", 2))])


def test_step_names_reports_what_was_declared() -> None:
    pipeline = Pipeline([("a", _add("x", 1)), ("b", _add("y", 2))])
    assert pipeline.step_names == ("a", "b")


def test_then_returns_a_new_pipeline_and_leaves_the_original_alone() -> None:
    original = Pipeline([("a", _add("x", 1))])
    extended = original.then("b", _add("y", 2))

    assert original.step_names == ("a",)
    assert extended.step_names == ("a", "b")


def test_then_preserves_the_recording_choice() -> None:
    pipeline = Pipeline([("a", _add("x", 1))], record_steps=False).then("b", _add("y", 2))
    assert pipeline.step_names == ("a", "b")


def test_a_pipeline_built_with_of_names_steps_by_function_name() -> None:
    def fetch(context: PipelineContext) -> PipelineContext:
        return context

    async def rank(context: PipelineContext) -> PipelineContext:
        return context

    assert Pipeline.of(fetch, rank).step_names == ("fetch", "rank")


def test_of_names_a_callable_object_by_its_type() -> None:
    class Enrich:
        def __call__(self, context: PipelineContext) -> PipelineContext:
            return context

    assert Pipeline.of(Enrich()).step_names == ("Enrich",)


async def test_run_accepts_a_mapping_as_the_initial_context() -> None:
    pipeline = Pipeline([("a", _add("b", 2))])
    assert (await pipeline.run({"a": 1})).values == {"a": 1, "b": 2, STEPS_KEY: ("a",)}


async def test_run_with_no_initial_context_starts_empty() -> None:
    assert (await Pipeline([("a", _add("a", 1))]).run()).get("a") == 1


async def test_a_step_may_return_a_mapping_instead_of_a_context() -> None:
    def step(context: PipelineContext) -> dict[str, Any]:
        return {"from_step": True}

    context = await Pipeline([("map", step)]).run()
    assert context.get("from_step") is True


async def test_a_step_returning_something_else_aborts_the_pipeline() -> None:
    def step(context: PipelineContext) -> Any:
        return 42

    with pytest.raises(
        PipelineError,
        match="step 'bad' failed: a pipeline step must return a PipelineContext",
    ):
        await Pipeline([("bad", step)]).run()


async def test_a_step_returning_none_yields_an_empty_context() -> None:
    def step(context: PipelineContext) -> None:
        return None

    context = await Pipeline([("a", _add("a", 1)), ("drop", step)]).run()
    assert context.get("a") is None


async def test_a_failing_step_is_wrapped_and_its_cause_is_preserved() -> None:
    log: list[str] = []

    def fail(context: PipelineContext) -> PipelineContext:
        raise BoomError("provider is down")

    pipeline = Pipeline(
        [("ok", _record(log, "ok")), ("fail", fail), ("after", _record(log, "after"))]
    )

    with pytest.raises(PipelineError, match="step 'fail' failed: provider is down") as excinfo:
        await pipeline.run()

    assert isinstance(excinfo.value.__cause__, BoomError)
    assert log == ["ok"]


async def test_stop_pipeline_ends_the_run_as_a_success() -> None:
    log: list[str] = []

    def stop(context: PipelineContext) -> PipelineContext:
        raise StopPipeline("nothing left to do")

    pipeline = Pipeline(
        [("a", _record(log, "a")), ("stop", stop), ("never", _record(log, "never"))]
    )
    context = await pipeline.run()

    assert log == ["a"]
    assert context.get(STEPS_KEY) == ("a", "stop")


async def test_the_context_after_an_early_stop_is_the_last_completed_step_s() -> None:
    def stop(context: PipelineContext) -> PipelineContext:
        raise StopPipeline("done")

    context = await Pipeline([("a", _add("a", 1)), ("stop", stop)]).run()

    assert context.values == {"a": 1, STEPS_KEY: ("a", "stop")}


async def test_a_bare_stop_pipeline_has_a_readable_reason() -> None:
    stop = StopPipeline()
    assert stop.reason == ""
    assert str(stop) == "pipeline stopped"
