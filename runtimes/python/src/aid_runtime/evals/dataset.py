"""Eval datasets: the probabilistic analogue of a golden fixture.

A dataset is versioned and committed. The version matters as much as the cases:
comparing a run against a baseline recorded on a *different* dataset version is
the most common way an eval gate becomes noise, so the gate refuses it.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from aid_runtime.errors import EvalError

__all__ = ["Dataset", "EvalCase"]


class EvalCase(BaseModel):
    """One input, its expected output, and any tags the metrics key off."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(min_length=1)
    input: str
    expected: str | None = None
    tags: tuple[str, ...] = ()
    metadata: dict[str, str] = Field(default_factory=dict)


class Dataset(BaseModel):
    """An ordered, versioned set of cases."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    cases: tuple[EvalCase, ...] = Field(min_length=1)

    @field_validator("cases", mode="before")
    @classmethod
    def _coerce_cases(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value

    def __len__(self) -> int:
        return len(self.cases)

    def ids(self) -> tuple[str, ...]:
        return tuple(case.id for case in self.cases)

    def case(self, case_id: str) -> EvalCase:
        for candidate in self.cases:
            if candidate.id == case_id:
                return candidate
        raise EvalError(f"dataset {self.name!r} has no case {case_id!r}")

    def by_tag(self, tag: str) -> tuple[EvalCase, ...]:
        return tuple(case for case in self.cases if tag in case.tags)

    @classmethod
    def from_records(cls, name: str, version: str, records: list[dict[str, object]]) -> Dataset:
        return cls.model_validate({"name": name, "version": version, "cases": records})

    @classmethod
    def from_json(cls, payload: str) -> Dataset:
        return cls.model_validate_json(payload)

    @classmethod
    def from_path(cls, path: Path | str) -> Dataset:
        return cls.from_json(Path(path).read_text(encoding="utf-8"))

    def to_json(self) -> str:
        """Canonical JSON: sorted keys, so a dataset diff is reviewable."""
        return json.dumps(self.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
