"""Discover the decimal scale of every numeric column. `python -m ademe.scales`

Storing `43.27` as REAL costs 8 body bytes; storing `4327` with a declared
scale of 100 costs 2. Measured over five columns and 200k rows, scaling is
5.47 B per column per row cheaper than REAL, and NUMERIC affinity was verified
to be byte-identical to REAL (it only compacts values that are already whole).
Across ~65 populated numeric columns that is several GB.

Scaling is also the only *lossless* option. `text -> double -> text` does not
round-trip: trailing zeros and binary fractions both break exact regeneration.
An integer plus a declared scale is byte-exact by construction.

The sample is ordered by the dataset's `_rand` field rather than `_i`. Insertion
order is clustered by departement and date, so an `_i`-ordered head would
report the decimal habits of one region.
"""

from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
from pathlib import Path

import httpx

from ademe import api, db, spec
from ademe.config import API, DEFAULT_DB

# The Lambert-93 coordinates carry up to 6 decimals (x*10^6 is ~1e12, well
# inside int64). Past this a column is stored as TEXT -- scale 0 is the
# sentinel for that.
#
# This cap used to fall back to scale=1, i.e. plain INTEGER, which TRUNCATED
# the decimals it was meant to protect. The coordinate columns hit it, so the
# bug was live. The fallback for "too precise to scale" must be the exact
# encoding, never the lossy one.
MAX_SCALE_EXP = 6
TEXT_SENTINEL = 0


def decimals(raw: str) -> int | None:
    """Decimal places in a numeric literal, or None if it is not one."""
    try:
        d = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None
    exp = d.as_tuple().exponent
    if not isinstance(exp, int):
        return None  # NaN / Infinity
    return max(0, -exp)


def discover(
    client: httpx.Client, numeric: list[str], *, sample: int, page_size: int
) -> tuple[dict[str, int], dict[str, int], int]:
    """Return (scale per column, non-numeric hits per column, rows seen)."""
    maxdec: dict[str, int] = {c: 0 for c in numeric}
    bad: dict[str, int] = {}
    seen = 0

    url = f"{API}/lines"
    params = {"size": page_size, "format": "csv", "sort": "_rand"}
    while seen < sample:
        p = api.page(client, url, params)
        if not p.rows:
            break
        for row in p.rows:
            seen += 1
            for col in numeric:
                raw = row.get(col, "")
                if raw == "" or raw is None:
                    continue
                d = decimals(raw)
                if d is None:
                    bad[col] = bad.get(col, 0) + 1
                elif d > maxdec[col]:
                    maxdec[col] = d
        if not p.next_url:
            break
        url, params = p.next_url, None

    scales = {}
    for col, d in maxdec.items():
        scales[col] = 10**d if d <= MAX_SCALE_EXP else TEXT_SENTINEL
    # A column where a non-numeric literal turned up cannot be trusted to an
    # integer encoding at all.
    for col in bad:
        scales[col] = TEXT_SENTINEL
    return scales, bad, seen


def store(path: Path, scales: dict[str, int]) -> None:
    conn = db.connect(path)
    try:
        with db.transaction(conn):
            conn.executemany(
                "UPDATE column_meta SET scale = ?, encoding = ?"
                " WHERE column_name = ?",
                [
                    (
                        s,
                        "text" if s == TEXT_SENTINEL else ("scaled" if s > 1 else "int"),
                        c,
                    )
                    for c, s in scales.items()
                ],
            )
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db-path", type=Path, default=DEFAULT_DB)
    ap.add_argument("--sample", type=int, default=20_000)
    ap.add_argument("--page-size", type=int, default=2_000)
    args = ap.parse_args(argv)

    cols = spec.load()
    numeric = spec.numeric_columns(cols)
    client = api.client()
    print(f"sampling {args.sample:,} random rows for {len(numeric)} numeric columns...")
    scales, bad, seen = discover(
        client, numeric, sample=args.sample, page_size=args.page_size
    )
    store(args.db_path, scales)

    hist: dict[int, int] = {}
    for s in scales.values():
        hist[s] = hist.get(s, 0) + 1
    print(f"\nsampled {seen:,} rows")
    for s in sorted(hist):
        if s == TEXT_SENTINEL:
            print(f"  TEXT (too precise to scale)  {hist[s]:3d} columns")
        else:
            print(f"  scale {s:>9,}  (10^{len(str(s)) - 1})  {hist[s]:3d} columns")
    if bad:
        print("\n  non-numeric values seen in numeric columns:")
        for c, n in sorted(bad.items(), key=lambda kv: -kv[1])[:10]:
            print(f"    {c:52s} {n}")
    plain = [c for c, s in scales.items() if s == 1]
    astext = [c for c, s in scales.items() if s == TEXT_SENTINEL]
    print(
        f"\n{len(scales) - len(plain) - len(astext)} scaled, "
        f"{len(plain)} plain integers, {len(astext)} as TEXT"
    )
    for c in astext:
        print(f"    TEXT: {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
