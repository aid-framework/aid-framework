"""Exception hierarchy for the AID Python runtime.

Every error this library raises derives from :class:`AidRuntimeError`, so an
application can distinguish "the framework refused to proceed" from "the network
was flaky" with a single `except`.
"""

from __future__ import annotations

from collections.abc import Sequence

__all__ = [
    "AgentBudgetDegradedError",
    "AgentHandoffUnsupportedError",
    "AgentTransferCycleError",
    "AidRuntimeError",
    "BudgetExceededError",
    "CapabilityMismatchError",
    "ConfigurationError",
    "DeepAgentsEngineError",
    "DeepAgentsMaxStepsError",
    "DeepAgentsUnavailableError",
    "DeepAgentsVersionMismatchError",
    "EvalError",
    "FeatureDeferredError",
    "GateConfigurationError",
    "PipelineError",
    "PolicyEvaluationError",
    "PromptNotFoundError",
    "PromptRenderError",
    "ProviderError",
    "ProviderResponseError",
    "StructuredOutputError",
    "ToolArgumentError",
    "ToolExecutionError",
    "ToolNotFoundError",
    "UnknownModelAliasError",
]


class AidRuntimeError(Exception):
    """Base class for every error raised by this library."""


class ConfigurationError(AidRuntimeError):
    """The runtime was configured with something it cannot use."""


class UnknownModelAliasError(ConfigurationError):
    """An alias was requested that the gateway has no pinned model for.

    Model pinning means the alias table is closed: an unknown alias is a
    configuration error, never a silent pass-through to a provider default.
    """

    def __init__(self, alias: str, known: Sequence[str]) -> None:
        listed = ", ".join(sorted(known)) or "<none>"
        super().__init__(f"unknown model alias {alias!r}; pinned aliases: {listed}")
        self.alias = alias
        self.known = tuple(sorted(known))


class CapabilityMismatchError(ConfigurationError):
    """A pinned model does not declare a capability the caller requires."""

    def __init__(self, alias: str, missing: Sequence[str]) -> None:
        listed = ", ".join(sorted(missing))
        super().__init__(f"model alias {alias!r} does not support: {listed}")
        self.alias = alias
        self.missing = tuple(sorted(missing))


class BudgetExceededError(AidRuntimeError):
    """A cost or token budget was crossed.

    Raised after a call is charged, so the ledger it reports has already recorded
    the spend that crossed the line -- a caller that catches this still sees
    truthful accounting rather than a pre-call estimate.
    """

    def __init__(self, scope: str, limit: float, spent: float, unit: str = "usd") -> None:
        if unit == "usd":
            limit_text = f"${limit:.6f}"
            spent_text = f"${spent:.6f}"
            over_text = f"${spent - limit:.6f}"
        else:
            limit_text = f"{limit:.0f} {unit}"
            spent_text = f"{spent:.0f} {unit}"
            over_text = f"{spent - limit:.0f} {unit}"
        super().__init__(
            f"budget {scope!r} exceeded: limit {limit_text}, spent {spent_text} "
            f"(over by {over_text})"
        )
        self.scope = scope
        self.limit = limit
        self.spent = spent
        self.unit = unit


class FeatureDeferredError(AidRuntimeError):
    """A capability is declared for the IR contract but not implemented yet.

    Streaming is the motivating case: the runtime is request/response only, no
    target declares the ``streaming`` capability, and this error is what ``stream()``
    raises instead of returning a silently non-streaming "stream". Phase 2 layer L5
    implements streaming and restores the declaration.
    """


class ProviderError(AidRuntimeError):
    """A provider call failed after exhausting retries."""


class ProviderResponseError(ProviderError):
    """The provider answered with a body we could not interpret."""

    def __init__(self, message: str, body: str | None = None) -> None:
        super().__init__(message if body is None else f"{message}: {body[:500]}")
        self.body = body


class PromptNotFoundError(AidRuntimeError):
    """No prompt is registered under the requested name and version."""

    def __init__(self, name: str, version: str | None, known: Sequence[str]) -> None:
        suffix = " (latest)" if version is None else f" version {version!r}"
        listed = ", ".join(sorted(known)) or "<none>"
        super().__init__(f"no prompt {name!r}{suffix}; registered: {listed}")
        self.name = name
        self.version = version


class PromptRenderError(AidRuntimeError):
    """A prompt template could not be rendered from the supplied variables."""


class StructuredOutputError(AidRuntimeError):
    """A model response could not be coerced into the requested output type."""

    def __init__(self, message: str, *, attempts: int, problems: Sequence[str] = ()) -> None:
        detail = f" after {attempts} attempt(s)"
        if problems:
            detail += ": " + "; ".join(problems)
        super().__init__(message + detail)
        self.attempts = attempts
        self.problems = tuple(problems)


class ToolNotFoundError(AidRuntimeError):
    """A tool call named a tool the executor does not have."""

    def __init__(self, name: str, known: Sequence[str]) -> None:
        listed = ", ".join(sorted(known)) or "<none>"
        super().__init__(f"unknown tool {name!r}; registered: {listed}")
        self.name = name


class ToolArgumentError(AidRuntimeError):
    """Tool call arguments failed schema validation."""

    def __init__(self, tool: str, problems: Sequence[str]) -> None:
        super().__init__(f"invalid arguments for tool {tool!r}: {'; '.join(problems)}")
        self.tool = tool
        self.problems = tuple(problems)


class ToolExecutionError(AidRuntimeError):
    """A tool handler raised."""


class PipelineError(AidRuntimeError):
    """A pipeline step failed or the pipeline was wired incorrectly."""


class PolicyEvaluationError(AidRuntimeError):
    """A parsed ``PolicyExpr`` referenced something the evaluator cannot decide.

    The IR's policy grammar is closed, and a comparison between incompatible
    values has no truth value. Failing closed here is what keeps a HITL gate from
    silently deciding *not* to ask for approval.
    """


class GuardrailBlockedError(AidRuntimeError):
    """A guardrail stopped the run before (or after) the guarded effect.

    Raised by the ``block`` action, and by any guardrail the engine cannot
    evaluate. An undecidable policy is a block, never an allow: the failure mode
    this class exists to prevent is a check that quietly returns "no violation"
    because its input did not match what it expected.
    """

    def __init__(self, guardrail: str, stage: str, message: str) -> None:
        super().__init__(f"guardrail {guardrail!r} blocked the {stage} stage: {message}")
        self.guardrail = guardrail
        self.stage = stage
        self.message = message


class ToolPermissionError(AidRuntimeError):
    """An agent asked for a tool it was not granted, or one its auth policy denies.

    Raised before the handler body runs. The check is deliberately not a tool
    result: a model can repair a bad argument, but it cannot repair a missing
    grant, so the caller is the party that has to fix this.
    """

    def __init__(self, agent: str, tool: str, reason: str) -> None:
        super().__init__(f"agent {agent!r} may not call tool {tool!r}: {reason}")
        self.agent = agent
        self.tool = tool
        self.reason = reason


class AgentTransferCycleError(AidRuntimeError):
    """A transfer chain revisited an agent that already held control.

    ``agents/handoff-cycles`` rejects this at build time; the runtime refuses it
    again rather than trusting that every caller came through the gate.
    """

    def __init__(self, path: Sequence[str]) -> None:
        super().__init__(f"transfer cycle: {' -> '.join(path)}")
        self.path = tuple(path)


class AgentBudgetDegradedError(AidRuntimeError):
    """A budget was crossed and there is no cheaper alias left to route to.

    ``ir/agents-budget-degrade`` rejects this at build time for declared specs;
    this is the run-time counterpart for a hand-built IR.
    """


class EvalError(AidRuntimeError):
    """An eval run could not be completed."""


class AgentHandoffUnsupportedError(AidRuntimeError):
    """An agent asked for ``handoffs`` on an engine that has no transfer primitive.

    Deep Agents has ``subagents`` -- delegation that *returns* -- and no transfer:
    control never moves, the caller always resumes and always authors the final
    answer. Emulating transfer with a delegate would change who answers, so the
    engine refuses instead of silently degrading ``handoffs`` into a delegate.
    Transfer therefore stays native-only, and the IR gate plus this error are the
    two places that say so.
    """

    def __init__(self, agent: str, targets: Sequence[str], engine: str) -> None:
        super().__init__(
            f"agent {agent!r} declares handoffs {list(targets)} but runs on the {engine!r} "
            "engine, which has no transfer primitive; transfer is native-only, and "
            "delegation (delegates) is the deepagents equivalent"
        )
        self.agent = agent
        self.targets = tuple(targets)
        self.engine = engine


class DeepAgentsEngineError(AidRuntimeError):
    """The ``deepagents`` engine cannot be used as configured.

    Base class so a caller can catch "the backend refused to start" without
    enumerating the two reasons it can refuse.
    """


class DeepAgentsUnavailableError(DeepAgentsEngineError):
    """The ``deepagents`` optional extra is not installed.

    A named error rather than an ``ImportError`` because the fix is an install
    instruction the caller can act on, and because an agent silently falling back
    to the native loop would leave ``engine`` in the IR meaning nothing.
    """

    def __init__(self, extra: str, distribution: str) -> None:
        super().__init__(
            f"this agent runs on the 'deepagents' engine, but the {distribution!r} package "
            f"is not installed; install the extra with: pip install '{extra}'"
        )
        self.extra = extra
        self.distribution = distribution


class DeepAgentsMaxStepsError(DeepAgentsEngineError):
    """The harness asked for one model call more than ``maxSteps`` allows.

    Raised by the adapter rather than the harness, because the harness's own call
    limiter does not fail: it appends a synthetic "model call limits exceeded"
    answer and lets the run finish, which would report an exhausted agent as a
    successful one. The engine translates this into ``RunStatus.MAX_STEPS``, the
    same outcome the native loop reports for the same condition.
    """

    def __init__(self, alias: str, max_steps: int) -> None:
        super().__init__(
            f"the deepagents harness requested model call {max_steps + 1} on alias "
            f"{alias!r}, exceeding maxSteps {max_steps}; the run is exhausted"
        )
        self.alias = alias
        self.max_steps = max_steps


class DeepAgentsVersionMismatchError(DeepAgentsEngineError):
    """``engineVersion`` does not match the release this runtime is pinned to.

    The IR gate refuses ``engine: deepagents`` without a pinned ``engineVersion``
    precisely so that this comparison can exist: an unpinned engine is a backend
    whose behaviour can change under a stored eval baseline. A mismatch is
    therefore a hard failure, never a warning, and it fires in both directions --
    a declared version this runtime is not built for, and a run-time that cannot
    find the declaration at all.
    """

    def __init__(self, agent: str, declared: str, pinned: str) -> None:
        detail = (
            "the IR declares no engineVersion"
            if not declared
            else f"the IR declares engineVersion {declared!r}"
        )
        super().__init__(
            f"agent {agent!r}: {detail}, but this runtime is pinned to deepagents=={pinned}; "
            f"set engineVersion to {pinned!r} or install the runtime that matches"
        )
        self.agent = agent
        self.declared = declared
        self.pinned = pinned


class GateConfigurationError(EvalError):
    """The gate was configured in a way that cannot be trusted as a CI signal.

    The load-bearing case: a threshold that references a metric whose result is
    itself produced by a model. Gating on one source of non-determinism using
    another is not a gate.
    """
