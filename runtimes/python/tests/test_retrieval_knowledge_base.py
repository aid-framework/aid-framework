"""Managed retrieval: binding, the fixture client, and the failures that matter.

The load-bearing cases are the two refusals and the missing-ingestion error. A dropped
filter silently widens a tenant-scoped query, and a base that was deployed but never
indexed returns nothing -- which a model reads as "the answer is not in the corpus"
rather than "the corpus is empty". Both are asserted as raised, not as logged.

The sync half of the file makes the same kind of claim from the other direction. A managed
base ingests inside the engine, driven by its data source, so `sync` is what a managed
retriever has instead of `ingest` -- and the case worth pinning is that a `FAILED` job is
reported with the engine's own reason rather than swallowed, because a sync that claimed
success while the corpus stayed empty is the same silent-empty-corpus bug as above.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from aid_runtime import BedrockProvider
from aid_runtime.cost import CostLedger
from aid_runtime.errors import ConfigurationError, FeatureDeferredError, ProviderError
from aid_runtime.retrieval import (
    FIXTURE_ENV,
    BedrockKnowledgeBaseClient,
    FixtureKnowledgeBaseClient,
    KnowledgeBaseEngine,
    KnowledgeBaseSpec,
    ManagedRetrieverBinding,
    ManagedRetrieverSpec,
    Retriever,
    RetrieverSpec,
    SyncResult,
    VertexKnowledgeBaseClient,
    binding_from_managed_spec,
    knowledge_base_env_id,
    sync_support,
)


def base_spec(**overrides: object) -> KnowledgeBaseSpec:
    payload: dict[str, object] = {
        "id": "product-docs",
        "engine": "aws-bedrock",
        "dataSource": {"kind": "s3", "uri": "s3://bucket/docs/"},
        "chunking": {"strategy": "fixed", "size": 512, "overlap": 64},
        "embedModel": "amazon.titan-embed-text-v2:0",
        "filterable": ["tenant"],
        "vectorStore": {"kind": "provisioned"},
    }
    payload.update(overrides)
    return KnowledgeBaseSpec.model_validate(payload)


def retriever_spec(**overrides: object) -> ManagedRetrieverSpec:
    payload: dict[str, object] = {
        "id": "docs",
        "knowledgeBase": "product-docs",
        "topK": 3,
        "traits": [],
    }
    payload.update(overrides)
    return ManagedRetrieverSpec.model_validate(payload)


def test_the_ir_discriminator_validates_on_both_retriever_shapes() -> None:
    """Generated bindings validate the IR fragment as written, which carries ``kind``."""

    local = RetrieverSpec.model_validate(
        {
            "kind": "local",
            "id": "handbook",
            "source": {"kind": "file", "uri": "./docs", "glob": "**/*.md"},
            "chunking": {"strategy": "fixed", "size": 120, "overlap": 0, "keepMetadata": []},
            "embedModel": "embed",
            "store": "vectors",
            "index": {"metric": "cosine", "hybrid": False},
            "topK": 3,
            "rerank": None,
            "filters": None,
            "refresh": {"mode": "full"},
            "traits": ["retrieval"],
        }
    )

    assert local.kind == "local"
    assert retriever_spec(kind="managed").kind == "managed"


def fixture_client(*, ready: bool = True, cost: float | None = None) -> FixtureKnowledgeBaseClient:
    return FixtureKnowledgeBaseClient(
        payload={
            "bases": {
                "product-docs": {
                    "ready": ready,
                    "chunks": [
                        {
                            "text": "hello world",
                            "sourceUri": "s3://bucket/docs/a.md",
                            "score": 0.9,
                            "position": 0,
                        },
                        {
                            "text": "second passage",
                            "sourceUri": "s3://bucket/docs/b.md",
                            "score": 0.5,
                            "position": 1,
                        },
                    ],
                }
            }
        }
    )


def binding(
    *,
    spec: ManagedRetrieverSpec | None = None,
    base: KnowledgeBaseSpec | None = None,
) -> ManagedRetrieverBinding:
    return binding_from_managed_spec(
        spec or retriever_spec(),
        knowledge_base=base or base_spec(),
    )


def test_a_managed_binding_keeps_the_engine_owned_fields_off_the_runtime_record() -> None:
    bound = binding()

    assert bound.retriever_id == "docs"
    assert bound.knowledge_base.id == "product-docs"
    assert bound.top_k == 3
    assert bound.filters == ()


def test_binding_refuses_an_alias_that_names_a_different_knowledge_base() -> None:
    with pytest.raises(ConfigurationError, match="other-docs"):
        binding(spec=retriever_spec(knowledgeBase="other-docs"))


def test_binding_refuses_a_filter_because_the_runtime_cannot_translate_it() -> None:
    with pytest.raises(FeatureDeferredError, match="does not translate them"):
        binding(spec=retriever_spec(filters=["tenant = 'acme'"]))


def test_binding_refuses_a_reranker_the_runtime_does_not_have() -> None:
    spec = retriever_spec(rerank={"model": "cohere.rerank-v3", "topN": 2})

    with pytest.raises(FeatureDeferredError, match=r"cohere\.rerank-v3"):
        binding(spec=spec)


@pytest.mark.asyncio
async def test_the_fixture_client_returns_mapped_chunks_with_citations() -> None:
    retriever = Retriever(binding(), knowledge_base_client=fixture_client())

    result = await retriever.retrieve("hello")

    assert [item.chunk.text for item in result.items] == ["hello world", "second passage"]
    assert [item.rank for item in result.items] == [1, 2]
    assert result.items[0].citation.uri == "s3://bucket/docs/a.md"
    await retriever.aclose()


@pytest.mark.asyncio
async def test_top_k_bounds_a_managed_retrieval() -> None:
    retriever = Retriever(binding(), knowledge_base_client=fixture_client())

    result = await retriever.retrieve("hello", top_k=1)

    assert len(result.items) == 1
    await retriever.aclose()


@pytest.mark.asyncio
async def test_a_base_without_a_completed_ingestion_job_fails_loudly() -> None:
    retriever = Retriever(binding(), knowledge_base_client=fixture_client(ready=False))

    with pytest.raises(ConfigurationError, match="has no completed ingestion job"):
        await retriever.retrieve("hello")
    await retriever.aclose()


@pytest.mark.asyncio
async def test_a_filtered_binding_is_refused_when_the_client_cannot_apply_it() -> None:
    filtered = ManagedRetrieverBinding(
        retriever_id="docs",
        knowledge_base=base_spec(),
        top_k=3,
        filters=("tenant = 'acme'",),
    )

    with pytest.raises(FeatureDeferredError, match="whole corpus"):
        Retriever(filtered, knowledge_base_client=fixture_client())


@pytest.mark.asyncio
async def test_a_priced_retrieval_charges_the_ledger_once() -> None:
    ledger = CostLedger()
    retriever = Retriever(
        binding(base=base_spec(retrieveCostPerQueryUsd=0.001)),
        knowledge_base_client=fixture_client(),
        ledger=ledger,
    )

    await retriever.retrieve("hello")

    assert [(entry.alias, entry.cost_usd) for entry in ledger.entries] == [("docs", 0.001)]
    await retriever.aclose()


@pytest.mark.asyncio
async def test_an_unpriced_retrieval_records_no_charge_rather_than_zero() -> None:
    ledger = CostLedger()
    retriever = Retriever(
        binding(),
        knowledge_base_client=fixture_client(),
        ledger=ledger,
    )

    await retriever.retrieve("hello")

    assert ledger.entries == ()
    await retriever.aclose()


@pytest.mark.asyncio
async def test_ingesting_a_managed_retriever_is_refused() -> None:
    retriever = Retriever(binding(), knowledge_base_client=fixture_client())

    with pytest.raises(ConfigurationError, match="reads a managed knowledge base"):
        await retriever.ingest()
    await retriever.aclose()


def test_a_managed_retriever_has_no_local_store() -> None:
    retriever = Retriever(binding(), knowledge_base_client=fixture_client())

    with pytest.raises(ConfigurationError, match="no local store"):
        assert retriever.store is not None


def test_the_service_id_environment_name_is_per_base_and_per_engine() -> None:
    bedrock = base_spec()
    vertex = base_spec(id="product-docs", engine="vertex-rag")
    other = base_spec(id="support-docs")

    assert knowledge_base_env_id(bedrock) == "BEDROCK_KNOWLEDGE_BASE_PRODUCT_DOCS"
    assert knowledge_base_env_id(vertex) == "VERTEX_RAG_CORPUS_PRODUCT_DOCS"
    assert knowledge_base_env_id(other) == "BEDROCK_KNOWLEDGE_BASE_SUPPORT_DOCS"


def test_the_factory_prefers_a_fixture_over_the_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "kb.json"
    path.write_text(json.dumps({"bases": {}}), encoding="utf-8")
    monkeypatch.setenv("AID_KNOWLEDGE_BASE_FIXTURE", str(path))

    from aid_runtime.retrieval import knowledge_base_client_for

    assert isinstance(knowledge_base_client_for(base_spec()), FixtureKnowledgeBaseClient)


def test_a_missing_fixture_file_is_reported_rather_than_guessed(tmp_path: Path) -> None:
    from aid_runtime.retrieval import knowledge_base_client_for

    missing = tmp_path / "nope.json"

    with pytest.raises(ConfigurationError, match="cannot be read"):
        knowledge_base_client_for(base_spec(), fixture=missing)


def test_the_engine_enum_matches_the_spec_spelling() -> None:
    assert KnowledgeBaseEngine.AWS_BEDROCK.value == "aws-bedrock"
    assert KnowledgeBaseEngine.VERTEX_RAG.value == "vertex-rag"


# --- sync: the operation a managed retriever has instead of ingest ---------------------
#
# Everything below runs against an ``httpx.MockTransport``. A managed sync is a request to
# an engine nobody's test machine is authenticated against, so the only honest way to assert
# it here is to pin the requests it sends and the statuses it reports -- the same choice
# ``test_bedrock_provider.py`` makes for the model adapter.


class Recorder:
    """A transport handler that records requests and replays queued responses."""

    def __init__(self, *responses: httpx.Response) -> None:
        self.requests: list[httpx.Request] = []
        self._responses = list(responses)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError("the client sent more requests than the test queued responses")
        return self._responses.pop(0)

    @property
    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]


def _answer(payload: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload)


def _data_sources(data_source_id: str = "ds-1") -> httpx.Response:
    return _answer({"dataSourceSummaries": [{"dataSourceId": data_source_id}]})


def _started(job_id: str = "job-1", status: str = "STARTING") -> httpx.Response:
    return _answer({"ingestionJob": {"ingestionJobId": job_id, "status": status}})


def _latest(status: str, job_id: str = "job-1") -> httpx.Response:
    # `IngestionJobSummary` has no `failureReasons` member, so the list never carries one.
    job = {"ingestionJobId": job_id, "status": status}
    return _answer({"ingestionJobSummaries": [job]})


def _job_detail(
    job_id: str = "job-1", status: str = "FAILED", reason: str | None = None
) -> httpx.Response:
    # `IngestionJob.failureReasons` is an array of strings, not of records.
    job: dict[str, Any] = {"ingestionJobId": job_id, "status": status}
    if reason is not None:
        job["failureReasons"] = [reason]
    return _answer({"ingestionJob": job})


def _retrieved(text: str = "hello") -> httpx.Response:
    return _answer(
        {
            "retrievalResults": [
                {
                    "content": {"text": text},
                    "location": {"s3Location": {"uri": "s3://bucket/docs/a.md"}},
                    "score": 0.9,
                }
            ]
        }
    )


def bedrock_kb(recorder: Recorder) -> BedrockKnowledgeBaseClient:
    """A SigV4 client whose only transport is the recorder, so no request leaves the process."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(recorder.handle))
    return BedrockKnowledgeBaseClient(
        provider=BedrockProvider(
            access_key_id="AKIDEXAMPLE",
            secret_access_key="wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",  # noqa: S106
            region="us-east-1",
            backoff_seconds=0.0,
            client=client,
        ),
        client=client,
        max_attempts=1,
        backoff_seconds=0.0,
    )


SERVICE_ID = "kb-123"


def test_sync_support_names_the_engine_that_has_no_job_to_start() -> None:
    bedrock = sync_support("aws-bedrock")
    vertex = sync_support("vertex-rag")

    assert bedrock.supported is True
    assert bedrock.reason is None
    # The reason is a standalone sentence that names the provider, because the CLI prints it
    # verbatim as the hint on its refusal and a reader has to know what to do instead.
    assert vertex.supported is False
    assert vertex.engine == "vertex-rag"
    assert "vertex-rag" in (vertex.reason or "")
    assert "import" in (vertex.reason or "")


def test_sync_support_refuses_an_engine_it_does_not_know_by_name() -> None:
    support = sync_support("pgvector-cloud")

    assert support.supported is False
    assert "pgvector-cloud" in (support.reason or "")


def test_sync_support_answers_the_json_shape_a_reader_without_the_module_can_parse() -> None:
    assert sync_support("vertex-rag").as_dict() == {
        "engine": "vertex-rag",
        "supported": False,
        "reason": sync_support("vertex-rag").reason,
    }


@pytest.mark.asyncio
async def test_sync_starts_a_job_and_reports_what_the_engine_queued(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(knowledge_base_env_id(base_spec()), SERVICE_ID)
    recorder = Recorder(_data_sources(), _started())
    client = bedrock_kb(recorder)

    result = await client.sync(base_spec())

    assert result == SyncResult(
        knowledge_base_id=SERVICE_ID,
        data_source_id="ds-1",
        job_id="job-1",
        status="STARTING",
        waited=False,
        failure_reason=None,
    )
    # A started job is a success without `wait`: the request was to begin an ingestion.
    assert result.ok
    assert recorder.paths == [
        f"/knowledgebases/{SERVICE_ID}/datasources",
        f"/knowledgebases/{SERVICE_ID}/datasources/ds-1/ingestionjobs",
    ]
    assert recorder.requests[1].method == "POST"
    await client.aclose()


@pytest.mark.asyncio
async def test_sync_waits_on_the_latest_job_until_the_engine_says_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(knowledge_base_env_id(base_spec()), SERVICE_ID)
    recorder = Recorder(_data_sources(), _started(), _latest("IN_PROGRESS"), _latest("COMPLETE"))
    client = bedrock_kb(recorder)

    result = await client.sync(base_spec(), wait=True, poll_seconds=0.0)

    assert result.status == "COMPLETE"
    assert result.waited is True
    assert result.ok
    # The poll reads the same collection the readiness check reads, with the canonical
    # query string the signature was computed over.
    assert "maxResults=1&sortOrder=DESCENDING" in str(recorder.requests[2].url)
    assert recorder.requests[2].method == "GET"
    # A job that completes is explained by its status alone, so the wait stops there
    # rather than spending a request on a reason there is none of.
    assert recorder.paths[-1].endswith("/ingestionjobs")
    assert len(recorder.requests) == 4
    await client.aclose()


@pytest.mark.asyncio
async def test_a_failed_job_is_reported_with_the_engines_own_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never swallowed: the status is the engine's verdict, and the reason is its words."""
    monkeypatch.setenv(knowledge_base_env_id(base_spec()), SERVICE_ID)
    reason = "the data source role cannot read s3://bucket/docs/"
    # The summary the poll reads carries no reason, so the failed wait reads the job itself.
    recorder = Recorder(
        _data_sources(), _started(), _latest("FAILED"), _job_detail("job-1", "FAILED", reason)
    )
    client = bedrock_kb(recorder)

    result = await client.sync(base_spec(), wait=True, poll_seconds=0.0)

    assert result.status == "FAILED"
    assert result.waited is True
    assert result.ok is False
    assert result.failure_reason == reason
    detail = recorder.requests[3]
    assert detail.method == "GET"
    assert detail.url.path.endswith("/ingestionjobs/job-1")
    await client.aclose()


@pytest.mark.asyncio
async def test_a_job_that_never_finishes_fails_the_call_rather_than_hanging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(knowledge_base_env_id(base_spec()), SERVICE_ID)
    recorder = Recorder(_data_sources(), _started())
    client = bedrock_kb(recorder)

    with pytest.raises(ProviderError, match="was still STARTING"):
        await client.sync(base_spec(), wait=True, timeout_seconds=0.0, poll_seconds=0.0)
    await client.aclose()


@pytest.mark.asyncio
async def test_starting_a_job_invalidates_the_cached_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The base was complete a minute ago; the sync is rebuilding it now.

    A retrieve that trusted the old answer would search a corpus that is briefly empty, so
    the readiness check has to run again -- which is what the re-read of the job summary
    below proves it did.
    """
    monkeypatch.setenv(knowledge_base_env_id(base_spec()), SERVICE_ID)
    recorder = Recorder(_data_sources(), _started(), _data_sources(), _latest("IN_PROGRESS"))
    client = bedrock_kb(recorder)

    await client.sync(base_spec())

    with pytest.raises(ConfigurationError, match="no completed ingestion job"):
        await client.retrieve(base_spec(), "hello", top_k=3)
    await client.aclose()


@pytest.mark.asyncio
async def test_a_waited_complete_job_saves_the_next_retrieve_a_round_trip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(knowledge_base_env_id(base_spec()), SERVICE_ID)
    recorder = Recorder(_data_sources(), _started(), _latest("COMPLETE"), _retrieved())
    client = bedrock_kb(recorder)

    await client.sync(base_spec(), wait=True, poll_seconds=0.0)
    knowledge = await client.retrieve(base_spec(), "hello", top_k=3)

    assert [chunk.text for chunk in knowledge.chunks] == ["hello"]
    # Four requests: data sources, start, the poll, and the retrieve. A fifth would be the
    # readiness re-read this status was recorded to avoid.
    assert len(recorder.requests) == 4
    await client.aclose()


@pytest.mark.asyncio
async def test_syncing_a_vertex_corpus_is_refused_by_name() -> None:
    client = VertexKnowledgeBaseClient(
        project="acme",
        location="us-central1",
        access_token="t",  # noqa: S106
    )
    base = base_spec(
        id="product-docs", engine="vertex-rag", dataSource={"kind": "gcs", "uri": "gs://b/d/"}
    )

    with pytest.raises(ConfigurationError) as caught:
        await client.sync(base)

    assert "product-docs" in str(caught.value)
    assert "vertex-rag" in str(caught.value)
    await client.aclose()


@pytest.mark.asyncio
async def test_syncing_a_fixture_is_refused_and_names_the_variable_to_unset() -> None:
    """The engine's capability is not in question; the fixture replaced the engine."""
    client = fixture_client()

    with pytest.raises(ConfigurationError) as caught:
        await client.sync(base_spec())

    assert "fixture" in str(caught.value)
    assert FIXTURE_ENV in str(caught.value)
    await client.aclose()
