"""Cost accounting and budget enforcement.

Cost is the budget this runtime enforces in Phase 0. A latency p95 budget is
deliberately absent: it is only meaningful next to a dashboard, and a gate nobody
reads is not a gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

from aid_runtime.errors import BudgetExceededError
from aid_runtime.types import ModelSpec, TokenUsage

__all__ = [
    "Budget",
    "CostLedger",
    "LedgerEntry",
    "SpendSummary",
    "estimate_cost_usd",
    "estimate_prompt_cost_usd",
]

# Prices are quoted per 1k tokens, so a call costs fractions of a cent. Six
# decimals keeps a single call representable without letting float error
# accumulate visibly over a long run.
_USD_PRECISION = 6

NonNegativeUsd = Annotated[float, Field(ge=0.0)]


class Budget(BaseModel):
    """A spending ceiling for one scope (a run, a request, a nightly job)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    max_usd: NonNegativeUsd | None = None
    max_total_tokens: int | None = Field(default=None, gt=0)
    scope: str = "run"

    @model_validator(mode="after")
    def _at_least_one_ceiling(self) -> Budget:
        if self.max_usd is None and self.max_total_tokens is None:
            raise ValueError("a budget must set max_usd, max_total_tokens, or both")
        return self


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """One charged model call."""

    alias: str
    model: str
    provider: str
    usage: TokenUsage
    cost_usd: float


class SpendSummary(BaseModel):
    """Aggregate spend, suitable for a log line or an OTel span attribute."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    calls: int = Field(ge=0)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_usd: NonNegativeUsd
    by_model: dict[str, float] = Field(default_factory=dict)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def estimate_cost_usd(spec: ModelSpec, usage: TokenUsage) -> float:
    """Price a call against a pinned model's published cost."""
    return spec.cost.cost_usd(usage)


def estimate_prompt_cost_usd(spec: ModelSpec, text: str) -> float:
    """Rough pre-flight price for a prompt, used to fail before spending.

    Four characters per token is the usual English approximation. It is
    deliberately an over-estimate: refusing a call that would have fit is a
    recoverable annoyance; overshooting a hard budget is not.
    """
    estimated = TokenUsage(input_tokens=(len(text) + 3) // 4, output_tokens=0)
    return spec.cost.cost_usd(estimated)


class CostLedger:
    """Accumulates spend and refuses to let a budget be crossed.

    The ledger is intentionally not thread-safe and not async-safe: a gateway owns
    one ledger per logical run, and sharing one across concurrent runs would make
    "spent so far" meaningless.
    """

    def __init__(self) -> None:
        self._entries: list[LedgerEntry] = []

    @property
    def entries(self) -> tuple[LedgerEntry, ...]:
        return tuple(self._entries)

    @property
    def cost_usd(self) -> float:
        return round(sum(entry.cost_usd for entry in self._entries), _USD_PRECISION)

    @property
    def total_tokens(self) -> int:
        return sum(entry.usage.total_tokens for entry in self._entries)

    def check(self, budget: Budget) -> None:
        """Raise if current spend already violates ``budget``."""
        self._check_usd(budget)
        self._check_tokens(budget)

    def charge(self, budget: Budget | None, entry: LedgerEntry) -> None:
        """Record a call, raising :class:`BudgetExceededError` if it overshoots.

        The entry is recorded before the check so the ledger reflects what was
        actually spent when the error propagates -- a caller that catches the
        error still sees truthful accounting.
        """
        self._entries.append(entry)
        if budget is None:
            return
        self.check(budget)

    def summary(self) -> SpendSummary:
        by_model: dict[str, float] = {}
        for entry in self._entries:
            by_model[entry.model] = round(
                by_model.get(entry.model, 0.0) + entry.cost_usd, _USD_PRECISION
            )
        return SpendSummary(
            calls=len(self._entries),
            input_tokens=sum(e.usage.input_tokens for e in self._entries),
            output_tokens=sum(e.usage.output_tokens for e in self._entries),
            cost_usd=self.cost_usd,
            by_model=by_model,
        )

    def _check_usd(self, budget: Budget) -> None:
        if budget.max_usd is None:
            return
        spent = self.cost_usd
        if spent > budget.max_usd:
            raise BudgetExceededError(budget.scope, budget.max_usd, spent)

    def _check_tokens(self, budget: Budget) -> None:
        if budget.max_total_tokens is None:
            return
        spent_tokens = self.total_tokens
        if spent_tokens > budget.max_total_tokens:
            raise BudgetExceededError(
                budget.scope, float(budget.max_total_tokens), float(spent_tokens), unit="tokens"
            )
