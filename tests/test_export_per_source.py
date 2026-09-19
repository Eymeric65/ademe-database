"""A second ADEME source publishes its own tree, and existing housing's stays put.

The export used to write whatever database it was handed into `v1/`, with
existing housing's search columns and repeating groups. Given another source's
database it would have overwritten the files the app reads; given one whose
repeating groups differ -- a group the dataset lacks entirely, or one existing
housing does not have -- it joins tables that database does not have. See
ADR-0018.

The source here is existing housing's vendored schema minus new housing's real
20 missing columns, the same one `test_mapping_per_source.py` builds.
`test_export_parquet.py`, unchanged, keeps pinning existing housing's own export.
"""

from __future__ import annotations

import json
from datetime import date

import duckdb
import pytest

from ademe import db, export_parquet, ingest, mapping, recent, reconstruct, schema, spec
from ademe.config import SCHEMA_JSON, SOURCES, Source
from tests.test_export_parquet import SCALES, _equal, _row
from tests.test_mapping_per_source import NEUF_ABSENT


@pytest.fixture
def neuf(tmp_path) -> tuple[Source, list[str]]:
    fields = [f for f in json.loads(SCHEMA_JSON.read_text()) if f["key"] not in NEUF_ABSENT]
    path = tmp_path / "neuf-like-schema.json"
    path.write_text(json.dumps(fields))
    src = Source(
        slug="neuf-like",
        dataset="neuf-like",
        schema_json=path,
        db_path=tmp_path / "neuf-like.sqlite",
        subdir="neuf-like",
        mapping=mapping.EXISTANT.without(NEUF_ABSENT),
    )
    schema.build(src.db_path, scales=SCALES, source=src)
    conn = db.connect(src.db_path, bulk=True)
    rows = [
        # A generator slot whose `description` column this source does not have.
        _row(f"2409N{i:07d}", "09001", "09", type_generateur_n1_installation_n1="PAC air/eau")
        for i in range(3)
    ]
    ingest.Loader(conn, spec.load(SCALES, source=src), source=src).load_page(rows)
    conn.commit()
    conn.close()
    return src, [r["numero_dpe"] for r in rows]


@pytest.fixture
def declared(monkeypatch):
    """New housing's search index is existing housing's: it has every one of
    those columns. Declared here as the source's own PR would declare it."""
    monkeypatch.setitem(
        export_parquet.SEARCH,
        "neuf-like",
        (export_parquet.SEARCH_COLUMNS, export_parquet.SEARCH_SORT),
    )


def test_a_second_source_exports_to_its_own_tree(neuf, declared, tmp_path):
    src, _numeros = neuf
    out = tmp_path / "out"
    manifest = export_parquet.export(src.db_path, out, source=src)

    root = out / export_parquet.VERSION / "neuf-like"
    assert (root / "dpe" / "dept=09" / "part-0000.parquet").exists()
    assert (root / "search" / "dept=09" / "part-0000.parquet").exists()
    assert json.loads((root / "manifest.json").read_text()) == manifest
    assert manifest["search_columns"] == list(export_parquet.SEARCH_COLUMNS)
    # Nothing at v1/ itself: that is existing housing's tree, and the app's.
    assert [p.name for p in (out / export_parquet.VERSION).iterdir()] == ["neuf-like"]


def test_every_column_of_the_second_source_survives(neuf, declared, tmp_path):
    src, numeros = neuf
    out = tmp_path / "out"
    export_parquet.export(src.db_path, out, source=src)
    published = export_parquet.read_rows(out / export_parquet.VERSION / "neuf-like", numeros)

    conn = db.connect(src.db_path)
    rec = reconstruct.Reconstructor(conn, source=src)
    numeric = {
        r[0]
        for r in conn.execute(
            "SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')"
        )
    }
    compared, bad = 0, []
    for numero in numeros:
        want = rec.row(numero)
        assert not NEUF_ABSENT & set(want)
        for col, value in want.items():
            compared += 1
            if not _equal(col, value, published[numero].get(col, ""), numeric):
                bad.append(f"{numero}.{col}: sqlite={value!r} parquet={published[numero].get(col)!r}")
    # 206 columns: existing housing's 226 recorded ones, less the 20 absent.
    assert compared == 3 * 206
    assert not bad, "\n  ".join(bad[:20])


def test_a_source_with_no_declared_search_columns_is_refused(neuf, tmp_path):
    """A tertiary DPE has no `surface_habitable_logement`: existing housing's
    search index cannot be anybody's default."""
    src, _numeros = neuf
    with pytest.raises(ValueError, match="neuf-like"):
        export_parquet.export(src.db_path, tmp_path / "out", source=src)
    assert not (tmp_path / "out").exists()


# --- the paid window, per source (ADR-0039) ----------------------------------


@pytest.mark.parametrize("slug", sorted(SOURCES))
def test_the_counts_columns_are_search_columns_that_name_no_row(slug):
    """The counts file is cut from the search file, and published to every
    signed-in caller: a key, an address or a coordinate there would publish
    the recent rows themselves."""
    date_col, columns = export_parquet.RECENT[slug]
    search, _sort = export_parquet.SEARCH[slug]
    assert set(columns) <= set(search)
    assert date_col in columns
    assert len(set(columns)) == len(columns)
    named = {SOURCES[slug].mapping.key, "numero_dpe", "n_audit", "adresse_ban", "lat", "lon"}
    assert not named & set(columns)


def test_every_step_of_an_audit_lands_on_the_same_side(tmp_path):
    """The detail view shows an audit's steps together; half of them in the
    free tree would show half an audit."""
    from tests.test_source_audit import SCALES as AUDIT_SCALES
    from tests.test_source_audit import _step

    src = SOURCES["audit"]
    path = tmp_path / "audit.sqlite"
    schema.build(path, scales=AUDIT_SCALES, source=src)
    conn = db.connect(path, bulk=True)
    steps = [
        _step("E1", "étape 1", n_audit="A1", date_etablissement_audit="2026-08-01"),
        _step("E2", "étape 2", n_audit="A1", date_etablissement_audit="2026-05-01"),
        _step("E3", "étape 1", n_audit="A2", date_etablissement_audit="2026-05-01"),
        _step("E4", "étape 2", n_audit="A2", date_etablissement_audit=""),
    ]
    ingest.Loader(conn, spec.load(AUDIT_SCALES, source=src), source=src).load_page(steps)
    conn.commit()
    conn.close()
    export_parquet.export(path, tmp_path / "whole", source=src)

    out = tmp_path / "publish"
    m = recent.split(tmp_path / "whole", out, date(2026, 7, 19), source=src)
    assert m["recent"]["tree"] == "recent/v1/audit"
    assert m["recent"]["date_column"] == "date_etablissement_audit"

    def ids(tree):
        return sorted(
            r[0]
            for r in duckdb.connect()
            .execute(
                f"SELECT id_etape FROM read_parquet('{tree / 'dpe' / 'dept=09' / 'part-0000.parquet'}')"
            )
            .fetchall()
        )

    assert ids(out / "recent" / "v1" / "audit") == ["E1", "E2"]
    assert ids(out / "v1" / "audit") == ["E3", "E4"]
    counts = out / "v1" / "audit" / "recent-counts" / "dept=09" / "part-0000.parquet"
    assert duckdb.connect().execute(f"SELECT count(*) FROM read_parquet('{counts}')").fetchone()[0] == 2

    joined = tmp_path / "joined"
    recent.join(out, joined, source=src)
    assert ids(joined / "v1" / "audit") == ["E1", "E2", "E3", "E4"]


def test_read_rows_reads_the_recent_tree_too(neuf, declared, tmp_path, monkeypatch):
    """The round-trip samples from both trees, so it has to read both."""
    src, numeros = neuf
    monkeypatch.setitem(export_parquet.RECENT, "neuf-like", export_parquet.RECENT["neuf"])
    export_parquet.export(src.db_path, tmp_path / "whole", source=src)
    whole = export_parquet.read_rows(tmp_path / "whole" / "v1" / "neuf-like", numeros)

    out = tmp_path / "publish"
    # Every fixture row is dated 2024-03-11: split one side of it, then the other.
    recent.split(tmp_path / "whole", out, date(2024, 1, 1), source=src)
    base = out / "v1" / "neuf-like"
    paid = out / "recent" / "v1" / "neuf-like"
    assert export_parquet.read_rows(base, numeros) == {}
    assert export_parquet.read_rows(base, numeros, recent_dir=paid) == whole
