"""A source whose record key, departement and modification date are its own.

ADEME's audits publish one row per audit STEP. `n_audit` repeats across an
audit's steps and `numero_dpe` is the DPE the audit refers to, so neither
identifies a row. `id_etape` does, alone: unique over all 3 237 797 rows,
checked on 2026-09-10. The audits also rename the departement and
modification columns (`n_departement_ban`, `date_derniere_modification`).

Before this, the key was `numero_dpe` everywhere. `ON CONFLICT(numero_dpe) DO
NOTHING` would have kept one step of each audit and dropped the rest, and the
weekly merge's anti-join on `numero_dpe` would have deleted every step of an
audit to put back the one that changed. See ADR-0029.
"""

from __future__ import annotations

import json
from dataclasses import replace

import duckdb
import pytest

from ademe import api, db, delta, export_parquet, ingest, mapping, reconstruct, schema, spec
from ademe.config import SCHEMA_JSON, UNGEOCODED, Source

RENAMED = {
    "code_departement_ban": "n_departement_ban",
    "date_derniere_modification_dpe": "date_derniere_modification",
}
SEARCH = (("id_etape", "numero_dpe", "n_departement_ban", "etiquette_dpe"), ("id_etape",))


def _row(step: str, **over) -> dict:
    return {
        "id_etape": step,
        # Every step of the audit refers to the same DPE.
        "numero_dpe": "2409E0000001",
        "code_insee_ban": "09225",
        "nom_commune_ban": "Pamiers",
        "n_departement_ban": "09",
        "code_region_ban": "76",
        "code_postal_ban": "09100",
        "adresse_ban": "1 rue de Test 09100 Pamiers",
        "nom_rue_ban": "rue de Test",
        "numero_voie_ban": "1",
        "identifiant_ban": "09225_0001",
        "date_derniere_modification": "2024-04-02",
        **over,
    }


@pytest.fixture
def audit_like(tmp_path, monkeypatch) -> Source:
    fields = []
    for f in json.loads(SCHEMA_JSON.read_text()):
        if f["key"] in RENAMED:
            f = {**f, "key": RENAMED[f["key"]], "label": RENAMED[f["key"]]}
        fields.append(f)
    fields.append(
        {"key": "id_etape", "label": "id_etape", "type": "string", "x-cardinality": 3_237_797}
    )
    path = tmp_path / "audit-like-schema.json"
    path.write_text(json.dumps(fields))
    monkeypatch.setitem(export_parquet.SEARCH, "audit-like", SEARCH)
    return Source(
        slug="audit-like",
        dataset="audit-like",
        schema_json=path,
        db_path=tmp_path / "audit-like.sqlite",
        subdir="audit-like",
        mapping=replace(
            mapping.EXISTANT,
            commune={RENAMED.get(s, s): d for s, d in mapping.COMMUNE_COLUMNS.items()},
            key="id_etape",
            departement="n_departement_ban",
            modified="date_derniere_modification",
        ),
    )


def _build(source: Source, rows: list[dict], path=None):
    path = path or source.db_path
    schema.build(path, source=source)
    conn = db.connect(path, bulk=True)
    ingest.Loader(conn, spec.load(source=source), source=source).load_page(rows)
    conn.commit()
    return conn


def test_two_steps_of_one_audit_are_two_rows(audit_like):
    conn = _build(audit_like, [_row("E1", etiquette_dpe="D"), _row("E2", etiquette_dpe="B")])

    assert conn.execute("SELECT count(*) FROM dpe").fetchone()[0] == 2
    rec = reconstruct.Reconstructor(conn, source=audit_like)
    assert rec.row("E1")["etiquette_dpe"] == "D"
    # numero_dpe is an ordinary column now, and it survives.
    assert rec.row("E2")["etiquette_dpe"] == "B"
    assert rec.row("E2")["numero_dpe"] == "2409E0000001"
    conn.close()


def test_the_export_partitions_sorts_and_reads_back_by_the_sources_own_fields(audit_like, tmp_path):
    _build(
        audit_like,
        [
            _row("E2", etiquette_dpe="B", date_derniere_modification="2024-04-03"),
            _row("E1", etiquette_dpe="D"),
        ],
    ).close()

    manifest = export_parquet.export(audit_like.db_path, tmp_path / "out", source=audit_like)
    root = tmp_path / "out" / export_parquet.VERSION / "audit-like"

    # The partition comes from n_departement_ban, the high-water mark from
    # date_derniere_modification.
    assert [(p["dept"], p["rows"]) for p in manifest["partitions"]] == [("09", 2)]
    assert manifest["high_water"] == "2024-04-03"
    assert manifest["key"] == "id_etape"
    got = [
        r[0]
        for r in duckdb.connect().execute(
            "SELECT id_etape FROM read_parquet(?, hive_partitioning = false)",
            [str(root / "dpe" / "dept=09" / "part-0000.parquet")],
        ).fetchall()
    ]
    assert got == ["E1", "E2"]
    rows = export_parquet.read_rows(root, ["E1", "E2"])
    assert rows["E1"]["etiquette_dpe"] == "D"
    assert rows["E2"]["numero_dpe"] == "2409E0000001"


def test_the_weekly_merge_replaces_one_step_and_keeps_the_others(audit_like, tmp_path):
    _build(audit_like, [_row("E1", etiquette_dpe="D"), _row("E2", etiquette_dpe="D")]).close()
    export_parquet.export(audit_like.db_path, tmp_path / "base", source=audit_like)
    changed = tmp_path / "changed.sqlite"
    _build(audit_like, [_row("E2", etiquette_dpe="A")], path=changed).close()
    export_parquet.export(changed, tmp_path / "delta", source=audit_like)

    out = tmp_path / "merged"
    delta.merge_partition(
        duckdb.connect(),
        tmp_path / "base" / export_parquet.VERSION / "audit-like",
        tmp_path / "delta" / export_parquet.VERSION / "audit-like",
        "09",
        out,
        source=audit_like,
    )
    merged = duckdb.connect().execute(
        "SELECT id_etape, etiquette_dpe FROM read_parquet(?, hive_partitioning = false)"
        " ORDER BY id_etape",
        [str(out / "dpe" / "dept=09" / "part-0000.parquet")],
    ).fetchall()
    # Anti-joined on numero_dpe, E1 would be gone: it shares E2's DPE.
    assert merged == [("E1", "D"), ("E2", "A")]


def test_queries_name_the_sources_own_fields(audit_like, tmp_path, monkeypatch):
    seen: list[tuple[str, dict]] = []

    class Response:
        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    def fake_get(_client, url, params=None):
        seen.append((url, dict(params or {})))
        return Response({"total": 0} if url.endswith("/lines") else ["09"])

    monkeypatch.setattr(api, "_get", fake_get)
    api.total(None, departement="09", source=audit_like)
    api.total(None, departement=UNGEOCODED, source=audit_like)
    assert ingest.departements(None, audit_like) == ["09", UNGEOCODED]
    assert seen[0][1]["qs"] == 'n_departement_ban:"09"'
    assert seen[1][1]["qs"] == "NOT _exists_:n_departement_ban"
    assert seen[2][0].endswith("/values/n_departement_ban")

    asked = []

    def pages(_client, *, qs=None, **_kw):
        asked.append(qs)
        return iter(())

    monkeypatch.setattr(delta.api, "iter_pages", pages)
    delta.fetch_delta(None, "2024-04-01", tmp_path / "d.sqlite", {"column_meta": {}}, source=audit_like)
    assert asked == ["date_derniere_modification:[2024-04-01 TO *]"]
