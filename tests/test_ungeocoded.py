"""Certificates ADEME could not geocode: fetched, exported, merged.

The ingest asks ADEME for one departement at a time, by `code_departement_ban`.
A certificate whose address the BAN could not match carries no departement at
all -- "adresse non géocodée ban car aucune correspondance trouvée" -- so no
departement query ever returns it. On 2026-09-10 that was 531 646 of 15 557 428,
3.4% of the dataset, silently absent from the national build: the ledger
matched ADEME's per-departement totals exactly, and the round-trip only samples
what was loaded. They are one pseudo-departement, `NG` (non géocodé), from the
query to the published partition. See ADR-0024.
"""

from __future__ import annotations

import json

import duckdb
import httpx
import pytest

from ademe import api, db, delta, export_parquet, ingest, reconstruct, schema, spec
from tests.test_export_parquet import SCALES, _equal, _row

# What a BAN miss looks like: every BAN field empty, the raw address intact.
NO_BAN = {
    "code_departement_ban": "",
    "code_insee_ban": "",
    "nom_commune_ban": "",
    "code_postal_ban": "",
    "adresse_ban": "",
    "identifiant_ban": "",
    "nom_rue_ban": "",
    "numero_voie_ban": "",
    "coordonnee_cartographique_x_ban": "",
    "coordonnee_cartographique_y_ban": "",
}


def _ungeocoded(numero: str, **over) -> dict:
    fields = {
        **NO_BAN,
        "adresse_brut": "STCHAMAND BAT B2",
        "code_postal_brut": "84000",
        "nom_commune_brut": "AVIGNON",
        **over,
    }
    return _row(numero, "84007", "84", **fields)


def test_ng_asks_ademe_for_the_certificates_with_no_departement():
    seen: list[httpx.Request] = []

    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={"total": 531646})

    cl = httpx.Client(transport=httpx.MockTransport(handle))
    assert api.total(cl, departement="NG") == 531646
    assert seen[0].url.params["qs"] == "NOT _exists_:code_departement_ban"
    # Every other code is still an ordinary departement query.
    api.total(cl, departement="09")
    assert seen[1].url.params["qs"] == 'code_departement_ban:"09"'


def test_ingest_all_includes_ng():
    cl = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=["09", "2A"])))
    assert ingest.departements(cl) == ["09", "2A", "NG"]


@pytest.fixture
def exported(tmp_path):
    path = tmp_path / "t.sqlite"
    schema.build(path, scales=SCALES)
    conn = db.connect(path, bulk=True)
    ingest.Loader(conn, spec.load(SCALES)).load_page(
        [
            _row("2409E0000001", "09001", "09"),
            _row("2409E0000002", "09001", "09"),
            _ungeocoded("2684E0024134R"),
            # An INSEE code but still no departement: 34 346 of them upstream.
            _ungeocoded("2675E0018872Y", code_insee_ban="75118"),
        ]
    )
    conn.commit()
    out = tmp_path / "out"
    manifest = export_parquet.export(path, out)
    return conn, path, out / export_parquet.VERSION, manifest


NG_NUMEROS = ["2675E0018872Y", "2684E0024134R"]


def test_an_ungeocoded_certificate_is_published_in_ng(exported):
    conn, _path, root, manifest = exported
    assert [p["dept"] for p in manifest["partitions"]] == ["09", "NG"]
    ng = root / "dpe" / "dept=NG" / "part-0000.parquet"
    got = sorted(
        r[0]
        for r in duckdb.connect()
        .execute(f"SELECT numero_dpe FROM read_parquet('{ng}', hive_partitioning = false)")
        .fetchall()
    )
    assert got == NG_NUMEROS


def test_every_column_of_an_ungeocoded_certificate_survives(exported):
    conn, _path, root, _manifest = exported
    published = export_parquet.read_rows(root, NG_NUMEROS)
    rec = reconstruct.Reconstructor(conn)
    numeric = {
        r[0] for r in conn.execute("SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')")
    }
    bad = [
        f"{n}.{c}: sqlite={v!r} parquet={published[n].get(c)!r}"
        for n in NG_NUMEROS
        for c, v in rec.row(n).items()
        if not _equal(c, v, published[n].get(c, ""), numeric)
    ]
    assert not bad, bad[:10]
    assert published["2684E0024134R"]["adresse_brut"] == "STCHAMAND BAT B2"


def test_the_detail_view_can_find_them(exported):
    """The detail view guesses a partition from the numero's digits; a
    certificate elsewhere is found through the exceptions index."""
    _conn, _path, root, _manifest = exported
    rows = duckdb.connect().execute(
        f"SELECT numero_dpe, dept FROM read_parquet('{root / 'index' / 'numero-exceptions.parquet'}')"
        " ORDER BY numero_dpe"
    ).fetchall()
    assert [r for r in rows if r[1] == "NG"] == [(n, "NG") for n in NG_NUMEROS]


def test_a_weekly_delta_merges_an_ungeocoded_certificate_into_ng(exported, tmp_path):
    _conn, _path, root, _manifest = exported
    dpath = tmp_path / "delta.sqlite"
    schema.build(dpath, scales=SCALES)
    dconn = db.connect(dpath, bulk=True)
    ingest.Loader(dconn, spec.load(SCALES)).load_page(
        [_ungeocoded("2684E0024134R", etiquette_dpe="A"), _ungeocoded("2613E0000009X")]
    )
    dconn.commit()
    dconn.close()
    export_parquet.export(dpath, tmp_path / "delta-out")

    merged = tmp_path / "merged"
    assert delta.merge(root, tmp_path / "delta-out" / export_parquet.VERSION, merged) == ["NG"]
    got = dict(
        duckdb.connect()
        .execute(
            f"SELECT numero_dpe, etiquette_dpe FROM read_parquet("
            f"'{merged / 'dpe' / 'dept=NG' / 'part-0000.parquet'}', hive_partitioning = false)"
        )
        .fetchall()
    )
    assert got == {"2613E0000009X": "D", "2675E0018872Y": "D", "2684E0024134R": "A"}
    counts = {p["dept"]: p["rows"] for p in json.loads((merged / "manifest.json").read_text())["partitions"]}
    assert counts == {"09": 2, "NG": 3}
