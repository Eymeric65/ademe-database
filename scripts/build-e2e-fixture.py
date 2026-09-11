"""Rebuild test/e2e/fixtures from live ADEME. `python scripts/build-e2e-fixture.py`

The fixture is committed, so this is not run by CI -- it exists so the fixture
can be regenerated and so its provenance is a script rather than a story.

A SAMPLE of two real departements, not a whole one: the smallest metropolitan
departement is 10,647 certificates and its wide file is megabytes, which is too
much to carry in git for a test that needs a few hundred rows. Two departements
rather than one because the search has to choose a partition from the postcode,
and one partition cannot get that wrong.

Metropolitan on purpose: overseas coordinates are published as NULL (ADR-0011),
so an overseas fixture could not exercise the map link at all.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ademe import api, db, export_parquet, ingest, schema, spec
from ademe.config import API

# Ariege and Lozere: small, metropolitan, and far enough apart that a postcode
# selects exactly one of them.
DEPTS = ("09", "48")
PER_DEPT = 400


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("test/e2e/fixtures"))
    ap.add_argument("--scales-from", type=Path, required=True,
                    help="a built database to copy column scales and vocabularies from")
    args = ap.parse_args(argv)

    source = db.connect(args.scales_from)
    scales = {
        r[0]: r[1]
        for r in source.execute("SELECT column_name, scale FROM column_meta WHERE scale != 1")
    }

    work = args.out / "fixture.sqlite"
    work.parent.mkdir(parents=True, exist_ok=True)
    work.unlink(missing_ok=True)
    schema.build(work, scales=scales)

    conn = db.connect(work, bulk=True)
    for (name,) in source.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vocab_%'"
    ):
        rows = source.execute(f"SELECT id, code FROM {name}").fetchall()
        if rows:
            conn.executemany(f"INSERT INTO {name} (id, code) VALUES (?,?)", [tuple(r) for r in rows])
    conn.commit()

    loader = ingest.Loader(conn, spec.load(scales))
    client = api.client()
    for dept in DEPTS:
        page = api.page(
            client,
            f"{API}/lines",
            {"size": PER_DEPT, "format": "csv", "sort": "_i",
             "qs": f'code_departement_ban:"{dept}"'},
        )
        with db.transaction(conn):
            loaded = loader.load_page(page.rows)
        conn.execute(
            "INSERT INTO ingest_departement"
            " (code_departement, total_expected, rows_loaded, started_at, completed_at)"
            " VALUES (?,?,?,datetime(),datetime())"
            " ON CONFLICT(code_departement) DO UPDATE SET rows_loaded = excluded.rows_loaded",
            (dept, loaded, loaded),
        )
        conn.commit()
        print(f"  {dept}: {loaded} certificates")
    conn.close()

    export_parquet.export(work, args.out, quiet=False)
    work.unlink()
    print(f"fixture written to {args.out / export_parquet.VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
