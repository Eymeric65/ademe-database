"""The weekly delta and the reconciliation, for a source that is not existing housing.

Both rewrite search files with existing housing's 17 columns and sort, fetch
through existing housing's dataset, and build their SQLite with its schema --
so the first week a second source ran, its merge would either fail or be built
from the wrong dataset. The source here has a five-column search index unlike
existing housing's, so a merge that used the wrong one cannot pass for right.
See ADR-0018.
"""

from __future__ import annotations

import json

import duckdb
import pytest

from ademe import db, delta, export_parquet, ingest, mapping, schema, spec
from ademe.config import SCHEMA_JSON, Source
from tests.test_delta import SCALES, FakeApi, _row
from tests.test_mapping_per_source import NEUF_ABSENT

COLUMNS = ("numero_dpe", "code_postal_ban", "etiquette_dpe", "lat", "lon")
SORT = ("code_postal_ban", "etiquette_dpe")


@pytest.fixture
def source(tmp_path, monkeypatch) -> Source:
    fields = [f for f in json.loads(SCHEMA_JSON.read_text()) if f["key"] not in NEUF_ABSENT]
    path = tmp_path / "neuf-like-schema.json"
    path.write_text(json.dumps(fields))
    monkeypatch.setitem(export_parquet.SEARCH, "neuf-like", (COLUMNS, SORT))
    return Source(
        slug="neuf-like",
        dataset="neuf-like",
        schema_json=path,
        db_path=tmp_path / "neuf-like.sqlite",
        subdir="neuf-like",
        mapping=mapping.EXISTANT.without(NEUF_ABSENT),
    )


def _build(tmp_path, source: Source, name: str, rows: list[dict]):
    path = tmp_path / f"{name}.sqlite"
    schema.build(path, scales=SCALES, source=source)
    conn = db.connect(path, bulk=True)
    ingest.Loader(conn, spec.load(SCALES, source=source), source=source).load_page(rows)
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def base(tmp_path, source):
    """This source's published tree: two partitions."""
    rows = [
        _row("2409N0000001", "09", "2026-08-01"),
        _row("2409N0000002", "09", "2026-08-02", etiquette_dpe="E"),
        _row("2431N0000001", "31", "2026-08-01"),
    ]
    export_parquet.export(_build(tmp_path, source, "base", rows), tmp_path / "published", source=source)
    return tmp_path / "published" / export_parquet.VERSION / "neuf-like"


def _names(path) -> list[str]:
    # Without hive_partitioning = false, DuckDB reads the `dept=09` directory as
    # a column and reports one the file does not have.
    return [
        r[0]
        for r in duckdb.connect()
        .execute(f"DESCRIBE SELECT * FROM read_parquet('{path}', hive_partitioning = false)")
        .fetchall()
    ]


def test_a_merge_keeps_the_sources_own_search_index(base, source, tmp_path):
    delta_rows = [_row("2409N0000002", "09", "2026-09-01", etiquette_dpe="A")]
    export_parquet.export(_build(tmp_path, source, "delta", delta_rows), tmp_path / "delta-out", source=source)

    merged = tmp_path / "merged"
    touched = delta.merge(
        base, tmp_path / "delta-out" / export_parquet.VERSION / "neuf-like", merged, source=source
    )
    assert touched == ["09"]
    assert _names(merged / "search" / "dept=09" / "part-0000.parquet") == list(COLUMNS)
    got = duckdb.connect().execute(
        f"SELECT etiquette_dpe FROM read_parquet('{merged / 'dpe' / 'dept=09' / 'part-0000.parquet'}')"
        " WHERE numero_dpe = '2409N0000002'"
    ).fetchone()
    assert got == ("A",), "the delta's version of the changed row must win"


class RecordingApi(FakeApi):
    """FakeApi, noting which source each call was made for."""

    def __init__(self, by_dept):
        super().__init__(by_dept)
        self.sources = []

    def total(self, _client, *, departement=None, qs=None, source=None):
        self.sources.append(source)
        return super().total(_client, departement=departement, qs=qs)

    def iter_pages(self, _client, *, source=None, **kw):
        self.sources.append(source)
        return super().iter_pages(_client, **kw)


def test_reconciliation_asks_the_sources_own_dataset(base, source, tmp_path, monkeypatch):
    fake = RecordingApi({"09": ["2409N0000001"], "31": ["2431N0000001"]})
    monkeypatch.setattr(delta.api, "total", fake.total)
    monkeypatch.setattr(delta.api, "iter_pages", fake.iter_pages)

    report = delta.reconcile(None, base, source=source)
    assert set(fake.sources) == {source}
    assert report["09"].gone == ["2409N0000002"]

    out = tmp_path / "reconciled"
    delta.apply_deletions(base, report, out, source=source)
    assert _names(out / "search" / "dept=09" / "part-0000.parquet") == list(COLUMNS)


def test_the_delta_is_fetched_from_the_sources_dataset_into_its_schema(base, source, tmp_path, monkeypatch):
    fake = RecordingApi({})

    def pages(_client, *, source=None, **kw):
        fake.sources.append(source)

        class Page:
            rows, next_url, nbytes = [_row("2409N0000009", "09", "2026-09-05")], None, 0

        yield Page()

    monkeypatch.setattr(delta.api, "iter_pages", pages)
    manifest = json.loads((base / "manifest.json").read_text())
    path = tmp_path / "fetched.sqlite"

    assert delta.fetch_delta(None, "2026-09-01", path, manifest, source=source) == 1
    assert fake.sources == [source]
    conn = db.connect(path)
    assert conn.execute("SELECT dataset FROM data_source").fetchone()[0] == "neuf-like"
    columns = {r[0] for r in conn.execute("SELECT column_name FROM column_meta")}
    assert not NEUF_ABSENT & columns
