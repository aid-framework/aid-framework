"""Datasets: the committed fixture an eval compares *like with like*.

A dataset is the denominator of every score. If it is not versioned and
canonical on disk, a baseline comparison silently measures a different thing
than the one that was recorded.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from aid_runtime import Dataset, EvalCase, EvalError


def _dataset(*, tags: tuple[str, ...] = ()) -> Dataset:
    return Dataset(
        name="d",
        version="1.0.0",
        cases=(
            EvalCase(id="a", input="Q a", expected="A a", tags=tags),
            EvalCase(id="b", input="Q b", expected="A b"),
        ),
    )


def test_a_case_needs_an_id_and_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        EvalCase(id="", input="Q")
    with pytest.raises(ValidationError):
        EvalCase.model_validate({"id": "a", "input": "Q", "unexpected": 1})


def test_expected_defaults_to_none_so_an_open_ended_case_is_expressible() -> None:
    case = EvalCase(id="a", input="Q")
    assert case.expected is None
    assert case.tags == ()
    assert case.metadata == {}


def test_a_dataset_needs_a_name_a_version_and_at_least_one_case() -> None:
    with pytest.raises(ValidationError):
        Dataset(name="d", version="1", cases=())
    with pytest.raises(ValidationError):
        Dataset(name="", version="1", cases=(EvalCase(id="a", input="Q"),))
    with pytest.raises(ValidationError):
        Dataset(name="d", version="", cases=(EvalCase(id="a", input="Q"),))


def test_a_dataset_coerces_a_list_of_cases_to_a_tuple() -> None:
    dataset = Dataset.model_validate(
        {"name": "d", "version": "1", "cases": [{"id": "a", "input": "Q"}]}
    )
    assert dataset.cases == (EvalCase(id="a", input="Q"),)


def test_length_and_ids_report_the_case_order_on_disk() -> None:
    dataset = _dataset()
    assert len(dataset) == 2
    assert dataset.ids() == ("a", "b")


def test_lookup_by_id_returns_the_case() -> None:
    assert _dataset().case("b") == EvalCase(id="b", input="Q b", expected="A b")


def test_lookup_by_an_unknown_id_raises_rather_than_returning_none() -> None:
    with pytest.raises(EvalError, match="has no case 'missing'"):
        _dataset().case("missing")


def test_by_tag_filters_in_dataset_order_and_is_empty_when_nothing_matches() -> None:
    dataset = _dataset(tags=("smoke",))
    assert [case.id for case in dataset.by_tag("smoke")] == ["a"]
    assert dataset.by_tag("absent") == ()


def test_a_dataset_can_be_built_from_records() -> None:
    dataset = Dataset.from_records(
        "d", "2.0.0", [{"id": "a", "input": "Q", "expected": "A"}, {"id": "b", "input": "Q2"}]
    )
    assert dataset.ids() == ("a", "b")
    assert dataset.version == "2.0.0"
    assert dataset.case("b").expected is None


def test_to_json_is_sorted_newline_terminated_and_round_trips() -> None:
    dataset = _dataset()
    payload = dataset.to_json()

    assert payload.endswith("\n")
    decoded = json.loads(payload)
    assert list(decoded) == ["cases", "name", "version"]
    assert list(decoded["cases"][0]) == ["expected", "id", "input", "metadata", "tags"]

    assert Dataset.from_json(payload) == dataset


def test_a_dataset_round_trips_through_a_path(tmp_path: Path) -> None:
    dataset = _dataset()
    path = tmp_path / "capitals.json"
    path.write_text(dataset.to_json(), encoding="utf-8")

    assert Dataset.from_path(path) == dataset
    assert Dataset.from_path(str(path)) == dataset
