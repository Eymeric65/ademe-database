"""The resume cursor has a shelf life, and nothing says so.

`ingest_departement` stores the server's own `after` token so a killed run
restarts mid-departement. The token is a position in a sort order, not an
identity -- and ADEME keeps publishing. Departement 30 grew from 157 179 to
157 573 rows over the three days a crashed run sat idle, and the resume then
served certificates that were already loaded:

    sqlite3.IntegrityError: UNIQUE constraint failed: dpe.numero_dpe

after 80 000 clean rows. This is not ADEME serving duplicates -- pulling the
whole departement with `select=numero_dpe` gives 157 573 rows and 157 573
distinct numeros. It is entirely an artefact of resuming across a change.

The load therefore has to be idempotent on `numero_dpe`, which needs the unique
index during the load rather than at `finalise`. Without it the second copy
inserts silently and the failure moves to `finalise`, hours later, over 15M
rows -- the worst of both.
"""

from __future__ import annotations

import pytest

from ademe import db, ingest, reconstruct, schema, spec


def _row(numero: str, nom: str = "NIMES") -> dict:
    return {
        "numero_dpe": numero,
        "code_insee_ban": "30189",
        "nom_commune_ban": nom,
        "code_departement_ban": "30",
        "code_region_ban": "76",
        "code_postal_ban": "30000",
        "adresse_ban": f"{numero} rue de Test",
        "nom_rue_ban": "rue de Test",
        "numero_voie_ban": "1",
        "identifiant_ban": "30189_0001",
        "etiquette_dpe": "D",
    }


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "t.sqlite"
    schema.build(path)
    c = db.connect(path, bulk=True)
    yield c
    c.close()


def test_a_resumed_page_that_overlaps_does_not_duplicate(conn):
    """The shape of the real failure: a second page whose first rows are the
    tail of the first, because rows were inserted ahead of the cursor."""
    loader = ingest.Loader(conn, spec.load())
    loader.load_page([_row("2430E0000001"), _row("2430E0000002")])
    # The resume re-serves 0002 and then continues.
    loader.load_page([_row("2430E0000002"), _row("2430E0000003")])
    conn.commit()

    assert conn.execute("SELECT COUNT(*) FROM dpe").fetchone()[0] == 3
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM (SELECT numero_dpe FROM dpe"
            " GROUP BY numero_dpe HAVING COUNT(*) > 1)"
        ).fetchone()[0]
        == 0
    )


def test_the_children_of_a_skipped_row_are_not_duplicated_either(conn):
    """A certificate carries rows in seven child tables. Skipping only the
    `dpe` insert would leave the children to be written a second time against
    a different dpe_id -- invisible until the export doubled a generator."""
    loader = ingest.Loader(conn, spec.load())
    row = _row("2430E0000001")
    row["type_generateur_chauffage_principal"] = "Chaudière gaz"
    loader.load_page([row])
    before = {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ("dpe_adresse_brut", "dpe_installation_chauffage",
                  "dpe_generateur_chauffage", "dpe_bilan_energie")
    }
    loader.load_page([row])
    conn.commit()
    after = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in before}
    assert after == before, f"child rows written twice: {before} -> {after}"


def test_the_first_copy_is_the_one_that_survives_intact(conn):
    """Non-vacuity in the other direction: skipping must not corrupt the row
    that is already there. A guard that emptied the certificate instead of
    leaving it alone would satisfy both counts above."""
    loader = ingest.Loader(conn, spec.load())
    loader.load_page([_row("2430E0000001", nom="NIMES")])
    loader.load_page([_row("2430E0000001", nom="NIMES")])
    conn.commit()
    rec = reconstruct.Reconstructor(conn)
    got = rec.row("2430E0000001")
    assert got["nom_commune_ban"] == "NIMES"
    assert got["etiquette_dpe"] == "D"


def test_every_row_is_counted_even_when_it_is_skipped(conn):
    """`rows_loaded` advances the cursor's bookkeeping, so it counts what the
    server handed over -- not what turned out to be new. Counting only inserts
    would make a resumed departement look permanently incomplete and re-fetch
    it forever."""
    loader = ingest.Loader(conn, spec.load())
    assert loader.load_page([_row("2430E0000001"), _row("2430E0000002")]) == 2
    assert loader.load_page([_row("2430E0000002"), _row("2430E0000003")]) == 2
