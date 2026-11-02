"""The TypeSafe AI (Jev) decision client.

Jev is a *System One* model, not a chat model: it takes a state and typed
questions and returns typed answers. It has no ``/v1/chat/completions``
surface, no free-text output and no tool calls, so it is deliberately not a
member of :mod:`aid_runtime.providers`. Putting it there would let a pipeline
select it as the model that writes an answer, which it cannot do.

The four primitives map to the places a pipeline already needs a judgment:

``choice``
    one label out of a list -- routing, classification.
``score``
    a position on an ordered rubric -- eval scoring.
``noul``
    a probability in ``[0, 1]`` -- a cheap pre-filter.

Two facts drive the shape of this module:

**``noul`` answers carry no ``confidence`` at all.** ``choice`` and ``score``
answers do. A caller that branches on confidence must therefore refuse a
``noul`` decision rather than defaulting the missing value to zero, which
would silently disable the branch.

**A moving model alias cannot be used where a result must be reproducible.**
``jev-latest`` is legal for interactive routing and refused when
``reproducible=True``, which is what the eval harness passes.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from aid_runtime.errors import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.tracing import llm_span, record_attributes, record_cost, record_usage
from aid_runtime.types import TokenUsage

__all__ = [
    "DEFAULT_TYPESAFE_BASE_URL",
    "JEV_INPUT_USD_PER_MTOK",
    "JEV_MOVING_ALIASES",
    "TYPESAFE_API_KEY_ENVS",
    "TYPESAFE_BASE_URL_ENV",
    "DecisionAnswer",
    "DecisionClient",
    "DecisionQuestion",
    "DecisionResponse",
    "decision_cost_usd",
    "decision_key",
    "is_reproducible_model",
]

DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai"

#: The first-party SDK reads ``TYPESAFE_API_KEY``; Vercel's provider reads
#: ``TYPESAFE_AI_API_KEY``. Accept both, first-party name first.
TYPESAFE_API_KEY_ENVS = ("TYPESAFE_API_KEY", "TYPESAFE_AI_API_KEY")

TYPESAFE_BASE_URL_ENV = "TYPESAFE_BASE_URL"

#: Aliases that move to a new model version. Legal interactively, refused under
#: ``reproducible=True``.
JEV_MOVING_ALIASES = frozenset({"jev-latest", "jev-preview"})

#: Jev bills input tokens at $42 per billion ($0.042 per million) and states that
#: output tokens are free. A call therefore needs an input row only, and a
#: decision run must never be reported as unpriceable.
JEV_INPUT_USD_PER_MTOK = 0.042

QuestionType = Literal["choice", "score", "noul"]

_QUESTION_TYPES: frozenset[str] = frozenset({"choice", "score", "noul"})

#: 429 and 529 are the retryable classes the vendor names; both may carry
#: ``retry-after``. The rest are caller errors and are not retried.
_RETRYABLE_STATUS = frozenset({429, 529})


def decision_key(env: Mapping[str, str] | None = None) -> str | None:
    """Return the first configured TypeSafe key, or ``None``.

    Both the first-party name and Vercel's spelling are accepted. An empty
    string counts as unset, so a workflow that exports a missing secret does
    not authenticate with ``""``.
    """
    source = os.environ if env is None else env
    for name in TYPESAFE_API_KEY_ENVS:
        value = source.get(name)
        if value is not None and value != "":
            return value
    return None


def is_reproducible_model(model: str) -> bool:
    """Whether ``model`` is pinned to one version rather than a moving alias."""
    return model not in JEV_MOVING_ALIASES


def decision_cost_usd(input_tokens: int | None) -> float:
    """Price one decision call from its input tokens alone.

    Output tokens are free by contract, so they are deliberately not part of the
    arithmetic: a caller that passed a total would overcharge the run. ``None``
    means the vendor reported no usage; :meth:`DecisionClient.decide` then records
    no cost at all, so the call stays unknown rather than free.
    """
    if input_tokens is None:
        return 0.0
    return (input_tokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK


@dataclass(frozen=True, slots=True)
class DecisionQuestion:
    """One typed question.

    ``criteria`` is required by ``choice`` and ``score`` and forbidden by
    ``noul``, because a probability has nothing to choose between. ``score``
    criteria are ordered: the position is the score.
    """

    type: QuestionType
    instructions: str
    criteria: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        if self.type not in _QUESTION_TYPES:
            raise ConfigurationError(
                f"unknown decision question type {self.type!r}; expected one of "
                f"{', '.join(sorted(_QUESTION_TYPES))}"
            )
        if self.instructions.strip() == "":
            raise ConfigurationError("a decision question needs instructions")
        if self.type == "noul":
            if self.criteria is not None:
                raise ConfigurationError("a noul question takes no criteria")
            return
        if not self.criteria:
            raise ConfigurationError(f"a {self.type} question needs at least one criterion")
        if self.type == "score" and not 2 <= len(self.criteria) <= 10:
            raise ConfigurationError(
                "a score question needs between 2 and 10 ordered criteria; "
                f"got {len(self.criteria)}"
            )
        if self.type == "choice" and len(self.criteria) > 255:
            raise ConfigurationError("a choice question takes at most 255 criteria")

    def as_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": self.type, "instructions": self.instructions}
        if self.criteria is not None:
            payload["criteria"] = list(self.criteria)
        return payload


@dataclass(frozen=True, slots=True)
class DecisionAnswer:
    """One typed answer, with every field the question type can produce."""

    type: QuestionType
    choice: str | None = None
    score: float | None = None
    noul: float | None = None
    confidence: float | None = None
    probabilities: Mapping[str, float] | None = None
    legend: str | None = None
    raw: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class DecisionResponse:
    """``model`` is echoed by the vendor, so a trace records the version that
    actually answered -- the only way to explain a score that moved."""

    model: str
    answers: Mapping[str, DecisionAnswer]
    input_tokens: int | None = None
    output_tokens: int | None = None
    raw: Mapping[str, Any] | None = None


class DecisionClient:
    """Calls ``POST /v1/systemone`` and maps the reply to typed answers."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        name: str = "typesafe",
        timeout_seconds: float = 60.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.5,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_key = api_key if api_key is not None else decision_key()
        if resolved_key is None or resolved_key == "":
            raise ConfigurationError(
                "TypeSafe AI needs an API key; set TYPESAFE_API_KEY (or TYPESAFE_AI_API_KEY)"
            )
        resolved_base = (
            base_url or os.environ.get(TYPESAFE_BASE_URL_ENV) or DEFAULT_TYPESAFE_BASE_URL
        )
        if not resolved_base.startswith(("http://", "https://")):
            raise ConfigurationError(
                f"base_url must be an absolute http(s) URL, got {resolved_base!r}"
            )
        if max_attempts < 1:
            raise ConfigurationError("max_attempts must be at least 1")
        self._name = name
        self._base_url = resolved_base.rstrip("/")
        self._api_key = resolved_key
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._closed = False

    @property
    def name(self) -> str:
        return self._name

    async def decide(
        self,
        *,
        model: str,
        state: str | Mapping[str, Any] | Sequence[Any],
        questions: Mapping[str, DecisionQuestion],
        reproducible: bool = False,
    ) -> DecisionResponse:
        """Ask ``questions`` about ``state``.

        ``reproducible=True`` refuses a moving alias, because two runs of an
        eval would otherwise score two different models under one name.
        """
        if not questions:
            raise ConfigurationError("a decision needs at least one question")
        if reproducible and not is_reproducible_model(model):
            raise ConfigurationError(
                f"{model!r} is a moving alias and cannot be used where the result must be "
                "reproducible; pin a version such as 'jev-1.14.0'"
            )
        payload: dict[str, Any] = {
            "model": model,
            "state": state,
            "questions": {key: question.as_payload() for key, question in questions.items()},
        }
        # A decision is billed like any other model call, so it gets the same
        # span: `aid cost` and the eval budget read `aid.cost.usd` off it.
        with llm_span(model=model, provider=self._name, operation="decision") as span:
            body = await self._post(payload)
            response = self._parse(body, questions)
            if response.input_tokens is not None:
                usage = TokenUsage(
                    input_tokens=response.input_tokens,
                    output_tokens=response.output_tokens or 0,
                )
                record_usage(span, usage)
                record_cost(span, decision_cost_usd(usage.input_tokens))
            # The vendor echoes the version that actually answered, which is the
            # only record of what a moving alias resolved to.
            record_attributes(span, response_model=response.model)
            return response

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> DecisionClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
            "accept": "application/json",
        }

    async def _post(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        url = f"{self._base_url}/v1/systemone"
        attempt = 0
        while True:
            attempt += 1
            try:
                response = await self._client.post(url, json=payload, headers=self._headers())
            except httpx.HTTPError as error:
                if attempt >= self._max_attempts:
                    raise ProviderError(f"{self._name} request failed: {error}") from error
                await asyncio.sleep(self._backoff * attempt)
                continue

            if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
                await asyncio.sleep(self._retry_delay(response, attempt))
                continue
            if response.status_code >= 400:
                raise ProviderError(
                    f"{self._name} returned {response.status_code}: {response.text[:500]}"
                )
            try:
                parsed = response.json()
            except ValueError as error:
                raise ProviderResponseError(f"{self._name} returned non-JSON: {error}") from error
            if not isinstance(parsed, dict):
                raise ProviderResponseError(f"{self._name} returned a non-object body")
            return parsed

    def _retry_delay(self, response: httpx.Response, attempt: int) -> float:
        raw = response.headers.get("retry-after")
        if raw is not None:
            try:
                return max(0.0, float(raw))
            except ValueError:
                pass
        return self._backoff * attempt

    def _parse(
        self, body: Mapping[str, Any], questions: Mapping[str, DecisionQuestion]
    ) -> DecisionResponse:
        model = body.get("model")
        answers = body.get("answers")
        if not isinstance(model, str) or not isinstance(answers, dict):
            raise ProviderResponseError(f"{self._name} response is missing 'model' or 'answers'")
        parsed: dict[str, DecisionAnswer] = {}
        for key, question in questions.items():
            raw = answers.get(key)
            if not isinstance(raw, dict):
                raise ProviderResponseError(
                    f"{self._name} response is missing an answer for question {key!r}"
                )
            parsed[key] = _answer(question.type, raw)
        usage = body.get("usage")
        return DecisionResponse(
            model=model,
            answers=parsed,
            input_tokens=_int_or_none(_field(usage, "input_tokens")),
            output_tokens=_int_or_none(_field(usage, "output_tokens")),
            raw=body,
        )


def _field(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, Mapping) else None


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _float_or_none(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _answer(kind: QuestionType, raw: Mapping[str, Any]) -> DecisionAnswer:
    """Map one answer, refusing a shape the question type cannot produce.

    The confidence rule is the important one: a ``noul`` answer has no
    ``confidence`` field, so inventing one here would make a guardrail that
    branches on confidence look satisfiable when it never is.
    """
    if kind == "noul":
        noul = _float_or_none(raw.get("noul"))
        if noul is None:
            raise ProviderResponseError("a noul answer must carry 'noul'")
        if "confidence" in raw:
            raise ProviderResponseError("a noul answer must not carry 'confidence'")
        return DecisionAnswer(type=kind, noul=noul, raw=raw)

    confidence = _float_or_none(raw.get("confidence"))
    if confidence is None:
        raise ProviderResponseError(f"a {kind} answer must carry 'confidence'")
    probabilities = raw.get("probabilities")
    mapped = (
        {str(key): float(value) for key, value in probabilities.items()}
        if isinstance(probabilities, Mapping)
        else None
    )
    if kind == "choice":
        choice = raw.get("choice")
        if not isinstance(choice, str):
            raise ProviderResponseError("a choice answer must carry 'choice'")
        return DecisionAnswer(
            type=kind,
            choice=choice,
            confidence=confidence,
            probabilities=mapped,
            raw=raw,
        )
    score = _float_or_none(raw.get("score"))
    if score is None:
        raise ProviderResponseError("a score answer must carry 'score'")
    legend = raw.get("legend")
    return DecisionAnswer(
        type=kind,
        score=score,
        confidence=confidence,
        probabilities=mapped,
        legend=legend if isinstance(legend, str) else None,
        raw=raw,
    )
