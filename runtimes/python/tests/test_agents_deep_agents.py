"""L4: the Deep Agents backend, and the gateway adapter that keeps it honest.

Two things are being pinned here, and they are different in kind.

The first is *selection*: an agent names its engine, native stays the default, and
every way of asking for a backend this runtime cannot honour -- an unknown name, a
declared transfer, a pin that does not match the release in the environment, a
release that is not installed -- fails closed with a named error rather than
silently running as something else.

The second is *continuity*. Deep Agents calls a LangChain chat model, so the only
way the budget, fallback, cost ledger and spans keep applying is for that model to
be our own adapter over :class:`ModelGateway`. That is not a claim a unit test can
carry: the three ``inside the harness`` tests below drive the whole runtime through
``create_deep_agent`` and assert the guarantee still holds at that depth. Without
them the adapter could be perfect and unreachable.

The module is skipped when the optional extra is absent, which is the state a
``pip install -e .[dev]`` environment is in. The ``python`` CI job installs the
extra, so the gates always execute this file.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer

from agent_support import (
    agent_def,
    build,
    document,
    guardrail_def,
    model_def,
    prompt_def,
    recording_tool,
    solo,
    tool_def,
)
from aid_runtime import (
    ATTRIBUTES,
    AgentHandoffUnsupportedError,
    BudgetExceededError,
    ConfigurationError,
    DeepAgentsMaxStepsError,
    DeepAgentsUnavailableError,
    DeepAgentsVersionMismatchError,
    GuardrailBlockedError,
    ScriptedTurn,
    StepKind,
)
from aid_runtime.agents.chat_model import GatewayChatModel
from aid_runtime.agents.engine import (
    DEEPAGENTS,
    DEEPAGENTS_PIN,
    installed_deepagents_version,
)
from aid_runtime.agents.state import RunStatus

pytestmark = pytest.mark.skipif(
    installed_deepagents_version() is None,
    reason="the deepagents extra is not installed: aid-framework-python[deepagents]",
)

PROMPT = "Answer in one sentence."
QUESTION = "How long does delivery take?"
PIN = DEEPAGENTS_PIN


def _deep(**agent_fields: Any) -> dict[str, Any]:
    """A one-agent document running on the pinned backend."""
    agent_fields.setdefault("engine_version", PIN)
    return solo(prompt=PROMPT, engine=DEEPAGENTS, **agent_fields)


def _tracer() -> tuple[Tracer, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("aid-runtime-tests"), exporter


# --- the engine seam ------------------------------------------------------------------


async def test_native_remains_the_default_engine() -> None:
    """A document that names no engine is a native document, and still runs."""
    harness = build(solo(prompt=PROMPT), script=[ScriptedTurn.answer("two days")])

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert result.answer == "two days"
    assert result.path == ("solo",)
    assert len(harness.provider.calls) == 1


async def test_the_installed_release_is_the_pinned_one() -> None:
    """The pin is a measurement, not a guess: it has to match the environment.

    This is the test that fails when the extra is bumped without moving the pin,
    which is the failure mode the single authoritative constant exists to prevent.
    """
    assert installed_deepagents_version() == PIN


async def test_an_unknown_engine_is_refused_by_name() -> None:
    harness = build(solo(prompt=PROMPT, engine="langgraph"))

    with pytest.raises(ConfigurationError, match="langgraph"):
        await harness.runtime.run("solo", QUESTION)

    assert harness.provider.calls == []


async def test_a_declared_handoff_fails_closed_instead_of_degrading() -> None:
    """Transfer has no primitive in this backend, so it is refused, never improvised.

    The alternative -- letting the agent run and dropping the handoff -- is the
    silent capability loss this contract forbids: the graph would answer as the
    caller and no one would learn that the transfer never happened.
    """
    doc = document(
        models=[model_def("cheap")],
        prompts=[prompt_def("main", PROMPT)],
        agents=[
            agent_def("caller", engine=DEEPAGENTS, engine_version=PIN, handoffs=["target"]),
            agent_def("target"),
        ],
    )

    with pytest.raises(AgentHandoffUnsupportedError, match="native-only"):
        await build(doc).runtime.run("caller", QUESTION)


async def test_a_declared_delegate_is_not_mistaken_for_a_handoff() -> None:
    """Delegation *is* supported, so the refusal above must be specific to transfer."""
    doc = document(
        models=[model_def("cheap")],
        prompts=[prompt_def("main", PROMPT)],
        agents=[
            agent_def("caller", engine=DEEPAGENTS, engine_version=PIN, delegates=["helper"]),
            agent_def("helper"),
        ],
    )
    harness = build(
        doc,
        script=[ScriptedTurn.tool("task", {"description": "summarise the order"})],
    )

    result = await harness.runtime.run("caller", QUESTION)

    assert result.completed


# --- the pinning rule, in both directions ---------------------------------------------


async def test_the_declared_pin_matches_and_the_run_proceeds() -> None:
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")])

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert result.answer == "two days"


@pytest.mark.parametrize("declared", ["0.7.31", "0.7.33", "", "0.7"])
async def test_a_pin_that_differs_from_the_runtime_fails_closed(declared: str) -> None:
    """Both directions, and the empty pin an ungated document could carry."""
    harness = build(_deep(engine_version=declared), script=[ScriptedTurn.answer("two days")])

    with pytest.raises(DeepAgentsVersionMismatchError, match=PIN.replace(".", r"\.")):
        await harness.runtime.run("solo", QUESTION)

    # Refused before the first model call, so a mismatch costs nothing.
    assert harness.provider.calls == []


def test_the_optional_extra_installs_exactly_the_pinned_release() -> None:
    """One authoritative pin, and the extra that installs it may not drift from it."""
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"

    assert f'deepagents = ["deepagents=={DEEPAGENTS_PIN}"]' in pyproject.read_text(encoding="utf-8")


async def test_a_missing_extra_fails_closed_rather_than_importing_lazily(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The check reads installed metadata, so "not installed" is answerable.

    Importing ``deepagents`` to find out would raise ``ImportError`` deep inside a
    provider call instead, which reads as a crash rather than as a configuration
    answer. The installer is what makes this reachable.
    """
    monkeypatch.setattr("aid_runtime.agents.engine.installed_deepagents_version", lambda: None)
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")])

    with pytest.raises(DeepAgentsUnavailableError, match="deepagents"):
        await harness.runtime.run("solo", QUESTION)


# --- P9.3: the adapter is exercised by the harness, not only by a unit test ------------


async def test_every_model_call_inside_the_harness_reaches_the_gateway() -> None:
    """The premise of the three tests below: nothing bypasses the adapter."""
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")])

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert len(harness.provider.calls) == 1
    # The ledger is the gateway's, so a written cost means the gateway did the call.
    assert result.cost_usd > 0.0
    assert result.total_tokens > 0
    assert [step.alias for step in result.steps] == ["cheap"]


async def test_fallback_still_happens_inside_the_harness() -> None:
    """The primary alias fails, the gateway steps to the fallback, the run continues.

    Under the harness this can only work if the adapter passes ``fallbacks`` through
    to ``ModelGateway.generate``. Calling the provider directly would fail the run.
    """
    provider_failure = "upstream 503"
    doc = document(
        models=[
            model_def("strong", fallbacks=["cheap"]),
            model_def("cheap"),
        ],
        prompts=[prompt_def("main", PROMPT)],
        agents=[agent_def("solo", model="strong", engine=DEEPAGENTS, engine_version=PIN)],
    )
    from aid_runtime.providers.fake import FakeProvider

    provider = FakeProvider(
        name="fake", fail_with=(provider_failure,), script=[ScriptedTurn.answer("two days")]
    )
    harness = build(doc, provider=provider)

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert result.answer == "two days"
    # Two attempts: the failed dear one and the cheap one that answered.
    assert len(provider.calls) == 2
    assert harness.aliases_charged() == ("cheap",)
    assert [step.alias for step in result.steps] == ["cheap"]


async def test_a_budget_breach_still_stops_the_harness() -> None:
    """A ceiling is enforced inside the harness, before the call goes out.

    This is the defect class the whole project exists to prevent: without the
    adapter the budget would stop applying the moment the agent ran under Deep
    Agents, and the run would be billed while nobody was watching.
    """
    harness = build(
        _deep(max_cost_budget=1e-9, on_budget_exhausted="fail"),
        script=[ScriptedTurn.answer("two days")],
    )

    with pytest.raises(BudgetExceededError):
        await harness.runtime.run("solo", QUESTION)

    assert harness.provider.calls == []
    assert harness.aliases_charged() == ()


async def test_model_spans_are_still_emitted_inside_the_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Our OTel spans, not the harness's optional tracing, and emitted by the gateway."""
    tracer, exporter = _tracer()
    # The gateway resolves its tracer late, through ``get_tracer``, so a run under this
    # engine must still find one. Patching *behind* that function rather than in front of
    # it keeps our resolution step in the path under test: with the whole factory stubbed
    # out, a ``get_tracer`` that silently returned a no-op tracer would still pass.
    monkeypatch.setattr("aid_runtime.tracing.trace.get_tracer", lambda name: tracer)
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")], tracer=tracer)

    await harness.runtime.run("solo", QUESTION)

    chat = [span for span in exporter.get_finished_spans() if span.name.startswith("chat ")]
    assert len(chat) == 1
    attributes = dict(chat[0].attributes or {})
    assert attributes[ATTRIBUTES["alias"]] == "cheap"
    cost = attributes[ATTRIBUTES["cost_usd"]]
    tokens = attributes[ATTRIBUTES["input_tokens"]]
    assert isinstance(cost, float)
    assert cost > 0.0
    assert isinstance(tokens, int)
    assert tokens > 0

    (agent_span,) = [
        span for span in exporter.get_finished_spans() if span.name == "invoke_agent solo"
    ]
    engine_attributes = dict(agent_span.attributes or {})
    assert engine_attributes[ATTRIBUTES["agent_engine"]] == DEEPAGENTS
    assert engine_attributes[ATTRIBUTES["agent_status"]] == "completed"


# --- mapping: what each AID concept became --------------------------------------------


async def test_a_tool_call_is_executed_by_our_executor_and_recorded() -> None:
    tool, recorder = recording_tool()
    harness = build(
        _deep(tool_specs=[tool_def("t1", "search")], tools=["t1"]),
        tools=[tool],
        script=[
            ScriptedTurn.tool("search", {"query": "delivery"}),
            ScriptedTurn.answer("two days"),
        ],
    )

    result = await harness.runtime.run("solo", QUESTION)

    assert result.completed
    assert recorder.queries == ["delivery"]
    assert [step.kind for step in result.steps] == [StepKind.TOOLS, StepKind.ANSWER]
    assert result.steps[0].tool_names == ("search",)


async def test_the_allow_list_keeps_the_bundled_tools_out_of_reach() -> None:
    """Filesystem and shell tools are not enabled, and not because nobody asked.

    Every tool the harness bundles arrives through ``bind_tools``, so filtering
    there is the one funnel that covers them all -- including the ones a future
    release adds after this code was written.
    """
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")])
    model = GatewayChatModel(
        gateway=harness.gateway,
        alias="cheap",
        allowed_tools=frozenset({"search"}),
    )
    bundled = [
        {"name": "search", "description": "", "parameters": {}},
        {"name": "ls", "description": "", "parameters": {}},
        {"name": "read_file", "description": "", "parameters": {}},
        {"name": "write_file", "description": "", "parameters": {}},
        {"name": "execute", "description": "", "parameters": {}},
        {"name": "task", "description": "", "parameters": {}},
    ]

    bound = model.bind_tools(bundled)

    assert [definition.name for definition in bound.bound_tools] == ["search"]
    # The original is untouched: binding is what the harness does per call, and a
    # mutated adapter would leak one agent's grant into the next agent's turn.
    assert model.bound_tools == ()


async def test_a_tool_call_guardrail_block_stops_the_harness() -> None:
    tool, recorder = recording_tool()
    harness = build(
        _deep(
            tool_specs=[tool_def("t1", "search")],
            tools=["t1"],
            guardrail_specs=[
                guardrail_def("g-tool", stages=["tool-call"], policies=["secret-scan"])
            ],
        ),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "the key is AKIAIOSFODNN7EXAMPLE"})],
    )

    with pytest.raises(GuardrailBlockedError, match="g-tool"):
        await harness.runtime.run("solo", QUESTION)

    # The credential never reached the tool body.
    assert recorder.calls == 0


async def test_maxsteps_exhaustion_reports_the_same_outcome_as_the_native_loop() -> None:
    """``maxSteps`` becomes a counted ceiling, not the harness's own soft limit.

    The harness's model-call limiter answers with a synthetic message and reports
    success, which would turn an exhausted run into a plausible-looking answer. The
    adapter counts instead, and the outcome is the native loop's own.
    """
    native = build(
        solo(
            prompt=PROMPT,
            max_steps=2,
            tool_specs=[tool_def("t1", "search")],
            tools=["t1"],
        ),
        tools=[recording_tool()[0]],
        script=[ScriptedTurn.tool("search", {"query": "a"})] * 8,
    )
    native_result = await native.runtime.run("solo", QUESTION)

    tool, _ = recording_tool()
    deep = build(
        _deep(max_steps=2, tool_specs=[tool_def("t1", "search")], tools=["t1"]),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "a"})] * 8,
    )
    deep_result = await deep.runtime.run("solo", QUESTION)

    assert native_result.status is RunStatus.MAX_STEPS
    assert deep_result.status is RunStatus.MAX_STEPS
    assert deep_result.status == native_result.status


async def test_the_adapter_refuses_a_call_past_maxsteps_itself() -> None:
    """The counter is the adapter's, so it is assertable without a graph."""
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")])
    model = GatewayChatModel(gateway=harness.gateway, alias="cheap", max_calls=1)
    from langchain_core.messages import HumanMessage

    await model.ainvoke([HumanMessage(content=QUESTION)])

    with pytest.raises(DeepAgentsMaxStepsError, match="maxSteps 1"):
        await model.ainvoke([HumanMessage(content=QUESTION)])


async def test_hitl_pauses_before_the_tool_and_approval_executes_it() -> None:
    tool, recorder = recording_tool("deploy")
    harness = build(
        _deep(
            tool_specs=[tool_def("t1", "deploy", requires_confirmation=True)],
            tools=["t1"],
        ),
        tools=[tool],
        script=[ScriptedTurn.tool("deploy", {"query": "prod"})],
    )

    paused = await harness.runtime.run("solo", QUESTION)

    assert paused.status is RunStatus.PAUSED
    assert paused.checkpoint is not None
    assert [call.name for call in paused.checkpoint.calls] == ["deploy"]
    # The tool has not run: a pause is a question, not a decision.
    assert recorder.calls == 0

    resumed = await harness.runtime.resume(paused.checkpoint, "approve")

    assert resumed.completed
    assert recorder.queries == ["prod"]


async def test_a_rejected_tool_call_never_runs() -> None:
    tool, recorder = recording_tool("deploy")
    harness = build(
        _deep(
            tool_specs=[tool_def("t1", "deploy", requires_confirmation=True)],
            tools=["t1"],
        ),
        tools=[tool],
        script=[
            ScriptedTurn.tool("deploy", {"query": "prod"}),
            ScriptedTurn.answer("understood"),
        ],
    )
    paused = await harness.runtime.run("solo", QUESTION)
    assert paused.checkpoint is not None

    resumed = await harness.runtime.resume(paused.checkpoint, "reject")

    assert recorder.calls == 0
    assert resumed.completed


async def test_the_engine_does_not_expose_streaming() -> None:
    """A half-supported streaming path would be worse than none: no span, no ledger."""
    harness = build(_deep(), script=[ScriptedTurn.answer("two days")])
    model = GatewayChatModel(gateway=harness.gateway, alias="cheap")

    with pytest.raises(Exception, match="streaming is not supported"):
        model._astream([])


# --- determinism ----------------------------------------------------------------------


async def test_the_same_transcript_twice_is_byte_equal() -> None:
    """No clock, no network, no random identifier in anything the caller sees."""

    async def once() -> str:
        tool, _ = recording_tool()
        harness = build(
            _deep(tool_specs=[tool_def("t1", "search")], tools=["t1"]),
            tools=[tool],
            script=[
                ScriptedTurn.tool("search", {"query": "delivery"}),
                ScriptedTurn.answer("two days"),
            ],
        )
        return (await harness.runtime.run("solo", QUESTION)).model_dump_json()

    assert await once() == await once()
