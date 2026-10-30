"""The composite step family: branch, parallel, map and reduce.

Each test drives real pipelines rather than asserting that the factories were
called, because every property this family promises -- the cap, the ordering, the
nesting bound -- is only observable while work runs. The ordering cases use arms
that finish in reverse declaration order, so a result list that came out in
completion order would fail rather than happen to match.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from aid_runtime import (
    DEPTH_KEY,
    INDEX_KEY,
    ITEM_KEY,
    LIMITER_KEY,
    MAX_STEP_DEPTH,
    PRINCIPAL_KEY,
    REDUCED_KEY,
    ConcurrencyLimiter,
    Pipeline,
    PipelineContext,
    PipelineError,
    Principal,
    branch,
    map_step,
    parallel,
    reduce_step,
)

IS_AUTHENTICATED: Mapping[str, Any] = {"kind": "call", "name": "isAuthenticated", "args": []}
HAS_ROLE_ADMIN: Mapping[str, Any] = {
    "kind": "call",
    "name": "hasRole",
    "args": [{"kind": "string", "value": "admin"}],
}


def context(**values: Any) -> PipelineContext:
    return PipelineContext(values=dict(values))


def step(bind: str, *, delay: float = 0.0, name: str | None = None) -> Any:
    """A step that sleeps, then binds itself, so finishing order is declaration order."""

    async def run(current: PipelineContext) -> PipelineContext:
        if delay:
            await asyncio.sleep(delay)
        return current.with_values(**{bind: name or bind})

    run.__name__ = bind
    return run


def one(name: str, *, delay: float = 0.0, bind: str | None = None) -> Pipeline:
    return Pipeline.of(step(bind or name, delay=delay))


# --- branch -----------------------------------------------------------------


async def test_branch_takes_then_when_the_principal_satisfies_the_policy() -> None:
    result = await Pipeline.of(
        branch(
            when=HAS_ROLE_ADMIN,
            then=Pipeline.of(step("then_ran")),
            otherwise=Pipeline.of(step("else_ran")),
        )
    ).run(context(**{PRINCIPAL_KEY: Principal(roles=frozenset({"admin"}))}))

    assert result.get("then_ran") == "then_ran"
    assert result.get("else_ran") is None
    # The unchosen arm binds nothing, so a later step cannot see its name at all.
    assert "else_ran" not in result.values


async def test_branch_takes_else_when_the_policy_does_not_hold() -> None:
    result = await Pipeline.of(
        branch(
            when=HAS_ROLE_ADMIN,
            then=Pipeline.of(step("then_ran")),
            otherwise=Pipeline.of(step("else_ran")),
        )
    ).run(context(**{PRINCIPAL_KEY: Principal(roles=frozenset({"viewer"}))}))

    assert result.get("else_ran") == "else_ran"
    assert "then_ran" not in result.values


async def test_branch_without_an_else_binds_nothing_at_all() -> None:
    """A spec may declare no alternative; then a false predicate is a no-op, not a binding."""

    result = await Pipeline.of(branch(when=HAS_ROLE_ADMIN, then=Pipeline.of(step("then_ran")))).run(
        context(**{PRINCIPAL_KEY: Principal()})
    )

    assert result.get("then_ran") is None
    assert result.get("else_ran") is None
    assert result.get(DEPTH_KEY) is None


async def test_branch_refuses_a_context_with_no_principal() -> None:
    """Missing identity raises: defaulting would decide an authorization question."""

    with pytest.raises(PipelineError, match="needs a principal"):
        await Pipeline.of(branch(when=HAS_ROLE_ADMIN, then=Pipeline.of(step("x")))).run(context())


async def test_unauthenticated_principal_makes_is_authenticated_false() -> None:
    """Amendment 5: an app with no auth layer seeds a principal that is *not* authenticated.

    ``Principal()`` defaults ``authenticated=True``, so seeding the bare default would
    make every ``isAuthenticated()`` branch take ``then`` in an app that never
    identified the caller. The fail-closed seed is the opposite, and this pins it.
    """

    anonymous = Principal(authenticated=False)
    pipeline = Pipeline.of(
        branch(
            when=IS_AUTHENTICATED,
            then=Pipeline.of(step("then_ran")),
            otherwise=Pipeline.of(step("else_ran")),
        )
    )

    assert anonymous.authenticated is False
    result = await pipeline.run(context(**{PRINCIPAL_KEY: anonymous}))
    assert "then_ran" not in result.values
    assert result.get("else_ran") == "else_ran"


# --- parallel ---------------------------------------------------------------


async def test_parallel_never_exceeds_the_declared_cap_under_load() -> None:
    """Twelve arms, a cap of three: the peak observed overlap is three, not twelve."""

    tracker = {"now": 0, "peak": 0}

    def arm(index: int) -> Pipeline:
        async def run(current: PipelineContext) -> PipelineContext:
            tracker["now"] += 1
            tracker["peak"] = max(tracker["peak"], tracker["now"])
            try:
                await asyncio.sleep(0.02)
            finally:
                tracker["now"] -= 1
            return current.with_values(**{f"arm{index}": index})

        run.__name__ = f"arm{index}"
        return Pipeline.of(run)

    result = await Pipeline.of(parallel(branches=[arm(index) for index in range(12)])).run(
        context(**{LIMITER_KEY: ConcurrencyLimiter(3)})
    )

    assert tracker["peak"] == 3, f"observed {tracker['peak']} concurrent arms, cap was 3"
    assert [result.get(f"arm{index}") for index in range(12)] == list(range(12))


async def test_parallel_merges_in_input_order_whatever_order_the_arms_finish() -> None:
    """The first arm is the slowest, so completion order is the reverse of declaration."""

    async def delayed(bind: str, delay: float) -> Any:
        async def run(current: PipelineContext) -> PipelineContext:
            await asyncio.sleep(delay)
            return current.with_values(**{bind: bind})

        run.__name__ = bind
        return run

    arms = [
        Pipeline.of(await delayed("first", 0.06)),
        Pipeline.of(await delayed("second", 0.03)),
        Pipeline.of(await delayed("third", 0.0)),
    ]
    result = await Pipeline.of(parallel(branches=arms)).run(
        context(**{LIMITER_KEY: ConcurrencyLimiter(4)})
    )

    assert [result.get("first"), result.get("second"), result.get("third")] == [
        "first",
        "second",
        "third",
    ]


async def test_parallel_refuses_two_arms_binding_the_same_name() -> None:
    with pytest.raises(PipelineError, match="both bind 'shared'"):
        await Pipeline.of(
            parallel(
                branches=[Pipeline.of(step("shared")), Pipeline.of(step("shared", name="other"))]
            )
        ).run(context(**{LIMITER_KEY: ConcurrencyLimiter(2)}))


async def test_a_failing_arm_fails_the_whole_run() -> None:
    async def boom(current: PipelineContext) -> PipelineContext:
        raise RuntimeError("arm failed")

    boom.__name__ = "boom"

    with pytest.raises(PipelineError, match="arm failed"):
        await Pipeline.of(parallel(branches=[Pipeline.of(step("ok")), Pipeline.of(boom)])).run(
            context(**{LIMITER_KEY: ConcurrencyLimiter(2)})
        )


async def test_the_first_failing_arm_in_input_order_is_the_one_reported() -> None:
    """Two arms fail; which error surfaces follows declaration order, not timing."""

    def failing(name: str, delay: float) -> Pipeline:
        async def run(current: PipelineContext) -> PipelineContext:
            await asyncio.sleep(delay)
            raise RuntimeError(name)

        run.__name__ = name
        return Pipeline.of(run)

    with pytest.raises(PipelineError, match="first"):
        await Pipeline.of(parallel(branches=[failing("first", 0.03), failing("second", 0.0)])).run(
            context(**{LIMITER_KEY: ConcurrencyLimiter(2)})
        )


async def test_parallel_with_no_arms_is_a_no_op() -> None:
    result = await Pipeline.of(parallel(branches=[])).run(context(kept=1))
    assert result.get("kept") == 1
    assert result.get("steps") == ("_parallel",)


async def test_parallel_with_one_arm_runs_it() -> None:
    result = await Pipeline.of(parallel(branches=[Pipeline.of(step("only"))])).run(
        context(**{LIMITER_KEY: ConcurrencyLimiter(1)})
    )
    assert result.get("only") == "only"


async def test_parallel_without_a_limiter_refuses_rather_than_running_unbounded() -> None:
    with pytest.raises(PipelineError, match="no concurrency limiter"):
        await Pipeline.of(parallel(branches=[Pipeline.of(step("x"))])).run(context())


# --- the one limiter --------------------------------------------------------


async def test_a_leaf_call_inside_a_fanout_slot_does_not_deadlock_at_a_cap_of_one() -> None:
    """The limiter is shared with the gateway and tools, so a worker's body re-enters it.

    At a cap of one the worker holds the only slot; a second acquisition would wait
    for a release that only that worker could perform. Nested acquisition is a no-op
    inside a held slot, so three such workers finish in turn instead of hanging.
    """

    limit = ConcurrencyLimiter(1)

    async def leaf(current: PipelineContext) -> PipelineContext:
        async with current.require(LIMITER_KEY).run():
            await asyncio.sleep(0.01)
        return current

    leaf.__name__ = "leaf"

    pipeline = Pipeline.of(parallel(branches=[Pipeline.of(leaf) for _ in range(3)]))
    result = await asyncio.wait_for(pipeline.run(context(**{LIMITER_KEY: limit})), timeout=5)

    assert result.get(DEPTH_KEY) is None


# --- map --------------------------------------------------------------------


async def test_map_runs_the_body_once_per_item_and_binds_the_results_in_input_order() -> None:
    tracker = {"now": 0, "peak": 0}

    async def body(current: PipelineContext) -> PipelineContext:
        tracker["now"] += 1
        tracker["peak"] = max(tracker["peak"], tracker["now"])
        index = current.require(INDEX_KEY)
        try:
            # Later items finish first, so completion order is the reverse of input order.
            await asyncio.sleep(0.05 - index * 0.01)
        finally:
            tracker["now"] -= 1
        return current.with_values(doubled=current.require(ITEM_KEY) * 2)

    body.__name__ = "body"

    result = await Pipeline.of(map_step(over="numbers", as_="doubled", step=Pipeline.of(body))).run(
        context(numbers=[1, 2, 3], **{LIMITER_KEY: ConcurrencyLimiter(4)})
    )

    assert result.require("doubled") == [
        {"doubled": 2},
        {"doubled": 4},
        {"doubled": 6},
    ]
    assert tracker["peak"] == 3


async def test_map_over_an_empty_list_binds_an_empty_list() -> None:
    result = await Pipeline.of(
        map_step(over="numbers", as_="doubled", step=Pipeline.of(step("doubled")))
    ).run(context(numbers=[], **{LIMITER_KEY: ConcurrencyLimiter(2)}))

    assert result.require("doubled") == []


async def test_map_over_one_item_binds_one_result() -> None:
    result = await Pipeline.of(
        map_step(over="numbers", as_="doubled", step=Pipeline.of(step("doubled")))
    ).run(context(numbers=[7], **{LIMITER_KEY: ConcurrencyLimiter(2)}))

    assert result.require("doubled") == [{"doubled": "doubled"}]


async def test_map_does_not_leak_its_iteration_keys_to_a_sibling() -> None:
    result = await Pipeline.of(
        map_step(over="numbers", as_="out", step=Pipeline.of(step("inner"))),
        lambda current: current.with_values(**{"after": True}),
    ).run(context(numbers=[1], **{LIMITER_KEY: ConcurrencyLimiter(2)}))

    assert result.get(ITEM_KEY) is None
    assert result.get(INDEX_KEY) is None
    assert result.get(DEPTH_KEY) is None
    assert result.get("after") is True


async def test_map_refuses_a_value_that_is_not_a_list() -> None:
    with pytest.raises(PipelineError, match="needs a list, got str"):
        await Pipeline.of(map_step(over="numbers", as_="out", step=Pipeline.of(step("inner")))).run(
            context(numbers="abc", **{LIMITER_KEY: ConcurrencyLimiter(2)})
        )


# --- reduce -----------------------------------------------------------------


async def test_reduce_collects_the_per_item_results_in_input_order() -> None:
    async def summarise(current: PipelineContext) -> PipelineContext:
        await asyncio.sleep(0.03 - current.require(INDEX_KEY) * 0.01)
        return current.with_values(**{REDUCED_KEY: f"summary of {current.require(ITEM_KEY)}"})

    summarise.__name__ = "summarise"

    result = await Pipeline.of(
        reduce_step(over="tickets", as_="summaries", step=Pipeline.of(summarise))
    ).run(context(tickets=["a", "b", "c"], **{LIMITER_KEY: ConcurrencyLimiter(4)}))

    assert result.require("summaries") == [
        "summary of a",
        "summary of b",
        "summary of c",
    ]


async def test_reduce_over_an_empty_list_binds_an_empty_list() -> None:
    result = await Pipeline.of(
        reduce_step(over="tickets", as_="summaries", step=Pipeline.of(step(REDUCED_KEY)))
    ).run(context(tickets=[], **{LIMITER_KEY: ConcurrencyLimiter(2)}))

    assert result.require("summaries") == []


async def test_reduce_refuses_a_body_that_binds_no_result() -> None:
    with pytest.raises(PipelineError, match="no 'reduced' binding for item 0"):
        await Pipeline.of(
            reduce_step(over="tickets", as_="summaries", step=Pipeline.of(step("other")))
        ).run(context(tickets=["a"], **{LIMITER_KEY: ConcurrencyLimiter(2)}))


# --- nesting ----------------------------------------------------------------


def nested(depth: int) -> Pipeline:
    inner = Pipeline.of(step("innermost"))

    async def noop(current: PipelineContext) -> PipelineContext:
        return current

    noop.__name__ = "noop"
    for _ in range(depth):
        inner = Pipeline.of(parallel(branches=[inner]))
    return inner


async def test_nesting_up_to_the_bound_runs() -> None:
    result = await nested(MAX_STEP_DEPTH).run(context(**{LIMITER_KEY: ConcurrencyLimiter(2)}))
    assert result.get("innermost") == "innermost"


async def test_nesting_past_the_bound_raises_and_names_the_limit() -> None:
    """The spec layer rejects this before generation; the runtime still refuses it."""

    with pytest.raises(PipelineError, match=f"nested deeper than {MAX_STEP_DEPTH} levels"):
        await nested(MAX_STEP_DEPTH + 1).run(context(**{LIMITER_KEY: ConcurrencyLimiter(2)}))


async def test_a_finished_composite_leaves_no_depth_behind() -> None:
    result = await nested(2).run(context(**{LIMITER_KEY: ConcurrencyLimiter(2)}))
    assert result.get(DEPTH_KEY) is None
    assert result.get("steps") == ("_parallel",)


def test_reserved_keys_are_the_six_the_family_owns() -> None:
    from aid_runtime import RESERVED_KEYS

    assert frozenset({"principal", "limiter", "item", "index", "depth", "reduced"}) == RESERVED_KEYS
    assert isinstance(RESERVED_KEYS, frozenset)


def test_the_module_docstring_names_every_reserved_key() -> None:
    """The prose and ``RESERVED_KEYS`` are the same list, so a key added to one reaches both.

    This docstring said "four", listed five and the set held six, which is the kind
    of drift a reader trusts instead of checking. Both halves are asserted: every
    member is named in backticks, and the count word agrees with the set.
    """
    import aid_runtime.control as control

    docstring = control.__doc__ or ""
    for key in control.RESERVED_KEYS:
        assert f"``{key}``" in docstring, key

    spelled = {"Three": 3, "Four": 4, "Five": 5, "Six": 6, "Seven": 7, "Eight": 8}
    claimed = re.search(r"\b(" + "|".join(spelled) + r") context keys\b", docstring)
    assert claimed is not None
    assert spelled[claimed.group(1)] == len(control.RESERVED_KEYS)


def test_max_step_depth_matches_the_spec_constant() -> None:
    """The value is emitted by the generator, so a drift must fail here rather than hide.

    `packages/spec` owns the number; the generator writes it into the app, and this
    module keeps a default for hand-written pipelines. Reading the TypeScript source
    from the Python test is what keeps the two from diverging silently.
    """

    from pathlib import Path

    source = Path(__file__).resolve().parents[3] / "packages" / "spec" / "src" / "validate.ts"
    text = source.read_text(encoding="utf-8")
    marker = "export const MAX_STEP_DEPTH = "
    start = text.index(marker) + len(marker)
    declared = int(text[start : text.index(";", start)])
    assert declared == MAX_STEP_DEPTH


def test_the_sequence_guard_refuses_a_string_even_though_it_is_a_sequence() -> None:
    """`over` naming a string would iterate characters; the guard refuses the whole value."""

    from aid_runtime.control import _items

    with pytest.raises(PipelineError, match="needs a list"):
        _items(context(text="abc"), "text", "map")
    assert _items(context(text=["abc"]), "text", "map") == ["abc"]
    assert isinstance([], Sequence)
