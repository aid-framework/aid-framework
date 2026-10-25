"""Tool permissioning: the grant, the ``auth`` policy, and the order of the two.

Every denial here is asserted twice: once on the exception, and once on a counter
the handler increments. "Raised" alone would pass for a check that runs *after*
the body, which is the defect the layer exists to prevent.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from agent_support import ADMIN_ONLY, SEARCH_SCHEMA, build, solo, tool_def
from aid_runtime import ScriptedTurn, Tool, ToolPermissionError
from aid_runtime.agents import RunStatus

WRITER = "writer"
READER = "reader"

#: ``tool_def`` adds ``isAuthenticated()`` to a mutating entry because the IR's
#: security gate requires one. A spec that skipped the gate would have no policy
#: at all, and that is exactly what this entry reproduces.
WRITER_WITHOUT_AUTH: dict[str, Any] = {
    "id": WRITER,
    "name": WRITER,
    "description": "writer tool",
    "requiresConfirmation": False,
    "sideEffects": "write",
}

#: A policy whose builtin the evaluator does not implement: it cannot answer, and
#: "cannot answer" has to render as a denial rather than as a permit.
UNDECIDABLE: dict[str, Any] = {"kind": "call", "name": "isAdmin", "args": []}


def counting_tool(name: str) -> tuple[Tool, list[str]]:
    """A tool whose body records that it ran, so "did not run" is observable."""

    calls: list[str] = []

    def handler(query: str = "") -> str:
        calls.append(query)
        return f"{name}:{query}"

    return (
        Tool.of(name, handler, description=f"{name} tool", parameters=SEARCH_SCHEMA),
        calls,
    )


async def _run(
    document: dict[str, Any],
    tool: Tool,
    *,
    extra: Sequence[Tool] = (),
    target: str = WRITER,
) -> Any:
    harness = build(
        document,
        script=[ScriptedTurn.tool(target, {"query": "hello"}), ScriptedTurn.answer("done")],
        tools=[tool, *extra],
    )
    return await harness.runtime.run("solo", "do the thing")


# --- the grant is the agent's declared tool list ---------------------------------


async def test_an_ungranted_tool_never_runs_its_body() -> None:
    """Registered on the runtime, absent from the agent: refused, body untouched.

    The granted tool is registered too, so the refusal cannot be the build-time
    "declared but not registered" check standing in for permissioning.
    """
    tool, calls = counting_tool(WRITER)
    reader, _ = counting_tool(READER)
    document = solo(
        tool_specs=[tool_def(READER, READER), tool_def(WRITER, WRITER, side_effects="write")],
        tools=[READER],
    )

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool, extra=[reader])

    assert calls == []
    assert raised.value.tool == WRITER
    assert raised.value.agent == "solo"
    assert "does not declare it" in raised.value.reason


async def test_an_ungranted_read_only_tool_is_refused_too() -> None:
    """The grant is not a side-effect rule: nothing is callable unless declared.

    Without this case, ``_authorize``'s first step could be deleted and every
    other test in this file would still pass, because they all use mutating tools
    whose second step would deny the call for a different reason.
    """
    tool, calls = counting_tool(READER)
    document = solo(tool_specs=[tool_def(READER, READER)], tools=[])

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool, target=READER)

    assert calls == []
    assert "does not declare it" in raised.value.reason


async def test_the_grant_precedes_the_auth_policy() -> None:
    """An ungranted mutating tool is refused for the grant, not for its auth.

    Both steps would deny this call; the reason has to name the first one, or an
    operator told to "fix the auth policy" would edit a policy that is never read.
    """
    tool, calls = counting_tool(WRITER)
    document = solo(tool_specs=[tool_def(WRITER, WRITER, side_effects="write")], tools=[])

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool)

    assert calls == []
    assert "does not declare it" in raised.value.reason
    assert "auth policy" not in raised.value.reason


# --- the auth policy, evaluated at call time -------------------------------------


async def test_a_granted_tool_whose_auth_policy_holds_runs() -> None:
    """The positive control: a granted tool with a satisfied policy really executes."""
    tool, calls = counting_tool(WRITER)
    document = solo(tool_specs=[tool_def(WRITER, WRITER, side_effects="write")], tools=[WRITER])

    result = await _run(document, tool)

    assert calls == ["hello"]
    assert result.status is RunStatus.COMPLETED


async def test_an_auth_policy_that_denies_this_principal_never_runs_the_body() -> None:
    """``ADMIN_ONLY`` against a principal with no roles: denied, body untouched."""
    tool, calls = counting_tool(WRITER)
    document = solo(
        tool_specs=[tool_def(WRITER, WRITER, side_effects="write", auth=ADMIN_ONLY)],
        tools=[WRITER],
    )

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool)

    assert calls == []
    assert "denies this principal" in raised.value.reason


async def test_an_undecidable_auth_policy_is_a_denial() -> None:
    """A policy the evaluator cannot answer must not degrade into a permit."""
    tool, calls = counting_tool(WRITER)
    document = solo(
        tool_specs=[tool_def(WRITER, WRITER, side_effects="write", auth=UNDECIDABLE)],
        tools=[WRITER],
    )

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool)

    assert calls == []
    assert "could not be decided" in raised.value.reason


async def test_a_side_effecting_tool_with_no_auth_policy_is_denied_by_default() -> None:
    """The missing policy is the defect: no policy means no permit, not a permit."""
    tool, calls = counting_tool(WRITER)
    document = solo(tool_specs=[WRITER_WITHOUT_AUTH], tools=[WRITER])

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool)

    assert calls == []
    assert "declares no auth policy" in raised.value.reason


async def test_a_read_only_tool_needs_no_auth_policy() -> None:
    """Only side effects need authorization; reading is allowed by the grant alone.

    This is the boundary that keeps ``_authorize`` from denying everything: if it
    demanded an ``auth`` on every tool, this case would fail.
    """
    tool, calls = counting_tool(READER)
    document = solo(tool_specs=[tool_def(READER, READER)], tools=[READER])

    result = await _run(document, tool, target=READER)

    assert calls == ["hello"]
    assert result.status is RunStatus.COMPLETED


async def test_a_destructive_tool_is_held_to_the_same_rule_as_a_write() -> None:
    """``destructive`` is in the side-effecting set, not a separate weaker one."""
    tool, calls = counting_tool(WRITER)
    document = solo(
        tool_specs=[{**WRITER_WITHOUT_AUTH, "sideEffects": "destructive"}],
        tools=[WRITER],
    )

    with pytest.raises(ToolPermissionError) as raised:
        await _run(document, tool)

    assert calls == []
    assert "declares no auth policy" in raised.value.reason
