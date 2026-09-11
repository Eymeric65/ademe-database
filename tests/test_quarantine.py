"""One bad certificate in 15.5M must not end a seventeen-hour import.

The resumability spine already works: `ingest_departement` keeps a cursor per
departement and a page loads in a transaction, so a killed run restarts where
it stopped and nothing is discarded. Two crashes proved that -- 3 062 035 rows
survived the first, all of them survived the second.

What neither survived was the *process*. `load_page` iterates certificates and
any exception on any one of them propagates out through `main()`, so a single
malformed row ends the run and the machine then sits idle until somebody
notices. That is the actual defect: not the overflow, not the duplicate, but
that either of them could stop everything.

So a certificate that cannot be loaded goes to `bad_row` with its raw CSV and
the exception, and the load continues. `finalise` then refuses to publish a
build whose quarantine nobody has acknowledged -- because quarantine that
swallows silently is worse than the crash it replaced.
"""

from __future__ import annotations

import json

import pytest

from ademe import db, ddl, finalise, ingest, schema, spec


def _row(numero: str, **over) -> dict:
    row = {
        "numero_dpe": numero,
        "code_insee_ban": "30189",
        "nom_commune_ban": "NIMES",
        "code_departement_ban": "30",
        "code_region_ban": "76",
        "code_postal_ban": "30000",
        "adresse_ban": f"{numero} rue de Test",
        "nom_rue_ban": "rue de Test",
        "numero_voie_ban": "1",
        "identifiant_ban": f"30189_{numero[-4:]}",
        "etiquette_dpe": "D",
    }
    row.update(over)
    return row


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "t.sqlite"
    schema.build(path)
    c = db.connect(path, bulk=True)
    yield c
    c.close()


def _break_one(loader, numero: str):
    """Make exactly one certificate raise, at the point the real ones did --
    inside the per-row conversion, after its address has been written."""
    original = loader.convert

    def convert(key, raw):
        if raw == f"POISON-{numero}":
            raise ValueError("simulated bad value")
        return original(key, raw)

    loader.convert = convert


def test_a_page_survives_a_certificate_that_cannot_be_loaded(conn):
    loader = ingest.Loader(conn, spec.load())
    _break_one(loader, "2430E0000002")
    n = loader.load_page([
        _row("2430E0000001"),
        _row("2430E0000002", etiquette_ges="POISON-2430E0000002"),
        _row("2430E0000003"),
    ])
    conn.commit()

    assert n == 3, "every row the server handed over is still counted"
    loaded = [r[0] for r in conn.execute("SELECT numero_dpe FROM dpe ORDER BY 1")]
    assert loaded == ["2430E0000001", "2430E0000003"]

    bad = conn.execute("SELECT numero_dpe, code_departement, error, raw FROM bad_row").fetchall()
    assert len(bad) == 1
    assert bad[0][0] == "2430E0000002"
    assert bad[0][1] == "30"
    assert "simulated bad value" in bad[0][2]
    assert json.loads(bad[0][3])["etiquette_ges"] == "POISON-2430E0000002"


def test_the_quarantined_row_leaves_nothing_behind(conn):
    """The trap that makes a savepoint insufficient on its own.

    `adresse_id` writes an address and caches its id. Roll the write back and
    the id is gone -- but a cache that still hands it out would give every
    later certificate at that address a dangling `adresse_id`, accepted in
    silence because the load runs with `PRAGMA foreign_keys = OFF`, and
    surfacing twelve hours later as a `foreign_key_check` failure.
    """
    loader = ingest.Loader(conn, spec.load())
    _break_one(loader, "2430E0000002")
    # The poisoned certificate shares its address with the one after it, so the
    # cache entry its rollback removes is one a later row genuinely needs.
    shared = {"identifiant_ban": "30189_SHARED", "adresse_ban": "1 rue Partagee"}
    loader.load_page([
        _row("2430E0000002", etiquette_ges="POISON-2430E0000002", **shared),
        _row("2430E0000003", **shared),
    ])
    conn.commit()

    assert not conn.execute("PRAGMA foreign_key_check").fetchall(), (
        "the quarantined row left a dangling reference behind"
    )
    orphans = conn.execute(
        "SELECT COUNT(*) FROM dpe d LEFT JOIN adresse a USING (adresse_id)"
        " WHERE a.adresse_id IS NULL"
    ).fetchone()[0]
    assert orphans == 0


def test_a_clean_page_never_touches_the_slow_path(conn):
    """Non-vacuity for the fast path: the row-by-row replay costs a round trip
    per certificate across seven child tables, and it must run only for a page
    that actually failed."""
    loader = ingest.Loader(conn, spec.load())
    calls = []
    original = loader._load_rows_carefully
    loader._load_rows_carefully = lambda rows: (calls.append(rows), original(rows))

    loader.load_page([_row("2430E0000001"), _row("2430E0000002")])
    conn.commit()
    assert calls == [], "a clean page was replayed row by row for nothing"
    assert conn.execute("SELECT COUNT(*) FROM dpe").fetchone()[0] == 2


def test_finalise_refuses_a_quarantine_nobody_has_read(conn):
    """Quarantine must not become the thing that makes a broken load look
    finished. A schema change upstream would send every certificate to
    `bad_row`, and without this the build would publish empty and green."""
    loader = ingest.Loader(conn, spec.load())
    _break_one(loader, "2430E0000002")
    loader.load_page([
        _row("2430E0000001"),
        _row("2430E0000002", etiquette_ges="POISON-2430E0000002"),
    ])
    conn.execute(
        "INSERT INTO ingest_departement"
        " (code_departement, total_expected, rows_loaded, started_at, completed_at)"
        " VALUES ('30', 2, 2, datetime(), datetime())"
    )
    conn.commit()

    with pytest.raises(finalise.Quarantined) as exc:
        finalise.finalise(conn)
    assert "2430E0000002" in str(exc.value)
    assert not conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_dpe_adresse'"
    ).fetchone(), "finalise did an hour of index building before refusing"

    # Acknowledged, it proceeds.
    assert finalise.finalise(conn, allow_bad_rows=1) == 1


def test_finalise_is_unaffected_when_the_quarantine_is_empty(conn):
    loader = ingest.Loader(conn, spec.load())
    loader.load_page([_row("2430E0000001")])
    conn.execute(
        "INSERT INTO ingest_departement"
        " (code_departement, total_expected, rows_loaded, started_at, completed_at)"
        " VALUES ('30', 1, 1, datetime(), datetime())"
    )
    conn.commit()
    assert finalise.finalise(conn) == 1
