"""Tool definitions and the executor that runs them.

A tool handler is business logic -- in a generated app it lives under
``business/`` and is never overwritten by regeneration. The executor only owns
argument validation, dispatch, and turning a handler crash into a tool error the
model can read.

Validation covers the JSON Schema subset the model is actually given (object
``required`` and ``properties`` with scalar/array types). It is deliberately not a
general JSON Schema implementation: a fuller validator belongs to the schema
library, not to a runtime that must stay small.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

from aid_runtime.errors import ToolArgumentError, ToolExecutionError, ToolNotFoundError
from aid_runtime.types import ToolCall, ToolDefinition, ToolResult

__all__ = ["Tool", "ToolExecutor"]

#: A tool handler: sync or async, taking keyword arguments, returning anything JSON-ish.
Handler = Callable[..., Any]

_SCALAR_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list, tuple),
    "null": (type(None),),
}


class Tool:
    """A definition plus the callable that implements it."""

    __slots__ = ("definition", "handler")

    def __init__(self, definition: ToolDefinition, handler: Handler) -> None:
        self.definition = definition
        self.handler = handler

    @property
    def name(self) -> str:
        return self.definition.name

    @classmethod
    def of(
        cls,
        name: str,
        handler: Handler,
        *,
        description: str = "",
        parameters: Mapping[str, Any] | None = None,
    ) -> Tool:
        """Declare a tool, inferring the parameter schema from the handler signature.

        Inference covers names and required-ness only. Types must be declared
        explicitly: guessing a type from a default is how a schema quietly
        disagrees with the implementation.

        An explicit ``parameters`` schema is checked against the handler at
        registration, so a generated tool wired to the wrong function fails at
        import time rather than the first time a model calls it.
        """
        declared = parameters if parameters is not None else _infer_parameters(handler)
        _check_declaration(name, handler, declared)
        return cls(
            ToolDefinition(
                name=name,
                description=description or (inspect.getdoc(handler) or ""),
                parameters=dict(declared),
            ),
            handler,
        )


class ToolExecutor:
    """Validates and dispatches tool calls."""

    def __init__(self, tools: Iterable[Tool] = (), *, strict: bool = False) -> None:
        self._tools: dict[str, Tool] = {}
        self._strict = strict
        for tool in tools:
            self.register(tool)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def definition(self, name: str) -> ToolDefinition:
        return self._get(name).definition

    def definitions(self) -> tuple[ToolDefinition, ...]:
        return tuple(self._tools[name].definition for name in self.names)

    async def execute(self, call: ToolCall) -> ToolResult:
        """Run a tool call, never raising for a bad argument or a handler crash.

        Both are *tool* errors: the model composed the call, so the model is the
        party that can fix it, and it needs the message rather than a stack trace
        to do so. A call naming an unregistered tool is a programming error and
        does raise -- no prompt repair makes a missing tool exist.

        A ``strict`` executor is for development, where a handler traceback is
        what you actually want: it raises
        :class:`~aid_runtime.errors.ToolExecutionError` instead of returning an
        error the model would silently try to talk its way around.
        """
        tool = self._get(call.name)
        problems = validate_arguments(tool.definition.parameters, call.arguments)
        if problems:
            return ToolResult.from_error(
                call, f"invalid arguments: {'; '.join(problems)} -- {json.dumps(call.arguments)}"
            )
        try:
            value = await _invoke(tool.handler, call.arguments)
        except Exception as exc:
            if self._strict:
                raise ToolExecutionError(
                    f"tool {call.name!r} raised {type(exc).__name__}: {exc}"
                ) from exc
            return ToolResult.from_error(call, f"{type(exc).__name__}: {exc}")
        return ToolResult.from_value(call, value)

    async def execute_all(self, calls: Iterable[ToolCall]) -> tuple[ToolResult, ...]:
        """Run calls in order, each independent of the others' outcome."""
        return tuple([await self.execute(call) for call in calls])

    def _get(self, name: str) -> Tool:
        try:
            return self._tools[name]
        except KeyError:
            raise ToolNotFoundError(name, self.names) from None


def validate_arguments(schema: Mapping[str, Any], arguments: Mapping[str, Any]) -> list[str]:
    """Return every problem with ``arguments`` against ``schema``, in one pass."""
    problems: list[str] = []

    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        return problems

    for name in schema.get("required") or []:
        if name not in arguments:
            problems.append(f"missing required argument {name!r}")

    if schema.get("additionalProperties") is False:
        for name in arguments:
            if name not in properties:
                problems.append(f"unexpected argument {name!r}")

    for name, value in arguments.items():
        spec = properties.get(name)
        if not isinstance(spec, Mapping):
            continue
        problems.extend(_check_value(name, value, spec))

    return problems


def _check_value(name: str, value: Any, spec: Mapping[str, Any]) -> list[str]:
    declared = spec.get("type")
    if declared is None or value is None:
        return []

    allowed = [declared] if isinstance(declared, str) else list(declared)
    if any(_matches(value, kind) for kind in allowed):
        return []

    return [f"argument {name!r} must be {_join(allowed)}, got {type(value).__name__}"]


def _matches(value: Any, kind: str) -> bool:
    expected = _SCALAR_TYPES.get(kind)
    if expected is None:
        # An unknown type name cannot be checked, so it cannot be reported as a
        # mismatch either; rejecting here would fail every call.
        return True
    if kind in {"integer", "number"} and isinstance(value, bool):
        # bool is a subclass of int in Python; JSON Schema does not consider
        # `true` a valid number.
        return False
    return isinstance(value, expected)


def _join(kinds: list[str]) -> str:
    return " or ".join(kinds)


def _check_declaration(name: str, handler: Handler, parameters: Mapping[str, Any]) -> None:
    """Reject a schema that requires an argument the handler cannot receive."""
    if _accepts_keywords(handler):
        return
    accepted = set(inspect.signature(handler).parameters)
    required = parameters.get("required")
    if not isinstance(required, Sequence) or isinstance(required, str):
        return
    undeclared = sorted(str(item) for item in required if str(item) not in accepted)
    if undeclared:
        raise ToolArgumentError(
            name,
            [f"required argument(s) {', '.join(undeclared)} not accepted by the handler"],
        )


def _infer_parameters(handler: Handler) -> dict[str, Any]:
    signature = inspect.signature(handler)
    names = [
        name
        for name, parameter in signature.parameters.items()
        if parameter.kind in {parameter.POSITIONAL_OR_KEYWORD, parameter.KEYWORD_ONLY}
    ]
    return {"type": "object", "properties": {name: {} for name in names}, "required": names}


def _accepts_keywords(handler: Handler) -> bool:
    try:
        signature = inspect.signature(handler)
    except (TypeError, ValueError):
        return False
    return any(
        parameter.kind is parameter.VAR_KEYWORD for parameter in signature.parameters.values()
    )


async def _invoke(handler: Handler, arguments: Mapping[str, Any]) -> Any:
    """Call a sync or async handler with ``arguments`` as keyword arguments."""
    kwargs = dict(arguments) if _accepts_keywords(handler) else _bind(handler, arguments)
    result = handler(**kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def _bind(handler: Handler, arguments: Mapping[str, Any]) -> dict[str, Any]:
    """Drop arguments the handler does not name, so an over-supplying model is tolerated."""
    accepted = set(inspect.signature(handler).parameters)
    return {key: value for key, value in arguments.items() if key in accepted}
