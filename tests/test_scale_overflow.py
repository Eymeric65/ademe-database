"""A ceiling 5.5e181 metres high, and the seventeen-hour build it killed.

Certificate `2430E0700205G` (Gard) carries
`hauteur_sous_plafond = 5.55555555555556e+181`. The column's declared scale is
10, so `to_scaled` multiplied it out to a 182-digit integer and handed that to
SQLite, which stores integers in 64 bits and nothing wider:

    OverflowError: Python int too large to convert to SQLite INTEGER

The national ingest died there, 15 hours and 3.06M certificates in, with the
whole of departement 30 still to load.

The value is nonsense, but "nonsense" is not a category this ETL has: ADR-0004
says the raw literal is preserved whenever the scaled encoding cannot hold it,
and `scale_violation` is where that already happens for a number carrying more
decimals than its scale. A number too *large* for the encoding is the same
failure and belongs in the same place -- NULL in the column, the literal in
`scale_violation`, and `reconstruct` hands the original text back.
"""

from __future__ import annotations

import pytest

from ademe import db, ingest, reconstruct, schema, spec

# The real value, from the real certificate, in the real departement.
ABSURD = "5.55555555555556e+181"


def _row(numero: str, hauteur: str) -> dict:
    return {
        "numero_dpe": numero,
        "code_insee_ban": "30189",
        "nom_commune_ban": "NIMES",
        "code_departement_ban": "30",
        "code_region_ban": "76",
        "code_postal_ban": "30000",
        "adresse_ban": "1 rue de Test",
        "nom_rue_ban": "rue de Test",
        "numero_voie_ban": "1",
        "identifiant_ban": "30189_0001",
        "etiquette_dpe": "D",
        "hauteur_sous_plafond": hauteur,
    }


# The scale `ademe.scales` discovered for this column against the live API.
# `spec.load()` with no scales makes every numeric column a plain INTEGER,
# which is not the encoding the national build actually ran with.
SCALES = {"hauteur_sous_plafond": 10}


@pytest.fixture
def loaded(tmp_path):
    path = tmp_path / "t.sqlite"
    schema.build(path, scales=SCALES)
    conn = db.connect(path, bulk=True)
    loader = ingest.Loader(conn, spec.load(SCALES))
    # Both in one page, because that is how they arrived: a single absurd
    # value must not take the 9 999 sane rows beside it down with it.
    loader.load_page(
        [_row("2430E0700205G", ABSURD), _row("2430E0700206H", "2.5")]
    )
    conn.commit()
    yield conn
    conn.close()


def test_a_value_too_large_for_int64_does_not_kill_the_load(loaded):
    assert loaded.execute("SELECT COUNT(*) FROM dpe").fetchone()[0] == 2


def test_the_absurd_value_is_preserved_verbatim(loaded):
    """Lossless is lossless. The column is NULL and the literal is kept."""
    rec = reconstruct.Reconstructor(loaded)
    assert rec.row("2430E0700205G")["hauteur_sous_plafond"] == ABSURD

    stored = loaded.execute(
        "SELECT hauteur_sous_plafond FROM dpe WHERE numero_dpe = ?",
        ("2430E0700205G",),
    ).fetchone()[0]
    assert stored is None, "an unstorable value must not be silently truncated"

    raw = loaded.execute(
        "SELECT raw_value FROM scale_violation sv JOIN dpe USING (dpe_id)"
        " WHERE numero_dpe = ? AND column_name = 'hauteur_sous_plafond'",
        ("2430E0700205G",),
    ).fetchone()
    assert raw is not None and raw[0] == ABSURD


def test_ordinary_values_still_scale(loaded):
    """Non-vacuity: the guard must reject what int64 cannot hold and nothing
    else. A bound that swept every value into `scale_violation` would pass the
    two tests above and destroy the encoding the database is built on."""
    stored = loaded.execute(
        "SELECT hauteur_sous_plafond FROM dpe WHERE numero_dpe = ?",
        ("2430E0700206H",),
    ).fetchone()[0]
    assert stored == 25, "2.5 at scale 10 must still be the integer 25"
    assert (
        loaded.execute(
            "SELECT COUNT(*) FROM scale_violation sv JOIN dpe USING (dpe_id)"
            " WHERE numero_dpe = ?",
            ("2430E0700206H",),
        ).fetchone()[0]
        == 0
    )


@pytest.mark.parametrize(
    "raw,scale,fits",
    [
        ("922337203685477580.7", 10, True),   # int64 max, exactly
        ("922337203685477580.8", 10, False),  # one tick past it
        ("-922337203685477580.8", 10, True),  # int64 min, exactly
        ("-922337203685477580.9", 10, False),
        (ABSURD, 10, False),
    ],
)
def test_the_boundary_is_exactly_int64(raw, scale, fits):
    value, kept = ingest.to_scaled(raw, scale)
    assert (value is not None) is fits
    assert (kept is None) is fits
