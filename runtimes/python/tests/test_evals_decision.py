"""A ``score`` decision measured as an eval metric.

Two things are pinned here beyond the arithmetic: the metric asks reproducibly, so a
vendor temperature change cannot move a recorded score, and a vendor failure raises
instead of scoring. A ``0.0`` would look like a regression the candidate caused.
"""

from __future__ import annotations

from typing import Any

import pytest

from aid_runtime.agents.ir import DecisionDefinition
from aid_runtime.decisions import DecisionAnswer, DecisionQuestion, DecisionResponse
from aid_runtime.errors import ConfigurationError, EvalError
from aid_runtime.evals import DecisionScore, EvalCase

DEFINITION = DecisionDefinition(
    id="helpfulness",
    model="jev-1.14.0",
    instructions="How helpful is this answer",
    criteria=("unusable", "partial", "complete"),
)


class FakeAsker:
    """A ``DecisionAsker`` returning one scripted answer, and recording the call."""

    def __init__(self, answer: DecisionAnswer | None, *, key: str = "helpfulness") -> None:
        self._answer = answer
        self._key = key
        self.calls: list[dict[str, Any]] = []

    async def decide(
        self,
        *,
        model: str,
        state: Any,
        questions: Any,
        reproducible: bool = False,
    ) -> DecisionResponse:
        self.calls.append(
            {
                "model": model,
                "state": state,
                "questions": dict(questions),
                "reproducible": reproducible,
            }
        )
        answers = {} if self._answer is None else {self._key: self._answer}
        return DecisionResponse(model=model, answers=answers)


def metric_for(answer: DecisionAnswer | None, **kwargs: Any) -> tuple[DecisionScore, FakeAsker]:
    asker = FakeAsker(answer)
    return DecisionScore(DEFINITION, client_factory=lambda: asker, **kwargs), asker


CASE = EvalCase(id="a", input="Q", expected="A")


def scored(level: float) -> DecisionAnswer:
    return DecisionAnswer(type="score", score=level)


async def test_a_score_metric_is_not_deterministic() -> None:
    metric, _ = metric_for(scored(3))

    assert metric.name == "decision"
    assert metric.deterministic is False


@pytest.mark.parametrize(("level", "expected"), [(1, 0.0), (2, 0.5), (3, 1.0)])
async def test_the_ordered_criteria_position_maps_onto_the_unit_interval(
    level: int, expected: float
) -> None:
    metric, _ = metric_for(scored(level))

    assert (await metric.score(CASE, "answer")).score == expected


async def test_the_detail_names_the_level_and_the_number_of_levels() -> None:
    metric, _ = metric_for(scored(2))

    assert (await metric.score(CASE, "answer")).detail == "level 2 of 3"


async def test_the_threshold_marks_a_single_answer_as_passing() -> None:
    at_half, _ = metric_for(scored(2))
    at_bottom, _ = metric_for(scored(1))

    assert (await at_half.score(CASE, "answer")).passed is True
    assert (await at_bottom.score(CASE, "answer")).passed is False


async def test_the_metric_asks_the_decision_it_was_built_from() -> None:
    metric, asker = metric_for(scored(3))

    await metric.score(CASE, "the prediction")

    assert asker.calls == [
        {
            "model": "jev-1.14.0",
            "state": "the prediction",
            "questions": {
                "helpfulness": DecisionQuestion(
                    type="score",
                    instructions="How helpful is this answer",
                    criteria=("unusable", "partial", "complete"),
                )
            },
            # A recorded score has to mean the same thing when the eval runs again.
            "reproducible": True,
        }
    ]


async def test_a_missing_answer_raises_rather_than_scoring_zero() -> None:
    metric, _ = metric_for(None)

    with pytest.raises(EvalError, match="returned no score"):
        await metric.score(CASE, "answer")


async def test_an_answer_without_a_score_raises() -> None:
    metric, _ = metric_for(DecisionAnswer(type="score"))

    with pytest.raises(EvalError, match="returned no score"):
        await metric.score(CASE, "answer")


@pytest.mark.parametrize("level", [0, 4])
async def test_a_level_outside_the_declared_range_raises(level: int) -> None:
    metric, _ = metric_for(scored(level))

    with pytest.raises(EvalError, match=r"outside the declared 1\.\.3 range"):
        await metric.score(CASE, "answer")


def test_a_decision_with_fewer_than_two_levels_cannot_be_scored() -> None:
    single = DecisionDefinition(
        id="helpfulness",
        model="jev-1.14.0",
        instructions="How helpful is this answer",
        criteria=("complete",),
    )

    with pytest.raises(ConfigurationError, match="at least two ordered levels"):
        DecisionScore(single)
