"""The TypeSafe AI decision client, against a `MockTransport`.

No network is touched: the client's job is to shape a System One request and to
interpret the typed reply, and both are asserted on the bytes that would have
gone over the wire.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from aid_runtime import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.decisions import (
    DEFAULT_TYPESAFE_BASE_URL,
    DecisionClient,
    DecisionQuestion,
    decision_key,
    is_reproducible_model,
)

API_KEY = "ts-test-not-a-real-key"
MODEL = "jev-1.14.0"


class Recorder:
    """A transport handler that records requests and replays queued responses."""

    def __init__(self, *responses: httpx.Response) -> None:
        self.requests: list[httpx.Request] = []
        self.payloads: list[dict[str, Any]] = []
        self._responses = list(responses)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.payloads.append(json.loads(request.content))
        if not self._responses:
            raise AssertionError("the client sent more requests than the test queued responses")
        return self._responses.pop(0)


def _client(recorder: Recorder, **overrides: Any) -> DecisionClient:
    transport = httpx.MockTransport(recorder.handle)
    options: dict[str, Any] = {
        "api_key": API_KEY,
        "client": httpx.AsyncClient(transport=transport),
    }
    options.update(overrides)
    return DecisionClient(**options)


def _reply(
    answers: dict[str, Any],
    *,
    model: str = MODEL,
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "model": model,
            "answers": answers,
            "usage": {"input_tokens": 430, "output_tokens": 0},
        },
        headers=headers,
    )


def test_key_prefers_the_first_party_name() -> None:
    assert decision_key({"TYPESAFE_API_KEY": "a", "TYPESAFE_AI_API_KEY": "b"}) == "a"


def test_key_falls_back_to_the_vercel_spelling() -> None:
    assert decision_key({"TYPESAFE_AI_API_KEY": "b"}) == "b"


def test_an_empty_key_counts_as_unset() -> None:
    assert decision_key({"TYPESAFE_API_KEY": "", "TYPESAFE_AI_API_KEY": "b"}) == "b"
    assert decision_key({}) is None


def test_a_missing_key_is_a_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.delenv("TYPESAFE_AI_API_KEY", raising=False)
    with pytest.raises(ConfigurationError, match="TYPESAFE_API_KEY"):
        DecisionClient()


@pytest.mark.asyncio
async def test_choice_round_trip() -> None:
    recorder = Recorder(
        _reply(
            {
                "triage": {
                    "choice": "billing",
                    "confidence": 0.91,
                    "probabilities": {"billing": 0.91, "technical": 0.09},
                }
            }
        )
    )
    client = _client(recorder)
    response = await client.decide(
        model=MODEL,
        state={"message": "I was charged twice"},
        questions={
            "triage": DecisionQuestion(
                type="choice",
                instructions="Which team should handle this",
                criteria=("billing", "technical"),
            )
        },
    )

    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url) == f"{DEFAULT_TYPESAFE_BASE_URL}/v1/systemone"
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    assert recorder.payloads[0] == {
        "model": MODEL,
        "state": {"message": "I was charged twice"},
        "questions": {
            "triage": {
                "type": "choice",
                "instructions": "Which team should handle this",
                "criteria": ["billing", "technical"],
            }
        },
    }

    answer = response.answers["triage"]
    assert answer.type == "choice"
    assert answer.choice == "billing"
    assert answer.confidence == 0.91
    assert answer.probabilities == {"billing": 0.91, "technical": 0.09}
    assert response.model == MODEL
    assert response.input_tokens == 430
    assert response.output_tokens == 0


@pytest.mark.asyncio
async def test_score_keeps_the_legend() -> None:
    recorder = Recorder(
        _reply(
            {
                "quality": {
                    "score": 3,
                    "confidence": 0.7,
                    "legend": "bad",
                    "probabilities": {"bad": 0.7, "good": 0.3},
                }
            }
        )
    )
    client = _client(recorder)
    response = await client.decide(
        model=MODEL,
        state="the answer",
        questions={
            "quality": DecisionQuestion(
                type="score",
                instructions="Rate the answer",
                criteria=("bad", "good"),
            )
        },
    )

    answer = response.answers["quality"]
    assert answer.score == 3
    assert answer.legend == "bad"
    assert answer.confidence == 0.7


@pytest.mark.asyncio
async def test_noul_has_no_confidence_field() -> None:
    recorder = Recorder(_reply({"urgent": {"noul": 0.12}}))
    client = _client(recorder)
    response = await client.decide(
        model=MODEL,
        state="when is this due",
        questions={
            "urgent": DecisionQuestion(type="noul", instructions="The message conveys urgency")
        },
    )

    answer = response.answers["urgent"]
    assert answer.noul == 0.12
    assert answer.confidence is None
    assert recorder.payloads[0]["questions"]["urgent"] == {
        "type": "noul",
        "instructions": "The message conveys urgency",
    }


@pytest.mark.asyncio
async def test_a_noul_answer_with_confidence_is_refused() -> None:
    recorder = Recorder(_reply({"urgent": {"noul": 0.12, "confidence": 0.9}}))
    client = _client(recorder)
    with pytest.raises(ProviderResponseError, match="must not carry 'confidence'"):
        await client.decide(
            model=MODEL,
            state="x",
            questions={"urgent": DecisionQuestion(type="noul", instructions="Is it urgent")},
        )


@pytest.mark.asyncio
async def test_a_choice_answer_without_confidence_is_refused() -> None:
    recorder = Recorder(_reply({"triage": {"choice": "billing"}}))
    client = _client(recorder)
    with pytest.raises(ProviderResponseError, match="must carry 'confidence'"):
        await client.decide(
            model=MODEL,
            state="x",
            questions={
                "triage": DecisionQuestion(
                    type="choice", instructions="Which", criteria=("billing", "technical")
                )
            },
        )


@pytest.mark.asyncio
async def test_429_is_retried_and_retry_after_is_honoured() -> None:
    recorder = Recorder(
        httpx.Response(429, headers={"retry-after": "0"}),
        _reply({"urgent": {"noul": 0.4}}),
    )
    client = _client(recorder)
    response = await client.decide(
        model=MODEL,
        state="x",
        questions={"urgent": DecisionQuestion(type="noul", instructions="Is it urgent")},
    )

    assert len(recorder.requests) == 2
    assert response.answers["urgent"].noul == 0.4


@pytest.mark.asyncio
async def test_a_4xx_is_not_retried() -> None:
    recorder = Recorder(httpx.Response(400, text="bad request"))
    client = _client(recorder)
    with pytest.raises(ProviderError, match="returned 400"):
        await client.decide(
            model=MODEL,
            state="x",
            questions={"urgent": DecisionQuestion(type="noul", instructions="Is it urgent")},
        )
    assert len(recorder.requests) == 1


@pytest.mark.asyncio
async def test_reproducible_refuses_a_moving_alias() -> None:
    client = _client(Recorder())
    with pytest.raises(ConfigurationError, match="moving alias"):
        await client.decide(
            model="jev-latest",
            state="x",
            questions={"urgent": DecisionQuestion(type="noul", instructions="Is it urgent")},
            reproducible=True,
        )


def test_question_types_are_validated() -> None:
    with pytest.raises(ConfigurationError, match="takes no criteria"):
        DecisionQuestion(type="noul", instructions="x", criteria=("a",))
    with pytest.raises(ConfigurationError, match="needs at least one criterion"):
        DecisionQuestion(type="choice", instructions="x")
    with pytest.raises(ConfigurationError, match="between 2 and 10"):
        DecisionQuestion(type="score", instructions="x", criteria=("a",))
    with pytest.raises(ConfigurationError, match="needs instructions"):
        DecisionQuestion(type="noul", instructions="  ")


def test_aliases_are_not_reproducible() -> None:
    assert is_reproducible_model("jev-1.14.0")
    assert not is_reproducible_model("jev-latest")
    assert not is_reproducible_model("jev-preview")
