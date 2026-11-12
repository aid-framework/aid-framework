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

from aid_runtime.agents.guardrails import DecisionAsker
from aid_runtime.agents.ir import DecisionDefinition
from aid_runtime.decisions import DecisionClient, DecisionQuestion, DecisionResponse
from aid_runtime.errors import ConfigurationError, EvalError
from aid_runtime.evals.dataset import EvalCase
from aid_runtime.evals.predicate import evaluate_predicate
from aid_runtime.evals.trajectory import Trajectory
from aid_runtime.structured import run_structured

__all__ = [
    "ApprovalRespected",
    "AssertMetric",
    "CostCeiling",
    "DecisionScore",
    "ExactMatch",
    "ForbiddenTool",
    "JsonSchemaValid",
    "JudgeVerdict",
    "LatencyCeiling",
    "LlmJudge",
    "Metric",
    "MetricResult",
    "NormalizedContains",
    "RunContext",
    "StepCount",
    "ToolTrace",
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


class RunContext(BaseModel):
    """What the harness measured about the run a prediction came from.

    A prediction on its own cannot answer "what did this case cost" or "how long did
    it take", and those are numbers the harness already has. They travel beside the
    prediction so a ceiling metric can read them without the runner having to smuggle
    them through the answer text. A metric that only inspects text ignores this and
    behaves exactly as it did before.

    ``metered`` is deliberately separate from ``cost_usd``. An unmetered runner reports
    a real ``0.0`` -- "does not meter" and "spent nothing" are the same number -- so a
    cost ceiling has to be told which one it is looking at, or it would pass forever
    over a run nobody measured.

    ``trajectory`` is ``None`` when the runner said nothing about tool calls, and that is
    distinguishable from a run that called no tools: the second is an empty trajectory,
    the first is a runner that only ever returned its answer text.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    cost_usd: float = Field(default=0.0, ge=0.0)
    latency_ms: float = Field(default=0.0, ge=0.0)
    metered: bool = False
    trajectory: Trajectory | None = None


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

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult: ...


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

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
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

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
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

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
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


class AssertMetric:
    """Whether a declared predicate holds for the case and its prediction.

    The condition arrives as the IR's predicate AST -- the very tree the spec
    layer parsed and checked -- so this metric needs no parser and cannot
    disagree with the one that accepted the spec. A prediction that makes the
    predicate false scores 0.0 and reports the spec's own ``message`` verbatim,
    because the point of letting the author write the message is that a failure
    quotes them.

    A predicate that cannot be decided raises instead of scoring. See
    ``aid_runtime.evals.predicate`` for why that distinction is load-bearing.
    """

    def __init__(self, *, expr: Any, message: str, name: str = "assert") -> None:
        self._expr = expr
        self._message = message
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
        ok = evaluate_predicate(self._expr, case=case, prediction=prediction)
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail="" if ok else self._message,
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

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
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


class DecisionScore:
    """Scores a prediction with a TypeSafe AI Jev ``score`` decision.

    ``deterministic`` is ``False``: the answer comes from a model, so the gate
    refuses to threshold on it and ``gate.ci`` may not declare it. What makes a
    ``score`` decision the right rubric here is that its ``criteria`` are
    ordered: the position the model returns *is* the score, so this metric maps
    that position onto ``[0, 1]`` instead of inventing an order for labels.

    A call that fails, or an answer outside the declared range, raises rather
    than scoring. A ``0.0`` would read as a regression the candidate caused and
    a ``1.0`` would silently pass; neither is what "the vendor did not answer"
    means.

    ``threshold`` marks a single answer as passing, which is useful when the
    metric is read directly. It is not a gate: ``BaselineGate`` refuses a
    ``Threshold`` on any non-deterministic metric, so a spec has no way to floor
    this score and the generated eval never asks for one.
    """

    def __init__(
        self,
        decision: DecisionDefinition,
        *,
        threshold: float = 0.5,
        name: str = "decision",
        client_factory: Callable[[], DecisionAsker] | None = None,
    ) -> None:
        if len(decision.criteria) < 2:
            raise ConfigurationError(
                f"decision {decision.id!r} declares {len(decision.criteria)} criteria, "
                "but scoring needs at least two ordered levels"
            )
        self._decision = decision
        self._threshold = threshold
        self._name = name
        self._client_factory = client_factory
        self._client: DecisionAsker | None = None

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return False

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
        response = await self._ask(prediction)
        answer = response.answers.get(self._decision.id)
        if answer is None or answer.score is None:
            raise EvalError(
                f"decision {self._decision.id!r} returned no score for its own question"
            )
        levels = len(self._decision.criteria)
        normalized = (answer.score - 1.0) / (levels - 1)
        if not 0.0 <= normalized <= 1.0:
            raise EvalError(
                f"decision {self._decision.id!r} answered {answer.score:g}, "
                f"which is outside the declared 1..{levels} range"
            )
        return MetricResult(
            metric=self.name,
            score=normalized,
            passed=normalized >= self._threshold,
            detail=f"level {answer.score:g} of {levels}",
        )

    async def _ask(self, prediction: str) -> DecisionResponse:
        if self._client is None:
            self._client = (self._client_factory or DecisionClient)()
        return await self._client.decide(
            model=self._decision.model,
            state=prediction,
            questions={
                self._decision.id: DecisionQuestion(
                    type="score",
                    instructions=self._decision.instructions,
                    criteria=self._decision.criteria,
                )
            },
            reproducible=True,
        )


class _Ceiling:
    """Shared shape for the two metrics that read a number off the run context.

    Both refuse rather than pass when the number they are asked to bound was never
    measured: a ceiling that passes over an unmeasured run is a gate that cannot fail,
    which is worse than no gate at all because it looks like coverage.
    """

    _quantity = "value"

    def __init__(self, *, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    def _measure(self, case: EvalCase, context: RunContext | None) -> float:
        raise NotImplementedError

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
        ceiling = self._limit()
        measured = self._measure(case, context)
        ok = measured <= ceiling
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail=f"{self._quantity} {self._format(measured)}, ceiling {self._format(ceiling)}",
        )

    def _limit(self) -> float:
        raise NotImplementedError

    def _format(self, value: float) -> str:
        return f"{value:.4f}"


class CostCeiling(_Ceiling):
    """Whether one case stayed inside a declared per-case spend.

    Costs money to find out, so it is opt-in: an eval declares it and the generator
    maps it. The harness reads spend from the gateway ledger, which only exists for a
    runner that meters, so an unmetered runner is refused, not scored.
    """

    _quantity = "spent"

    def __init__(self, *, max_usd: float, name: str = "cost") -> None:
        if max_usd <= 0:
            raise ConfigurationError(f"a cost ceiling must be above zero, got {max_usd:g}")
        super().__init__(name=name)
        self._max = max_usd

    def _limit(self) -> float:
        return self._max

    def _measure(self, case: EvalCase, context: RunContext | None) -> float:
        if context is None or not context.metered:
            raise EvalError(
                f"case {case.id!r} carries a cost ceiling, but its runner does not meter "
                "spend, so the ceiling would pass over a run nobody measured"
            )
        return context.cost_usd

    def _format(self, value: float) -> str:
        return f"${value:.4f}"


class LatencyCeiling(_Ceiling):
    """Whether one case finished inside a declared wall-clock budget.

    Measured by the harness around the runner call, so it is available for every
    runner rather than only the metering ones.
    """

    _quantity = "took"

    def __init__(self, *, max_ms: float, name: str = "latency") -> None:
        if max_ms <= 0:
            raise ConfigurationError(f"a latency ceiling must be above zero, got {max_ms:g}")
        super().__init__(name=name)
        self._max = max_ms

    def _limit(self) -> float:
        return self._max

    def _measure(self, case: EvalCase, context: RunContext | None) -> float:
        if context is None:
            raise EvalError(
                f"case {case.id!r} carries a latency ceiling, but it was scored outside a "
                "measured run, so there is no elapsed time to compare against it"
            )
        return context.latency_ms

    def _format(self, value: float) -> str:
        return f"{value:.0f}ms"


class ToolTrace:
    """Whether a run called the tools it was expected to, in the order it was told.

    ``ordered`` is the whole semantics, and it is the reason this metric needs a
    decision rather than a default: ``True`` means ``expect`` has to appear as a
    *subsequence* of the calls made, ``False`` means every expected tool has to appear
    at least once, in any order. Extra calls are tolerated either way -- a run that
    looked one more thing up on the way did more than the minimum, and failing it would
    benchmark one exact transcript rather than a capability. A run that calls an
    expected tool twice passes too; the metric asks whether the tool was called, not how
    often, because "how often" is a budget question and ``cost`` answers it.

    Refuses rather than passes when the runner reported no trajectory: a trace assertion
    over an answer-only runner would pass on every case by having nothing to compare,
    which is coverage that does not exist.
    """

    def __init__(
        self,
        *,
        expect: Sequence[str],
        ordered: bool = False,
        name: str = "tool-trace",
    ) -> None:
        if not expect:
            raise ConfigurationError("a tool-trace metric must expect at least one tool")
        self._name = name
        self._expect = tuple(expect)
        self._ordered = ordered

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
        if context is None or context.trajectory is None:
            raise EvalError(
                f"case {case.id!r} carries a tool-trace metric, but its runner reported no "
                "tool calls, so there is nothing to compare the expectation against"
            )
        calls = context.trajectory.calls
        ok = self._satisfied_by(calls)
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail=(
                f"called {_tool_list(calls)}"
                if ok
                else (
                    f"expected {_tool_list(self._expect)}"
                    f"{' in order' if self._ordered else ''}, called {_tool_list(calls)}"
                )
            ),
        )

    def _satisfied_by(self, calls: Sequence[str]) -> bool:
        if not self._ordered:
            return set(self._expect) <= set(calls)
        # Walking the calls once with a cursor is the subsequence test: `in` on an
        # iterator advances it, so each expected tool has to be found after the last one.
        remaining = iter(calls)
        return all(tool in remaining for tool in self._expect)


def _tool_list(names: Sequence[str]) -> str:
    return ", ".join(names) if names else "no tools"


class StepCount(_Ceiling):
    """Whether a run finished inside a declared ceiling on model calls.

    The agent's own ``maxSteps`` already bounds a run, so this is not a second safety
    net -- it is the eval asserting the bound held for *this* case. A case expected to
    take three steps that takes nine is a run that looped, and the answer it eventually
    produced is not the run the case described.

    Refuses a trajectory that reports no steps rather than passing one: an agent run is
    model calls, so a count of zero means nobody counted, and a ceiling over an
    uncounted run would pass every case by accident.
    """

    _quantity = "took"

    def __init__(self, *, max_steps: int, name: str = "step-count") -> None:
        if max_steps <= 0:
            raise ConfigurationError(f"a step ceiling must be above zero, got {max_steps}")
        super().__init__(name=name)
        self._max = max_steps

    def _limit(self) -> float:
        return float(self._max)

    def _measure(self, case: EvalCase, context: RunContext | None) -> float:
        if context is None or context.trajectory is None:
            raise EvalError(
                f"case {case.id!r} carries a step ceiling, but its runner reported no "
                "trajectory, so there is no step count to compare against it"
            )
        if context.trajectory.steps == 0:
            raise EvalError(
                f"case {case.id!r} carries a step ceiling, but its trajectory records no "
                "steps; an agent run is at least one model call, so a count of zero means "
                "the count was never taken and the ceiling would pass over it"
            )
        return float(context.trajectory.steps)

    def _format(self, value: float) -> str:
        return f"{value:.0f} steps"


class ForbiddenTool:
    """Whether a run reached for a tool it was told not to use.

    The inverse of ``ToolTrace``: that one asks whether the run did a thing, this asks
    whether it crossed a line. A run that calls no tools at all passes, because "did not
    use the forbidden tool" is true of it -- but a runner that reports no trajectory is
    refused, since silence about tool calls is not evidence that none were made.
    """

    def __init__(self, *, forbid: Sequence[str], name: str = "forbidden-tool") -> None:
        if not forbid:
            raise ConfigurationError("a forbidden-tool metric must name at least one tool")
        self._name = name
        self._forbid = tuple(forbid)

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
        if context is None or context.trajectory is None:
            raise EvalError(
                f"case {case.id!r} carries a forbidden-tool metric, but its runner reported "
                "no tool calls, so there is nothing to clear the run of"
            )
        hit = tuple(sorted(set(self._forbid).intersection(context.trajectory.calls)))
        ok = not hit
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail=(
                f"called none of {_tool_list(self._forbid)}"
                if ok
                else f"called forbidden {_tool_list(hit)}"
            ),
        )


class ApprovalRespected:
    """Whether a run paused when a person had to decide, and obeyed the answer.

    Three findings, and a case passes only when none of them fires. They are separate
    because they mean different things to whoever reads the failure:

    ``pause-missed`` is a case that scripted a decision the run never asked for, so the
    decision was never tested. ``pause-unexpected`` is a pause the case supplied no
    decision for -- the run stopped where the dataset said nothing would. Both are
    mismatches between the dataset and the machinery.

    ``decision-ignored`` is the safety finding: a call ran after a reviewer rejected it.
    It fails the case even when the answer matches what the case expected, because a
    correct answer reached by crossing an approval is not a correct answer.

    The counts come from the runner, since no metric can recover them from an answer.
    A trajectory that carries none of them is refused when the case scripted a decision;
    an unrecorded approval is not a respected one.
    """

    def __init__(self, *, name: str = "approval-respected") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def deterministic(self) -> bool:
        return True

    async def score(
        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
    ) -> MetricResult:
        if context is None or context.trajectory is None:
            raise EvalError(
                f"case {case.id!r} carries an approval-respected metric, but its runner "
                "reported no trajectory, so there is no approval record to judge"
            )
        trajectory = context.trajectory
        findings: list[str] = []
        if case.approvals and trajectory.pauses == 0:
            findings.append("pause-missed: the case supplies a decision the run never asked for")
        if not case.approvals and trajectory.pauses > 0:
            findings.append(
                f"pause-unexpected: the run paused {trajectory.pauses} time(s) and the case "
                "supplies no decision"
            )
        if trajectory.ignored:
            findings.append(
                f"decision-ignored: {_tool_list(trajectory.ignored)} ran after a rejection"
            )
        ok = not findings
        return MetricResult(
            metric=self.name,
            score=1.0 if ok else 0.0,
            passed=ok,
            detail=(
                f"respected {len(trajectory.decisions)} decision(s) across "
                f"{trajectory.pauses} pause(s)"
                if ok
                else "; ".join(findings)
            ),
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
