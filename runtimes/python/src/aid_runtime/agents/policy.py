"""Evaluation of the IR's ``PolicyExpr`` AST.

The grammar is the one ``packages/ir/src/policy`` parses, and the AST is plain
JSON precisely so a target does not need a second parser:

    expression := or
    or         := and ('or' and)*
    and        := comparison ('and' comparison)*
    comparison := unary (('==' | '!=' | '<' | '<=' | '>' | '>=') unary)?
    unary      := 'not' unary | primary
    primary    := 'true' | 'false' | string | number | call | '(' expression ')'
    call       := builtin '(' (operand (',' operand)*)? ')'

The builtins are the closed set ``hasRole``, ``hasScope``, ``isAuthenticated``, so
the context this evaluates against is a :class:`Principal` -- who is asking --
and not loop state such as a step counter. Anything the evaluator cannot decide
raises: for a human-in-the-loop gate, "could not decide" must never degrade into
"do not ask".
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from aid_runtime.errors import PolicyEvaluationError

__all__ = ["Principal", "evaluate_policy", "policy_source"]

_COMPARISONS = frozenset({"==", "!=", "<", "<=", ">", ">="})
_LOGICAL = frozenset({"and", "or"})


@dataclass(frozen=True, slots=True)
class Principal:
    """Who a policy is evaluated for.

    Defaults are the anonymous-but-authenticated caller an app with no auth layer
    has: ``isAuthenticated()`` is true and both role and scope sets are empty, so
    ``hasRole('admin')`` is false rather than undefined.
    """

    roles: frozenset[str] = frozenset()
    scopes: frozenset[str] = frozenset()
    authenticated: bool = True


def evaluate_policy(node: Mapping[str, Any], principal: Principal) -> bool:
    """Evaluate a parsed policy against ``principal``. Never returns "maybe"."""
    value = _evaluate(node, principal)
    if not isinstance(value, bool):
        raise PolicyEvaluationError(
            f"policy did not evaluate to a boolean, got {type(value).__name__}: "
            f"{policy_source(node)}"
        )
    return value


def policy_source(node: Mapping[str, Any]) -> str:
    """Render an AST back to source, so a trace or error can quote the policy."""
    kind = node.get("kind")
    if kind in {"string", "number", "boolean"}:
        return _literal_source(node.get("value"))
    if kind == "call":
        arguments = ", ".join(policy_source(argument) for argument in node.get("args", ()))
        return f"{node.get('name')}({arguments})"
    if kind == "comparison":
        return f"{policy_source(node['left'])} {node.get('op')} {policy_source(node['right'])}"
    if kind in _LOGICAL:
        return f"({policy_source(node['left'])} {kind} {policy_source(node['right'])})"
    if kind == "not":
        return f"not {policy_source(node['operand'])}"
    raise PolicyEvaluationError(f"unsupported policy node kind {kind!r}")


def _literal_source(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return f'"{value}"'
    return str(value)


def _evaluate(node: Mapping[str, Any], principal: Principal) -> Any:
    kind = node.get("kind")
    if kind in {"string", "number", "boolean"}:
        return node.get("value")
    if kind == "call":
        return _call(node, principal)
    if kind == "comparison":
        return _compare(node, principal)
    if kind in _LOGICAL:
        return _logic(kind, node, principal)
    if kind == "not":
        return not _as_bool(_evaluate(node["operand"], principal), node)
    raise PolicyEvaluationError(f"unsupported policy node kind {kind!r}")


def _call(node: Mapping[str, Any], principal: Principal) -> bool:
    name = node.get("name")
    arguments = [_evaluate(argument, principal) for argument in node.get("args", ())]
    if name == "isAuthenticated":
        if arguments:
            raise PolicyEvaluationError("isAuthenticated() takes no arguments")
        return principal.authenticated
    if name == "hasRole":
        return _membership(name, arguments, principal.roles)
    if name == "hasScope":
        return _membership(name, arguments, principal.scopes)
    raise PolicyEvaluationError(f"unknown policy builtin {name!r}")


def _membership(name: str, arguments: list[Any], held: frozenset[str]) -> bool:
    if len(arguments) != 1:
        raise PolicyEvaluationError(f"{name}() takes exactly one argument")
    (wanted,) = arguments
    if not isinstance(wanted, str):
        raise PolicyEvaluationError(f"{name}() argument must be a string, got {wanted!r}")
    return wanted in held


def _compare(node: Mapping[str, Any], principal: Principal) -> bool:
    operator = node.get("op")
    if operator not in _COMPARISONS:
        raise PolicyEvaluationError(f"unknown comparison operator {operator!r}")
    left = _evaluate(node["left"], principal)
    right = _evaluate(node["right"], principal)
    if operator == "==":
        return bool(left == right)
    if operator == "!=":
        return bool(left != right)
    try:
        if operator == "<":
            return bool(left < right)
        if operator == "<=":
            return bool(left <= right)
        if operator == ">":
            return bool(left > right)
        return bool(left >= right)
    except TypeError as exc:
        raise PolicyEvaluationError(
            f"cannot compare {type(left).__name__} {operator} {type(right).__name__}: "
            f"{policy_source(node)}"
        ) from exc


def _logic(kind: str, node: Mapping[str, Any], principal: Principal) -> bool:
    left = _as_bool(_evaluate(node["left"], principal), node)
    # ``and``/``or`` short-circuit on the left operand's truth value.
    if kind == "and" and not left:
        return False
    if kind == "or" and left:
        return True
    return _as_bool(_evaluate(node["right"], principal), node)


def _as_bool(value: Any, node: Mapping[str, Any]) -> bool:
    if not isinstance(value, bool):
        raise PolicyEvaluationError(
            f"expected a boolean operand in {policy_source(node)}, got {value!r}"
        )
    return value
