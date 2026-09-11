"""Existing housing's structure, for a dataset that has most of it.

ADEME's new-housing DPE (`dpe02neuf`) publishes 212 columns: 210 of existing
housing's 230, plus two of its own. The 20 it lacks are not scattered. Eight are
top-level, and the other twelve are whole columns of a repeating group:
`description_generateur_chauffage_n{g}_installation_n{i}` is gone from all four
generator slots, not from one. That is what lets one structure serve both, minus
what the second lacks.

Before this, `mapping.classify` named existing housing's columns and refused any
schema missing one of them ("the export shape changed"), so a second dataset
could not be built at all. See ADR-0017.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from ademe import db, ddl, ingest, mapping, reconstruct, schema, spec
from ademe.config import EXISTANT, SCHEMA_JSON, Source

# The 20, measured against the live catalogue on 2026-09-10.
NEUF_ABSENT = frozenset(
    {
        "apport_interne_saison_chauffe",
        "apport_interne_saison_froide",
        "apport_solaire_saison_chauffe",
        "apport_solaire_saison_froide",
        "date_installation_generateur_n1_ecs_n1",
        "date_installation_generateur_n2_ecs_n1",
        "description_generateur_chauffage_n1_installation_n1",
        "description_generateur_chauffage_n1_installation_n2",
        "description_generateur_chauffage_n2_installation_n1",
        "description_generateur_chauffage_n2_installation_n2",
        "facteur_couverture_solaire_installation_chauffage_n1",
        "facteur_couverture_solaire_installation_chauffage_n2",
        "facteur_couverture_solaire_n1",
        "facteur_couverture_solaire_saisi_installation_chauffage_n1",
        "facteur_couverture_solaire_saisi_installation_chauffage_n2",
        "facteur_couverture_solaire_saisi_n1",
        "periode_installation_generateur_froid",
        "qualite_isolation_plancher_haut_comble_perdu",
        "qualite_isolation_plancher_haut_toit_terrasse",
        "type_energie_climatisation",
    }
)

# sha256 of existing housing's generated DDL, column_meta rows and indexes,
# computed on the code before this change (dev + #23 + #24, 37d6a64). The
# national build is loading into that schema right now; it must not move a byte.
GOLDEN = "59a5e5c2102681d577c19691a62dedc3aa7a80030776117009b9cda1be0716bb"

ROW = {
    "numero_dpe": "2409N0000001",
    "code_insee_ban": "09225",
    "nom_commune_ban": "Pamiers",
    "code_departement_ban": "09",
    "code_region_ban": "76",
    "code_postal_ban": "09100",
    "adresse_ban": "1 rue de Test 09100 Pamiers",
    "nom_rue_ban": "rue de Test",
    "numero_voie_ban": "1",
    "identifiant_ban": "09225_0001",
    "etiquette_dpe": "A",
    # A generator slot whose `description` column no longer exists.
    "type_generateur_n1_installation_n1": "PAC air/eau",
    "type_energie_n1": "Électricité",
    "conso_5_usages_ef_energie_n1": "1234",
}


@pytest.fixture
def neuf_like(tmp_path) -> Source:
    fields = [f for f in json.loads(SCHEMA_JSON.read_text()) if f["key"] not in NEUF_ABSENT]
    path = tmp_path / "neuf-like-schema.json"
    path.write_text(json.dumps(fields))
    return Source(
        slug="neuf-like",
        dataset="neuf-like",
        schema_json=path,
        db_path=tmp_path / "neuf-like.sqlite",
        subdir="neuf-like",
        mapping=mapping.EXISTANT.without(NEUF_ABSENT),
    )


def test_a_dataset_missing_columns_builds_loads_and_reconstructs(neuf_like):
    schema.build(neuf_like.db_path, source=neuf_like)
    conn = db.connect(neuf_like.db_path, bulk=True)
    cols = spec.load(source=neuf_like)
    ingest.Loader(conn, cols, source=neuf_like).load_page([ROW])
    conn.commit()

    got = reconstruct.Reconstructor(conn, source=neuf_like).row(ROW["numero_dpe"])
    assert {k: v for k, v in got.items() if v} == ROW
    # The missing columns are not resurrected as empty ones.
    assert not NEUF_ABSENT & set(got)
    generator = {r[1] for r in conn.execute("PRAGMA table_info(dpe_generateur_chauffage)")}
    assert "type_generateur_id" in generator and "description" not in generator
    assert tuple(conn.execute("SELECT dataset, url FROM data_source").fetchone()) == (
        "neuf-like",
        neuf_like.api,
    )


def test_a_column_missing_from_only_some_slots_is_refused():
    """A repeating group's child table is built from its first slot, so a
    column absent from one slot but present in another has nowhere to go."""
    with pytest.raises(ValueError, match="description_generateur_chauffage"):
        mapping.EXISTANT.without({"description_generateur_chauffage_n1_installation_n1"})


def test_a_whole_slot_can_go():
    third = {c for c in mapping.BILAN_ENERGIE.source_columns() if c.endswith("_n3")}
    m = mapping.EXISTANT.without(third)
    (bilan,) = [r for r in m.repeats if r.table == "dpe_bilan_energie"]
    assert bilan.outer == (1, 2)
    assert bilan.source_columns() == mapping.BILAN_ENERGIE.source_columns() - third


def test_one_cell_of_a_two_dimensional_group_is_refused():
    """Installation 2's second generator, alone: the slots left would no longer
    be installations x generators, which is the only shape a Repeat has."""
    cell = {
        s.format(i=2, g=2) for s in mapping.GENERATEUR_CHAUFFAGE.columns
    }
    with pytest.raises(ValueError, match="slot"):
        mapping.EXISTANT.without(cell)


def test_existing_housings_schema_is_unchanged():
    cols = spec.load()
    blob = json.dumps(
        {
            "ddl": ddl.all_ddl(cols),
            "meta": ddl.column_meta_rows(cols),
            "indexes": ddl.indexes_ddl(),
        }
    )
    assert hashlib.sha256(blob.encode()).hexdigest() == GOLDEN
    assert EXISTANT.mapping is mapping.EXISTANT
