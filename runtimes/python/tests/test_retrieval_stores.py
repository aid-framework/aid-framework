"""The two store adapters, the similarity rule they share, and the import guard.

The in-memory adapter is the one every gate runs against, so its behaviour is the
contract the pgvector adapter is written to match. Two properties carry that:

* Similarity is always reported **higher is better**, including for L2 where the raw
  quantity is a distance. Inverting the sign for one metric would make every caller
  remember which metric it asked for, and fusion and reranking would silently rank
  backwards.
* Ties break on ``chunk_id``, never on insertion order, so a corpus ingested in a
  different order still ranks identically.

The pgvector block then pins the optional-extra rule: the package must import with no
database driver present, and a missing driver must surface as a configuration error
naming the extra rather than as an ``ImportError`` escaping a lazy import.
"""

from __future__ import annotations

import importlib.util
import sys

import pytest

from aid_runtime import ConfigurationError, FeatureDeferredError
from aid_runtime.retrieval import (
    DistanceMetric,
    InMemoryVectorStore,
    SearchHit,
    StoreKind,
    StoreRecord,
    VectorStore,
    create_store,
    similarity,
)
from aid_runtime.retrieval.pgvector import PgVectorStore, _parse_vector, resolve_uri
from retrieval_support import DIMENSIONS, chunk

URI = "postgresql://aid:aid@localhost:5432/aid"
UNSET_VARIABLE = "AID_TEST_PGVECTOR_URI_FOR_SURE_UNSET"


def store_record(name: str, vector: tuple[float, ...], *, index: int = 0) -> StoreRecord:
    return StoreRecord(chunk=chunk(f"{name}.md", name, index=index), vector=vector)


def driver_installed() -> bool:
    return importlib.util.find_spec("psycopg") is not None


def test_a_dot_product_is_the_unnormalised_inner_product() -> None:
    assert similarity((1.0, 2.0), (3.0, 4.0), metric=DistanceMetric.DOT) == pytest.approx(11.0)


def test_the_l2_metric_is_negated_so_a_closer_vector_scores_higher() -> None:
    near = similarity((0.0, 0.0), (1.0, 0.0), metric=DistanceMetric.L2)
    far = similarity((0.0, 0.0), (5.0, 0.0), metric=DistanceMetric.L2)

    assert near == pytest.approx(-1.0)
    assert far == pytest.approx(-5.0)
    assert near > far


def test_cosine_ignores_magnitude() -> None:
    assert similarity((2.0, 0.0), (7.0, 0.0), metric=DistanceMetric.COSINE) == pytest.approx(1.0)


def test_cosine_of_orthogonal_vectors_is_zero() -> None:
    assert similarity((1.0, 0.0), (0.0, 1.0), metric=DistanceMetric.COSINE) == pytest.approx(0.0)


def test_cosine_of_opposed_vectors_is_minus_one() -> None:
    assert similarity((1.0, 0.0), (-1.0, 0.0), metric=DistanceMetric.COSINE) == pytest.approx(-1.0)


def test_a_zero_vector_has_no_direction_and_scores_zero() -> None:
    # Undefined rather than zero in principle; returning 0.0 keeps it last without
    # inventing a ranking, which is the honest choice available here.
    assert similarity((0.0, 0.0), (1.0, 1.0), metric=DistanceMetric.COSINE) == 0.0
    assert similarity((1.0, 1.0), (0.0, 0.0), metric=DistanceMetric.COSINE) == 0.0


def test_comparing_vectors_of_different_widths_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="dimensions"):
        similarity((1.0, 2.0), (1.0,), metric=DistanceMetric.COSINE)


def test_an_in_memory_store_defaults_to_the_memory_kind() -> None:
    assert InMemoryVectorStore().kind is StoreKind.MEMORY


def test_an_in_memory_store_satisfies_the_protocol() -> None:
    assert isinstance(InMemoryVectorStore(), VectorStore)


async def test_upserting_reports_how_many_records_were_written() -> None:
    store = InMemoryVectorStore()

    assert await store.upsert([store_record("a", (1.0, 0.0))]) == 1
    assert await store.upsert([]) == 0


async def test_re_upserting_the_same_chunk_replaces_it_rather_than_duplicating() -> None:
    # This is what makes ingest idempotent: the key is the content hash, so the
    # store's contents are a function of the input, not of how often it was ingested.
    store = InMemoryVectorStore()
    record = store_record("a", (1.0, 0.0))

    await store.upsert([record])
    await store.upsert([record])

    assert len(await store.corpus()) == 1


async def test_the_corpus_is_ordered_by_chunk_id() -> None:
    # Ordered by id rather than by insertion, so re-reading a store is stable no
    # matter what order its records were written in.
    store = InMemoryVectorStore()
    records = [store_record("b", (1.0,)), store_record("a", (1.0,))]

    await store.upsert(records)

    corpus = await store.corpus()
    assert [record.chunk.chunk_id for record in corpus] == sorted(
        record.chunk.chunk_id for record in records
    )
    assert {record.chunk.doc_id for record in corpus} == {"a.md", "b.md"}


async def test_a_search_returns_the_nearest_records_highest_first() -> None:
    store = InMemoryVectorStore()
    await store.upsert(
        [
            store_record("near", (1.0, 0.0)),
            store_record("far", (0.0, 1.0)),
        ]
    )

    hits = await store.search((1.0, 0.0), top_k=2, metric=DistanceMetric.COSINE)

    assert [hit.record.chunk.doc_id for hit in hits] == ["near.md", "far.md"]
    assert hits[0].score > hits[1].score


async def test_a_search_respects_top_k() -> None:
    store = InMemoryVectorStore()
    await store.upsert([store_record(f"d{index}", (float(index), 1.0)) for index in range(5)])

    assert len(await store.search((1.0, 1.0), top_k=2, metric=DistanceMetric.COSINE)) == 2


async def test_a_search_over_an_empty_corpus_finds_nothing() -> None:
    assert await InMemoryVectorStore().search((1.0,), top_k=3, metric=DistanceMetric.DOT) == ()


async def test_equal_scores_rank_by_chunk_id_and_not_by_insertion_order() -> None:
    first = InMemoryVectorStore()
    second = InMemoryVectorStore()
    records = [store_record("b", (1.0, 0.0)), store_record("a", (1.0, 0.0))]

    await first.upsert(records)
    await second.upsert(list(reversed(records)))

    forward = await first.search((1.0, 0.0), top_k=2, metric=DistanceMetric.COSINE)
    backward = await second.search((1.0, 0.0), top_k=2, metric=DistanceMetric.COSINE)

    assert [hit.record.chunk.chunk_id for hit in forward] == [
        hit.record.chunk.chunk_id for hit in backward
    ]


async def test_a_search_needs_a_positive_top_k() -> None:
    with pytest.raises(ConfigurationError, match="top_k"):
        await InMemoryVectorStore().search((1.0,), top_k=0, metric=DistanceMetric.COSINE)


async def test_a_hit_carries_the_record_and_its_score() -> None:
    store = InMemoryVectorStore()
    await store.upsert([store_record("a", (1.0, 0.0))])

    (hit,) = await store.search((1.0, 0.0), top_k=1, metric=DistanceMetric.COSINE)

    assert isinstance(hit, SearchHit)
    assert hit.record.chunk.doc_id == "a.md"
    assert hit.score == pytest.approx(1.0)


async def test_closing_an_in_memory_store_is_harmless() -> None:
    store = InMemoryVectorStore()

    await store.aclose()
    await store.aclose()


def test_create_store_builds_the_memory_adapter() -> None:
    store = create_store(StoreKind.MEMORY)

    assert isinstance(store, InMemoryVectorStore)
    assert store.kind is StoreKind.MEMORY


@pytest.mark.parametrize("kind", ["qdrant", "pinecone", "weaviate", "custom"])
def test_the_store_kinds_without_an_adapter_are_deferred(kind: str) -> None:
    with pytest.raises(FeatureDeferredError, match="no adapter"):
        create_store(StoreKind(kind))


def test_a_pgvector_store_reports_its_kind() -> None:
    assert PgVectorStore(uri=URI, dimensions=DIMENSIONS).kind is StoreKind.PGVECTOR


def test_the_environment_reference_form_is_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AID_TEST_PGVECTOR_URI", URI)

    assert resolve_uri("env:AID_TEST_PGVECTOR_URI") == URI


def test_a_plain_uri_is_passed_through() -> None:
    assert resolve_uri(URI) == URI


def test_a_missing_uri_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="requires a uri"):
        resolve_uri(None)


def test_an_empty_environment_variable_name_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="empty environment variable"):
        resolve_uri("env:")


def test_an_unset_environment_variable_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(UNSET_VARIABLE, raising=False)

    with pytest.raises(ConfigurationError, match="unset"):
        resolve_uri(f"env:{UNSET_VARIABLE}")


def test_create_store_refuses_a_pgvector_store_with_no_uri() -> None:
    with pytest.raises(ConfigurationError, match="requires a uri"):
        create_store(StoreKind.PGVECTOR, uri=None, dimensions=DIMENSIONS)


def test_create_store_refuses_a_pgvector_uri_that_names_an_unset_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(UNSET_VARIABLE, raising=False)

    with pytest.raises(ConfigurationError, match="unset"):
        create_store(StoreKind.PGVECTOR, uri=f"env:{UNSET_VARIABLE}", dimensions=DIMENSIONS)


def test_importing_the_runtime_does_not_import_a_database_driver() -> None:
    # The whole reason the driver import lives inside `_load_driver`: the `python` CI
    # job installs only the dev extra, so importing the package must not need it.
    import aid_runtime
    import aid_runtime.retrieval
    import aid_runtime.retrieval.pgvector

    assert aid_runtime.retrieval.pgvector.__name__ == "aid_runtime.retrieval.pgvector"
    assert "psycopg" not in sys.modules


async def test_upserting_nothing_does_not_reach_for_the_driver() -> None:
    # An empty ingest short-circuits before connecting, so a caller that indexes an
    # empty corpus is not punished for a database it never touched.
    store = PgVectorStore(uri=URI, dimensions=DIMENSIONS)

    assert await store.upsert([]) == 0


async def test_a_missing_driver_is_a_configuration_error_that_names_the_extra() -> None:
    if driver_installed():
        pytest.skip("the pgvector extra is installed, so the missing-driver path is unreachable")

    store = PgVectorStore(uri=URI, dimensions=DIMENSIONS)

    with pytest.raises(ConfigurationError, match=r"pip install aid-runtime-python\[pgvector\]"):
        await store.search((0.0,), top_k=1, metric=DistanceMetric.COSINE)


async def test_a_missing_driver_does_not_escape_as_an_import_error() -> None:
    if driver_installed():
        pytest.skip("the pgvector extra is installed, so the missing-driver path is unreachable")

    store = PgVectorStore(uri=URI, dimensions=DIMENSIONS)

    with pytest.raises(ConfigurationError) as excinfo:
        await store.corpus()

    assert not isinstance(excinfo.value, ImportError)
    assert isinstance(excinfo.value.__cause__, ImportError)


async def test_a_record_of_the_wrong_width_is_refused_before_connecting() -> None:
    # The width check is deliberate and cheap: it runs before the driver is loaded,
    # so a mismatched record fails with the pin's own error rather than a driver
    # message about a vector literal it could not parse.
    store = PgVectorStore(uri=URI, dimensions=DIMENSIONS)

    with pytest.raises(ConfigurationError, match="dimensions"):
        await store.upsert([store_record("a", (1.0, 2.0))])


async def test_a_closed_store_refuses_further_work() -> None:
    store = PgVectorStore(uri=URI, dimensions=DIMENSIONS)

    await store.aclose()
    await store.aclose()

    with pytest.raises(ConfigurationError, match="closed"):
        await store.search((0.0,), top_k=1, metric=DistanceMetric.COSINE)


def test_a_store_uri_is_resolved_from_the_environment_and_not_a_catalog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `env:NAME` names a variable, not an alias. Pointing it at the golden fixture's
    # `env:PGVECTOR_URL` with nothing set must fail rather than fall back to a value
    # recorded anywhere else, because a silent fallback would change which store a
    # run wrote to.
    monkeypatch.delenv("PGVECTOR_URL", raising=False)

    with pytest.raises(ConfigurationError, match="unset"):
        resolve_uri("env:PGVECTOR_URL")


def test_the_driver_text_form_is_parsed() -> None:
    # The driver's return type is not fixed by the protocol, so the adapter accepts
    # both a sequence and pgvector's `[1,2]` text form. This is the only place the
    # text form is exercised without a live database.
    assert _parse_vector("[1.0,2.5]") == [1.0, 2.5]
    assert _parse_vector("[]") == []
    assert _parse_vector([3, 4]) == [3.0, 4.0]
