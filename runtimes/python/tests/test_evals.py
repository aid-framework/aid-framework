"""Metrics, the runner, and the N-run sampler.

Everything here is scripted rather than sampled: the gate's behaviour against a
genuinely varying provider is the subject of ``test_evals_gate.py``, and duplicating
that here would make the same failure appear twice without adding a distinction.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

import pytest

from aid_runtime import (
    CompletionRequest,
    Dataset,
    DatasetRun,
    EvalCase,
    EvalError,
    ExactMatch,
    FakeProvider,
    GatewayRunner,
    JsonSchemaValid,
    LlmJudge,
    ModelGateway,
    NormalizedContains,
    Runner,
    UnknownModelAliasError,
    default_metrics,
    evaluate_once,
    gateway_judge,
    metric_names,
    normalize,
    run_evaluation,
)
from aid_runtime.evals.metrics import JudgeCall

SMALL_ALIAS = "small"


def _scripted(replies: Mapping[str, str]) -> Runner:
    async def run(case: EvalCase) -> str:
        return replies[case.id]

    return run


def _reply_json(payload: str) -> JudgeCall:
    async def call(prompt: str) -> str:
        return payload

    return call


async def _all_correct(dataset: Dataset) -> DatasetRun:
    async def runner(case: EvalCase) -> str:
        return case.expected or ""

    return await evaluate_once(dataset, runner, [ExactMatch()])


def test_normalize_casefolds_collapses_whitespace_and_strips_punctuation() -> None:
    assert normalize("  Paris,   FRANCE!  ") == "paris, france"
    assert normalize('"paris"') == "paris"
    assert normalize("???") == ""


async def test_exact_match_scores_normalized_equality(cases: tuple[EvalCase, ...]) -> None:
    metric = ExactMatch()

    assert metric.name == "exact-match"
    assert metric.deterministic is True
    assert (await metric.score(cases[0], "  Paris. ")).passed is True

    missed = await metric.score(cases[0], "Paris, France")
    assert missed.score == 0.0
    assert missed.detail == "expected 'paris'"


async def test_exact_match_without_an_expectation_is_an_error() -> None:
    with pytest.raises(EvalError, match="has no expected value for exact-match"):
        await ExactMatch().score(EvalCase(id="open", input="Q"), "anything")


async def test_contains_accepts_a_longer_answer(cases: tuple[EvalCase, ...]) -> None:
    metric = NormalizedContains()

    assert metric.name == "contains"
    assert metric.deterministic is True
    assert (await metric.score(cases[0], "The capital is Paris.")).passed is True

    missed = await metric.score(cases[0], "The capital is Lyon")
    assert missed.score == 0.0
    assert missed.detail == "missing 'paris'"


async def test_contains_without_an_expectation_is_an_error() -> None:
    with pytest.raises(EvalError, match="has no expected value for contains"):
        await NormalizedContains().score(EvalCase(id="open", input="Q"), "anything")


async def test_json_valid_accepts_any_parseable_json_without_a_declared_schema() -> None:
    metric = JsonSchemaValid()
    assert metric.name == "json-valid"
    assert metric.deterministic is True

    result = await metric.score(EvalCase(id="a", input="Q"), '{"a": 1}')
    assert result.passed is True
    assert result.detail == "parsed"


async def test_json_valid_reports_unparseable_output() -> None:
    result = await JsonSchemaValid().score(EvalCase(id="a", input="Q"), "not json")

    assert result.score == 0.0
    assert result.detail.startswith("invalid JSON: ")


async def test_json_valid_checks_the_schema_declared_in_the_case_metadata() -> None:
    schema = json.dumps(
        {
            "type": "object",
            "required": ["city"],
            "properties": {"city": {"type": "string"}},
        }
    )
    case = EvalCase(id="a", input="Q", metadata={"json_schema": schema})
    metric = JsonSchemaValid()

    assert (await metric.score(case, '{"city": "Lima"}')).passed is True

    wrong = await metric.score(case, '{"city": 3}')
    assert wrong.passed is False
    assert wrong.detail == "$.city: expected string, got int"

    absent = await metric.score(case, "{}")
    assert absent.detail == "$: missing required property 'city'"


async def test_json_valid_walks_array_items_and_nested_objects() -> None:
    schema = json.dumps(
        {
            "type": "array",
            "items": {"type": "object", "properties": {"n": {"type": "integer"}}},
        }
    )
    case = EvalCase(id="a", input="Q", metadata={"json_schema": schema})
    metric = JsonSchemaValid()

    assert (await metric.score(case, '[{"n": 1}]')).passed is True

    nested = await metric.score(case, '[{"n": 1}, {"n": "x"}]')
    assert nested.detail == "$[1].n: expected integer, got str"

    wrong_root = await metric.score(case, '"a string"')
    assert wrong_root.detail == "$: expected array, got str"


async def test_json_valid_rejects_a_boolean_where_a_number_is_declared() -> None:
    schema = json.dumps({"type": "object", "properties": {"n": {"type": "number"}}})
    case = EvalCase(id="a", input="Q", metadata={"json_schema": schema})

    result = await JsonSchemaValid().score(case, '{"n": true}')
    assert result.detail == "$.n: expected number, got bool"


async def test_a_malformed_schema_in_a_case_is_a_hard_error_not_a_zero() -> None:
    case = EvalCase(id="a", input="Q", metadata={"json_schema": "{not json"})
    with pytest.raises(json.JSONDecodeError):
        await JsonSchemaValid().score(case, "{}")


def test_default_metrics_are_the_deterministic_three() -> None:
    metrics = default_metrics()

    assert metric_names(metrics) == ("exact-match", "contains", "json-valid")
    assert all(metric.deterministic for metric in metrics)


async def test_the_llm_judge_declares_itself_nondeterministic() -> None:
    judge = LlmJudge(_reply_json('{"score": 1.0}'), rubric="r")
    assert judge.name == "llm-judge"
    assert judge.deterministic is False


async def test_the_llm_judge_scores_from_the_verdict_it_receives(
    cases: tuple[EvalCase, ...],
) -> None:
    judge = LlmJudge(_reply_json('{"score": 0.8, "reason": "close enough"}'), rubric="r")
    result = await judge.score(cases[0], "paris")

    assert result.metric == "llm-judge"
    assert result.score == 0.8
    assert result.passed is True
    assert result.detail == "close enough"


async def test_the_llm_judge_fails_a_low_score(cases: tuple[EvalCase, ...]) -> None:
    judge = LlmJudge(_reply_json('{"score": 0.2}'), rubric="r")
    assert (await judge.score(cases[0], "lyon")).passed is False


async def test_a_broken_judge_is_a_zero_rather_than_an_exception(
    cases: tuple[EvalCase, ...],
) -> None:
    judge = LlmJudge(_reply_json("no json at all"), rubric="r", retries=0)
    result = await judge.score(cases[0], "lyon")

    assert result.score == 0.0
    assert result.passed is False
    assert result.detail.startswith("judge failed: ")


async def test_the_judge_prompt_carries_the_rubric_the_reference_and_the_candidate(
    cases: tuple[EvalCase, ...],
) -> None:
    prompts: list[str] = []

    async def call(prompt: str) -> str:
        prompts.append(prompt)
        return '{"score": 1.0}'

    judge = LlmJudge(call, rubric="Be strict about capitals.")
    await judge.score(cases[0], "Paris")

    assert "Be strict about capitals." in prompts[0]
    assert "Reference: paris" in prompts[0]
    assert "Candidate: Paris" in prompts[0]


async def test_a_case_without_a_reference_says_so_in_the_judge_prompt() -> None:
    prompts: list[str] = []

    async def call(prompt: str) -> str:
        prompts.append(prompt)
        return '{"score": 1.0}'

    await LlmJudge(call, rubric="r").score(EvalCase(id="open", input="Q"), "answer")
    assert "Reference: <not provided>" in prompts[0]


async def test_evaluate_once_scores_every_case_with_every_metric(dataset: Dataset) -> None:
    replies = {
        "capital-fr": "paris",
        "capital-jp": "tokyo",
        "capital-pe": "lima",
        "capital-ke": "mombasa",
    }
    run = await evaluate_once(dataset, _scripted(replies), default_metrics())

    assert run.dataset == "capitals"
    assert run.dataset_version == "1.0.0"
    assert [outcome.case_id for outcome in run.outcomes] == list(dataset.ids())
    assert len(run.outcomes[0].scores) == 3

    assert run.means() == {"exact-match": 0.75, "contains": 0.75, "json-valid": 0.0}

    # A case passes only when every metric passes, and ``json-valid`` scores 0.0
    # for every plain-word prediction -- so a run over the default metric set
    # fails everywhere. The per-metric means above are the informative signal.
    assert [outcome.case_id for outcome in run.failures()] == list(dataset.ids())


async def test_a_case_fails_when_only_one_of_its_metrics_fails(dataset: Dataset) -> None:
    replies = {
        "capital-fr": "paris",
        "capital-jp": "tokyo",
        "capital-pe": "lima",
        "capital-ke": "mombasa",
    }
    run = await evaluate_once(dataset, _scripted(replies), [ExactMatch(), NormalizedContains()])

    assert [outcome.case_id for outcome in run.failures()] == ["capital-ke"]
    assert run.outcome("capital-ke").passed is False
    assert [score.metric for score in run.outcome("capital-ke").scores] == [
        "exact-match",
        "contains",
    ]
    assert run.means() == {"exact-match": 0.75, "contains": 0.75}


async def test_a_case_without_an_expectation_cannot_be_judged_by_exact_match() -> None:
    dataset = Dataset(name="d", version="1", cases=(EvalCase(id="open", input="Q"),))
    with pytest.raises(EvalError, match="has no expected value"):
        await evaluate_once(dataset, _scripted({"open": "anything"}), [ExactMatch()])


async def test_evaluate_once_requires_at_least_one_metric(dataset: Dataset) -> None:
    with pytest.raises(ValueError, match="at least one metric is required"):
        await evaluate_once(dataset, _scripted({}), [])


async def test_the_run_summary_names_the_failing_cases(dataset: Dataset) -> None:
    replies = {
        "capital-fr": "paris",
        "capital-jp": "tokyo",
        "capital-pe": "lima",
        "capital-ke": "mombasa",
    }
    run = await evaluate_once(dataset, _scripted(replies), [ExactMatch(), NormalizedContains()])
    lines = run.summary().splitlines()

    assert lines[0] == "capitals@1.0.0: 3/4 cases passed"
    assert "  exact-match: 0.7500" in lines
    assert "  contains: 0.7500" in lines
    assert any(
        line.startswith("  FAIL capital-ke: exact-match: expected 'nairobi'") for line in lines
    )


async def test_outcome_lookup_and_its_absent_case_error(dataset: Dataset) -> None:
    run = await _all_correct(dataset)

    assert run.outcome("capital-fr").prediction == "paris"
    assert run.outcome("capital-fr").passed is True
    assert run.outcome("capital-fr").scores[0].metric == "exact-match"

    with pytest.raises(EvalError, match="no outcome recorded for case 'absent'"):
        run.outcome("absent")


async def test_run_evaluation_samples_the_dataset_once_per_run(dataset: Dataset) -> None:
    calls = 0

    async def runner(case: EvalCase) -> str:
        nonlocal calls
        calls += 1
        return case.expected or ""

    run = await run_evaluation(dataset, runner, [ExactMatch()], runs=3)

    assert calls == 12
    assert run.runs == 3
    assert run.values_for("exact-match") == (1.0, 1.0, 1.0)
    assert run.means()["exact-match"] == 1.0
    assert run.spread()["exact-match"] == 0.0
    assert run.is_varying() is False


async def test_run_evaluation_records_variation_across_runs(dataset: Dataset) -> None:
    calls = 0

    async def runner(case: EvalCase) -> str:
        nonlocal calls
        calls += 1
        return (case.expected or "") if calls <= 4 else "wrong"

    run = await run_evaluation(dataset, runner, [ExactMatch()], runs=2)

    assert run.values_for("exact-match") == (1.0, 0.0)
    assert run.is_varying() is True


async def test_values_for_an_absent_metric_raises(dataset: Dataset) -> None:
    async def runner(case: EvalCase) -> str:
        return case.expected or ""

    run = await run_evaluation(dataset, runner, [ExactMatch()], runs=1)
    with pytest.raises(EvalError, match="is not in this run"):
        run.values_for("llm-judge")


async def test_run_evaluation_requires_runs_and_metrics(dataset: Dataset) -> None:
    async def runner(case: EvalCase) -> str:
        return ""

    with pytest.raises(ValueError, match="runs must be at least 1"):
        await run_evaluation(dataset, runner, [ExactMatch()], runs=0)
    with pytest.raises(ValueError, match="at least one metric is required"):
        await run_evaluation(dataset, runner, [], runs=1)


async def test_gateway_runner_defaults_to_one_user_message(
    gateway: ModelGateway, dataset: Dataset, provider: FakeProvider
) -> None:
    runner = GatewayRunner(gateway, SMALL_ALIAS)
    prediction = await runner(dataset.case("capital-fr"))

    assert runner.alias == SMALL_ALIAS
    assert prediction.startswith("echo:")
    (request,) = provider.calls
    assert [(message.role, message.content) for message in request.messages] == [
        ("user", "Capital of France?")
    ]


async def test_gateway_runner_applies_sampling_options_and_a_system_message(
    gateway: ModelGateway, dataset: Dataset, provider: FakeProvider
) -> None:
    runner = GatewayRunner(
        gateway, SMALL_ALIAS, system="Be brief.", temperature=0.0, max_output_tokens=16
    )
    await runner(dataset.case("capital-jp"))

    (request,) = provider.calls
    assert [(message.role, message.content) for message in request.messages] == [
        ("system", "Be brief."),
        ("user", "Capital of Japan?"),
    ]
    assert request.temperature == 0.0
    assert request.max_output_tokens == 16


async def test_a_custom_request_for_owns_the_request_entirely(
    gateway: ModelGateway, dataset: Dataset, provider: FakeProvider
) -> None:
    def request_for(case: EvalCase) -> CompletionRequest:
        return CompletionRequest.prompt(f"Q: {case.input}", system="custom")

    runner = GatewayRunner(gateway, SMALL_ALIAS, system="ignored", request_for=request_for)
    await runner(dataset.case("capital-jp"))

    (request,) = provider.calls
    assert [(message.role, message.content) for message in request.messages] == [
        ("system", "custom"),
        ("user", "Q: Capital of Japan?"),
    ]


async def test_gateway_runner_reports_the_ledger_cost(
    gateway: ModelGateway, dataset: Dataset
) -> None:
    runner = GatewayRunner(gateway, SMALL_ALIAS)
    assert runner.cost_usd == 0.0

    await runner(dataset.case("capital-fr"))
    assert runner.cost_usd > 0.0


def test_gateway_runner_refuses_an_unknown_alias_when_it_is_built(
    gateway: ModelGateway,
) -> None:
    with pytest.raises(UnknownModelAliasError):
        GatewayRunner(gateway, "not-a-model")


async def test_gateway_judge_turns_the_gateway_into_a_judge_call(
    gateway: ModelGateway, provider: FakeProvider
) -> None:
    call = await gateway_judge(gateway, SMALL_ALIAS, system="Be strict.")
    reply = await call("Is this good?")

    assert reply.startswith("echo:")
    (request,) = provider.calls
    assert [(message.role, message.content) for message in request.messages] == [
        ("system", "Be strict."),
        ("user", "Is this good?"),
    ]
