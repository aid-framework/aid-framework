"""Chunk identity, and the resolved forms pinned out of the IR.

The pinning tests are the load-bearing ones here: the plan requires that a resolved
embedding id, its width, and the store kind are recorded in generated code and that
an alias is *never* resolved at run time. A test that only checked ``model_id`` came
back unchanged would pass even if the code consulted a live catalog, so these check
that the pin is a function of the IR entry alone.
"""

from __future__ import annotations

import pytest

from aid_runtime import Capability, ConfigurationError, FeatureDeferredError, TokenUsage
from aid_runtime.retrieval import (
    ChunkingStrategy,
    DistanceMetric,
    RefreshMode,
    SourceKind,
    StoreKind,
    binding_from_spec,
    chunk_id_for,
    pinned_embedding,
)
from retrieval_support import (
    DIMENSIONS,
    EMBED_ALIAS,
    MODEL_ID,
    binding,
    embedding_spec,
    pinned,
    retriever_spec,
    store_spec,
)


def test_a_chunk_id_is_a_content_hash() -> None:
    identifier = chunk_id_for("a.md", 0, "hello")

    assert identifier.startswith("sha256:")
    assert identifier == chunk_id_for("a.md", 0, "hello")


def test_a_chunk_id_separates_document_position_and_text() -> None:
    base = chunk_id_for("a.md", 0, "hello")

    assert chunk_id_for("b.md", 0, "hello") != base
    assert chunk_id_for("a.md", 1, "hello") != base
    assert chunk_id_for("a.md", 0, "hello!") != base


def test_a_chunk_id_is_not_ambiguous_across_field_boundaries() -> None:
    # Without a separator between the parts, ("ab", 0, "c") and ("a", 0, "bc")
    # would hash the same bytes and two different chunks would collide.
    assert chunk_id_for("ab", 0, "c") != chunk_id_for("a", 0, "bc")


def test_a_chunk_id_is_stable_across_processes() -> None:
    # A literal, not a recomputation: the value is part of the on-disk corpus
    # contract, and a re-ingest after an unrelated refactor must be a no-op.
    assert chunk_id_for("a.md", 0, "hello") == (
        "sha256:247170a6f3e8b25f6ad374f26ba9162eff1b51d6ebce1966f1e23ac48b4560d6"
    )


def test_the_pin_carries_the_alias_the_entry_id_and_the_resolved_model() -> None:
    pin = pinned()

    assert pin.alias == EMBED_ALIAS
    assert pin.provider == "fake"
    assert pin.model_id == MODEL_ID
    assert pin.dimensions == DIMENSIONS


def test_a_pin_is_a_function_of_the_ir_entry() -> None:
    # No catalog, no alias table, no provider call: a different modelId in the IR
    # is a different pin, which is what lets a run be reproducible from code alone.
    other = pinned(model_id="text-embedding-3-large")

    assert other.model_id != pinned().model_id
    assert other.dimensions == DIMENSIONS


def test_the_pin_converts_the_ir_per_mtok_profile_to_the_runtime_per_1k_form() -> None:
    pin = pinned()

    assert pin.cost.input_per_1k_usd == pytest.approx(0.02 / 1000.0)
    assert pin.cost.output_per_1k_usd == 0.0
    assert pin.cost.cost_usd(TokenUsage(input_tokens=1000, output_tokens=0)) == pytest.approx(
        0.00002
    )


def test_an_entry_with_no_cost_profile_is_free() -> None:
    pin = pinned(cost_profile=False)

    assert pin.cost.input_per_1k_usd == 0.0
    assert pin.cost.output_per_1k_usd == 0.0


def test_the_pin_falls_back_to_the_width_the_entry_records() -> None:
    pin = pinned_embedding(embedding_spec(dimensions=1536), alias=EMBED_ALIAS)

    assert pin.dimensions == 1536


def test_a_supplied_width_overrides_the_entry() -> None:
    pin = pinned_embedding(embedding_spec(dimensions=1536), alias=EMBED_ALIAS, dimensions=64)

    assert pin.dimensions == 64


def test_a_pin_with_no_width_anywhere_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="pins no dimensions"):
        pinned_embedding(embedding_spec(dimensions=None), alias=EMBED_ALIAS)


def test_a_binding_records_the_pin_the_store_kind_and_the_store_uri() -> None:
    pinned_binding = binding(store_kind=StoreKind.PGVECTOR, store_uri="env:PGVECTOR_URL")

    assert pinned_binding.retriever_id == "docs"
    assert pinned_binding.embed_model == "embed"
    assert pinned_binding.embedding.model_id == MODEL_ID
    assert pinned_binding.embedding.dimensions == DIMENSIONS
    assert pinned_binding.store_kind is StoreKind.PGVECTOR
    assert pinned_binding.store_uri == "env:PGVECTOR_URL"


def test_a_binding_carries_the_ir_names_through_unchanged() -> None:
    pinned_binding = binding(
        hybrid=True,
        top_k=7,
        strategy=ChunkingStrategy.RECURSIVE,
        size=64,
        overlap=8,
        metric=DistanceMetric.L2,
        refresh_mode=RefreshMode.FULL,
    )

    assert pinned_binding.source.kind is SourceKind.FILE
    assert pinned_binding.index.metric is DistanceMetric.L2
    assert pinned_binding.index.hybrid is True
    assert pinned_binding.top_k == 7
    assert pinned_binding.chunking.strategy is ChunkingStrategy.RECURSIVE
    assert pinned_binding.chunking.size == 64
    assert pinned_binding.chunking.overlap == 8
    assert pinned_binding.refresh_mode is RefreshMode.FULL
    assert pinned_binding.traits == ("retrieval",)


def test_a_binding_defaults_the_optional_pieces_to_absent() -> None:
    pinned_binding = binding()

    assert pinned_binding.rerank is None
    assert pinned_binding.store_uri is None
    assert pinned_binding.store_kind is StoreKind.MEMORY


def test_a_binding_keeps_the_declared_rerank_entry() -> None:
    pinned_binding = binding(rerank_model="fake-lexical-rerank")

    assert pinned_binding.rerank is not None
    assert pinned_binding.rerank.model == "fake-lexical-rerank"
    assert pinned_binding.rerank.top_n == 3


def test_a_binding_refuses_an_embed_model_naming_no_supplied_entry() -> None:
    spec = retriever_spec().model_copy(update={"embed_model": "other"})

    with pytest.raises(ConfigurationError, match="embedModel 'other'"):
        binding_from_spec(spec, embedding=embedding_spec(), store=store_spec())


def test_a_binding_refuses_a_store_naming_no_supplied_entry() -> None:
    spec = retriever_spec().model_copy(update={"store": "other"})

    with pytest.raises(ConfigurationError, match="store 'other'"):
        binding_from_spec(spec, embedding=embedding_spec(), store=store_spec())


def test_a_binding_refuses_a_store_whose_declared_width_disagrees() -> None:
    with pytest.raises(ConfigurationError, match="must agree"):
        binding_from_spec(
            retriever_spec(),
            embedding=embedding_spec(dimensions=DIMENSIONS),
            store=store_spec(dimensions=64),
        )


def test_a_store_with_no_declared_width_is_accepted() -> None:
    pinned_binding = binding_from_spec(
        retriever_spec(),
        embedding=embedding_spec(),
        store=store_spec(dimensions=None),
    )

    assert pinned_binding.embedding.dimensions == DIMENSIONS


def test_a_binding_defers_filters_instead_of_ignoring_them() -> None:
    # The spec validator refuses filters too; this refuses them again because
    # generated code is reachable without the validator having run, and silently
    # ignoring a filter would return passages the caller asked to exclude.
    with pytest.raises(FeatureDeferredError, match="filters"):
        binding_from_spec(
            retriever_spec(filters=("lang:en",)),
            embedding=embedding_spec(),
            store=store_spec(),
        )


def test_the_runtime_names_the_two_model_side_capabilities_the_ir_declares() -> None:
    assert Capability.EMBEDDINGS.value == "embeddings"
    assert Capability.RERANK.value == "rerank"
