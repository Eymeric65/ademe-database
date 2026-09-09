"""`finalise` is the step between "the load finished" and "the database is
usable", and both halves of it are load-bearing.

The indexes are deliberately not built during ingest -- creating them up front
makes every one of ~15.5M inserts maintain a B-tree it does not need yet. And
`db.connect(bulk=True)` turns foreign keys OFF for the load, which is far
cheaper than per-row enforcement across ~57M child rows but is only sound if
something checks them wholesale afterwards. Nothing did.
"""

from __future__ import annotations

import pytest

from ademe import db, ddl, finalise, ingest, schema, spec


def _row(numero: str, insee: str = "09001", dept: str = "09", **over) -> dict:
    """A minimal certificate. Only the columns the assertions touch are set;
    the loader fills the other 220-odd with NULL, which is what a sparse real
    row looks like anyway."""
    return {
        "numero_dpe": numero,
        "code_insee_ban": insee,
        "code_departement_ban": dept,
        "code_postal_ban": "09000",
        "nom_commune_ban": "Foix",
        "adresse_ban": f"{numero} rue de Test",
        "identifiant_ban": f"ban-{numero}",
        "etiquette_dpe": "D",
        "etiquette_ges": "C",
        "date_etablissement_dpe": "2024-03-11",
        "surface_habitable_logement": "78.5",
        "_geopoint": "42.964,1.605",
        **over,
    }


@pytest.fixture
def built(tmp_path):
    """A tiny but real database: the generated DDL, two loaded certificates,
    and a ledger that says the load is done."""
    path = tmp_path / "t.sqlite"
    schema.build(path)
    conn = db.connect(path, bulk=True)
    cols = spec.load()
    loader = ingest.Loader(conn, cols)
    loader.load_page([
        _row("2409E0000001"),
        _row("2409E0000002"),
        # Two certificates sharing one BAN identifier but disagreeing on the
        # street text -- the mojibake case ingest.adresse_id's docstring
        # describes. The loader keeps both address rows on purpose, so any
        # index over identifiant_ban must tolerate the duplicate.
        _row("2409E0000003", identifiant_ban="ban-shared", nom_rue_ban="Parc d\u2019Espagne"),
        _row("2409E0000004", identifiant_ban="ban-shared", nom_rue_ban="Parc d\u00e2\u20ac\u2122Espagne"),
    ])
    conn.execute(
        "INSERT INTO ingest_departement"
        " (code_departement, total_expected, rows_loaded, started_at, completed_at)"
        " VALUES ('09', 4, 4, datetime(), datetime())"
    )
    conn.commit()
    yield conn, path
    conn.close()


def test_builds_indexes_and_records_the_row_count(built):
    conn, _ = built
    before = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_dpe_numero'"
    ).fetchone()
    assert before is None, "the index must not exist before finalise runs"

    finalise.finalise(conn)

    assert conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_dpe_numero'"
    ).fetchone(), "ux_dpe_numero was not created"
    assert not conn.execute("PRAGMA foreign_key_check").fetchall()
    assert conn.execute("SELECT upstream_rows FROM data_source").fetchone()[0] == 4


def test_an_orphaned_reference_is_refused(built):
    """The non-vacuity proof for the whole foreign-key half of finalise.

    The load runs with `PRAGMA foreign_keys = OFF`, so SQLite accepts this
    write without complaint. If `finalise` did not check, a database with a
    dangling adresse_id would be published and the detail view would show a
    certificate with no address -- silently, for those rows only.
    """
    conn, _ = built
    conn.execute("UPDATE dpe SET adresse_id = 999999 WHERE numero_dpe = '2409E0000001'")
    conn.commit()

    with pytest.raises(finalise.IntegrityError) as e:
        finalise.finalise(conn)
    assert "dpe" in str(e.value)


def test_refuses_while_a_departement_is_still_loading(built):
    """Indexing and ANALYZE on a half-loaded database produce statistics that
    are wrong for the finished one, and a foreign-key check that means nothing
    because the missing parent may simply not have arrived yet."""
    conn, _ = built
    conn.execute(
        "INSERT INTO ingest_departement (code_departement, started_at)"
        " VALUES ('31', datetime())"
    )
    conn.commit()

    with pytest.raises(finalise.Incomplete) as e:
        finalise.finalise(conn)
    assert "31" in str(e.value)

    # --partial is the deliberate override, for exporting one departement.
    finalise.finalise(conn, partial=True)
    assert conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_dpe_numero'"
    ).fetchone()


def test_every_declared_index_can_actually_be_built(built):
    """Regression. `indexes_ddl()` had no caller, so nothing ever executed it
    and two of its five statements were wrong against the schema it describes:

      - `ux_adresse_ban` was UNIQUE over `adresse(identifiant_ban)`, which
        contradicts the loader. `ingest.adresse_id` deliberately keys on the
        whole address tuple because certificates sharing a BAN identifier
        disagree on the street text, so duplicates of that column are the
        designed behaviour, not corruption.
      - `ix_commune_dept` named `commune(code_departement)`; the column is
        `code_departement_id`, because it is a vocabulary reference.

    Both would have surfaced only at the end of the 17-hour base build.
    """
    finalise.finalise(conn := built[0])
    names = {
        r[0]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
    }
    for stmt in ddl.indexes_ddl():
        name = stmt.split("EXISTS ")[1].split(" ")[0]
        assert name in names, f"{name} was declared but is not on the database"
