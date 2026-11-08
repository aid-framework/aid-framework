"""Managed retrieval: binding, the fixture client, and the failures that matter.

The load-bearing cases are the two refusals and the missing-ingestion error. A dropped
filter silently widens a tenant-scoped query, and a base that was deployed but never
indexed returns nothing -- which a model reads as "the answer is not in the corpus"
rather than "the corpus is empty". Both are asserted as raised, not as logged.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aid_runtime.cost import CostLedger
from aid_runtime.errors import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval import (
    FixtureKnowledgeBaseClient,
    KnowledgeBaseEngine,
    KnowledgeBaseSpec,
    ManagedRetrieverBinding,
    ManagedRetrieverSpec,
    Retriever,
    RetrieverSpec,
    binding_from_managed_spec,
    knowledge_base_env_id,
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
