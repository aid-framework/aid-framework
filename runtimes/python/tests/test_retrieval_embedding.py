"""The two Phase 1 embedders.

The fake gets the most attention because it is the adapter the eval gate runs
against: a gate that needed an API key could not run offline in CI, which is the same
reason the spec DSL already offers ``provider: fake``. So what matters about it is not
that its vectors are good -- they are deliberately meaningless -- but that they are
*reproducible* and that they follow the pin.

The hosted adapter is asserted on the bytes that would have gone over the wire. No
network is touched: the adapter's job is to shape one request and interpret one reply.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from aid_runtime import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.retrieval import (
    Embedder,
    FakeDeterministicEmbedder,
    OpenAICompatibleEmbedder,
    embedder_for,
    estimate_tokens,
)
from retrieval_support import DIMENSIONS, pinned

BASE_URL = "https://embeddings.test/v1"
API_KEY = "test-key"


class Recorder:
    """A `MockTransport` handler that records requests and replays replies."""

    def __init__(self, *responses: httpx.Response) -> None:
        self.requests: list[httpx.Request] = []
        self._responses = list(responses)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._responses:
            return httpx.Response(500, text="no reply queued")
        return self._responses.pop(0)


def _client(recorder: Recorder) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle))


def _embedder(recorder: Recorder, **kwargs: Any) -> OpenAICompatibleEmbedder:
    options: dict[str, Any] = {"base_url": BASE_URL, "backoff_seconds": 0.0}
    options.update(kwargs)
    return OpenAICompatibleEmbedder(client=_client(recorder), **options)


def _reply(vectors: list[list[float]], *, prompt_tokens: int = 5, **extra: Any) -> httpx.Response:
    body: dict[str, Any] = {
        "model": "text-embedding-3-small",
        "data": [
            {"object": "embedding", "index": index, "embedding": vector}
            for index, vector in enumerate(vectors)
        ],
        "usage": {"prompt_tokens": prompt_tokens, "total_tokens": prompt_tokens},
    }
    body.update(extra)
    return httpx.Response(200, json=body)


def _vector() -> list[float]:
    return [0.5] * DIMENSIONS


def test_the_token_estimate_rounds_up_at_four_characters() -> None:
    # Deliberately the same arithmetic as the cost module's prompt estimate, so an
    # offline charge and an offline estimate cannot disagree about what text costs.
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcde") == 2


async def test_the_fake_produces_one_vector_per_text_at_the_pinned_width() -> None:
    batch = await FakeDeterministicEmbedder().embed(["one", "two", "three"], model=pinned())

    assert len(batch.vectors) == 3
    assert all(len(vector) == DIMENSIONS for vector in batch.vectors)


async def test_the_fake_vectors_are_unit_length() -> None:
    batch = await FakeDeterministicEmbedder().embed(["some text"], model=pinned())

    norm = sum(value * value for value in batch.vectors[0]) ** 0.5

    assert norm == pytest.approx(1.0)


async def test_the_fake_is_reproducible_across_instances() -> None:
    first = await FakeDeterministicEmbedder().embed(["same"], model=pinned())
    second = await FakeDeterministicEmbedder().embed(["same"], model=pinned())

    assert first.vectors == second.vectors


async def test_the_fake_changes_when_the_pinned_model_changes() -> None:
    # A changed pin has to invalidate stored vectors rather than silently mix two
    # vector spaces in one table, so the pin is part of the hashed input.
    small = await FakeDeterministicEmbedder().embed(
        ["same"], model=pinned(model_id="text-embedding-3-small")
    )
    large = await FakeDeterministicEmbedder().embed(
        ["same"], model=pinned(model_id="text-embedding-3-large")
    )

    assert small.vectors != large.vectors


async def test_the_fake_changes_when_the_pinned_width_changes() -> None:
    narrow = await FakeDeterministicEmbedder().embed(["same"], model=pinned(dimensions=8))
    wide = await FakeDeterministicEmbedder().embed(["same"], model=pinned(dimensions=16))

    assert [len(vector) for vector in narrow.vectors] == [8]
    assert [len(vector) for vector in wide.vectors] == [16]


async def test_the_fake_uses_a_different_vector_per_text() -> None:
    batch = await FakeDeterministicEmbedder().embed(["alpha", "beta"], model=pinned())

    assert batch.vectors[0] != batch.vectors[1]


async def test_the_fake_reports_input_tokens_and_no_output_tokens() -> None:
    batch = await FakeDeterministicEmbedder().embed(["abcd", "abcde"], model=pinned())

    assert batch.usage.input_tokens == estimate_tokens("abcd") + estimate_tokens("abcde")
    assert batch.usage.output_tokens == 0


async def test_the_fake_embeds_nothing_without_complaint() -> None:
    batch = await FakeDeterministicEmbedder().embed([], model=pinned())

    assert batch.vectors == ()
    assert batch.usage.input_tokens == 0


async def test_the_fake_is_named_and_closable() -> None:
    embedder = FakeDeterministicEmbedder()

    assert embedder.name == "fake-embedder"
    assert isinstance(embedder, Embedder)
    await embedder.aclose()
    await embedder.aclose()


def test_the_fake_name_can_be_overridden() -> None:
    assert FakeDeterministicEmbedder(name="custom").name == "custom"


def test_a_fake_pin_selects_the_fake_adapter() -> None:
    assert isinstance(embedder_for(pinned(provider="fake")), FakeDeterministicEmbedder)


def test_a_hosted_pin_selects_the_hosted_adapter() -> None:
    assert isinstance(embedder_for(pinned(provider="openai")), OpenAICompatibleEmbedder)


def test_selecting_an_adapter_never_selects_a_model() -> None:
    # The model id and its width arrive already pinned and are passed straight
    # through, so the only choice made here is which provider to talk to.
    embedder = embedder_for(pinned(provider="openai", model_id="anything-at-all"))

    assert isinstance(embedder, OpenAICompatibleEmbedder)


async def test_the_hosted_adapter_posts_the_pinned_model_and_the_texts() -> None:
    recorder = Recorder(_reply([_vector()]))

    await _embedder(recorder).embed(["alpha", "beta"], model=pinned())

    request = recorder.requests[0]
    assert str(request.url) == f"{BASE_URL}/embeddings"
    assert json.loads(request.content) == {
        "model": pinned().model_id,
        "input": ["alpha", "beta"],
    }


async def test_the_hosted_adapter_sends_the_key_as_a_bearer_token() -> None:
    recorder = Recorder(_reply([_vector()]))

    await _embedder(recorder, api_key=API_KEY).embed(["alpha"], model=pinned(provider="openai"))

    assert recorder.requests[0].headers["authorization"] == f"Bearer {API_KEY}"


async def test_the_hosted_adapter_sends_no_authorization_without_a_key() -> None:
    recorder = Recorder(_reply([_vector()]))

    await _embedder(recorder).embed(["alpha"], model=pinned(provider="openai"))

    assert "authorization" not in recorder.requests[0].headers


async def test_the_hosted_adapter_merges_extra_headers() -> None:
    recorder = Recorder(_reply([_vector()]))

    await _embedder(recorder, extra_headers={"x-tenant": "acme"}).embed(["a"], model=pinned())

    assert recorder.requests[0].headers["x-tenant"] == "acme"
    assert recorder.requests[0].headers["content-type"] == "application/json"


@pytest.mark.parametrize("base_url", ["api.openai.com/v1", "ftp://api.test/v1", ""])
def test_a_base_url_that_is_not_http_is_refused(base_url: str) -> None:
    with pytest.raises(ConfigurationError, match="absolute http"):
        OpenAICompatibleEmbedder(base_url=base_url)


@pytest.mark.parametrize("attempts", [0, -1])
def test_at_least_one_attempt_is_required(attempts: int) -> None:
    with pytest.raises(ConfigurationError, match="max_attempts"):
        OpenAICompatibleEmbedder(base_url=BASE_URL, max_attempts=attempts)


async def test_the_vectors_come_back_in_the_order_they_were_asked_for() -> None:
    # A provider is free to answer out of order; the index is what restores the
    # caller's ordering, and getting it wrong would silently swap two documents.
    shuffled = httpx.Response(
        200,
        json={
            "data": [
                {"index": 1, "embedding": [2.0] * DIMENSIONS},
                {"index": 0, "embedding": [1.0] * DIMENSIONS},
            ],
            "usage": {"prompt_tokens": 4},
        },
    )
    recorder = Recorder(shuffled)

    batch = await _embedder(recorder).embed(["first", "second"], model=pinned())

    assert batch.vectors[0][0] == pytest.approx(1.0)
    assert batch.vectors[1][0] == pytest.approx(2.0)


async def test_the_reported_usage_is_the_providers() -> None:
    recorder = Recorder(_reply([_vector()], prompt_tokens=42))

    batch = await _embedder(recorder).embed(["alpha"], model=pinned())

    assert batch.usage.input_tokens == 42
    assert batch.usage.output_tokens == 0


async def test_a_reply_without_usage_charges_nothing() -> None:
    recorder = Recorder(
        httpx.Response(200, json={"data": [{"index": 0, "embedding": [1.0] * DIMENSIONS}]})
    )

    batch = await _embedder(recorder).embed(["alpha"], model=pinned())

    assert batch.usage.input_tokens == 0


async def test_a_width_that_disagrees_with_the_pin_is_refused() -> None:
    # The pin is what the store was created for; a reply of another width would be
    # written into a table it does not fit.
    recorder = Recorder(_reply([_vector()]))

    with pytest.raises(ProviderResponseError, match="dimensions"):
        await _embedder(recorder).embed(["alpha"], model=pinned(dimensions=DIMENSIONS + 1))


async def test_an_empty_data_list_is_refused() -> None:
    recorder = Recorder(_reply([]))

    with pytest.raises(ProviderResponseError, match="no embeddings"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_missing_data_key_is_refused() -> None:
    recorder = Recorder(httpx.Response(200, json={"model": "x"}))

    with pytest.raises(ProviderResponseError, match="no embeddings"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_non_list_embedding_is_refused() -> None:
    recorder = Recorder(httpx.Response(200, json={"data": [{"index": 0, "embedding": "nope"}]}))

    with pytest.raises(ProviderResponseError, match="non-list"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_non_numeric_embedding_is_refused() -> None:
    recorder = Recorder(
        httpx.Response(200, json={"data": [{"index": 0, "embedding": ["a"] * DIMENSIONS}]})
    )

    with pytest.raises(ProviderResponseError, match="non-numeric"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_non_object_entry_is_refused() -> None:
    recorder = Recorder(httpx.Response(200, json={"data": ["nope"]}))

    with pytest.raises(ProviderResponseError, match="non-object"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_non_integer_index_is_refused() -> None:
    recorder = Recorder(
        httpx.Response(200, json={"data": [{"index": "0", "embedding": _vector()}]})
    )

    with pytest.raises(ProviderResponseError, match="non-integer"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_non_json_body_is_reported_with_its_cause() -> None:
    recorder = Recorder(httpx.Response(200, text="<html>gateway</html>"))

    with pytest.raises(ProviderResponseError, match="not JSON"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


async def test_a_json_body_that_is_not_an_object_is_rejected() -> None:
    recorder = Recorder(httpx.Response(200, json=[1, 2, 3]))

    with pytest.raises(ProviderResponseError, match="not an object"):
        await _embedder(recorder).embed(["alpha"], model=pinned())


@pytest.mark.parametrize("status", [408, 409, 425, 429, 500, 502, 503, 504])
async def test_a_transient_status_is_retried(status: int) -> None:
    recorder = Recorder(httpx.Response(status, text="later"), _reply([_vector()]))

    batch = await _embedder(recorder, max_attempts=2).embed(["alpha"], model=pinned())

    assert len(recorder.requests) == 2
    assert batch.vectors[0][0] == pytest.approx(0.5)


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
async def test_a_decisive_status_fails_immediately(status: int) -> None:
    # Retrying a malformed request only wastes the caller's time.
    recorder = Recorder(httpx.Response(status, text="bad request"), _reply([_vector()]))

    with pytest.raises(ProviderError, match=f"HTTP {status}"):
        await _embedder(recorder, max_attempts=3).embed(["alpha"], model=pinned())

    assert len(recorder.requests) == 1


async def test_a_transient_status_that_persists_is_reported_after_the_last_attempt() -> None:
    recorder = Recorder(httpx.Response(503, text="down"), httpx.Response(503, text="down"))

    with pytest.raises(ProviderError, match="failed after 2 attempt"):
        await _embedder(recorder, max_attempts=2).embed(["alpha"], model=pinned())

    assert len(recorder.requests) == 2


async def test_a_persistent_transport_error_fails_with_its_cause() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    embedder = OpenAICompatibleEmbedder(
        base_url=BASE_URL,
        max_attempts=2,
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(ProviderError, match="failed after 2 attempt") as excinfo:
        await embedder.embed(["alpha"], model=pinned())

    assert isinstance(excinfo.value.__cause__, httpx.ConnectError)


async def test_a_transport_error_is_retried_before_it_is_given_up_on() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("too slow")
        return _reply([_vector()])

    embedder = OpenAICompatibleEmbedder(
        base_url=BASE_URL,
        max_attempts=2,
        backoff_seconds=0.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    batch = await embedder.embed(["alpha"], model=pinned())

    assert len(calls) == 2
    assert batch.vectors[0][0] == pytest.approx(0.5)


async def test_aclose_is_idempotent() -> None:
    embedder = OpenAICompatibleEmbedder(base_url=BASE_URL)

    await embedder.aclose()
    await embedder.aclose()


async def test_aclose_leaves_a_caller_supplied_client_open() -> None:
    # Whoever constructed the client closes it: a shared pool closed by one adapter
    # would break every other user of it.
    recorder = Recorder(_reply([_vector()]), _reply([_vector()]))
    async with httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle)) as client:
        embedder = OpenAICompatibleEmbedder(base_url=BASE_URL, client=client)
        await embedder.aclose()

        batch = await embedder.embed(["alpha"], model=pinned())

    assert batch.vectors[0][0] == pytest.approx(0.5)
