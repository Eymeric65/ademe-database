"""ADEME's energy audits, the fourth source.

Dataset `ync2epx48x9azbdnggbygqp0` publishes 3 237 797 rows in 232 columns, one
row per audit STEP: an audit (`n_audit`) proposes renovation scenarios in
steps, and each step is a row with its own `id_etape`. `id_etape` is the key,
alone (ADR-0029). `numero_dpe` is the DPE the audit refers to, so it repeats.
The BAN columns are renamed (`n_departement_ban`, `n_voie_ban`,
`nom_voie_ban`, `n_region_ban`), and its repeating groups are its own. Like
existing housing, it is a virtual view filtered on a flag (`in_desactive`), so
reconciliation applies (ADR-0007). See ADR-0031.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest

from ademe import api, db, export_parquet, finalise, ingest, mapping, reconstruct, schema, spec
from ademe.config import SOURCES
from tests.test_export_parquet import _equal

# The header line of the audits' `lines?format=csv`, as served on 2026-09-10.
HEADER = Path(__file__).parent / "fixtures" / "audit-csv-header-2026-09-10.txt"

SCALES = {
    "surface_habitable_logement": 10,
    "ep_conso_5_usages_m2": 10,
    "coordonnee_cartographique_x_ban": 10**6,
    "coordonnee_cartographique_y_ban": 10**6,
}


def _step(step: str, etape: str, **over) -> dict:
    return {
        "id_etape": step,
        "n_audit": "A240900000001",
        # Every step of an audit refers to the same DPE.
        "numero_dpe": "2409E0000001",
        "categorie_scenario": "Scénario principal",
        "etape_travaux": etape,
        "code_insee_ban": "09122",
        "nom_commune_ban": "Foix",
        "n_departement_ban": "09",
        "n_region_ban": "76",
        "code_postal_ban": "09000",
        "adresse_ban": "2 rue de la Préfecture 09000 Foix",
        "identifiant_ban": "09122_0042_00002",
        "nom_voie_ban": "rue de la Préfecture",
        "n_voie_ban": "2",
        "coordonnee_cartographique_x_ban": "592611.330000",
        "coordonnee_cartographique_y_ban": "6207452.180000",
        "date_etablissement_audit": "2025-11-04",
        "date_derniere_modification": "2025-11-05",
        "surface_habitable_logement": "96.5",
        "ep_conso_5_usages_m2": "212.4",
        # One heating installation with one generator, one energy, one
        # hot-water generator: a slot of each of the four groups.
        "type_installation_chauffage_n1": "installation individuelle",
        "type_generateur_n1_installation_chauffage_n1": "Chaudière gaz",
        "type_energie_n1": "Gaz naturel",
        "type_generateur_ecs_n1": "Ballon électrique",
        **over,
    }


def _reaches_every_column_once(headers: list[str]) -> bool:
    src = SOURCES["audit"]
    to_key = spec.csv_header_to_key(src)
    keys = [to_key.get(h, h) for h in headers]
    wanted = {f["key"] for f in spec._raw(src.schema_json)} - src.mapping.internal
    return len(set(keys)) == len(keys) and set(keys) == wanted


def test_the_audits_are_a_source_of_their_own():
    src = SOURCES["audit"]
    assert (src.dataset, src.subdir, src.db_path.name) == (
        "ync2epx48x9azbdnggbygqp0",
        "audit",
        "ademe-audit.sqlite",
    )
    assert len({s.db_path for s in SOURCES.values()}) == len(SOURCES)
    m = src.mapping
    assert (m.key, m.departement, m.modified) == (
        "id_etape",
        "n_departement_ban",
        "date_derniere_modification",
    )


def test_every_audit_column_has_a_place_and_the_groups_repeat():
    src = SOURCES["audit"]
    cov = mapping.check_coverage(list(spec.load(source=src)), src.mapping)
    # Eight fields in two installations, four in 2x2 generators, ten in three
    # energies, seven in one hot-water generator.
    assert {t: len(c) for t, c in cov.repeats.items()} == {
        "dpe_installation_chauffage": 16,
        "dpe_generateur_chauffage": 16,
        "dpe_bilan_energie": 30,
        "dpe_generateur_ecs": 7,
    }
    assert {"id_etape", "n_audit", "numero_dpe", "etape_travaux"} <= set(cov.dpe)


def test_the_vendored_labels_are_the_header_the_audits_served():
    line = HEADER.read_text(encoding="utf-8-sig")
    assert _reaches_every_column_once(next(csv.reader(io.StringIO(line))))


@pytest.mark.live
def test_the_vendored_labels_are_the_header_the_audits_serve_today():
    r = api._get(api.client(), f"{SOURCES['audit'].api}/lines", {"size": 1, "format": "csv"})
    assert _reaches_every_column_once(next(csv.reader(io.StringIO(r.content.decode("utf-8-sig")))))


def test_its_search_index_is_its_own_and_its_columns_exist():
    columns, sort = export_parquet.SEARCH["audit"]
    have = set(spec.load(source=SOURCES["audit"])) | {"lat", "lon"}
    assert set(columns) <= have and set(sort) <= set(columns)
    # The weekly merge anti-joins the search file on the key.
    assert "id_etape" in columns


def test_two_steps_of_one_audit_round_trip(tmp_path):
    src = SOURCES["audit"]
    path = tmp_path / "audit.sqlite"
    schema.build(path, scales=SCALES, source=src)
    conn = db.connect(path, bulk=True)
    steps = [_step("E1", "Étape 1"), _step("E2", "Étape 2", ep_conso_5_usages_m2="98.0")]
    ingest.Loader(conn, spec.load(SCALES, source=src), source=src).load_page(steps)
    conn.commit()
    assert finalise.finalise(conn, source=src) == 2

    rec = reconstruct.Reconstructor(conn, source=src)
    numeric = {
        r[0] for r in conn.execute("SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')")
    }
    for step in steps:
        rebuilt = rec.row(step["id_etape"])
        wrong = {k: (v, rebuilt[k]) for k, v in step.items() if not _equal(k, v, rebuilt[k], numeric)}
        assert not wrong, wrong

    manifest = export_parquet.export(path, tmp_path / "out", source=src)
    assert [(p["dept"], p["rows"]) for p in manifest["partitions"]] == [("09", 2)]
    assert manifest["high_water"] == "2025-11-05"
    published = export_parquet.read_rows(tmp_path / "out" / "v1" / "audit", ["E1", "E2"])
    for step in steps:
        rebuilt = rec.row(step["id_etape"])
        got = published[step["id_etape"]]
        bad = [c for c, v in rebuilt.items() if not _equal(c, v, got.get(c, ""), numeric)]
        assert not bad, bad[:10]
    conn.close()
