"""Running a dataset through a gateway, once or N times.

The split with :mod:`aid_runtime.evals.gate` is deliberate: this module *produces*
numbers, the gate *judges* them. Keeping them apart is what lets the sampling
loop stay boring and the decision logic stay testable without a provider.
"""

from __future__ import annotations

import statistics
from collections.abc import Awaitable, Callable, Sequence
from time import perf_counter

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import EvalError
from aid_runtime.evals.dataset import Dataset, EvalCase
from aid_runtime.evals.gate import EvalRun, MetricRun
from aid_runtime.evals.metrics import Metric, MetricResult, RunContext
from aid_runtime.evals.trajectory import RunOutput, Trajectory
from aid_runtime.gateway import ModelGateway
from aid_runtime.metrics import record_eval_case
from aid_runtime.types import CompletionRequest, Message

__all__ = [
    "CaseOutcome",
    "DatasetRun",
    "GatewayRunner",
    "Runner",
    "evaluate_once",
    "gateway_judge",
    "run_evaluation",
]

#: Anything that turns a case into a prediction. A runner that can also say how it got
#: there returns a :class:`RunOutput`; one that only has an answer returns a ``str``,
#: which is what every text metric needs and all a ``tool-trace`` metric refuses.
Runner = Callable[[EvalCase], Awaitable[str | RunOutput]]


class CaseOutcome(BaseModel):
    """One case's prediction and its per-metric scores, for inspection.

    ``trajectory`` is ``None`` for a runner that reported no tool calls, so "the runner
    said nothing" and "the run called no tools" stay different answers.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    case_id: str
    prediction: str
    scores: tuple[MetricResult, ...] = ()
    trajectory: Trajectory | None = None

    @property
    def passed(self) -> bool:
        return all(score.passed for score in self.scores)


class DatasetRun(BaseModel):
    """A single pass over a dataset, keeping per-case detail.

    ``run_evaluation`` only needs the means, but a failing gate is useless without
    knowing *which* cases moved, so the detail is kept here and summarised there.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset: str
    dataset_version: str
    outcomes: tuple[CaseOutcome, ...] = Field(min_length=1)

    def means(self) -> dict[str, float]:
        """Mean score per metric across the cases of this pass."""
        collected: dict[str, list[float]] = {}
        for outcome in self.outcomes:
            for score in outcome.scores:
                collected.setdefault(score.metric, []).append(score.score)
        return {name: statistics.fmean(values) for name, values in collected.items()}

    def failures(self) -> tuple[CaseOutcome, ...]:
        return tuple(outcome for outcome in self.outcomes if not outcome.passed)

    def outcome(self, case_id: str) -> CaseOutcome:
        for outcome in self.outcomes:
            if outcome.case_id == case_id:
                return outcome
        raise EvalError(f"no outcome recorded for case {case_id!r}")

    def summary(self) -> str:
        lines = [
            f"{self.dataset}@{self.dataset_version}: "
            f"{len(self.outcomes) - len(self.failures())}/{len(self.outcomes)} cases passed"
        ]
        for name, mean in sorted(self.means().items()):
            lines.append(f"  {name}: {mean:.4f}")
        for outcome in self.failures():
            failed = [score for score in outcome.scores if not score.passed]
            detail = "; ".join(f"{score.metric}: {score.detail}" for score in failed)
            lines.append(f"  FAIL {outcome.case_id}: {detail}")
        return "\n".join(lines)


class GatewayRunner:
    """Adapts a :class:`ModelGateway` into a :data:`Runner`.

    ``request_for`` exists so a caller can supply a prompt-registry-backed request
    (with its own system message and version) instead of the default
    one-message-for-``case.input`` shape. Keeping it a parameter rather than a
    subclass is enough: the only thing that varies is how a case becomes a
    request.
    """

    def __init__(
        self,
        gateway: ModelGateway,
        alias: str,
        *,
        system: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
        request_for: Callable[[EvalCase], CompletionRequest] | None = None,
        fallbacks: Sequence[str] = (),
    ) -> None:
        gateway.resolve(alias)
        self._gateway = gateway
        self._alias = alias
        self._fallbacks = tuple(fallbacks)
        self._temperature = temperature
        self._max_output_tokens = max_output_tokens
        self._system = None if request_for is not None else system
        self._request_for: Callable[[EvalCase], CompletionRequest] = (
            self._default_request if request_for is None else request_for
        )

    @property
    def alias(self) -> str:
        return self._alias

    @property
    def cost_usd(self) -> float:
        return self._gateway.ledger.cost_usd

    async def __call__(self, case: EvalCase) -> str:
        request = self._request_for(case)
        # Evals are cache-off by default: a cached prediction is a false pass, not
        # a measurement of the model. The ``use_cache`` opt-out exists precisely so
        # a runner can insist on a live call without the caller knowing the cache
        # is there at all.
        result = await self._gateway.generate(
            self._alias, request, fallbacks=self._fallbacks, use_cache=False
        )
        return result.text

    def _default_request(self, case: EvalCase) -> CompletionRequest:
        messages: list[Message] = []
        if self._system is not None:
            messages.append(Message(role="system", content=self._system))
        messages.append(Message(role="user", content=case.input))
        return CompletionRequest(
            messages=tuple(messages),
            temperature=self._temperature,
            max_output_tokens=self._max_output_tokens,
        )


async def gateway_judge(
    gateway: ModelGateway,
    alias: str,
    *,
    system: str | None = None,
) -> Callable[[str], Awaitable[str]]:
    """A :data:`JudgeCall` backed by the gateway, for :class:`LlmJudge`.

    Note what this does *not* do: it does not make the judge deterministic. It is
    still unfit for a CI threshold.
    """

    async def call(prompt: str) -> str:
        request = CompletionRequest.prompt(prompt, system=system)
        result = await gateway.generate(alias, request, use_cache=False)
        return result.text

    return call


async def evaluate_once(
    dataset: Dataset,
    runner: Runner,
    metrics: Sequence[Metric],
    *,
    eval_id: str | None = None,
) -> DatasetRun:
    """One pass over ``dataset``, scoring every prediction with every metric.

    Every case publishes its spend and duration as it completes, which is what makes
    ``eval.cost`` and ``eval.latency.p95`` a series an alarm can watch. ``eval_id`` is the
    *declared* eval this dataset belongs to -- the id an alarm's ``source`` names -- and
    falls back to the dataset's own name for a caller that runs a dataset directly.
    """
    if not metrics:
        raise ValueError("at least one metric is required")
    label = dataset.name if eval_id is None else eval_id
    outcomes: list[CaseOutcome] = []
    for case in dataset.cases:
        cost_before = _runner_cost(runner)
        started = perf_counter()
        raw = await runner(case)
        prediction, trajectory = _split(raw)
        # The runner call, not the scoring, is what a latency budget constrains: scoring
        # is the harness measuring the answer, and charging its time to the pipeline would
        # report a slower product because a judge was added to its eval.
        latency_ms = (perf_counter() - started) * 1000.0
        # Metrics see the pipeline's own spend, measured before scoring, because "what did
        # this task cost" is a property of the product and not of the harness auditing it.
        context = RunContext(
            cost_usd=_spent_since(runner, cost_before),
            latency_ms=latency_ms,
            metered=cost_before is not None,
            trajectory=trajectory,
        )
        scores = tuple(
            [await metric.score(case, prediction, context=context) for metric in metrics]
        )
        outcomes.append(
            CaseOutcome(
                case_id=case.id,
                prediction=prediction,
                scores=scores,
                trajectory=trajectory,
            )
        )
        # The published series is read after scoring, because a model-backed metric spends
        # money too and a cost series that ignored the judge would report half the run.
        record_eval_case(
            eval_id=label,
            cost_usd=_spent_since(runner, cost_before),
            latency_ms=latency_ms,
        )
    return DatasetRun(
        dataset=dataset.name, dataset_version=dataset.version, outcomes=tuple(outcomes)
    )


def _split(raw: str | RunOutput) -> tuple[str, Trajectory | None]:
    """The prediction, and the trajectory when the runner reported one."""
    if isinstance(raw, RunOutput):
        return raw.text, raw.trajectory
    return raw, None


def _runner_cost(runner: Runner) -> float | None:
    """A runner's cumulative model spend, when it meters one.

    A :data:`Runner` is any callable, so most say nothing here; one built by
    :class:`EvalRunner` reads its gateway ledger. An unmetered runner reports a real
    ``0.0`` rather than a guess, which is why "does not meter" and "spent nothing" are the
    same answer for a series that only ever sums.
    """
    spent = getattr(runner, "cost_usd", None)
    return float(spent) if isinstance(spent, int | float) else None


def _spent_since(runner: Runner, before: float | None) -> float:
    after = _runner_cost(runner)
    if before is None or after is None:
        return 0.0
    return max(after - before, 0.0)


async def run_evaluation(
    dataset: Dataset,
    runner: Runner,
    metrics: Sequence[Metric],
    *,
    runs: int = 5,
    eval_id: str | None = None,
) -> EvalRun:
    """Sample ``dataset`` ``runs`` times, recording one mean per metric per run.

    Every run makes fresh calls, which is the point: the spread across runs is the
    measurement of how much this system varies when nothing has changed. Without
    it there is nothing to compare a "regression" against.

    ``eval_id`` is forwarded to :func:`evaluate_once` so every case's published series
    carries the declared eval, which is the value an alarm scopes itself to.
    """
    if runs < 1:
        raise ValueError("runs must be at least 1")
    if not metrics:
        raise ValueError("at least one metric is required")

    collected: dict[str, list[float]] = {metric.name: [] for metric in metrics}
    for _ in range(runs):
        pass_result = await evaluate_once(dataset, runner, metrics, eval_id=eval_id)
        means = pass_result.means()
        for metric in metrics:
            collected[metric.name].append(means[metric.name])

    return EvalRun(
        dataset=dataset.name,
        dataset_version=dataset.version,
        runs=runs,
        metrics=tuple(
            MetricRun(metric=metric.name, values=tuple(collected[metric.name]))
            for metric in metrics
        ),
    )
