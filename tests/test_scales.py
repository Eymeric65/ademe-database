"""Scaling is the mechanism the whole size argument rests on, and it is only
worth anything if it is exactly reversible."""

from __future__ import annotations

from decimal import Decimal

import pytest

from ademe import scales


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
