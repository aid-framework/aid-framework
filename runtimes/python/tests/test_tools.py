"""The tool executor: validate, dispatch, and fail in the model's direction.

The rule under test is about *who* can fix a failure. Bad arguments and a crashed
handler are the model's problem, so they come back as readable tool errors. A
missing tool is the application's problem, so it raises.
"""

from __future__ import annotations

from typing import Any

import pytest

from aid_runtime import (
    Tool,
    ToolArgumentError,
    ToolCall,
    ToolDefinition,
    ToolExecutionError,
    ToolExecutor,
    ToolNotFoundError,
)

CITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"city": {"type": "string"}, "days": {"type": "integer"}},
    "required": ["city"],
    "additionalProperties": False,
}


def _weather(city: str, days: int = 1) -> dict[str, Any]:
    """Report the weather."""
    return {"city": city, "days": days}


def _weather_tool() -> Tool:
    return Tool.of("weather", _weather, parameters=CITY_SCHEMA)


def _executor(*tools: Tool, strict: bool = False) -> ToolExecutor:
    return ToolExecutor(tools, strict=strict)


def _call(name: str = "weather", **arguments: Any) -> ToolCall:
    return ToolCall(id=f"call-{name}", name=name, arguments=arguments)


def test_a_tool_definition_needs_a_name_and_forbids_unknown_fields() -> None:
    assert ToolDefinition(name="t").description == ""
    with pytest.raises(ValueError, match="String should have at least 1 character"):
        ToolDefinition(name="")


def test_a_tool_dumps_to_the_openai_tool_shape() -> None:
    definition = ToolDefinition(name="weather", description="Report the weather.")
    assert definition.as_openai_tool() == {
        "type": "function",
        "function": {
            "name": "weather",
            "description": "Report the weather.",
            "parameters": {"type": "object", "properties": {}},
        },
    }


def test_tool_of_infers_parameters_from_the_handler_signature() -> None:
    def handler(city: str, days: int) -> str:
        return city

    tool = Tool.of("weather", handler)
    assert tool.definition.parameters == {
        "type": "object",
        "properties": {"city": {}, "days": {}},
        "required": ["city", "days"],
    }


def test_tool_of_defaults_the_description_to_the_docstring() -> None:
    assert _weather_tool().definition.description == "Report the weather."


def test_an_explicit_description_wins_over_the_docstring() -> None:
    tool = Tool.of("weather", _weather, description="explicit", parameters=CITY_SCHEMA)
    assert tool.definition.description == "explicit"


def test_tool_of_rejects_a_schema_the_handler_cannot_satisfy() -> None:
    def handler(city: str) -> str:
        return city

    schema = {
        "type": "object",
        "properties": {"city": {}, "days": {}},
        "required": ["city", "days"],
    }
    with pytest.raises(ToolArgumentError, match="not accepted by the handler"):
        Tool.of("weather", handler, parameters=schema)


def test_a_keyword_handler_is_never_rejected_for_its_schema() -> None:
    def handler(**kwargs: Any) -> str:
        return ",".join(sorted(kwargs))

    tool = Tool.of("t", handler, parameters={"type": "object", "properties": {}, "required": ["x"]})
    assert tool.name == "t"


def test_definitions_are_listed_in_name_order() -> None:
    def handler() -> str:
        return "ok"

    executor = _executor(Tool.of("b", handler), Tool.of("a", handler))
    assert executor.names == ("a", "b")
    assert [definition.name for definition in executor.definitions()] == ["a", "b"]
    assert executor.definition("a").name == "a"


def test_an_unregistered_tool_raises_rather_than_returning_an_error() -> None:
    executor = _executor(_weather_tool())
    with pytest.raises(ToolNotFoundError, match=r"unknown tool 'absent'; registered: weather"):
        executor.definition("absent")


async def test_executing_an_unregistered_tool_raises() -> None:
    executor = _executor(_weather_tool())
    with pytest.raises(ToolNotFoundError, match="unknown tool 'absent'"):
        await executor.execute(_call("absent", city="Lima"))


async def test_a_registered_tool_returns_its_value_as_json() -> None:
    result = await _executor(_weather_tool()).execute(_call(city="Lima", days=3))

    assert result.is_error is False
    assert result.name == "weather"
    assert result.call_id == "call-weather"
    assert result.content == '{"city": "Lima", "days": 3}'


async def test_a_string_result_is_passed_through_unquoted() -> None:
    def handler(city: str) -> str:
        return f"sunny in {city}"

    tool = Tool.of("weather", handler, parameters=CITY_SCHEMA)
    assert (await _executor(tool).execute(_call(city="Lima"))).content == "sunny in Lima"


async def test_an_async_handler_is_awaited() -> None:
    async def handler(city: str) -> str:
        return f"async {city}"

    tool = Tool.of("weather", handler, parameters=CITY_SCHEMA)
    assert (await _executor(tool).execute(_call(city="Lima"))).content == "async Lima"


async def test_a_missing_required_argument_is_a_tool_error() -> None:
    result = await _executor(_weather_tool()).execute(_call())

    assert result.is_error is True
    assert "missing required argument 'city'" in result.content


async def test_an_unexpected_argument_is_a_tool_error_when_additional_properties_is_false() -> None:
    result = await _executor(_weather_tool()).execute(_call(city="Lima", mood="happy"))

    assert result.is_error is True
    assert "unexpected argument 'mood'" in result.content


async def test_a_scalar_type_mismatch_is_a_tool_error() -> None:
    result = await _executor(_weather_tool()).execute(_call(city="Lima", days="three"))

    assert result.is_error is True
    assert "argument 'days' must be integer, got str" in result.content


async def test_a_boolean_is_not_accepted_where_a_number_is_declared() -> None:
    result = await _executor(_weather_tool()).execute(_call(city="Lima", days=True))

    assert result.is_error is True
    assert "must be integer, got bool" in result.content


async def test_a_none_value_is_not_type_checked() -> None:
    result = await _executor(_weather_tool()).execute(_call(city="Lima", days=None))

    assert result.is_error is False


async def test_every_argument_problem_is_reported_in_one_pass() -> None:
    result = await _executor(_weather_tool()).execute(_call(mood="happy", days="three"))

    assert "missing required argument 'city'" in result.content
    assert "unexpected argument 'mood'" in result.content
    assert "argument 'days' must be integer, got str" in result.content


async def test_an_unknown_declared_type_cannot_be_checked_and_so_is_accepted() -> None:
    def handler(city: Any) -> str:
        return str(city)

    tool = Tool.of(
        "weather",
        handler,
        parameters={"type": "object", "properties": {"city": {"type": "postcode"}}},
    )
    assert (await _executor(tool).execute(_call(city="Lima"))).is_error is False


async def test_a_declared_union_type_accepts_either_member() -> None:
    def handler(days: Any) -> str:
        return str(days)

    tool = Tool.of(
        "weather",
        handler,
        parameters={"type": "object", "properties": {"days": {"type": ["integer", "string"]}}},
    )
    executor = _executor(tool)
    assert (await executor.execute(_call(days=2))).is_error is False
    assert (await executor.execute(_call(days="two"))).is_error is False


async def test_a_handler_crash_becomes_a_readable_tool_error() -> None:
    def handler(city: str) -> str:
        raise ValueError("no weather service")

    tool = Tool.of("weather", handler, parameters=CITY_SCHEMA)
    result = await _executor(tool).execute(_call(city="Lima"))

    assert result.is_error is True
    assert result.content == "ValueError: no weather service"


async def test_a_strict_executor_raises_instead_of_hiding_a_handler_crash() -> None:
    def handler(city: str) -> str:
        raise ValueError("no weather service")

    tool = Tool.of("weather", handler, parameters=CITY_SCHEMA)
    executor = _executor(tool, strict=True)

    with pytest.raises(ToolExecutionError, match="tool 'weather' raised ValueError") as info:
        await executor.execute(_call(city="Lima"))
    assert isinstance(info.value.__cause__, ValueError)


async def test_a_strict_executor_still_returns_argument_errors_to_the_model() -> None:
    result = await _executor(_weather_tool(), strict=True).execute(_call())

    assert result.is_error is True


async def test_an_undeclared_argument_is_dropped_for_a_named_handler() -> None:
    def handler(city: str) -> str:
        return city

    tool = Tool.of(
        "weather",
        handler,
        parameters={"type": "object", "properties": {"city": {}, "extra": {}}},
    )
    result = await _executor(tool).execute(_call(city="Lima", extra="ignored"))

    assert result.is_error is False
    assert result.content == "Lima"


async def test_extra_arguments_reach_a_keyword_handler() -> None:
    def handler(**kwargs: Any) -> str:
        return ",".join(sorted(kwargs))

    tool = Tool.of("weather", handler, parameters={"type": "object", "properties": {}})
    result = await _executor(tool).execute(_call(city="Lima", extra="kept"))

    assert result.content == "city,extra"


async def test_execute_all_runs_every_call_in_order_even_when_one_fails() -> None:
    executor = _executor(_weather_tool())
    results = await executor.execute_all([_call(city="Lima"), _call(), _call(city="Cusco")])

    assert [result.name for result in results] == ["weather", "weather", "weather"]
    assert [result.is_error for result in results] == [False, True, False]
    assert [result.call_id for result in results] == ["call-weather"] * 3


def test_registering_a_later_tool_replaces_an_earlier_one() -> None:
    def first() -> str:
        return "first"

    def second() -> str:
        return "second"

    executor = _executor(Tool.of("t", first))
    executor.register(Tool.of("t", second))

    assert executor.names == ("t",)
