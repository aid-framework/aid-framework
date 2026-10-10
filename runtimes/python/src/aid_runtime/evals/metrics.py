"""Eval metrics.

A metric turns ``(case, prediction)`` into a score in ``[0, 1]``. Each metric
declares whether it is *deterministic*, and the gate uses that flag to refuse to
be built on a metric that calls a model. This is the enforcement point for a
Phase 0 decision: implement ``llm-judge``, never make CI depend on it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import EvalError
from aid_runtime.evals.dataset import EvalCase
from aid_runtime.structured import run_structured

__all__ = [
    "ExactMatch",
    "JsonSchemaValid",
    "JudgeVerdict",
    "LlmJudge",
    "Metric",
    "MetricResult",
    "NormalizedContains",
    "default_metrics",
    "metric_names",
    "normalize",
]

_WHITESPACE = re.compile(r"\s+")


class MetricResult(BaseModel):
    """One metric's verdict on one prediction."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: str
    score: float = Field(ge=0.0, le=1.0)
    passed: bool
    detail: str = ""


@runtime_checkable
class Metric(Protocol):
    """Scores a single prediction."""

    @property
    def name(self) -> str:
        """Stable identifier used in baselines and thresholds."""
        ...

    @property
    def deterministic(self) -> bool:
        """Whether the same prediction always yields the same score.

        A model-backed metric is not deterministic, and the gate refuses to
        threshold on one: a CI signal that itself varies run to run cannot
        distinguish a regression from its own noise.
        """
        ...

    async def score(self, case: EvalCase, prediction: str) -> MetricResult: ...


def normalize(text: str) -> str:
    """Casefold and collapse whitespace, then strip surrounding punctuation."""
    collapsed = _WHITESPACE.sub(" ", text.strip()).casefold()
    return collapsed.strip(" .!?\"'")


class ExactMatch:
    """Normalized string equality against ``case.expected``."""

    def __init__(self, *, name: str = "exact-match") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(self, case: EvalCase, prediction: str) -> MetricResult:
        if case.expected is None:
            raise EvalError(f"case {case.id!r} has no expected value for {self.name}")
        ok = normalize(prediction) == normalize(case.expected)
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail="" if ok else f"expected {case.expected!r}",
        )


class NormalizedContains:
    """Whether the normalized prediction contains the normalized expectation."""

    def __init__(self, *, name: str = "contains") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(self, case: EvalCase, prediction: str) -> MetricResult:
        if case.expected is None:
            raise EvalError(f"case {case.id!r} has no expected value for {self.name}")
        ok = normalize(case.expected) in normalize(prediction)
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail="" if ok else f"missing {case.expected!r}",
        )


class JsonSchemaValid:
    """Whether the prediction parses as JSON and satisfies the case's schema.

    The schema lives in the case's metadata under ``json_schema`` as a JSON
    string, which keeps datasets in a single file format.
    """

    def __init__(self, *, name: str = "json-valid") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(self, case: EvalCase, prediction: str) -> MetricResult:
        schema = case.metadata.get("json_schema")
        try:
            parsed = json.loads(prediction)
        except json.JSONDecodeError as exc:
            return MetricResult(
                metric=self.name, score=0.0, passed=False, detail=f"invalid JSON: {exc.msg}"
            )
        if schema is None:
            return MetricResult(metric=self.name, score=1.0, passed=True, detail="parsed")

        wanted = json.loads(schema)
        problems = _schema_problems(wanted, parsed, path="$")
        return MetricResult(
            metric=self.name,
            score=1.0 if not problems else 0.0,
            passed=not problems,
            detail="; ".join(problems),
        )


class JudgeVerdict(BaseModel):
    """The structured output an LLM judge must return."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    score: float = Field(ge=0.0, le=1.0)
    reason: str = ""


JudgeCall = Callable[[str], Awaitable[str]]


class LlmJudge:
    """Scores a prediction with a model, as a *metric only*.

    ``deterministic`` is ``False`` and must stay that way. Using this metric for a
    CI threshold would make the gate's own verdict probabilistic; the gate raises
    rather than allow it. It is implemented because a judge is the right way to
    explore quality locally and to produce a second opinion next to a
    deterministic gate -- not because it can be trusted as the gate.
    """

    def __init__(
        self,
        call: JudgeCall,
        *,
        rubric: str,
        name: str = "llm-judge",
        retries: int = 2,
    ) -> None:
        self._call = call
        self._rubric = rubric
        self._name = name
        self._retries = retries

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return False

    async def score(self, case: EvalCase, prediction: str) -> MetricResult:
        prompt = self._build_prompt(case, prediction)
        try:
            verdict = await run_structured(self._call, JudgeVerdict, prompt, retries=self._retries)
        except Exception as exc:
            return MetricResult(
                metric=self.name, score=0.0, passed=False, detail=f"judge failed: {exc}"
            )
        return MetricResult(
            metric=self.name,
            score=verdict.score,
            passed=verdict.score >= 0.5,
            detail=verdict.reason,
        )

    def _build_prompt(self, case: EvalCase, prediction: str) -> str:
        expected = case.expected if case.expected is not None else "<not provided>"
        return (
            f"{self._rubric}\n\n"
            f"Input: {case.input}\n"
            f"Reference: {expected}\n"
            f"Candidate: {prediction}\n\n"
            'Reply with JSON: {"score": <0.0-1.0>, "reason": "<short>"}'
        )


def default_metrics() -> tuple[Metric, ...]:
    """The deterministic gate metrics: everything that needs no model call."""
    return (ExactMatch(), NormalizedContains(), JsonSchemaValid())


def metric_names(metrics: Sequence[Metric]) -> tuple[str, ...]:
    return tuple(metric.name for metric in metrics)


def _schema_problems(schema: Any, value: Any, *, path: str, prefix: str = "") -> list[str]:
    """Check the JSON Schema subset a dataset realistically uses."""
    problems: list[str] = []
    if not isinstance(schema, dict):
        return problems

    declared = schema.get("type")
    if isinstance(declared, str) and not _type_ok(value, declared):
        problems.append(f"{prefix}{path}: expected {declared}, got {type(value).__name__}")

    if isinstance(value, dict):
        for name in schema.get("required") or []:
            if name not in value:
                problems.append(f"{prefix}{path}: missing required property {name!r}")
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for name, subschema in properties.items():
                if name in value:
                    problems.extend(
                        _schema_problems(
                            subschema, value[name], path=f"{path}.{name}", prefix=prefix
                        )
                    )

    if isinstance(value, list):
        items = schema.get("items")
        if isinstance(items, dict):
            for index, item in enumerate(value):
                problems.extend(
                    _schema_problems(items, item, path=f"{path}[{index}]", prefix=prefix)
                )

    return problems


def _type_ok(value: Any, declared: str) -> bool:
    if declared == "object":
        return isinstance(value, dict)
    if declared == "array":
        return isinstance(value, list)
    if declared == "string":
        return isinstance(value, str)
    if declared == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if declared == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if declared == "boolean":
        return isinstance(value, bool)
    if declared == "null":
        return value is None
    return True
