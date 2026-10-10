"""Structured output: parse, repair, retry.

The contract under test is not "the model returns valid JSON" -- that is a hope.
It is "an invalid response is fed back with the reason, and the caller eventually
gets a typed object or a loud failure".
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from aid_runtime import (
    StructuredOutputError,
    build_agent,
    format_problems,
    parse_structured,
    repair_prompt,
    run_structured,
)


class Verdict(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    label: str
    score: float


def test_parse_structured_reads_plain_json() -> None:
    assert parse_structured('{"label": "ok", "score": 0.5}', Verdict) == Verdict(
        label="ok", score=0.5
    )


def test_parse_structured_unwraps_a_json_fence() -> None:
    fenced = '```json\n{"label": "ok", "score": 1.0}\n```'
    assert parse_structured(fenced, Verdict).label == "ok"


def test_parse_structured_unwraps_a_bare_fence() -> None:
    assert parse_structured('```\n{"label": "ok", "score": 0}\n```', Verdict).label == "ok"


def test_parse_structured_rejects_empty_output() -> None:
    with pytest.raises(StructuredOutputError, match="model returned empty output for Verdict"):
        parse_structured("   \n  ", Verdict)


def test_parse_structured_reports_every_problem_at_once() -> None:
    with pytest.raises(StructuredOutputError) as info:
        parse_structured('{"score": "high", "unexpected": 1}', Verdict)

    assert info.value.attempts == 1
    assert any(problem.startswith("label:") for problem in info.value.problems)
    assert any(problem.startswith("score:") for problem in info.value.problems)
    assert any(problem.startswith("unexpected:") for problem in info.value.problems)


def test_the_error_message_carries_the_problems() -> None:
    with pytest.raises(StructuredOutputError, match=r"after 1 attempt\(s\): label: Field required"):
        parse_structured('{"score": 0.5}', Verdict)


def test_format_problems_flattens_a_validation_error_to_location_and_message() -> None:
    with pytest.raises(ValidationError) as info:
        Verdict.model_validate({"score": "high"})

    problems = format_problems(info.value)
    assert any(problem.startswith("label:") for problem in problems)
    assert any(problem.startswith("score:") for problem in problems)


def test_repair_prompt_attaches_the_problems_it_was_given() -> None:
    prompt = repair_prompt(
        StructuredOutputError("boom", attempts=1, problems=["label: Field required"])
    )
    assert "could not be parsed" in prompt
    assert "label: Field required" in prompt


def test_repair_prompt_falls_back_to_the_error_when_there_are_no_problems() -> None:
    assert "empty output" in repair_prompt(StructuredOutputError("empty output", attempts=1))


async def test_run_structured_repairs_after_a_bad_first_answer() -> None:
    responses = iter(["not json at all", '{"label": "ok", "score": 1.0}'])
    prompts: list[str] = []

    async def call(prompt: str) -> str:
        prompts.append(prompt)
        return next(responses)

    assert await run_structured(call, Verdict, "Extract", retries=1) == Verdict(
        label="ok", score=1.0
    )
    assert len(prompts) == 2
    assert prompts[0] == "Extract"
    assert "could not be parsed" in prompts[1]
    assert prompts[1].startswith("Extract")


async def test_run_structured_succeeds_on_the_first_attempt_without_repairing() -> None:
    prompts: list[str] = []

    async def call(prompt: str) -> str:
        prompts.append(prompt)
        return '{"label": "ok", "score": 0.0}'

    await run_structured(call, Verdict, "Extract", retries=2)
    assert prompts == ["Extract"]


async def test_run_structured_gives_up_after_the_retry_budget_is_spent() -> None:
    calls = 0

    async def call(prompt: str) -> str:
        nonlocal calls
        calls += 1
        return "still not json"

    with pytest.raises(StructuredOutputError, match=r"not produced from 3 attempt\(s\)") as info:
        await run_structured(call, Verdict, "Extract", retries=2)

    assert calls == 3
    assert info.value.attempts == 3


async def test_run_structured_makes_exactly_one_call_when_retries_are_disabled() -> None:
    calls = 0

    async def call(prompt: str) -> str:
        nonlocal calls
        calls += 1
        return "nope"

    with pytest.raises(StructuredOutputError, match=r"after 1 attempt\(s\)"):
        await run_structured(call, Verdict, "Extract", retries=0)
    assert calls == 1


async def test_run_structured_refuses_a_negative_retry_budget() -> None:
    async def call(prompt: str) -> str:
        return "{}"

    with pytest.raises(ValueError, match="retries must not be negative"):
        await run_structured(call, Verdict, "Extract", retries=-1)


async def test_build_agent_produces_a_typed_object_through_pydantic_ai() -> None:
    """Pydantic AI is a real dependency, so it is exercised rather than asserted about."""

    def respond(messages: Sequence[ModelMessage], info: AgentInfo) -> ModelResponse:
        output = info.output_tools[0].name
        return ModelResponse(
            parts=[ToolCallPart(tool_name=output, args={"label": "ok", "score": 0.9})]
        )

    agent = build_agent(FunctionModel(respond), Verdict, system_prompt="be terse")
    result = await agent.run("judge this")

    assert result.output == Verdict(label="ok", score=0.9)


async def test_build_agent_works_without_a_system_prompt() -> None:
    def respond(messages: Sequence[ModelMessage], info: AgentInfo) -> ModelResponse:
        output = info.output_tools[0].name
        return ModelResponse(
            parts=[ToolCallPart(tool_name=output, args={"label": "bare", "score": 0})]
        )

    agent = build_agent(FunctionModel(respond), Verdict)
    result = await agent.run("judge this")

    assert result.output.label == "bare"
