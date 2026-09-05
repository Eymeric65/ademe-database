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

import os
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pytest

from ademe import api, db, export_parquet, reconstruct
from ademe.config import API, DEFAULT_DB
from ademe.mapping import INTERNAL_COLUMNS

SAMPLE = 40

# Where `python -m ademe.export_parquet --out ...` put the files.
PARQUET_DIR = Path(
    os.environ.get("ADEME_PARQUET_DIR", str(DEFAULT_DB.parent / "parquet" / "v1"))
)


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


@pytest.mark.live
def test_published_parquet_round_trips():
    """The same contract as above, for the files the browser actually reads.

    A green SQLite round-trip and a lossy export are compatible states: the
    export re-encodes every value (scaled integer -> DECIMAL, day count ->
    DATE, vocabulary id -> code) and any one of those mappings can drop
    precision without the database noticing. This is the only test that would
    catch it.
    """
    if not (PARQUET_DIR / "manifest.json").exists():
        # A skip is not a pass. Under CI this is a missing artefact, not an
        # absent optional dependency (CLAUDE.md section 3).
        if os.environ.get("CI"):
            raise AssertionError(f"no export at {PARQUET_DIR}; set ADEME_PARQUET_DIR")
        pytest.skip(f"no export at {PARQUET_DIR} -- run ademe.export_parquet")

    import duckdb

    d = duckdb.connect()
    numeros = [
        r[0]
        for r in d.execute(
            f"SELECT numero_dpe FROM read_parquet('{PARQUET_DIR}/dpe/*/*.parquet')"
            f" USING SAMPLE {SAMPLE} ROWS"
        ).fetchall()
    ]
    assert numeros, "the export is empty"

    published = export_parquet.read_rows(PARQUET_DIR, numeros)
    source = _fetch(api.client(), numeros)
    assert source, "could not fetch the comparison records"

    manifest = __import__("json").loads((PARQUET_DIR / "manifest.json").read_text())
    numeric = {
        c
        for c, m in manifest["column_meta"].items()
        if m["encoding"] in ("scaled", "int")
    }

    mismatches, compared = [], 0
    for numero, original in source.items():
        rebuilt = published.get(numero)
        assert rebuilt is not None, f"{numero} is not in the published Parquet"
        for col, want in original.items():
            if col in INTERNAL_COLUMNS:
                continue
            compared += 1
            if not _equal(col, want, rebuilt.get(col, ""), numeric):
                mismatches.append(f"{numero}.{col}: source={want!r} parquet={rebuilt.get(col)!r}")

    assert compared > 1000, f"only {compared} fields compared -- test is too weak"
    assert not mismatches, (
        f"{len(mismatches)} of {compared} fields did not survive the export:\n  "
        + "\n  ".join(mismatches[:25])
    )


@pytest.mark.live
def test_published_coordinates_match_ademes_own_geopoint():
    """lat/lon are derived at export by inverting Lambert-93 (ademe/geo.py,
    ADR-0006) rather than read from the source, so they need a check against
    something that did not come from the same arithmetic."""
    if not (PARQUET_DIR / "manifest.json").exists():
        if os.environ.get("CI"):
            raise AssertionError(f"no export at {PARQUET_DIR}; set ADEME_PARQUET_DIR")
        pytest.skip(f"no export at {PARQUET_DIR} -- run ademe.export_parquet")

    import duckdb

    d = duckdb.connect()
    rows = d.execute(
        f"SELECT numero_dpe, lat, lon FROM read_parquet('{PARQUET_DIR}/dpe/*/*.parquet')"
        f" WHERE lat IS NOT NULL USING SAMPLE {SAMPLE} ROWS"
    ).fetchall()
    assert rows, "nothing in the export carries coordinates"

    numeros = [r[0] for r in rows]
    qs = " OR ".join(f'numero_dpe:"{n}"' for n in numeros)
    page = api.page(
        api.client(),
        f"{API}/lines",
        {"size": len(numeros), "format": "csv", "select": "numero_dpe,_geopoint", "qs": qs},
    )
    source = {r["numero_dpe"]: r["_geopoint"] for r in page.rows}

    worst, compared = 0.0, 0
    for numero, lat, lon in rows:
        geopoint = source.get(numero)
        if not geopoint:
            continue
        want_lat, want_lon = (float(v) for v in geopoint.split(","))
        worst = max(worst, abs(float(lat) - want_lat), abs(float(lon) - want_lon))
        compared += 1

    assert compared > 10, f"only {compared} coordinates compared"
    # DECIMAL(10,6) is ~0.1 m; 1e-5 degrees is ~1 m, which is what the map needs.
    assert worst < 1e-5, f"worst coordinate delta {worst:.2e} degrees over {compared} rows"
