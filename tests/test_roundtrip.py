"""The losslessness test.

Everything the schema does is a bet that the source record can be rebuilt
exactly. This is where the bet is settled: take certificates out of the built
database, reconstruct all 226 columns, fetch the same records live from ADEME,
and compare field by field.

Skips rather than fails when the database has not been built yet, so the
offline suite stays green on a fresh clone -- but `-m live` on a built database
is the check that matters.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

import pytest

from ademe import api, db, reconstruct
from ademe.config import API, DEFAULT_DB
from ademe.mapping import INTERNAL_COLUMNS

SAMPLE = 40


def _equal(col: str, want: str, got: str, numeric: set[str]) -> bool:
    """The losslessness contract, stated precisely.

    Text, vocabulary and date columns must come back BYTE-EXACT.

    Numeric columns must come back with the same VALUE, not the same literal.
    ADEME writes variable decimal places within one column -- `38` and `117.1`
    both appear in `conso_5_usages_par_m2_ef` -- so preserving the literal
    would mean storing a per-value decimal count purely to reproduce a trailing
    zero. Reconstruction emits the column's declared scale, so `38` comes back
    as `38.0`. That is a deliberate canonicalisation, not a loss: no
    information needed to recompute anything is discarded.
    """
    want, got = want or "", got or ""
    if want == got:
        return True
    if col in numeric and want and got:
        try:
            return Decimal(want) == Decimal(got)
        except InvalidOperation:
            return False
    return False


@pytest.fixture(scope="module")
def conn():
    if not DEFAULT_DB.exists():
        pytest.skip(f"no database at {DEFAULT_DB} -- run ademe.schema + ademe.ingest")
    c = db.connect(DEFAULT_DB)
    if not c.execute("SELECT COUNT(*) FROM dpe").fetchone()[0]:
        pytest.skip("database is empty -- run ademe.ingest")
    yield c
    c.close()


def _fetch(client, numeros: list[str]) -> dict[str, dict]:
    """The same records, straight from the source."""
    qs = " OR ".join(f'numero_dpe:"{n}"' for n in numeros)
    p = api.page(
        client,
        f"{API}/lines",
        {"size": len(numeros), "format": "csv", "qs": qs},
    )
    return {r["numero_dpe"]: r for r in p.rows}


@pytest.mark.live
def test_every_column_round_trips_exactly(conn):
    rows = conn.execute(
        "SELECT numero_dpe FROM dpe ORDER BY random() LIMIT ?", (SAMPLE,)
    ).fetchall()
    numeros = [r["numero_dpe"] for r in rows]
    assert numeros, "nothing loaded"

    source = _fetch(api.client(), numeros)
    assert source, "could not fetch the comparison records"

    rec = reconstruct.Reconstructor(conn)
    numeric = {
        r["column_name"]
        for r in conn.execute(
            "SELECT column_name FROM column_meta WHERE encoding IN ('scaled','int')"
        )
    }
    mismatches: list[str] = []
    compared = 0

    for numero, original in source.items():
        rebuilt = rec.row(numero)
        assert rebuilt is not None, f"{numero} missing from the database"
        for col, want in original.items():
            if col in INTERNAL_COLUMNS:
                continue
            got = rebuilt.get(col, "")
            compared += 1
            if not _equal(col, want, got, numeric):
                mismatches.append(f"{numero}.{col}: source={want!r} rebuilt={got!r}")

    assert compared > 1000, f"only {compared} fields compared -- test is too weak"
    assert not mismatches, (
        f"{len(mismatches)} of {compared} fields did not round-trip:\n  "
        + "\n  ".join(mismatches[:25])
    )


@pytest.mark.live
def test_reconstruction_covers_every_source_column(conn):
    """A column silently missing from reconstruction would make the test above
    vacuous for it."""
    rec = reconstruct.Reconstructor(conn)
    row = conn.execute("SELECT numero_dpe FROM dpe LIMIT 1").fetchone()
    rebuilt = rec.row(row["numero_dpe"])
    expected = {
        r["column_name"]
        for r in conn.execute("SELECT column_name FROM column_meta")
    }
    assert set(rebuilt) == expected, (
        f"reconstruction is missing {sorted(expected - set(rebuilt))[:10]}"
    )


def test_scaled_values_reverse_exactly():
    assert reconstruct._fmt_scaled(4327, 100) == "43.27"
    assert reconstruct._fmt_scaled(15, 10) == "1.5"
    assert reconstruct._fmt_scaled(150, 10) == "15.0"
    assert reconstruct._fmt_scaled(42, 1) == "42"
    assert reconstruct._fmt_scaled(6478894912345, 10**6) == "6478894.912345"
