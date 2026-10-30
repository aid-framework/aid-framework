"""The PredicateExpr evaluator an ``assert`` metric runs.

The AST is data, not code: the IR parses and validates it, the generator emits it as
a plain literal, and this module walks it. There is no ``eval`` and no ``exec``
anywhere on that path, so a predicate can only ever do what this file implements --
read the prediction, the case id and one metadata key, call four total string
builtins, and compare. Anything else is a node kind this walker does not know, and
an unknown node raises rather than passing.

Raising matters more than it looks. A false assertion and an *undecidable* one are
different outcomes: ``false`` is a legitimate result the gate must see, while a
missing metadata key or a string where a number belongs means the eval itself is
misconfigured. Returning ``False`` for either would report a broken eval as a
failing candidate, and returning ``True`` would hide it, so both raise ``EvalError``.
"""

from __future__ import annotations

from typing import Any

from aid_runtime.errors import EvalError
from aid_runtime.evals.dataset import EvalCase

__all__ = ["evaluate_predicate", "type_name"]

#: A value a predicate can carry. Numbers are normalized to ``float`` so that a JSON
#: literal ``3`` and ``length(...)`` compare equal; booleans are kept apart from
#: numbers on purpose, because ``1 == true`` is false in the other runtime and a
#: grammar that answered differently in each language would be worse than no grammar.
PredicateValue = float | str | bool

_ORDERING = frozenset({"<", "<=", ">", ">="})


def type_name(value: Any) -> str:
    """The name a diagnostic uses for a value's type.

    Booleans are checked before numbers because ``bool`` subclasses ``int`` in
    Python and would otherwise be reported as a number.
    """
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def evaluate_predicate(node: Any, *, case: EvalCase, prediction: str) -> bool:
    """Evaluate ``node`` against one case and prediction, or raise if it cannot be.

    A non-boolean result is an error rather than a truthiness test: the expression's
    type is fixed at build time, so a non-boolean here means the AST and the walker
    disagree, and guessing which one is right is exactly the kind of guess that makes
    a gate untrustworthy.
    """
    value = _value(node, case=case, prediction=prediction)
    if not isinstance(value, bool):
        raise EvalError(f"predicate expected a boolean, got {type_name(value)}")
    return value


def _value(node: Any, *, case: EvalCase, prediction: str) -> PredicateValue:
    if not isinstance(node, dict):
        raise EvalError(f"predicate node must be an object, got {type(node).__name__}")
    kind = node.get("kind")
    match kind:
        case "string":
            return _literal(node, "string")
        case "number":
            return _number(node)
        case "boolean":
            return _boolean_literal(node)
        case "invalid":
            # Unreachable through a built metric -- the build drops an invalid
            # expression -- but a hand-written AST must not become a silent pass.
            raise EvalError(f"invalid predicate: {node.get('reason', 'unknown reason')}")
        case "path":
            return _path(node, case=case, prediction=prediction)
        case "call":
            return _call(node, case=case, prediction=prediction)
        case "comparison":
            return _compare(node, case=case, prediction=prediction)
        case "not":
            operand = _boolean(node, "operand", case=case, prediction=prediction)
            return not operand
        case "and":
            left = _boolean(node, "left", case=case, prediction=prediction)
            right = _boolean(node, "right", case=case, prediction=prediction)
            # Both sides are always evaluated; see the module docstring of the
            # TypeScript mirror for why short-circuiting would hide a misconfiguration.
            return left and right
        case "or":
            left = _boolean(node, "left", case=case, prediction=prediction)
            right = _boolean(node, "right", case=case, prediction=prediction)
            return left or right
    # Deliberately outside the match, so an unknown kind is a raise rather than a
    # fall-through that would return None and read as falsy.
    raise EvalError(f"unknown predicate node {kind!r}")


def _literal(node: dict[str, Any], wanted: str) -> str:
    value = node.get("value")
    if not isinstance(value, str):
        raise EvalError(f"predicate {wanted} literal must be a {wanted}, got {type_name(value)}")
    return value


def _number(node: dict[str, Any]) -> float:
    value = node.get("value")
    # ``bool`` is an ``int`` in Python, so an explicit exclusion is what keeps
    # ``True`` from arriving as the number 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvalError(f"predicate number literal must be a number, got {type_name(value)}")
    return float(value)


def _boolean_literal(node: dict[str, Any]) -> bool:
    value = node.get("value")
    if not isinstance(value, bool):
        raise EvalError(f"predicate boolean literal must be a boolean, got {type_name(value)}")
    return value


def _path(node: dict[str, Any], *, case: EvalCase, prediction: str) -> str:
    path = node.get("path")
    if path == "prediction":
        return prediction
    if path == "case.id":
        return case.id
    if path == "case.metadata":
        name = node.get("name")
        if not isinstance(name, str):
            raise EvalError("case.metadata path must name a key")
        if name not in case.metadata:
            raise EvalError(f"unbound case.metadata key '{name}'")
        return case.metadata[name]
    raise EvalError(f"unknown predicate path {path!r}")


def _call(node: dict[str, Any], *, case: EvalCase, prediction: str) -> str | float:
    name = node.get("name")
    args = node.get("args")
    if not isinstance(args, list):
        raise EvalError(f"predicate call {name!r} must carry an argument list")
    values = [_value(arg, case=case, prediction=prediction) for arg in args]
    if name == "length":
        _arity(name, values, 1)
        text = _string(name, values[0])
        return float(len(text))
    if name in {"contains", "startswith", "endswith"}:
        _arity(name, values, 2)
        text = _string(name, values[0])
        needle = _string(name, values[1])
        if name == "contains":
            return needle in text
        if name == "startswith":
            return text.startswith(needle)
        return text.endswith(needle)
    raise EvalError(f"unknown predicate builtin {name!r}")


def _arity(name: str, values: list[PredicateValue], wanted: int) -> None:
    if len(values) != wanted:
        raise EvalError(f"{name}() takes {wanted} argument(s), got {len(values)}")


def _string(name: str, value: PredicateValue) -> str:
    if not isinstance(value, str):
        raise EvalError(f"{name}() requires strings, got {type_name(value)}")
    return value


def _compare(node: dict[str, Any], *, case: EvalCase, prediction: str) -> bool:
    op = node.get("op")
    left = _value(node.get("left"), case=case, prediction=prediction)
    right = _value(node.get("right"), case=case, prediction=prediction)
    if op in _ORDERING:
        if (
            isinstance(left, bool)
            or isinstance(right, bool)
            or not isinstance(left, (int, float))
            or not isinstance(right, (int, float))
        ):
            raise EvalError(
                f"ordering comparison {op!r} requires two numbers, "
                f"got {type_name(left)} and {type_name(right)}"
            )
        if op == "<":
            return float(left) < float(right)
        if op == "<=":
            return float(left) <= float(right)
        if op == ">":
            return float(left) > float(right)
        return float(left) >= float(right)
    if op not in {"==", "!="}:
        raise EvalError(f"unknown predicate operator {op!r}")
    if type_name(left) != type_name(right):
        raise EvalError(
            f"type mismatch: cannot apply {op!r} to {type_name(left)} and {type_name(right)}"
        )
    equal = left == right
    return equal if op == "==" else not equal


def _boolean(node: dict[str, Any], key: str, *, case: EvalCase, prediction: str) -> bool:
    value = _value(node.get(key), case=case, prediction=prediction)
    if not isinstance(value, bool):
        raise EvalError(f"predicate expected a boolean, got {type_name(value)}")
    return value
