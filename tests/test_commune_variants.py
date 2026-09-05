"""One INSEE code, two spellings, and the source means both.

ADEME does not normalise `nom_commune_ban`: certificates for the same commune
carry `PAMIERS` and `Pamiers`, `FOIX` and `Foix`. Measured against the live API
for departement 09, 13 of 326 INSEE codes carry more than one spelling -- and
they are the populous communes, so the share of affected certificates is far
higher than 4%.

This is the same failure `ingest.adresse_id` already documents for addresses,
where keying on the whole tuple instead of on `identifiant_ban` fixed it. The
`commune` table still had it: one row per INSEE code, ON CONFLICT DO NOTHING,
so whichever certificate arrived first imposed its spelling on every later one.

`tests/test_roundtrip.py` passes on a 40-row sample largely by luck.
"""

from __future__ import annotations

import pytest

from ademe import db, ingest, reconstruct, schema, spec

INSEE = "09225"


def _row(numero: str, nom: str) -> dict:
    return {
        "numero_dpe": numero,
        "code_insee_ban": INSEE,
        "nom_commune_ban": nom,
        "code_departement_ban": "09",
        "code_region_ban": "76",
        "code_postal_ban": "09100",
        "adresse_ban": "1 rue de Test",
        "nom_rue_ban": "rue de Test",
        "numero_voie_ban": "1",
        "identifiant_ban": "09225_0001",
        "etiquette_dpe": "D",
    }


@pytest.fixture
def loaded(tmp_path):
    path = tmp_path / "t.sqlite"
    schema.build(path)
    conn = db.connect(path, bulk=True)
    loader = ingest.Loader(conn, spec.load())
    # Same INSEE, same street, same BAN identifier -- only the commune's
    # spelling differs. Nothing else can absorb the difference.
    loader.load_page([_row("2409E0000001", "PAMIERS"), _row("2409E0000002", "Pamiers")])
    conn.commit()
    yield conn
    conn.close()


def test_both_spellings_of_one_commune_survive(loaded):
    rec = reconstruct.Reconstructor(loaded)
    first = rec.row("2409E0000001")["nom_commune_ban"]
    second = rec.row("2409E0000002")["nom_commune_ban"]
    assert (first, second) == ("PAMIERS", "Pamiers"), (
        "the second certificate's commune spelling was overwritten by the first"
    )


def test_identical_communes_still_collapse(loaded):
    """The fix must not turn deduplication off. Two certificates that agree
    share one commune row, which is the entire reason the table exists."""
    loaded.execute("DELETE FROM dpe")
    n_before = loaded.execute("SELECT COUNT(*) FROM commune").fetchone()[0]
    loader = ingest.Loader(loaded, spec.load())
    loader.load_page([_row("2409E0000003", "PAMIERS"), _row("2409E0000004", "PAMIERS")])
    loaded.commit()
    assert loaded.execute("SELECT COUNT(*) FROM commune").fetchone()[0] == n_before, (
        "agreeing certificates must not create a second commune row"
    )
