"""The tertiary DPE, the third ADEME source.

`dpe01tertiaire` publishes 562 695 certificates for offices, shops and public
buildings, in 69 columns. It shares existing housing's address and commune
columns, and has one repeating group of its own: up to three energies, each
with its use, its final and primary consumption, its annual cost and the year
it was read (`*_energie_n1..n3`). It has no floor area of a dwelling, so its
search index is its own. See ADR-0026.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest

from ademe import api, db, export_parquet, ingest, mapping, reconstruct, schema, spec
from ademe.config import SOURCES
from tests.test_export_parquet import _equal

HEADER = Path(__file__).parent / "fixtures" / "dpe01tertiaire-csv-header-2026-09-10.txt"

SCALES = {
    "surface_utile": 10,
    "conso_kwhep_m2_an": 10,
    "conso_ep_energie_n1": 10,
    "conso_ep_energie_n2": 10,
    "coordonnee_cartographique_x_ban": 10**6,
    "coordonnee_cartographique_y_ban": 10**6,
}

ROW = {
    "numero_dpe": "2409T0000001",
    "code_insee_ban": "09122",
    "nom_commune_ban": "Foix",
    "code_departement_ban": "09",
    "code_region_ban": "76",
    "code_postal_ban": "09000",
    "adresse_ban": "2 rue de la Préfecture 09000 Foix",
    "identifiant_ban": "09122_0042_00002",
    "nom_rue_ban": "rue de la Préfecture",
    "numero_voie_ban": "2",
    "coordonnee_cartographique_x_ban": "592611.330000",
    "coordonnee_cartographique_y_ban": "6207452.180000",
    "etiquette_dpe": "C",
    "etiquette_ges": "B",
    "date_etablissement_dpe": "2025-11-04",
    "date_derniere_modification_dpe": "2025-11-05",
    "secteur_activite": "Bureaux",
    "categorie_erp": "Bureaux",
    "surface_utile": "812.5",
    "conso_kwhep_m2_an": "143.2",
    # Two energies of the three slots.
    "type_energie_n1": "Électricité",
    "type_usage_energie_n1": "Chauffage",
    "conso_ep_energie_n1": "71210.0",
    "type_energie_n2": "Gaz naturel",
    "type_usage_energie_n2": "Eau chaude sanitaire",
    "conso_ep_energie_n2": "44100.5",
}


def _reaches_every_column_once(headers: list[str]) -> bool:
    src = SOURCES["tertiaire"]
    to_key = spec.csv_header_to_key(src)
    keys = [to_key.get(h, h) for h in headers]
    wanted = {f["key"] for f in spec._raw(src.schema_json)} - src.mapping.internal
    return len(set(keys)) == len(keys) and set(keys) == wanted


def test_the_tertiary_dpe_is_a_source_of_its_own():
    src = SOURCES["tertiaire"]
    assert (src.dataset, src.subdir, src.db_path.name) == (
        "dpe01tertiaire",
        "tertiaire",
        "ademe-tertiaire.sqlite",
    )
    assert len({s.db_path for s in SOURCES.values()}) == len(SOURCES)


def test_every_tertiary_column_has_a_place_and_the_energies_repeat():
    src = SOURCES["tertiaire"]
    cov = mapping.check_coverage(list(spec.load(source=src)), src.mapping)
    assert set(cov.repeats) == {"dpe_energie"}
    assert len(cov.repeats["dpe_energie"]) == 18  # six fields, three slots
    assert {"secteur_activite", "surface_utile", "categorie_erp"} <= set(cov.dpe)


def test_the_vendored_labels_are_the_header_the_tertiary_export_served():
    line = HEADER.read_text(encoding="utf-8-sig")
    assert _reaches_every_column_once(next(csv.reader(io.StringIO(line))))


@pytest.mark.live
def test_the_vendored_labels_are_the_header_the_tertiary_export_serves_today():
    r = api._get(api.client(), f"{SOURCES['tertiaire'].api}/lines", {"size": 1, "format": "csv"})
    assert _reaches_every_column_once(next(csv.reader(io.StringIO(r.content.decode("utf-8-sig")))))


def test_its_search_index_is_its_own_and_its_columns_exist():
    columns, sort = export_parquet.SEARCH["tertiaire"]
    have = set(spec.load(source=SOURCES["tertiaire"])) | {"lat", "lon"}
    assert set(columns) <= have and set(sort) <= set(columns)
    assert "surface_utile" in columns and "surface_habitable_logement" not in columns


def test_a_tertiary_certificate_round_trips(tmp_path):
    src = SOURCES["tertiaire"]
    path = tmp_path / "tertiaire.sqlite"
    schema.build(path, scales=SCALES, source=src)
    conn = db.connect(path, bulk=True)
    ingest.Loader(conn, spec.load(SCALES, source=src), source=src).load_page([ROW])
    conn.commit()

    assert conn.execute("SELECT count(*) FROM dpe_energie").fetchone()[0] == 2
    rebuilt = reconstruct.Reconstructor(conn, source=src).row(ROW["numero_dpe"])
    numeric = {
        r[0] for r in conn.execute("SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')")
    }
    wrong = {k: (v, rebuilt[k]) for k, v in ROW.items() if not _equal(k, v, rebuilt[k], numeric)}
    assert not wrong, wrong

    export_parquet.export(path, tmp_path / "out", source=src)
    published = export_parquet.read_rows(tmp_path / "out" / "v1" / "tertiaire", [ROW["numero_dpe"]])
    got = published[ROW["numero_dpe"]]
    bad = [c for c, v in rebuilt.items() if not _equal(c, v, got.get(c, ""), numeric)]
    assert not bad, bad[:10]
