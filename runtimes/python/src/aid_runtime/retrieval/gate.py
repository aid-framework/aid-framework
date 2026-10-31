"""Running the retrieval gate through the shipped statistical gate.

No gate logic lives here. :class:`RetrievalGate` samples a retriever over retrieval
cases, turns each per-run mean into a real
:class:`~aid_runtime.evals.gate.MetricRun`, and hands a real
:class:`~aid_runtime.evals.gate.EvalRun` to the real
:class:`~aid_runtime.evals.gate.BaselineGate`. That matters for the falsification
test, which must show the *shipped* gate rejecting a worse retriever; a comparator
written for the occasion would prove only that the comparator works.

Two deliberate details:

**The metrics hand-off needs a cast.** ``BaselineGate.__init__`` annotates ``metrics``
as ``Sequence[Metric]``, and the shipped ``Metric`` protocol requires ``score(case:
EvalCase, prediction: str)``, which a retrieval metric cannot implement. What the
gate actually consumes from that argument is only ``.name`` and ``.deterministic`` --
that is the entirety of ``_check_metric_eligibility`` -- so a cast is sound here, and
is confined to one line with this comment rather than spread through the runtime. The
eligibility check it feeds is real: a retrieval metric reporting
``deterministic = False`` is refused, which a test asserts.

**``allow_nondeterministic`` is not exposed.** The shipped gate has the flag for
local exploration, and wiring it through would make it reachable from a gate. There is
no retrieval metric in Phase 1 that is non-deterministic; if one ever appears, the
metric is what needs fixing.

``runs`` is a required argument rather than a default, because it is not a tuning
knob: at ``runs = 1`` the run-to-run standard deviation is zero and the statistical
half of the gate cannot fire at all, so a gate built on one run silently degrades to a
mean comparison.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast

from aid_runtime.errors import EvalError
from aid_runtime.evals.gate import (
    BaselineGate,
    EvalBaseline,
    EvalRun,
    GateResult,
    MetricRun,
    Threshold,
)
from aid_runtime.evals.metrics import Metric
from aid_runtime.retrieval.metrics import RetrievalCase, RetrievalMetric
from aid_runtime.retrieval.retriever import Retriever

__all__ = ["RetrievalGate"]


class RetrievalGate:
    """Samples a retriever and decides whether its retrieval regressed."""

    def __init__(
        self,
        thresholds: Sequence[Threshold],
        *,
        metrics: Sequence[RetrievalMetric] = (),
    ) -> None:
        self._metrics = tuple(metrics)
        # See the module docstring: the gate reads only `name` and `deterministic`
        # from these, which is the part of the protocol a retrieval metric shares.
        self._gate = BaselineGate(
            thresholds,
            metrics=cast(Sequence[Metric], self._metrics),
        )

    @property
    def thresholds(self) -> tuple[Threshold, ...]:
        return self._gate.thresholds

    @property
    def metrics(self) -> tuple[RetrievalMetric, ...]:
        return self._metrics

    async def sample(
        self,
        cases: Sequence[RetrievalCase],
        retriever: Retriever,
        *,
        runs: int,
        dataset: str,
        dataset_version: str,
    ) -> EvalRun:
        """Run every case ``runs`` times, producing one mean per metric per run."""
        if not cases:
            raise EvalError("a retrieval run needs at least one case")
        if runs < 1:
            raise EvalError(f"a retrieval run needs at least one run, got {runs}")
        if not self._metrics:
            raise EvalError("a retrieval run needs at least one metric")

        samples: dict[str, list[float]] = {metric.name: [] for metric in self._metrics}
        for _ in range(runs):
            totals: dict[str, float] = {metric.name: 0.0 for metric in self._metrics}
            for case in cases:
                # k comes from the case, because a case is what says how many
                # passages count as an answer; a retriever's own topK is a default.
                retrieved = await retriever.retrieve(case.query, top_k=case.k)
                for metric in self._metrics:
                    result = await metric.score(case, retrieved)
                    totals[metric.name] += result.score
            for name, total in totals.items():
                samples[name].append(total / len(cases))

        return EvalRun(
            dataset=dataset,
            dataset_version=dataset_version,
            runs=runs,
            metrics=tuple(
                MetricRun(metric=name, values=tuple(values)) for name, values in samples.items()
            ),
        )

    def evaluate(self, run: EvalRun, baseline: EvalBaseline) -> GateResult:
        """Delegate to the shipped gate; there is no verdict logic in this module."""
        return self._gate.evaluate(run, baseline)
