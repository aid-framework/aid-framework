"""AID runtime for Python: the execution half of a generated application.

The AID framework generates an application from an IR that declares *what* the
app does. This package is what the generated code calls at runtime: pin a model,
run a prompt, call a tool, trace it, stay inside a budget, and prove that quality
did not regress.

Design boundaries worth stating up front, because they are deliberate:

* **Control flow is plain async Python.** There is no graph or orchestration
  engine here. A generated app is ordinary code that is easy to read and to test.
* **Pydantic AI is used only for structured output.** No other responsibility is
  delegated to it.
* **Streaming is declared, not implemented.** ``Capability.STREAMING`` exists so a
  spec can require it and a gate can check it; calling
  :meth:`~aid_runtime.gateway.ModelGateway.stream` raises
  :class:`~aid_runtime.errors.FeatureDeferredError`.
* **One HTTP provider adapter and one fake.** Breadth of vendor coverage is a
  Phase 2 concern; a narrow, correct seam is worth more now than a wide shallow one.
"""

from __future__ import annotations

from aid_runtime.cost import (
    Budget,
    CostLedger,
    LedgerEntry,
    SpendSummary,
    estimate_cost_usd,
    estimate_prompt_cost_usd,
)
from aid_runtime.errors import (
    AidRuntimeError,
    BudgetExceededError,
    CapabilityMismatchError,
    ConfigurationError,
    EvalError,
    FeatureDeferredError,
    GateConfigurationError,
    PipelineError,
    PromptNotFoundError,
    PromptRenderError,
    ProviderError,
    ProviderResponseError,
    StructuredOutputError,
    ToolArgumentError,
    ToolExecutionError,
    ToolNotFoundError,
    UnknownModelAliasError,
)
from aid_runtime.evals import (
    BaselineGate,
    CaseOutcome,
    Dataset,
    DatasetRun,
    EvalBaseline,
    EvalCase,
    EvalRun,
    ExactMatch,
    GateResult,
    GatewayRunner,
    JsonSchemaValid,
    JudgeVerdict,
    LlmJudge,
    Metric,
    MetricBaseline,
    MetricGateResult,
    MetricResult,
    MetricRun,
    NormalizedContains,
    Runner,
    Threshold,
    default_metrics,
    evaluate_once,
    gate_from_config,
    gateway_judge,
    metric_names,
    normalize,
    run_evaluation,
    z_critical,
)
from aid_runtime.gateway import ModelGateway, estimate_usage
from aid_runtime.pipeline import (
    STEPS_KEY,
    Pipeline,
    PipelineContext,
    Step,
    StepResult,
    StopPipeline,
)
from aid_runtime.prompts import Example, PromptRegistry, PromptTemplate, RenderedPrompt
from aid_runtime.providers import (
    DEFAULT_BASE_URL,
    FakeProvider,
    OpenAICompatibleProvider,
    Provider,
)
from aid_runtime.structured import (
    build_agent,
    format_problems,
    parse_structured,
    repair_prompt,
    run_structured,
)
from aid_runtime.tools import Tool, ToolExecutor
from aid_runtime.tracing import (
    ATTRIBUTES,
    GEN_AI_OPERATION_CHAT,
    aid_attributes,
    get_tracer,
    llm_span,
    record_cost,
    record_exception,
    record_usage,
)
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    CostProfile,
    FinishReason,
    GenerationResult,
    Message,
    ModelSpec,
    PinnedModel,
    Role,
    TokenUsage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)

#: Kept in sync with ``pyproject.toml`` by a test, so the two cannot drift.
__version__ = "0.1.0"

__all__ = [
    "ATTRIBUTES",
    "DEFAULT_BASE_URL",
    "GEN_AI_OPERATION_CHAT",
    "STEPS_KEY",
    "AidRuntimeError",
    "BaselineGate",
    "Budget",
    "BudgetExceededError",
    "Capability",
    "CapabilityMismatchError",
    "CaseOutcome",
    "CompletionRequest",
    "CompletionResponse",
    "ConfigurationError",
    "CostLedger",
    "CostProfile",
    "Dataset",
    "DatasetRun",
    "EvalBaseline",
    "EvalCase",
    "EvalError",
    "EvalRun",
    "ExactMatch",
    "Example",
    "FakeProvider",
    "FeatureDeferredError",
    "FinishReason",
    "GateConfigurationError",
    "GateResult",
    "GatewayRunner",
    "GenerationResult",
    "JsonSchemaValid",
    "JudgeVerdict",
    "LedgerEntry",
    "LlmJudge",
    "Message",
    "Metric",
    "MetricBaseline",
    "MetricGateResult",
    "MetricResult",
    "MetricRun",
    "ModelGateway",
    "ModelSpec",
    "NormalizedContains",
    "OpenAICompatibleProvider",
    "PinnedModel",
    "Pipeline",
    "PipelineContext",
    "PipelineError",
    "PromptNotFoundError",
    "PromptRegistry",
    "PromptRenderError",
    "PromptTemplate",
    "Provider",
    "ProviderError",
    "ProviderResponseError",
    "RenderedPrompt",
    "Role",
    "Runner",
    "SpendSummary",
    "Step",
    "StepResult",
    "StopPipeline",
    "StructuredOutputError",
    "Threshold",
    "TokenUsage",
    "Tool",
    "ToolArgumentError",
    "ToolCall",
    "ToolDefinition",
    "ToolExecutionError",
    "ToolExecutor",
    "ToolNotFoundError",
    "ToolResult",
    "UnknownModelAliasError",
    "__version__",
    "aid_attributes",
    "build_agent",
    "default_metrics",
    "estimate_cost_usd",
    "estimate_prompt_cost_usd",
    "estimate_usage",
    "evaluate_once",
    "format_problems",
    "gate_from_config",
    "gateway_judge",
    "get_tracer",
    "llm_span",
    "metric_names",
    "normalize",
    "parse_structured",
    "record_cost",
    "record_exception",
    "record_usage",
    "repair_prompt",
    "run_evaluation",
    "run_structured",
    "z_critical",
]
