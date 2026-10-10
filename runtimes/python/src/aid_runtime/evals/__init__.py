"""Eval harness: datasets, metrics, N-run sampling, and the baseline gate."""

from __future__ import annotations

from aid_runtime.evals.dataset import Dataset, EvalCase
from aid_runtime.evals.gate import (
    BaselineGate,
    EvalBaseline,
    EvalRun,
    GateResult,
    MetricBaseline,
    MetricGateResult,
    MetricRun,
    Threshold,
    gate_from_config,
    z_critical,
)
from aid_runtime.evals.metrics import (
    ExactMatch,
    JsonSchemaValid,
    JudgeVerdict,
    LlmJudge,
    Metric,
    MetricResult,
    NormalizedContains,
    default_metrics,
    metric_names,
    normalize,
)
from aid_runtime.evals.runner import (
    CaseOutcome,
    DatasetRun,
    GatewayRunner,
    Runner,
    evaluate_once,
    gateway_judge,
    run_evaluation,
)

__all__ = [
    "BaselineGate",
    "CaseOutcome",
    "Dataset",
    "DatasetRun",
    "EvalBaseline",
    "EvalCase",
    "EvalRun",
    "ExactMatch",
    "GateResult",
    "GatewayRunner",
    "JsonSchemaValid",
    "JudgeVerdict",
    "LlmJudge",
    "Metric",
    "MetricBaseline",
    "MetricGateResult",
    "MetricResult",
    "MetricRun",
    "NormalizedContains",
    "Runner",
    "Threshold",
    "default_metrics",
    "evaluate_once",
    "gate_from_config",
    "gateway_judge",
    "metric_names",
    "normalize",
    "run_evaluation",
    "z_critical",
]
