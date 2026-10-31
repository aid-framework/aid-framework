"""The leaf step factories: read, call, ask, and project.

Each factory here is a thin wrapper over a primitive the generated code already calls,
so the tests are about the parts that are *not* the primitive: what gets bound, under
which name, in which shape, and what happens when the primitive fails. Those are the
places a wrapper silently disagrees with the emitted step -- a bound-but-wrong name, an
error swallowed into a value, a rendered prompt that never reached the gateway -- so
almost every assertion below fails if the wrapper is mutated rather than if the runtime
changed.

``emit_step`` gets the most attention because it is the one constructor with no emitted
counterpart yet: the generated route builds its event object itself, so nothing in
codegen would catch this surface drifting away from ``responsePlan``. The pipeline test
at the bottom pins the two properties a naive implementation gets wrong: the projection
keeps the order it was declared in, and the step **binds without stopping**, because a
stopping step's value is discarded and a later step still runs in the emitted route.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from pydantic import BaseModel

from aid_runtime import (
    CompletionRequest,
    CostProfile,
    FakeProvider,
    ModelGateway,
    ModelSpec,
    Pipeline,
    PipelineContext,
    PipelineError,
    PromptRegistry,
    PromptTemplate,
    Tool,
    ToolCall,
    ToolExecutor,
    ToolResult,
)
from aid_runtime.retrieval import (
    FakeDeterministicEmbedder,
    InMemoryVectorStore,
    RetrievalResult,
    Retriever,
)
from aid_runtime.steps import (
    EMITTED_KEY,
    emit_step,
    generate_step,
    resolve_source,
    retrieve_step,
    tool_step,
)
from retrieval_support import binding, document

SMALL_ALIAS = "small"


class _Answer(BaseModel):
    """A declared structured output, as a spec's named type would be."""

    verdict: str


class _Ticket(BaseModel):
    """A struct a response field is read off, standing in for a request event."""

    subject: str
    body: str


def _context(**values: object) -> PipelineContext:
    return PipelineContext(values=dict(values))


def _gateway(responder: Callable[[CompletionRequest, int], str] | None = None) -> ModelGateway:
    return ModelGateway(
        {"fake": FakeProvider(responder=responder, accuracy=1.0, seed=0)},
        {
            SMALL_ALIAS: ModelSpec(
                name="fake-small-1",
                provider="fake",
                cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
                context_window=128_000,
                max_output_tokens=4_096,
            )
        },
    )


def _prompts(template: str = "Hi {name}") -> PromptRegistry:
    return PromptRegistry([PromptTemplate(name="greet", version="1", template=template)])


# --- emit -------------------------------------------------------------------


def test_a_source_without_an_attribute_is_the_whole_binding() -> None:
    assert resolve_source(_context(ticket="T-1"), "ticket") == "T-1"


def test_a_source_with_an_attribute_reads_that_field() -> None:
    context = _context(ticket=_Ticket(subject="Refund", body="Where is it?"))
    assert resolve_source(context, "ticket.subject") == "Refund"


def test_a_mapping_source_reads_its_key() -> None:
    # A context seeded from JSON carries a mapping, not a model, and both are "a
    # struct" to this resolver -- the conformance corpus feeds exactly this shape.
    context = _context(ticket={"subject": "Refund", "body": "Where is it?"})
    assert resolve_source(context, "ticket.subject") == "Refund"


def test_a_mapping_without_the_key_says_which_field_is_missing() -> None:
    with pytest.raises(PipelineError, match=r"'ticket\.status'.*'status'"):
        resolve_source(_context(ticket={"subject": "Refund"}), "ticket.status")


def test_a_missing_binding_says_which_key_is_missing() -> None:
    with pytest.raises(PipelineError, match="pipeline context has no 'ticket'"):
        resolve_source(_context(), "ticket.subject")


def test_a_missing_attribute_says_which_source_and_field() -> None:
    # Distinct from a missing binding on purpose: "the field is not there" and "the
    # binding is not there" are different mistakes, and a response that silently
    # drops one of them is worse than one that fails loudly.
    context = _context(ticket=_Ticket(subject="Refund", body="Where is it?"))
    with pytest.raises(PipelineError, match=r"'ticket\.status'.*'status'"):
        resolve_source(context, "ticket.status")


def test_more_than_one_attribute_below_a_binding_is_refused() -> None:
    context = _context(ticket=_Ticket(subject="Refund", body="Where is it?"))
    with pytest.raises(PipelineError, match="more than one attribute"):
        resolve_source(context, "ticket.subject.text")


async def test_emit_projects_the_declared_fields_in_the_declared_order() -> None:
    context = _context(ticket=_Ticket(subject="Refund", body="Where is it?"))
    step = emit_step({"subject": "ticket.subject", "body": "ticket.body"})

    payload = (await step(context)).require(EMITTED_KEY)

    assert list(payload) == ["subject", "body"]
    assert payload == {"subject": "Refund", "body": "Where is it?"}


async def test_emit_binds_under_the_key_it_was_given() -> None:
    context = _context(ticket="T-1")
    step = emit_step({"id": "ticket"}, key="event")

    after = await step(context)

    assert after.require("event") == {"id": "T-1"}
    assert after.get(EMITTED_KEY) is None


async def test_emit_binds_and_lets_the_pipeline_continue() -> None:
    # Stopping would lose the payload: both runtimes return the *pre-step* context
    # when a step stops, so a stopping emit could not bind anything. A generated
    # route does not stop at its emit either -- it runs every step and only then
    # builds the response object.
    context = _context(ticket="T-1")

    async def _later(seen: PipelineContext) -> PipelineContext:
        return seen.with_values(after=True)

    after = await Pipeline.of(emit_step({"id": "ticket"}, name="emit"), _later).run(context)

    assert after.require(EMITTED_KEY) == {"id": "T-1"}
    assert after.require("after") is True


# --- retrieve ---------------------------------------------------------------


async def _retriever(*texts: str) -> Retriever:
    retriever = Retriever(
        binding(top_k=2), embedder=FakeDeterministicEmbedder(), store=InMemoryVectorStore()
    )
    await retriever.ingest([document(f"{index}.md", text) for index, text in enumerate(texts)])
    return retriever


async def test_retrieve_binds_the_result_of_the_real_retriever() -> None:
    retriever = await _retriever("Reset the password from the settings page.")
    step = retrieve_step(retriever, binding="passages", query="how do I reset my password")

    after = await step(_context())

    found = after.require("passages")
    assert isinstance(found, RetrievalResult)
    # The query is the one the step was given, not the binding's default: a wrapper
    # that dropped its argument would still return results.
    assert found.query == "how do I reset my password"
    assert [item.chunk.doc_id for item in found.items] == ["0.md"]


async def test_retrieve_narrows_to_top_k() -> None:
    retriever = await _retriever("Reset the password from settings.", "Contact support by email.")
    narrowed = retrieve_step(retriever, binding="passages", query="password", top_k=1)
    ceiling = retrieve_step(retriever, binding="passages", query="password")

    # The binding's own ceiling is 2, so only top_k can bring this down to one. A
    # wrapper that ignored top_k would leave both calls at the ceiling.
    assert len((await narrowed(_context())).require("passages").items) == 1
    assert len((await ceiling(_context())).require("passages").items) == 2


# --- tool -------------------------------------------------------------------


def _weather(city: str, days: int = 1) -> dict[str, object]:
    """Report the weather."""
    return {"city": city, "days": days}


def _explode(city: str) -> dict[str, object]:
    """Fail."""
    raise RuntimeError("upstream is down")


CITY_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {"city": {"type": "string"}, "days": {"type": "integer"}},
    "required": ["city"],
    "additionalProperties": False,
}


async def test_tool_binds_the_parsed_content() -> None:
    tools = ToolExecutor([Tool.of("weather", _weather, parameters=CITY_SCHEMA)])
    step = tool_step(tools, binding="forecast", tool="weather", arguments={"city": "Paris"})

    after = await step(_context())

    assert after.require("forecast") == {"city": "Paris", "days": 1}


async def test_tool_parses_content_into_a_declared_output_type() -> None:
    class _Forecast(BaseModel):
        city: str
        days: int

    tools = ToolExecutor([Tool.of("weather", _weather, parameters=CITY_SCHEMA)])
    step = tool_step(
        tools, binding="forecast", tool="weather", arguments={"city": "Paris"}, output=_Forecast
    )

    forecast = (await step(_context())).require("forecast")

    assert isinstance(forecast, _Forecast)
    assert forecast.city == "Paris"


async def test_tool_raises_rather_than_binding_an_error_outcome() -> None:
    tools = ToolExecutor([Tool.of("explode", _explode, parameters=CITY_SCHEMA)])
    step = tool_step(tools, binding="forecast", tool="explode", arguments={"city": "Paris"})

    with pytest.raises(PipelineError, match="tool explode failed: RuntimeError: upstream is down"):
        await step(_context())


async def test_tool_names_the_binding_as_the_call_id() -> None:
    class _Recording(ToolExecutor):
        """A real executor that keeps the call, so the id is observable."""

        def __init__(self, tools: list[Tool]) -> None:
            super().__init__(tools)
            self.seen: list[ToolCall] = []

        async def execute(self, call: ToolCall) -> ToolResult:
            self.seen.append(call)
            return await super().execute(call)

    tools = _Recording([Tool.of("weather", _weather, parameters=CITY_SCHEMA)])
    step = tool_step(tools, binding="forecast", tool="weather", arguments={"city": "Paris"})

    await step(_context())

    assert [call.id for call in tools.seen] == ["forecast"]
    assert [call.name for call in tools.seen] == ["weather"]
    assert [call.arguments for call in tools.seen] == [{"city": "Paris"}]


# --- generate ---------------------------------------------------------------


async def test_generate_renders_the_prompt_and_binds_the_answer() -> None:
    provider = FakeProvider(answers={"Hi Ada": "hello Ada"}, accuracy=1.0, seed=0)
    gateway = ModelGateway(
        {"fake": provider},
        {
            SMALL_ALIAS: ModelSpec(
                name="fake-small-1",
                provider="fake",
                cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
                context_window=128_000,
                max_output_tokens=4_096,
            )
        },
    )
    step = generate_step(
        gateway,
        _prompts(),
        binding="greeting",
        prompt="greet",
        model=SMALL_ALIAS,
        values={"name": "Ada"},
    )

    after = await step(_context())

    assert after.require("greeting") == "hello Ada"
    # Interpolation belongs to the registry; a wrapper that passed the raw template
    # through would send "{name}" and the answer map would not have matched.
    assert provider.calls[0].messages[-1].content == "Hi Ada"


async def test_generate_binds_a_structured_answer() -> None:
    gateway = _gateway(responder=lambda request, turn: '{"verdict": "accept"}')
    step = generate_step(
        gateway,
        _prompts(),
        binding="decision",
        prompt="greet",
        model=SMALL_ALIAS,
        values={"name": "Ada"},
        structured=_Answer,
    )

    decision = (await step(_context())).require("decision")

    assert isinstance(decision, _Answer)
    assert decision.verdict == "accept"


async def test_generate_repairs_a_malformed_structured_answer() -> None:
    calls: list[str] = []

    def _responder(request: object, turn: int) -> str:
        calls.append("call")
        return "not json" if turn == 0 else '{"verdict": "accept"}'

    gateway = _gateway(responder=_responder)
    step = generate_step(
        gateway,
        _prompts(),
        binding="decision",
        prompt="greet",
        model=SMALL_ALIAS,
        values={"name": "Ada"},
        structured=_Answer,
    )

    decision = (await step(_context())).require("decision")

    assert decision.verdict == "accept"
    # A wrapper that let the parse error escape, or one that re-rendered between
    # attempts, would not reach exactly two calls.
    assert len(calls) == 2
