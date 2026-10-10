"""Exception hierarchy for the AID Python runtime.

Every error this library raises derives from :class:`AidRuntimeError`, so an
application can distinguish "the framework refused to proceed" from "the network
was flaky" with a single `except`.
"""

from __future__ import annotations

from collections.abc import Sequence

__all__ = [
    "AidRuntimeError",
    "BudgetExceededError",
    "CapabilityMismatchError",
    "ConfigurationError",
    "EvalError",
    "FeatureDeferredError",
    "GateConfigurationError",
    "PipelineError",
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

    Streaming is the motivating case: the ``py-fastapi`` target advertises the
    ``streaming`` capability so the spec validator accepts specs that request it,
    but this runtime only does request/response today. Failing loudly here is the
    point -- a silently non-streaming "stream" would be worse than no stream.
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


class EvalError(AidRuntimeError):
    """An eval run could not be completed."""


class GateConfigurationError(EvalError):
    """The gate was configured in a way that cannot be trusted as a CI signal.

    The load-bearing case: a threshold that references a metric whose result is
    itself produced by a model. Gating on one source of non-determinism using
    another is not a gate.
    """
