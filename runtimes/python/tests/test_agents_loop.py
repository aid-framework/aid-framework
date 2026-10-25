"""The native loop: stop conditions, replay, and the two control edges.

Every assertion here is about something the loop *decides*: which step ended the
run, whose transcript contains whose messages, and how many model calls a bound
actually allowed.
"""

from __future__ import annotations

from typing import Any

import pytest

import aid_runtime.agents.memory as memory_module
from agent_support import (
    ADMIN_ONLY,
    CHEAP_COST,
    agent_def,
    build,
    document,
    model_def,
    prompt_def,
    recording_tool,
    solo,
    tool_def,
)
from aid_runtime import (
    AgentTransferCycleError,
    CapabilityMismatchError,
    ConfigurationError,
    DeepAgentsUnavailableError,
    FakeProvider,
    ScriptedTurn,
)
from aid_runtime.agents import IMPLEMENTED_MEMORY_KINDS, Principal, RunStatus, StepKind
from aid_runtime.agents.engine import DEEPAGENTS_PIN, installed_deepagents_version

SOLO_PROMPT = "You are a helpful assistant."
FRONT_PROMPT = "You triage requests and move them to the right agent."
WORKER_PROMPT = "You answer one question and stop."


def _pair(*, edge: str) -> dict[str, Any]:
    """Two agents, one control edge from ``front`` to ``worker``."""
    control: dict[str, Any] = {edge: ["worker"]}
    return document(
        models=[model_def("cheap")],
        prompts=[prompt_def("front", FRONT_PROMPT), prompt_def("worker", WORKER_PROMPT)],
        agents=[
            agent_def("front", prompt="front", **control),
            agent_def("worker", prompt="worker"),
        ],
    )


async def test_a_turn_without_tool_calls_ends_the_run() -> None:
    harness = build(solo(prompt=SOLO_PROMPT), script=[ScriptedTurn.answer("42")])

    result = await harness.runtime.run("solo", "what is the answer?")

    assert result.status is RunStatus.COMPLETED
    assert result.answer == "42"
    assert [(step.index, step.kind) for step in result.steps] == [(1, StepKind.ANSWER)]
    assert result.cost_usd > 0
    assert result.total_tokens > 0
    assert harness.aliases_charged() == ("cheap",)
    assert len(harness.provider.calls) == 1


async def test_tool_observations_are_replayed_into_the_next_request() -> None:
    tool, recorder = recording_tool()
    doc = solo(prompt=SOLO_PROMPT, tool_specs=[tool_def("t1", "search")], tools=["t1"])
    harness = build(
        doc,
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "paris"}), ScriptedTurn.answer("sunny")],
    )

    result = await harness.runtime.run("solo", "weather in paris?")

    assert result.answer == "sunny"
    assert [step.kind for step in result.steps] == [StepKind.TOOLS, StepKind.ANSWER]
    assert result.steps[0].tool_names == ("search",)
    assert recorder.queries == ["paris"]
    replay = harness.provider.calls[1].messages
    assistant = next(message for message in replay if message.tool_calls)
    observation = next(message for message in replay if message.role == "tool")
    assert assistant.tool_calls[0].name == "search"
    assert assistant.tool_calls[0].arguments == {"query": "paris"}
    assert observation.tool_call_id == assistant.tool_calls[0].id
    assert observation.content == "sunny:paris"


async def test_max_steps_stops_the_loop_after_exactly_max_steps_calls() -> None:
    tool, recorder = recording_tool()
    doc = solo(
        prompt=SOLO_PROMPT,
        tool_specs=[tool_def("t1", "search")],
        tools=["t1"],
        max_steps=2,
    )
    script = [ScriptedTurn.tool("search", {"query": str(index)}) for index in range(5)]
    harness = build(doc, tools=[tool], script=script)

    result = await harness.runtime.run("solo", "go")

    assert result.status is RunStatus.MAX_STEPS
    assert result.answer == ""
    assert len(result.steps) == 2
    # The bound is on model calls, so a loop that overshoots by one shows up
    # here and not only in the step records it happened to keep.
    assert len(harness.provider.calls) == 2
    assert recorder.calls == 2


async def test_a_hallucinated_tool_name_is_an_observation_not_a_crash() -> None:
    tool, recorder = recording_tool()
    doc = solo(prompt=SOLO_PROMPT, tool_specs=[tool_def("t1", "search")], tools=["t1"])
    harness = build(
        doc,
        tools=[tool],
        script=[
            ScriptedTurn.tool("lookup_by_telepathy", {"query": "x"}),
            ScriptedTurn.answer("let me answer directly"),
        ],
    )

    result = await harness.runtime.run("solo", "go")

    assert result.completed
    assert recorder.calls == 0
    observation = next(
        message for message in harness.provider.calls[1].messages if message.role == "tool"
    )
    assert observation.name == "lookup_by_telepathy"
    assert "lookup_by_telepathy" in observation.content


async def test_an_unregistered_declared_tool_is_refused_when_the_runtime_is_built() -> None:
    doc = solo(prompt=SOLO_PROMPT, tool_specs=[tool_def("t1", "search")], tools=["t1"])

    with pytest.raises(ConfigurationError, match="not registered on this runtime"):
        build(doc)


async def test_a_tool_may_not_shadow_a_control_tool() -> None:
    doc = document(
        models=[model_def("cheap")],
        prompts=[prompt_def("front", FRONT_PROMPT), prompt_def("worker", WORKER_PROMPT)],
        tools=[tool_def("t1", "transfer_to_worker")],
        agents=[
            agent_def("front", prompt="front", tools=["t1"], handoffs=["worker"]),
            agent_def("worker", prompt="worker"),
        ],
    )
    # Registered, so the refusal cannot be "this tool does not exist": the name
    # itself is the problem.
    shadow, _ = recording_tool("transfer_to_worker")

    with pytest.raises(ConfigurationError, match="named like a control tool"):
        build(doc, tools=[shadow])


async def test_transfer_moves_control_and_the_target_produces_the_answer() -> None:
    harness = build(
        _pair(edge="handoffs"),
        script=[
            ScriptedTurn.tool("transfer_to_worker", {"message": "the customer is angry"}),
            ScriptedTurn.answer("refund issued"),
        ],
    )

    result = await harness.runtime.run("front", "my order is late")

    assert result.completed
    # The target holds the conversation and its answer is the run's answer.
    assert result.agent_id == "worker"
    assert result.answer == "refund issued"
    assert result.path == ("front", "worker")
    assert [(step.agent_id, step.kind, step.target) for step in result.steps] == [
        ("front", StepKind.TRANSFER, "worker"),
        ("worker", StepKind.ANSWER, None),
    ]
    # Two model calls only: the caller never gets another turn.
    assert len(harness.provider.calls) == 2
    inherited = harness.provider.calls[1].messages
    assert inherited[0].content == WORKER_PROMPT
    assert [message.content for message in inherited[1:]] == [
        "my order is late",
        "the customer is angry",
    ]


async def test_delegate_returns_control_and_the_caller_produces_the_answer() -> None:
    harness = build(
        _pair(edge="delegates"),
        script=[
            ScriptedTurn.tool("delegate_to_worker", {"message": "look up order 42"}),
            ScriptedTurn.answer("order 42 is in transit"),
            ScriptedTurn.answer("It ships tomorrow."),
        ],
    )

    result = await harness.runtime.run("front", "where is my order?")

    assert result.completed
    # The caller holds the conversation and its answer is the run's answer; the
    # delegate's text is an observation, not the answer.
    assert result.agent_id == "front"
    assert result.answer == "It ships tomorrow."
    # ``path`` is the *control* path. Transfer moves control and appends to it;
    # delegation only lends it, so the run still looks like a solo run here.
    assert result.path == ("front",)
    assert [(step.agent_id, step.kind) for step in result.steps] == [
        ("front", StepKind.DELEGATE),
        ("worker", StepKind.ANSWER),
        ("front", StepKind.ANSWER),
    ]
    delegated = harness.provider.calls[1].messages
    assert [message.role for message in delegated] == ["system", "user"]
    assert delegated[0].content == WORKER_PROMPT
    assert delegated[1].content == "look up order 42"
    returned = harness.provider.calls[2].messages
    observation = next(message for message in returned if message.role == "tool")
    assert observation.content == "order 42 is in transit"
    assert "where is my order?" in [message.content for message in returned]


async def test_the_same_target_answers_for_itself_under_transfer_only() -> None:
    """One variable -- the edge -- decides who owns the answer."""
    transfer = build(
        _pair(edge="handoffs"),
        script=[
            ScriptedTurn.tool("transfer_to_worker", {"message": "x"}),
            ScriptedTurn.answer("from the worker"),
        ],
    )
    delegated = build(
        _pair(edge="delegates"),
        script=[
            ScriptedTurn.tool("delegate_to_worker", {"message": "x"}),
            ScriptedTurn.answer("from the worker"),
            ScriptedTurn.answer("from the caller"),
        ],
    )

    transferred = await transfer.runtime.run("front", "go")
    returned = await delegated.runtime.run("front", "go")

    assert (transferred.agent_id, transferred.answer) == ("worker", "from the worker")
    assert (returned.agent_id, returned.answer) == ("front", "from the caller")


async def test_a_control_call_must_be_the_only_call_in_its_step() -> None:
    doc = document(
        models=[model_def("cheap")],
        prompts=[prompt_def("front", FRONT_PROMPT), prompt_def("worker", WORKER_PROMPT)],
        tools=[tool_def("t1", "search")],
        agents=[
            agent_def("front", prompt="front", tools=["t1"], handoffs=["worker"]),
            agent_def("worker", prompt="worker"),
        ],
    )
    tool, _ = recording_tool()
    harness = build(
        doc,
        tools=[tool],
        script=[
            ScriptedTurn.tools(("transfer_to_worker", {"message": "x"}), ("search", {"query": "y"}))
        ],
    )

    with pytest.raises(ConfigurationError, match="only call in its step"):
        await harness.runtime.run("front", "go")


async def test_an_undeclared_control_target_is_refused() -> None:
    harness = build(
        solo(prompt=SOLO_PROMPT),
        script=[
            ScriptedTurn.tool("transfer_to_ghost", {"message": "x"}),
            ScriptedTurn.answer("y"),
        ],
    )

    with pytest.raises(ConfigurationError, match="does not"):
        await harness.runtime.run("solo", "go")


async def test_a_transfer_cycle_is_refused_with_the_path_it_took() -> None:
    doc = document(
        models=[model_def("cheap")],
        prompts=[prompt_def("a", FRONT_PROMPT), prompt_def("b", WORKER_PROMPT)],
        agents=[
            agent_def("a", prompt="a", handoffs=["b"]),
            agent_def("b", prompt="b", handoffs=["a"]),
        ],
    )
    harness = build(
        doc,
        script=[
            ScriptedTurn.tool("transfer_to_b", {"message": "first"}),
            ScriptedTurn.tool("transfer_to_a", {"message": "back"}),
        ],
    )

    with pytest.raises(AgentTransferCycleError) as caught:
        await harness.runtime.run("a", "go")

    assert caught.value.path == ("a", "b", "a")
    assert str(caught.value) == "transfer cycle: a -> b -> a"


async def test_a_declared_fallback_that_cannot_tool_call_is_refused() -> None:
    doc = document(
        models=[
            model_def("primary", cost=CHEAP_COST, fallbacks=["backup"]),
            model_def("backup", cost=CHEAP_COST, capabilities=()),
        ],
        prompts=[prompt_def("main", SOLO_PROMPT)],
        tools=[tool_def("t1", "search")],
        agents=[agent_def("solo", model="primary", tools=["t1"])],
    )
    tool, _ = recording_tool()
    provider = FakeProvider(name="fake", fail_with=["primary exploded"])
    harness = build(doc, tools=[tool], provider=provider)

    with pytest.raises(CapabilityMismatchError):
        await harness.runtime.run("solo", "go")


async def test_the_deepagents_engine_never_falls_back_to_the_native_loop() -> None:
    """Absent the pinned extra the engine fails closed; it is never quietly native.

    Which backend actually runs is asserted in ``test_agents_deep_agents``, where the
    harness can be observed from the inside. What this test pins is the seam's
    contract for every caller: a ``deepagents`` agent either runs under Deep Agents or
    raises, and the native loop never absorbs the request.
    """
    harness = build(
        solo(prompt=SOLO_PROMPT, engine="deepagents", engine_version=DEEPAGENTS_PIN),
        script=[ScriptedTurn.answer("x")],
    )

    if installed_deepagents_version() is None:
        with pytest.raises(DeepAgentsUnavailableError, match="deepagents"):
            await harness.runtime.run("solo", "go")
    else:
        result = await harness.runtime.run("solo", "go")
        assert result.completed
        assert harness.gateway.ledger.cost_usd > 0


async def test_a_hitl_policy_is_evaluated_against_the_principal() -> None:
    """The policy decides who is asked; the loop decides only when to ask."""
    doc = solo(
        prompt=SOLO_PROMPT,
        hitl={"when": ADMIN_ONLY, "channel": "ops"},
        tool_specs=[tool_def("t1", "search")],
        tools=["t1"],
    )
    tool, recorder = recording_tool()
    harness = build(
        doc,
        tools=[tool],
        script=[
            ScriptedTurn.tool("search", {"query": "one"}),
            ScriptedTurn.answer("done"),
            ScriptedTurn.tool("search", {"query": "two"}),
            ScriptedTurn.answer("done"),
        ],
    )

    unprivileged = await harness.runtime.run("solo", "go", principal=Principal())
    assert unprivileged.completed
    assert recorder.calls == 1

    privileged = await harness.runtime.run(
        "solo", "go", principal=Principal(roles=frozenset({"admin"}))
    )
    assert privileged.status is RunStatus.PAUSED
    assert privileged.approval is not None
    assert privileged.approval.channel == "ops"
    assert recorder.calls == 1


def test_memory_implements_exactly_the_ratified_set() -> None:
    """D5: in-process kinds, plus exactly one store-backed adapter."""
    assert IMPLEMENTED_MEMORY_KINDS == ("buffer", "window")


def test_memory_has_exactly_one_store_backed_adapter() -> None:
    """A third adapter has to be a decision, not an accident.

    D5 rules out a plugin zoo on the store axis, so this counts the adapters
    rather than trusting the docstring that says there is only one.
    """
    adapters = sorted(
        name
        for name, value in vars(memory_module).items()
        if isinstance(value, type)
        and value is not memory_module.MemoryStore
        and issubclass(value, memory_module.MemoryStore)
    )

    assert adapters == ["FileMemoryStore", "InProcessMemoryStore"]
