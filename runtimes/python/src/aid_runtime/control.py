"""Composite pipeline steps: ``branch``, ``parallel``, ``map`` and ``reduce``.

:class:`~aid_runtime.pipeline.Pipeline` is a sequential reducer, and it stays one.
Each factory here returns an ordinary :data:`~aid_runtime.pipeline.Step`, so a
composite composes with the flat steps by the same rule and replays unchanged on
the streaming route, which inlines the pipeline instead of driving it step by step.

Six context keys are reserved for the family, and no step may bind a name equal to
one of them: ``principal``, ``limiter``, ``item``, ``index``, ``reduced`` and
``depth``. The first two are seeded by the application; the rest belong to the
composites -- ``item``, ``index`` and ``depth`` are written and removed around a
fan-out, while ``reduced`` is the binding a ``reduce`` body must produce for the
composite to collect -- so an inner step can read ``item`` without a matching
binding leaking to a later sibling.

Two bounds are enforced here and both fail the run rather than degrade it:

* nesting, at :data:`MAX_STEP_DEPTH`. The spec layer rejects a deeper pipeline
  before generation, so reaching this bound at run time means a hand-built
  pipeline, and the reason is named in the error.
* concurrency, through the application's one :class:`ConcurrencyLimiter`. A
  fan-out with no limiter in the context raises rather than running unbounded,
  because the cap is what makes a fan-out safe and its absence is a wiring bug.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, TypeVar

from aid_runtime.agents.policy import Principal, evaluate_policy, policy_source
from aid_runtime.concurrency import ConcurrencyLimiter, holds_slot
from aid_runtime.errors import PipelineError
from aid_runtime.pipeline import STEPS_KEY, Pipeline, PipelineContext

__all__ = [
    "DEPTH_KEY",
    "INDEX_KEY",
    "ITEM_KEY",
    "LIMITER_KEY",
    "MAX_STEP_DEPTH",
    "PRINCIPAL_KEY",
    "REDUCED_KEY",
    "RESERVED_KEYS",
    "branch",
    "map_step",
    "parallel",
    "reduce_step",
]

#: Deepest composite nesting a pipeline may declare.
#:
#: The spec layer owns this number and the generator *emits* it into the generated
#: package, so a generated app passes its own build's value; this default is what a
#: hand-written pipeline gets. ``test_max_step_depth_matches_the_emitted_constant``
#: holds the two together, so a drift fails a test instead of diverging silently.
MAX_STEP_DEPTH = 4

#: Who the caller is, for ``branch``. Seeded by the route.
PRINCIPAL_KEY = "principal"
#: The application's single limiter, from ``deployments.concurrency``.
LIMITER_KEY = "limiter"
#: The current item and its position, written by ``map``/``reduce`` for one iteration.
ITEM_KEY = "item"
INDEX_KEY = "index"
#: How many composites deep the current step is.
DEPTH_KEY = "depth"
#: The binding ``reduce`` collects from each iteration. Reserved so a reduce body's
#: own binding cannot collide with the name the composite reads.
REDUCED_KEY = "reduced"

#: Names a composite owns. A spec binding equal to one of them is refused upstream.
RESERVED_KEYS = frozenset({PRINCIPAL_KEY, LIMITER_KEY, ITEM_KEY, INDEX_KEY, DEPTH_KEY, REDUCED_KEY})

#: A composite: ``async`` by construction, so ``await step(context)`` is well-typed.
#: ``Step`` also allows a sync return, which is what makes a generated ``await`` of one
#: untypeable; the factories below return this narrower alias instead.
CompositeStep = Callable[[PipelineContext], Awaitable[PipelineContext]]

_StepT = TypeVar("_StepT", bound=CompositeStep)

#: Values a fan-out child produced that its parent did not already hold.
_NewValues = dict[str, Any]


def _named(step: _StepT, name: str | None) -> _StepT:
    """Name a composite's callable, so a trace and ``Pipeline.of`` identify it.

    ``Pipeline`` names a step by the callable's ``__name__`` and refuses two steps
    with the same name, so a pipeline holding two ``branch`` composites must give
    them distinct names. The generator passes one; the default is the kind.
    """
    if name is not None:
        step.__name__ = name
    return step


def _depth(context: PipelineContext) -> int:
    value = context.get(DEPTH_KEY, 0)
    return 0 if value is None else int(value)


def _enter(context: PipelineContext, max_depth: int, where: str) -> PipelineContext:
    """The context a nested step list runs in, or a named refusal past the bound."""
    depth = _depth(context)
    if depth >= max_depth:
        raise PipelineError(
            f"composite step {where} is nested deeper than {max_depth} levels; "
            f"nesting is bounded so a self-similar spec cannot recurse without end"
        )
    return context.with_values(**{DEPTH_KEY: depth + 1})


def _limiter(context: PipelineContext, where: str) -> ConcurrencyLimiter:
    limiter = context.get(LIMITER_KEY)
    if not isinstance(limiter, ConcurrencyLimiter):
        raise PipelineError(
            f"step {where} fans out but the pipeline context has no concurrency "
            f"limiter; declare `concurrency` under a deployment in the spec so the "
            f"generator seeds one"
        )
    return limiter


def _escape(context: PipelineContext) -> PipelineContext:
    """Drop the iteration keys, so nothing a composite added reaches a later sibling."""
    return context.without(DEPTH_KEY, ITEM_KEY, INDEX_KEY, REDUCED_KEY)


async def _run_body(body: Pipeline, context: PipelineContext) -> tuple[PipelineContext, _NewValues]:
    """Run one iteration and return its context with only the bindings it added.

    Only the added names come back, so a composite hands its siblings the bindings
    the spec declared and nothing else. The inner run records its own ``steps``; it
    is excluded here because the outer ``Pipeline.run`` writes that key itself when
    the composite returns, and an inner list would otherwise be read as a binding.
    """
    result = await body.run(context)
    added = {
        key: value
        for key, value in result.values.items()
        if key not in context.values and key not in RESERVED_KEYS and key != STEPS_KEY
    }
    return result, added


async def _fan_out(
    workers: Sequence[Awaitable[tuple[PipelineContext, _NewValues]]],
) -> list[tuple[PipelineContext, _NewValues]]:
    """Run every worker, in the order given, whatever order they finish in.

    ``asyncio.gather`` returns results positionally, so the caller's ordering rule is
    input order even when the last worker finishes first.

    A worker inside a slot this task already holds runs its siblings one at a time
    instead of acquiring a second slot: the limiter is shared with the gateway and
    the tool executor, so a worker that acquired again while its own body waited for
    the gateway would deadlock at a cap of one. Serialising keeps the cap and
    cannot deadlock, which is the trade this family makes at nesting depth two.
    """
    if holds_slot():
        return [await worker for worker in workers]
    gathered = await asyncio.gather(*workers, return_exceptions=True)
    # Every worker is awaited even after one fails, so no task is left running and the
    # error that surfaces is the first in input order rather than the first to finish.
    for entry in gathered:
        if isinstance(entry, BaseException):
            raise entry
    return [entry for entry in gathered if not isinstance(entry, BaseException)]


def branch(
    *,
    when: Mapping[str, Any],
    then: Pipeline,
    otherwise: Pipeline | None = None,
    max_depth: int = MAX_STEP_DEPTH,
    name: str | None = None,
) -> CompositeStep:
    """Run ``then`` when the caller's principal satisfies ``when``, else ``otherwise``.

    ``when`` is a ``PolicyExpr`` AST, evaluated against the principal and nothing
    else: the grammar has no operand for a context value, so a branch cannot read
    what an earlier step produced. It is a ``Mapping`` rather than a parsed object
    so the generated code passes the AST the IR already carries, and
    :func:`evaluate_policy` stays the only evaluator.

    No principal in the context is an error, not a false. Defaulting would decide an
    authorization question for a caller nobody identified.
    """

    async def _branch(context: PipelineContext) -> PipelineContext:
        principal = context.get(PRINCIPAL_KEY)
        if not isinstance(principal, Principal):
            raise PipelineError(
                "branch needs a principal in the pipeline context to evaluate "
                f"{policy_source(when)!r}; none was seeded"
            )
        nested = _enter(context, max_depth, f"branch ({policy_source(when)})")
        chosen = then if evaluate_policy(when, principal) else otherwise
        if chosen is None:
            # No alternative declared: the branch binds nothing at all.
            return _escape(context)
        _, added = await _run_body(chosen, nested)
        return _escape(context.with_values(**added))

    return _named(_branch, name)


def parallel(
    *,
    branches: Sequence[Pipeline],
    max_depth: int = MAX_STEP_DEPTH,
    name: str | None = None,
) -> CompositeStep:
    """Run every arm concurrently under the shared cap, then merge what they bound.

    A failing arm fails the whole run: the results are inspected in input order and
    the first failure is raised, so which error surfaces does not depend on which
    arm happened to fail first. Two arms binding the same new name is an error
    rather than a silent last-writer-wins, because the winning value would depend on
    completion order and the ordering rule exists to remove that.
    """

    async def _parallel(context: PipelineContext) -> PipelineContext:
        if not branches:
            return _escape(context)
        limiter = _limiter(context, "parallel")
        nested = _enter(context, max_depth, "parallel")

        async def run_arm(arm: Pipeline) -> tuple[PipelineContext, _NewValues]:
            async with limiter.run():
                return await _run_body(arm, nested)

        outcomes = await _fan_out([run_arm(arm) for arm in branches])
        merged: dict[str, Any] = {}
        for _, added in outcomes:
            for key, value in added.items():
                if key in merged:
                    raise PipelineError(
                        f"parallel arms both bind {key!r}; a name may be bound by one arm"
                    )
                merged[key] = value
        return _escape(context.with_values(**merged))

    return _named(_parallel, name)


def map_step(
    *,
    over: str,
    as_: str,
    step: Pipeline,
    max_depth: int = MAX_STEP_DEPTH,
    name: str | None = None,
) -> CompositeStep:
    """Run ``step`` once per item of ``over``, binding the results in input order.

    ``as_`` holds one mapping of the names the body bound for that item, so an item
    that bound nothing contributes ``{}`` rather than vanishing: the list keeps the
    length of the input. An empty or absent-over value binds an empty list.
    """

    async def _map(context: PipelineContext) -> PipelineContext:
        items = _items(context, over, "map")
        limiter = _limiter(context, "map")
        nested = _enter(context, max_depth, f"map over {over!r}")

        async def run_item(index: int, item: Any) -> tuple[PipelineContext, _NewValues]:
            iteration = nested.with_values(**{ITEM_KEY: item, INDEX_KEY: index})
            async with limiter.run():
                return await _run_body(step, iteration)

        outcomes = await _fan_out(
            [run_item(index, item) for index, item in enumerate(items)],
        )
        results = [added for _, added in outcomes]
        return _escape(context.with_values(**{as_: results}))

    return _named(_map, name)


def reduce_step(
    *,
    over: str,
    as_: str,
    step: Pipeline,
    max_depth: int = MAX_STEP_DEPTH,
    name: str | None = None,
) -> CompositeStep:
    """Run ``step`` once per item of ``over``, binding its :data:`REDUCED_KEY` results.

    ``step`` is a one-step pipeline that renders the reduce prompt for one item and
    binds :data:`REDUCED_KEY`; the composite collects that binding into ``as_`` in
    input order. Combining the results is a following ``generate`` step, so this
    layer never invents a merge strategy.
    """

    async def _reduce(context: PipelineContext) -> PipelineContext:
        items = _items(context, over, "reduce")
        limiter = _limiter(context, "reduce")
        nested = _enter(context, max_depth, f"reduce over {over!r}")

        async def run_item(index: int, item: Any) -> tuple[PipelineContext, _NewValues]:
            iteration = nested.with_values(**{ITEM_KEY: item, INDEX_KEY: index})
            async with limiter.run():
                result = await step.run(iteration)
            if REDUCED_KEY not in result.values:
                raise PipelineError(
                    f"reduce over {over!r} produced no {REDUCED_KEY!r} binding for item {index}"
                )
            return result, {REDUCED_KEY: result.require(REDUCED_KEY)}

        outcomes = await _fan_out(
            [run_item(index, item) for index, item in enumerate(items)],
        )
        results = [added[REDUCED_KEY] for _, added in outcomes]
        return _escape(context.with_values(**{as_: results}))

    return _named(_reduce, name)


def _items(context: PipelineContext, over: str, where: str) -> list[Any]:
    """The sequence a ``map``/``reduce`` iterates, refusing a missing or odd value."""
    value = context.require(over)
    if isinstance(value, str) or not isinstance(value, Sequence):
        raise PipelineError(f"{where} over {over!r} needs a list, got {type(value).__name__}")
    return list(value)
