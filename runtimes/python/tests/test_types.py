"""The shapes that cross a boundary: pinning, usage accounting, request identity."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from aid_runtime import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    CostProfile,
    GenerationResult,
    Message,
    ModelSpec,
    PinnedModel,
    TokenUsage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)

SPEC = ModelSpec(
    name="fake-small-1",
    provider="fake",
    cost=CostProfile(input_per_1k_usd=0.15, output_per_1k_usd=0.60),
    context_window=128_000,
    max_output_tokens=4_096,
    capabilities=frozenset({Capability.TOOL_CALLING, Capability.STRUCTURED_OUTPUT}),
)


def _spec_payload(**changes: Any) -> dict[str, Any]:
    """A valid ``ModelSpec`` body with overrides, for exercising validation.

    ``model_copy`` is not used for these: it skips validation, so a test written
    against it would pass while proving nothing.
    """
    payload: dict[str, Any] = SPEC.model_dump()
    payload.update(changes)
    return payload


def test_capability_values_are_the_model_side_vocabulary() -> None:
    """A change here silently breaks the IR's capability negotiation."""
    values = {capability.value for capability in Capability}
    assert values == {"tool-calling", "structured-output", "streaming", "long-context"}
    assert str(Capability.STREAMING) == "streaming"


def test_message_factories_set_the_role() -> None:
    assert Message.system("s").role == "system"
    assert Message.user("u").role == "user"
    assert Message.assistant("a").role == "assistant"
    assert Message.user("u").content == "u"


def test_message_is_frozen_and_closed() -> None:
    message = Message.user("hello")
    with pytest.raises(ValidationError):
        message.content = "changed"
    with pytest.raises(ValidationError):
        # The stray keyword is the point: extra="forbid" must reject it.
        Message(role="user", content="hello", extra="no")  # type: ignore[call-arg]


def test_message_rejects_an_unknown_role() -> None:
    with pytest.raises(ValidationError):
        Message.model_validate({"role": "developer", "content": "hello"})


def test_cost_profile_prices_input_and_output_separately() -> None:
    profile = CostProfile(input_per_1k_usd=1.00, output_per_1k_usd=3.00)
    assert profile.cost_usd(TokenUsage(input_tokens=1_000, output_tokens=0)) == 1.0
    assert profile.cost_usd(TokenUsage(input_tokens=0, output_tokens=1_000)) == 3.0
    assert profile.cost_usd(TokenUsage(input_tokens=0, output_tokens=0)) == 0.0


def test_cost_profile_rounds_at_six_decimals() -> None:
    profile = CostProfile(input_per_1k_usd=0.333333, output_per_1k_usd=0.0)
    assert profile.cost_usd(TokenUsage(input_tokens=1, output_tokens=0)) == 0.000333


def test_cost_profile_rejects_negative_prices() -> None:
    with pytest.raises(ValidationError):
        CostProfile(input_per_1k_usd=-0.01, output_per_1k_usd=0.0)


def test_model_spec_coerces_raw_capability_strings() -> None:
    spec = ModelSpec.model_validate(_spec_payload(capabilities=["tool-calling"]))
    assert spec.capabilities == frozenset({Capability.TOOL_CALLING})


def test_model_spec_rejects_a_capability_from_another_target() -> None:
    with pytest.raises(ValidationError):
        ModelSpec.model_validate(_spec_payload(capabilities=["crewai"]))


def test_model_spec_requires_a_name_and_a_positive_window() -> None:
    with pytest.raises(ValidationError):
        ModelSpec.model_validate(_spec_payload(name=""))
    with pytest.raises(ValidationError):
        ModelSpec.model_validate(_spec_payload(context_window=0))
    with pytest.raises(ValidationError):
        ModelSpec.model_validate(_spec_payload(max_output_tokens=-1))


def test_pinned_model_supports_is_a_subset_test() -> None:
    pinned = PinnedModel(alias="small", spec=SPEC)
    assert pinned.provider == "fake"
    assert pinned.capabilities == SPEC.capabilities
    assert pinned.supports(frozenset({Capability.TOOL_CALLING}))
    assert pinned.supports(frozenset())
    assert not pinned.supports(frozenset({Capability.STREAMING}))
    assert not pinned.supports(frozenset({Capability.TOOL_CALLING, Capability.STREAMING}))


def test_token_usage_adds_and_totals() -> None:
    first = TokenUsage(input_tokens=10, output_tokens=5)
    second = TokenUsage(input_tokens=1, output_tokens=2)
    assert first.total_tokens == 15
    assert (first + second) == TokenUsage(input_tokens=11, output_tokens=7)


def test_token_usage_rejects_negative_counts() -> None:
    with pytest.raises(ValidationError):
        TokenUsage(input_tokens=-1, output_tokens=0)


def test_completion_request_prompt_shapes() -> None:
    plain = CompletionRequest.prompt("hi")
    assert plain.messages == (Message.user("hi"),)
    with_system = CompletionRequest.prompt("hi", system="be terse")
    assert with_system.messages == (Message.system("be terse"), Message.user("hi"))


def test_fingerprint_ignores_optionals_that_are_absent() -> None:
    """A fingerprint that changed on a no-op rewrite would break every cache key."""
    explicit = CompletionRequest(
        messages=(Message.user("hi"),), temperature=None, max_output_tokens=None
    )
    assert explicit.fingerprint() == CompletionRequest.prompt("hi").fingerprint()


def test_fingerprint_changes_when_output_could_change() -> None:
    base = CompletionRequest.prompt("hi").fingerprint()
    warmer = CompletionRequest(messages=(Message.user("hi"),), temperature=0.7).fingerprint()
    longer = CompletionRequest(messages=(Message.user("hi"),), max_output_tokens=64).fingerprint()
    other_text = CompletionRequest.prompt("hello").fingerprint()
    assert len({base, warmer, longer, other_text}) == 4


def test_fingerprint_is_stable_across_identical_constructions() -> None:
    first = CompletionRequest.prompt("hi").fingerprint()
    second = CompletionRequest.prompt("hi").fingerprint()
    assert first == second


def test_completion_request_rejects_an_empty_transcript() -> None:
    with pytest.raises(ValidationError):
        CompletionRequest(messages=())


def test_completion_request_bounds_temperature_and_max_tokens() -> None:
    with pytest.raises(ValidationError):
        CompletionRequest(messages=(Message.user("hi"),), temperature=2.5)
    with pytest.raises(ValidationError):
        CompletionRequest(messages=(Message.user("hi"),), max_output_tokens=0)


def test_generation_result_exposes_conveniences() -> None:
    response = CompletionResponse(
        text="ok",
        model="fake-small-1",
        provider="fake",
        usage=TokenUsage(input_tokens=3, output_tokens=1),
    )
    single = GenerationResult(response=response, alias="small", cost_usd=0.0)
    assert single.text == "ok"
    assert single.usage.output_tokens == 1
    assert not single.fell_back

    fell_back = GenerationResult(
        response=response, alias="large", cost_usd=0.0, attempts=("small", "large")
    )
    assert fell_back.fell_back


def test_completion_response_defaults_to_a_clean_stop() -> None:
    response = CompletionResponse(
        text="", model="m", provider="p", usage=TokenUsage(input_tokens=0, output_tokens=0)
    )
    assert response.finish_reason == "stop"
    assert response.tool_calls == ()


def test_tool_definition_serialises_to_the_openai_shape() -> None:
    definition = ToolDefinition(name="lookup", description="find a thing")
    payload = definition.as_openai_tool()
    assert payload["type"] == "function"
    assert payload["function"]["name"] == "lookup"
    assert payload["function"]["parameters"] == {"type": "object", "properties": {}}


def test_tool_result_from_value_is_deterministic_json() -> None:
    call = ToolCall(id="call_1", name="lookup", arguments={})
    assert ToolResult.from_value(call, {"b": 1, "a": 2}).content == '{"a": 2, "b": 1}'
    assert ToolResult.from_value(call, "already text").content == "already text"


def test_tool_result_from_error_marks_the_failure() -> None:
    call = ToolCall(id="call_1", name="lookup", arguments={})
    result = ToolResult.from_error(call, "nope")
    assert result.is_error
    assert result.content == "nope"
    assert result.call_id == "call_1"
    assert result.name == "lookup"


def test_tool_call_requires_identity() -> None:
    with pytest.raises(ValidationError):
        ToolCall(id="", name="lookup")
    with pytest.raises(ValidationError):
        ToolCall(id="call_1", name="")
