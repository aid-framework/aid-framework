"""The predicate evaluator and the ``assert`` metric.

The grammar and the AST belong to ``@aid-framework/ir``; what is pinned here is only the
interpreter of that AST and the metric that scores its verdict. Every "cannot be
decided" row asserts an ``EvalError`` rather than a ``False`` score, because a
predicate that silently fails closed would turn a broken spec into a red build for
the wrong reason, and a predicate that silently failed open would let it pass.
"""

from __future__ import annotations

from typing import Any

import pytest

from aid_runtime import EvalCase, EvalError, MetricResult
from aid_runtime.evals.metrics import AssertMetric, default_metrics
from aid_runtime.evals.predicate import evaluate_predicate

CASE = EvalCase(
    id="refund-1",
    input="where is my refund?",
    metadata={"severity": "low"},
)

PASSING = {
    "kind": "and",
    "left": {
        "kind": "comparison",
        "op": "!=",
        "left": {"kind": "path", "path": "prediction"},
        "right": {"kind": "string", "value": ""},
    },
    "right": {
        "kind": "call",
        "name": "contains",
        "args": [
            {"kind": "path", "path": "prediction"},
            {"kind": "string", "value": "refund"},
        ],
    },
}


def evaluate(
    node: Any,
    *,
    case: EvalCase = CASE,
    prediction: str = "your refund is on its way",
) -> bool:
    return evaluate_predicate(node, case=case, prediction=prediction)


class TestPredicatePaths:
    def test_reads_the_prediction(self) -> None:
        assert evaluate(_eq({"kind": "path", "path": "prediction"}, _str("abc")), prediction="abc")

    def test_reads_the_case_id(self) -> None:
        assert evaluate(_eq({"kind": "path", "path": "case.id"}, _str("refund-1")))

    def test_reads_declared_metadata(self) -> None:
        node = {"kind": "path", "path": "case.metadata", "name": "severity"}
        assert evaluate(_eq(node, _str("low")))

    def test_an_absent_metadata_key_raises_rather_than_reading_as_empty(self) -> None:
        # The whole reason `case.metadata.<name>` is the one dynamic lookup: a typo
        # must not look like "the case has no severity", which would decide the
        # predicate on a fact the dataset never stated.
        node = {"kind": "path", "path": "case.metadata", "name": "sevverity"}
        with pytest.raises(EvalError, match="sevverity"):
            evaluate(_eq(node, _str("low")))

    def test_an_absent_metadata_key_never_evaluates_to_false(self) -> None:
        node = {"kind": "path", "path": "case.metadata", "name": "missing"}
        with pytest.raises(EvalError):
            evaluate(_eq(node, _str("low")))

    def test_a_bare_path_is_refused_as_the_whole_expression(self) -> None:
        # The expression's type is fixed at build time, so a non-boolean here means the
        # AST and the walker disagree. Guessing is what would make the gate untrustworthy.
        with pytest.raises(EvalError, match="expected a boolean"):
            evaluate({"kind": "path", "path": "prediction"})


class TestPredicateOperators:
    def test_equality_on_strings(self) -> None:
        node = {
            "kind": "comparison",
            "op": "==",
            "left": {"kind": "path", "path": "case.id"},
            "right": {"kind": "string", "value": "refund-1"},
        }
        assert evaluate(node) is True

    def test_inequality_on_strings(self) -> None:
        node = {
            "kind": "comparison",
            "op": "!=",
            "left": {"kind": "path", "path": "case.id"},
            "right": {"kind": "string", "value": "refund-2"},
        }
        assert evaluate(node) is True

    def test_ordering_on_numbers(self) -> None:
        node = {
            "kind": "comparison",
            "op": "<",
            "left": {"kind": "number", "value": 2},
            "right": {"kind": "number", "value": 3},
        }
        assert evaluate(node) is True

    def test_ordering_on_strings_raises(self) -> None:
        # Python orders `str` by code point and JavaScript by code unit, so admitting
        # this would give the two runtimes different answers on the same spec.
        node = {
            "kind": "comparison",
            "op": "<",
            "left": {"kind": "string", "value": "a"},
            "right": {"kind": "string", "value": "b"},
        }
        with pytest.raises(EvalError):
            evaluate(node)

    def test_ordering_across_types_raises(self) -> None:
        node = {
            "kind": "comparison",
            "op": "<",
            "left": {"kind": "number", "value": 2},
            "right": {"kind": "string", "value": "3"},
        }
        with pytest.raises(EvalError):
            evaluate(node)

    def test_equality_across_types_raises(self) -> None:
        # `2 == "2"` has no answer both runtimes would agree on, so it is refused
        # rather than answered differently in each.
        node = {
            "kind": "comparison",
            "op": "==",
            "left": {"kind": "number", "value": 2},
            "right": {"kind": "string", "value": "2"},
        }
        with pytest.raises(EvalError, match="type mismatch"):
            evaluate(node)


class TestPredicateBuiltins:
    def test_contains_startswith_endswith(self) -> None:
        assert evaluate(_call("contains", "abc", "b")) is True
        assert evaluate(_call("startswith", "abc", "ab")) is True
        assert evaluate(_call("endswith", "abc", "bc")) is True

    def test_each_builtin_can_be_false(self) -> None:
        assert evaluate(_call("contains", "abc", "z")) is False
        assert evaluate(_call("startswith", "abc", "z")) is False
        assert evaluate(_call("endswith", "abc", "z")) is False

    def test_length(self) -> None:
        node = _eq(
            {"kind": "call", "name": "length", "args": [_str("abcd")]},
            {"kind": "number", "value": 4},
        )
        assert evaluate(node) is True

    def test_a_non_string_argument_raises(self) -> None:
        node = {
            "kind": "call",
            "name": "contains",
            "args": [{"kind": "number", "value": 1}, _str("1")],
        }
        with pytest.raises(EvalError):
            evaluate(node)

    def test_an_unknown_builtin_raises(self) -> None:
        node = {"kind": "call", "name": "matches", "args": [_str("a"), _str("b")]}
        with pytest.raises(EvalError):
            evaluate(node)


class TestPredicateUndecidable:
    def test_an_unknown_node_kind_raises(self) -> None:
        with pytest.raises(EvalError):
            evaluate({"kind": "lambda", "body": []})

    def test_an_unknown_path_raises(self) -> None:
        with pytest.raises(EvalError):
            evaluate({"kind": "path", "path": "case.input"})

    def test_an_invalid_node_raises(self) -> None:
        # The IR carries a parse failure as a node so it can never be mistaken for
        # "no condition"; the evaluator has to honour that by refusing it.
        with pytest.raises(EvalError):
            evaluate({"kind": "invalid", "reason": "unterminated string"})

    def test_a_non_boolean_in_a_boolean_slot_raises(self) -> None:
        node = {
            "kind": "and",
            "left": {"kind": "string", "value": "yes"},
            "right": {"kind": "boolean", "value": True},
        }
        with pytest.raises(EvalError):
            evaluate(node)


class TestBooleanLogic:
    def test_and_or_not(self) -> None:
        true_node = {"kind": "boolean", "value": True}
        false_node = {"kind": "boolean", "value": False}
        assert evaluate({"kind": "and", "left": true_node, "right": true_node}) is True
        assert evaluate({"kind": "and", "left": true_node, "right": false_node}) is False
        assert evaluate({"kind": "or", "left": false_node, "right": true_node}) is True
        assert evaluate({"kind": "not", "operand": false_node}) is True

    def test_both_sides_of_and_are_evaluated(self) -> None:
        # No short-circuit: `prediction != "" and case.metadata.typo` must raise, not
        # pass because the left side was already false.
        node = {
            "kind": "and",
            "left": {"kind": "boolean", "value": False},
            "right": {"kind": "path", "path": "case.metadata", "name": "typo"},
        }
        with pytest.raises(EvalError):
            evaluate(node)

    def test_both_sides_of_or_are_evaluated(self) -> None:
        node = {
            "kind": "or",
            "left": {"kind": "boolean", "value": True},
            "right": {"kind": "path", "path": "case.metadata", "name": "typo"},
        }
        with pytest.raises(EvalError):
            evaluate(node)


class TestAssertMetric:
    async def test_a_true_predicate_scores_one_and_names_the_metric(self) -> None:
        metric = AssertMetric(expr=PASSING, message="must mention the refund")
        result = await metric.score(CASE, "your refund is on its way")
        assert isinstance(result, MetricResult)
        assert result.metric == "assert"
        assert result.score == 1.0

    async def test_a_true_predicate_has_no_detail(self) -> None:
        metric = AssertMetric(expr=PASSING, message="must mention the refund")
        result = await metric.score(CASE, "your refund is on its way")
        assert result.passed is True
        assert result.detail == ""

    async def test_a_false_predicate_scores_zero_and_reports_the_declared_message(self) -> None:
        metric = AssertMetric(expr=PASSING, message="must mention the refund")
        result = await metric.score(CASE, "we cannot help with that")
        assert result.score == 0.0
        assert result.passed is False
        # Verbatim: the point of letting the author write the message is that a
        # failing run quotes them.
        assert result.detail == "must mention the refund"

    async def test_the_detail_is_the_message_and_not_a_rendered_expression(self) -> None:
        metric = AssertMetric(expr=PASSING, message="must mention the refund")
        result = await metric.score(CASE, "we cannot help with that")
        assert result.detail == "must mention the refund"
        assert "contains" not in result.detail

    async def test_an_undecidable_predicate_raises_instead_of_scoring_zero(self) -> None:
        metric = AssertMetric(
            expr={"kind": "path", "path": "case.metadata", "name": "missing"},
            message="unreachable",
        )
        with pytest.raises(EvalError):
            await metric.score(CASE, "anything")

    def test_the_metric_is_deterministic_and_named(self) -> None:
        metric = AssertMetric(expr=PASSING, message="m")
        assert metric.deterministic is True
        assert metric.name == "assert"

    def test_the_metric_is_not_in_the_default_set(self) -> None:
        # A default metric applies to every eval; an assertion is always authored.
        assert "assert" not in {metric.name for metric in default_metrics()}


def _str(value: str) -> dict[str, Any]:
    return {"kind": "string", "value": value}


def _eq(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    return {"kind": "comparison", "op": "==", "left": left, "right": right}


def _call(name: str, *args: str) -> dict[str, Any]:
    return {
        "kind": "comparison",
        "op": "==",
        "left": {"kind": "call", "name": name, "args": [_str(arg) for arg in args]},
        "right": {"kind": "boolean", "value": True},
    }
