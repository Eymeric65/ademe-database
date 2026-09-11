"""Scaling is the mechanism the whole size argument rests on, and it is only
worth anything if it is exactly reversible."""

from __future__ import annotations

from decimal import Decimal

import pytest

from ademe import db, ingest, reconstruct, scales, schema, spec
from tests.test_export_parquet import SCALES, _row


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("12", 0),
        ("12.0", 1),
        ("12.30", 2),
        ("0.000001", 6),
        ("-4.5", 1),
        ("1e3", 0),
        ("", None),
        ("collectif", None),
        ("NaN", None),
    ],
)
def test_decimals(raw, expected):
    assert scales.decimals(raw) == expected


def test_too_precise_falls_back_to_text_not_integer():
    """Regression, and a live bug when it was written.

    A column with more decimals than the cap used to be assigned scale 1 --
    plain INTEGER -- which truncated exactly the decimals the cap existed to
    protect. The Lambert-93 coordinate columns carry up to 6 decimals and hit
    it. The fallback for 'too precise to scale' must be the exact encoding.
    """
    numeric = ["ok", "too_precise"]
    rows = [
        {"ok": "1.5", "too_precise": "1." + "0" * scales.MAX_SCALE_EXP + "5"},
    ]

    class FakePage:
        def __init__(self, rows):
            self.rows, self.next_url, self.nbytes = rows, None, 0

    import ademe.api as api

    orig, api.page = api.page, lambda *a, **k: FakePage(rows)
    try:
        got, bad, seen = scales.discover(None, numeric, sample=1, page_size=1)
    finally:
        api.page = orig

    assert got["ok"] == 10
    assert got["too_precise"] == scales.TEXT_SENTINEL, (
        "a column too precise to scale must be stored as TEXT, never as a "
        "plain integer -- that silently truncates"
    )


def test_non_numeric_value_disqualifies_integer_encoding():
    """One stray literal in a numeric column and the whole column has to be
    stored exactly, or that row is lost."""

    class FakePage:
        def __init__(self, rows):
            self.rows, self.next_url, self.nbytes = rows, None, 0

    import ademe.api as api

    rows = [{"n": "1.5"}, {"n": "sans objet"}]
    orig, api.page = api.page, lambda *a, **k: FakePage(rows)
    try:
        got, bad, _ = scales.discover(None, ["n"], sample=2, page_size=2)
    finally:
        api.page = orig

    assert bad["n"] == 1
    assert got["n"] == scales.TEXT_SENTINEL


@pytest.mark.parametrize(
    "raw", ["0", "1.5", "43.27", "6478894.912345", "-0.1", "100.0", "0.0"]
)
def test_scaling_round_trips_exactly(raw):
    """Decimal, never float: `text -> double -> text` does not round-trip, and
    the requirement here is byte-exact regeneration."""
    d = scales.decimals(raw)
    scale = 10**d
    stored = int((Decimal(raw) * scale).to_integral_value())
    back = Decimal(stored) / Decimal(scale)
    assert f"{back:.{d}f}" == f"{Decimal(raw):.{d}f}"


def _load_like_the_cli(path, row):
    """What `python -m ademe.ingest` does: read the recorded scales back, load."""
    conn = db.connect(path, bulk=True)
    recorded = {
        r["column_name"]: r["scale"]
        for r in conn.execute("SELECT column_name, scale FROM column_meta WHERE scale != 1")
    }
    ingest.Loader(conn, spec.load(recorded)).load_page([row])
    conn.commit()
    return conn


def test_a_column_too_precise_to_scale_keeps_its_text_through_the_build_order(tmp_path):
    """The national builds run `ademe.schema`, then `ademe.scales`. The schema is
    generated before any scale is known, so every numeric column is declared
    INTEGER, and `scales` used to rewrite only column_meta. A column too precise
    to scale was then stored as text in an INTEGER column, and SQLite's affinity
    converted it: '78.50' came back '78.5'. 119 columns of the energy audits,
    millions of values, found when the export refused a REAL. See ADR-0032.
    """
    path = tmp_path / "t.sqlite"
    schema.build(path)  # `python -m ademe.schema`: no scale known yet
    scales.store(path, dict(SCALES, surface_habitable_logement=scales.TEXT_SENTINEL))

    conn = _load_like_the_cli(
        path, _row("2409E0000001", "09001", "09", surface_habitable_logement="78.50")
    )
    declared = {r["name"]: r["type"] for r in conn.execute("PRAGMA table_info(dpe)")}
    got = reconstruct.Reconstructor(conn).row("2409E0000001")["surface_habitable_logement"]
    conn.close()
    assert (got, declared["surface_habitable_logement"]) == ("78.50", "TEXT")


def test_scales_cannot_change_under_loaded_rows(tmp_path):
    """The scales are how the stored integers are read back. Changed after the
    load, every value already stored would be decoded with a scale it was not
    encoded with, silently."""
    path = tmp_path / "t.sqlite"
    schema.build(path)
    scales.store(path, dict(SCALES))
    _load_like_the_cli(path, _row("2409E0000001", "09001", "09")).close()
    with pytest.raises(SystemExit, match="already holds"):
        scales.store(path, dict(SCALES, surface_habitable_logement=100))
